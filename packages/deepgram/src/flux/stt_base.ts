// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/flux/stt_base.py

/**
 * Deepgram Flux STT base class shared across transports (WebSocket,
 * SageMaker, etc.).
 *
 * Porting notes:
 * - Settings field names are camelCase (`eotThreshold`, `languageHints`), so
 *   `_CONFIGURE_FIELDS`, `_CONNECTION_FIELDS` and `_LOCAL_FIELDS` hold the
 *   camelCase names `_updateSettings()` reports. Wire names (query
 *   parameters, `Configure` keys) stay snake_case.
 * - Query values are written with JS number formatting, so a float with an
 *   integral value (`eot_threshold=1.0` upstream) is written `eot_threshold=1`.
 */

import {
  Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import {
  EagerEndOfTurnSTTServiceMixin,
  type EagerEndOfTurnSTTServiceMixinOptions,
} from "@pipedog/core/turns/eager_end_of_turn_mixin";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `urlencode({key: value})` for a single pair. */
function urlencode(key: string, value: unknown): string {
  return new URLSearchParams([[key, String(value)]]).toString();
}

/** Flux accepted the connection but never confirmed it was ready. */
export class FluxConnectionNotConfirmedError extends Error {
  override name = "FluxConnectionNotConfirmedError";
}

/**
 * Flux reported a fatal error and terminated the connection.
 *
 * - `code`: the error code Flux sent, e.g. `UNPARSABLE_CLIENT_MESSAGE`.
 */
export class FluxFatalError extends Error {
  override name = "FluxFatalError";
  code: string;

  /**
   * Initialize the error.
   *
   * @param message The formatted error message.
   * @param code The error code Flux sent.
   */
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Convert a Pipecat Language to a Deepgram Flux language code.
 *
 * Only honored by the `flux-general-multi` model. Locale variants (e.g.
 * `Language.EN_GB`) fall back to the base code.
 */
export function languageToDeepgramFluxLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FR]: "fr",
    [Language.HI]: "hi",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.NL]: "nl",
    [Language.PT]: "pt",
    [Language.RU]: "ru",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Convert a list of Pipecat Languages to Deepgram Flux codes.
 *
 * Drops entries that can't be mapped and deduplicates while preserving order.
 */
export function _prepareLanguageHints(hints: Language[] | null | undefined): string[] {
  if (!hints || hints.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const prepared: string[] = [];
  for (const hint of hints) {
    const code = languageToDeepgramFluxLanguage(hint);
    if (code === null || code === undefined || seen.has(code)) {
      continue;
    }
    seen.add(code);
    prepared.push(code);
  }
  return prepared;
}

/** Convert a Deepgram-returned language code to a Pipecat Language. */
function _codeToPipecatLanguage(code: string): Language | null {
  if (isLanguage(code)) {
    return code;
  }
  logger.debug(`Unmapped Deepgram Flux detected language code: ${code}`);
  return null;
}

/**
 * Deepgram Flux WebSocket message types.
 *
 * These are the top-level message types that can be received from the
 * Deepgram Flux WebSocket connection.
 */
export const FluxMessageType = {
  RECEIVE_CONNECTED: "Connected",
  RECEIVE_FATAL_ERROR: "Error",
  TURN_INFO: "TurnInfo",
  CONFIGURE_SUCCESS: "ConfigureSuccess",
  CONFIGURE_FAILURE: "ConfigureFailure",
} as const;
export type FluxMessageType = (typeof FluxMessageType)[keyof typeof FluxMessageType];

/**
 * Deepgram Flux TurnInfo event types.
 *
 * These events are contained within TurnInfo messages and indicate different
 * stages of speech processing and turn detection.
 */
export const FluxEventType = {
  START_OF_TURN: "StartOfTurn",
  TURN_RESUMED: "TurnResumed",
  END_OF_TURN: "EndOfTurn",
  EAGER_END_OF_TURN: "EagerEndOfTurn",
  UPDATE: "Update",
} as const;
export type FluxEventType = (typeof FluxEventType)[keyof typeof FluxEventType];

const FLUX_MESSAGE_TYPES = new Set<string>(Object.values(FluxMessageType));
const FLUX_EVENT_TYPES = new Set<string>(Object.values(FluxEventType));

export interface DeepgramFluxSTTSettingsOptions extends STTSettingsOptions {
  /** EagerEndOfTurn/TurnResumed threshold. Off by default. */
  eagerEotThreshold?: number | null | NotGiven;
  /** End-of-turn confidence required to finish a turn (default 0.7). */
  eotThreshold?: number | null | NotGiven;
  /** Time in ms after speech to finish a turn regardless of EOT confidence (default 5000). */
  eotTimeoutMs?: number | null | NotGiven;
  /** Keyterms to boost recognition accuracy for specialized terminology. */
  keyterm?: string[] | NotGiven;
  /** Minimum confidence required to create a TranscriptionFrame. */
  minConfidence?: number | null | NotGiven;
  /** Convert spoken numbers to numeral form. */
  numerals?: boolean | null | NotGiven;
  /** Mask recognized profanity in the transcript. */
  profanityFilter?: boolean | null | NotGiven;
  /** Remove sensitive numbers from the transcript: "numbers" or "aggressive_numbers". */
  redact?: string | null | NotGiven;
  /** Languages to bias transcription toward (`flux-general-multi` only). */
  languageHints?: Language[] | null | NotGiven;
}

/**
 * Settings for DeepgramFluxSTTService.
 *
 * - `eagerEotThreshold`: EagerEndOfTurn/TurnResumed threshold. Off by
 *   default. Lower values = more aggressive (faster response, more LLM
 *   calls). Higher values = more conservative (slower response, fewer LLM
 *   calls).
 * - `eotThreshold`: end-of-turn confidence required to finish a turn
 *   (default 0.7).
 * - `eotTimeoutMs`: time in ms after speech to finish a turn regardless of
 *   EOT confidence (default 5000).
 * - `keyterm`: keyterms to boost recognition accuracy for specialized
 *   terminology.
 * - `minConfidence`: minimum confidence required to create a
 *   TranscriptionFrame.
 * - `numerals`: convert spoken numbers to numeral form (e.g. "twenty three"
 *   → "23"). Can be updated mid-stream via `STTUpdateSettingsFrame`.
 * - `profanityFilter`: mask recognized profanity in the transcript. Can be
 *   updated mid-stream via `STTUpdateSettingsFrame`.
 * - `redact`: remove sensitive numbers from the transcript: `"numbers"` or
 *   `"aggressive_numbers"`. Read only from the connection URL, so an update
 *   is applied by reconnecting.
 * - `languageHints`: languages to bias transcription toward. Only honored by
 *   the `flux-general-multi` model. An empty list clears any active hints;
 *   `null`/`NOT_GIVEN` means no hints (auto-detect). Can be updated
 *   mid-stream via `STTUpdateSettingsFrame`.
 */
export class DeepgramFluxSTTSettings extends STTSettings {
  eagerEotThreshold: number | null | NotGiven = NOT_GIVEN;
  eotThreshold: number | null | NotGiven = NOT_GIVEN;
  eotTimeoutMs: number | null | NotGiven = NOT_GIVEN;
  keyterm: string[] | NotGiven = NOT_GIVEN;
  minConfidence: number | null | NotGiven = NOT_GIVEN;
  numerals: boolean | null | NotGiven = NOT_GIVEN;
  profanityFilter: boolean | null | NotGiven = NOT_GIVEN;
  redact: string | null | NotGiven = NOT_GIVEN;
  languageHints: Language[] | null | NotGiven = NOT_GIVEN;

  constructor(options: DeepgramFluxSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface DeepgramFluxSTTBaseOptions
  extends STTServiceOptions,
    EagerEndOfTurnSTTServiceMixinOptions {
  /** Audio encoding format. Must be "linear16". */
  encoding?: string;
  /** Opt out of the Deepgram Model Improvement Program. */
  mipOptOut?: boolean | null;
  /** Tags to label requests for identification during usage reporting. */
  tag?: string[] | null;
  /** Whether to interrupt the bot when Flux detects that the user is speaking. */
  shouldInterrupt?: boolean;
  /** Minimum idle timeout before sending silence to prevent dangling turns. */
  watchdogMinTimeout?: number;
  /** Fully resolved settings instance (built by concrete subclass). */
  settings: DeepgramFluxSTTSettings;
}

/**
 * Base class for Deepgram Flux STT services across transports.
 *
 * Contains all shared Flux protocol logic (message handling, turn detection,
 * metrics, settings). Concrete subclasses implement the transport layer by
 * providing three abstract primitives: `_transportSendAudio`,
 * `_transportSendJson`, and `_transportIsActive`.
 */
export abstract class DeepgramFluxSTTBase extends EagerEndOfTurnSTTServiceMixin(STTService) {
  static Settings: typeof DeepgramFluxSTTSettings = DeepgramFluxSTTSettings;
  declare protected _settings: DeepgramFluxSTTSettings;

  static readonly _CONFIGURE_FIELDS: ReadonlySet<string> = new Set([
    "keyterm",
    "eotThreshold",
    "eagerEotThreshold",
    "eotTimeoutMs",
    "languageHints",
    "numerals",
    "profanityFilter",
  ]);
  /** Fields Flux only accepts in the connection URL, so changing them reconnects. */
  static readonly _CONNECTION_FIELDS: ReadonlySet<string> = new Set(["model", "redact"]);
  /** Fields applied to results as they arrive, so no connection change is needed. */
  static readonly _LOCAL_FIELDS: ReadonlySet<string> = new Set(["minConfidence"]);
  static readonly _MULTILINGUAL_MODEL: string = "flux-general-multi";
  /**
   * How long to wait for Flux to confirm a new connection. An endpoint that
   * rejects a connection parameter sends neither a Connected message nor an
   * error, so the wait needs a bound.
   */
  static _CONNECTION_TIMEOUT = 10.0;
  /**
   * Flux error codes whose cause a retry cannot clear. Rejected credentials
   * don't appear here: those fail the HTTP handshake and are classified from
   * its status code, never reaching a Flux error message. Anything not listed
   * falls back to the default classification, leaving recovery to the
   * service's own reconnect handling.
   */
  static readonly _ERROR_CODE_CATEGORIES: Readonly<Record<string, ErrorCategory>> = {
    UNPARSABLE_CLIENT_MESSAGE: ErrorCategory.INVALID_REQUEST,
  };
  /**
   * Threshold applied when eager end of turn is enabled without one. Flux
   * reports a prediction only above this confidence: lower is more eager
   * (faster responses, more discarded inferences), higher more conservative.
   */
  static _DEFAULT_EAGER_EOT_THRESHOLD = 0.5;
  /**
   * How long an in-flight Configure is trusted before a new update supersedes
   * it outright. Flux caps the number of un-acked Configure messages, so at
   * most one is ever in flight; this bounds how long a missing ack can block
   * later updates from ever being sent.
   */
  static _CONFIGURE_ACK_TIMEOUT = 5.0;

  static {
    installTracedStt(DeepgramFluxSTTBase.prototype, "_handleTranscription");
  }

  protected _encoding: string;
  protected _mipOptOut: boolean | null;
  protected _tag: string[];
  protected _shouldInterrupt: boolean;
  protected _watchdogMinTimeout: number;

  /** Connection readiness: Flux sends a "Connected" message when ready. */
  protected _connectionEstablishedEvent = new Event();

  // Configure serialization: Flux caps the number of un-acked Configure
  // messages, so we only allow one in flight at a time. A Configure sent
  // while one is already in flight is coalesced into
  // `_configurePendingFields` instead, and sent once the in-flight one is
  // acked (see `_onConfigureAcked`) — only the latest settings matter, so
  // there's no need to replay every intermediate update.
  protected _configureInFlight = false;
  protected _configureSentAt: number | null = null;
  protected _configurePendingFields: Set<string> | null = null;

  // Watchdog state — see _watchdogTaskHandler for details
  protected _lastSttTime: number | null = null;
  protected _watchdogTask: Task<unknown> | null = null;
  protected _userIsSpeaking = false;
  protected _lastAudioChunkDuration = 0.0;
  // The turn so far, from its latest Update, for a turn whose connection
  // closes before EndOfTurn (see _endTurnCutShort).
  protected _turnTranscript = "";
  protected _turnLanguage: Language | null = null;

  /**
   * Initialize the Deepgram Flux STT base service.
   *
   * @param options.encoding Audio encoding format. Must be "linear16".
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program.
   * @param options.tag Tags to label requests for identification during
   *   usage reporting.
   * @param options.shouldInterrupt Whether to interrupt the bot when Flux
   *   detects that the user is speaking. Passed along to the user turn
   *   strategies this service recommends, which own the interruption; a
   *   user-supplied `userTurnStrategies` overrides the recommendation and
   *   this setting with it.
   * @param options.watchdogMinTimeout Minimum idle timeout before sending
   *   silence to prevent dangling turns. The actual threshold is
   *   `max(chunkDuration * 2, watchdogMinTimeout)`. Defaults to 0.5.
   * @param options.enableEagerEndOfTurn Whether to answer Flux's predicted
   *   end of turn ahead of the committed one, so the gap between the two is
   *   spent generating a response rather than waiting. Off by default: it
   *   spends an inference on every prediction, including the ones Flux
   *   withdraws. Turning it on sets `eagerEotThreshold` to
   *   `_DEFAULT_EAGER_EOT_THRESHOLD` when the settings leave it unset, since
   *   Flux reports no prediction without it.
   * @param options.settings Fully resolved settings instance (built by
   *   concrete subclass).
   *   Other options are passed to the parent STTService (e.g. `sampleRate`).
   */
  constructor(options: DeepgramFluxSTTBaseOptions) {
    const baseOptions: DeepgramFluxSTTBaseOptions = {
      ...options,
      enableEagerEndOfTurn: options.enableEagerEndOfTurn ?? false,
    };
    super(baseOptions);

    const cls = this.constructor as typeof DeepgramFluxSTTBase;

    // Flux reports no prediction unless a threshold asks for one, so an
    // unconfigured threshold would leave the feature silently inert.
    if (this.eagerEndOfTurnEnabled && this._settings.eagerEotThreshold === null) {
      this._settings.eagerEotThreshold = cls._DEFAULT_EAGER_EOT_THRESHOLD;
    }

    this._encoding = options.encoding ?? "linear16";
    this._mipOptOut = options.mipOptOut ?? null;
    this._tag = options.tag ?? [];
    this._shouldInterrupt = options.shouldInterrupt ?? true;
    this._watchdogMinTimeout = options.watchdogMinTimeout ?? 0.5;

    // Flux event handlers
    this._registerEventHandler("on_start_of_turn");
    this._registerEventHandler("on_turn_resumed");
    this._registerEventHandler("on_end_of_turn");
    this._registerEventHandler("on_eager_end_of_turn");
    this._registerEventHandler("on_update");
  }

  /** The class of this instance, for its class-level configuration. */
  protected get _cls(): typeof DeepgramFluxSTTBase {
    return this.constructor as typeof DeepgramFluxSTTBase;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Deepgram Flux service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Recommend turn strategies that leave turn detection to Flux.
   *
   * Flux emits its own start-of-turn and end-of-turn events (as
   * `ProposedUserStarted/StoppedSpeakingFrame`), so the user aggregator
   * resolves those rather than running local VAD/smart-turn. With
   * `enableEagerEndOfTurn`, the recommendation also answers Flux's predicted
   * end of turn. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    frame.userTurnStrategies = this.recommendedUserTurnStrategies({
      enableInterruptions: this._shouldInterrupt,
    });
    return frame;
  }

  // ------------------------------------------------------------------
  // Abstract transport interface — implemented by each concrete subclass
  // ------------------------------------------------------------------

  /** Send raw audio bytes over the transport. */
  abstract _transportSendAudio(audio: Uint8Array): Promise<void>;

  /** Serialize and send a JSON control message over the transport. */
  abstract _transportSendJson(message: Dict): Promise<void>;

  /** Return true if the transport connection is currently active. */
  abstract _transportIsActive(): boolean;

  /** Establish the transport connection. */
  abstract _connect(): Promise<void>;

  /** Tear down the transport connection. */
  abstract _disconnect(): Promise<void>;

  // ------------------------------------------------------------------
  // Connection helpers
  // ------------------------------------------------------------------

  /**
   * Tear down the transport connection and re-establish it.
   *
   * Called by `STTService._reconnect()` inside the reconnecting guard.
   */
  protected override async _doReconnect(): Promise<void> {
    await this._disconnect();
    await this._connect();
  }

  /**
   * Classify the failures Flux signals in its own protocol.
   *
   * Flux reports these over the connection rather than as an HTTP status, so
   * they carry nothing the default classification can read.
   *
   * @param exception The exception to classify.
   * @returns The category, or null to fall back to the default
   *   classification.
   */
  protected override _classifyError(exception: unknown): ErrorCategory | null {
    if (exception instanceof FluxConnectionNotConfirmedError) {
      // Raised by the SageMaker transport, whose endpoint can leave a session
      // for a rejected setting open without confirming it, so an unconfirmed
      // session means the request was rejected, not that the network was
      // slow.
      return ErrorCategory.INVALID_REQUEST;
    }
    if (exception instanceof FluxFatalError) {
      return this._cls._ERROR_CODE_CATEGORIES[exception.code] ?? null;
    }
    return null;
  }

  /**
   * Wait for Flux to confirm the connection is ready.
   *
   * @throws FluxConnectionNotConfirmedError if no confirmation arrives within
   *   `_CONNECTION_TIMEOUT`.
   */
  protected async _awaitConnectionEstablished(): Promise<void> {
    const connectionTimeout = this._cls._CONNECTION_TIMEOUT;
    try {
      await waitFor(() => this._connectionEstablishedEvent.wait(), connectionTimeout);
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new FluxConnectionNotConfirmedError(
          `Flux did not confirm the connection within ${connectionTimeout}s; ` +
            "the endpoint may not accept the current connection settings",
        );
      }
      throw e;
    }
  }

  /** Build query string from current settings and init-only connection config. */
  protected _buildQueryString(): string {
    const params = [
      `model=${this._settings.model}`,
      `sample_rate=${this.sampleRate}`,
      `encoding=${this._encoding}`,
    ];

    if (this._settings.eagerEotThreshold !== null) {
      params.push(`eager_eot_threshold=${this._settings.eagerEotThreshold}`);
    }

    if (this._settings.eotThreshold !== null) {
      params.push(`eot_threshold=${this._settings.eotThreshold}`);
    }

    if (this._settings.eotTimeoutMs !== null) {
      params.push(`eot_timeout_ms=${this._settings.eotTimeoutMs}`);
    }

    if (this._settings.numerals !== null) {
      params.push(`numerals=${String(this._settings.numerals)}`);
    }

    if (this._settings.profanityFilter !== null) {
      params.push(`profanity_filter=${String(this._settings.profanityFilter)}`);
    }

    if (this._settings.redact !== null) {
      params.push(urlencode("redact", this._settings.redact));
    }

    if (this._mipOptOut !== null) {
      params.push(`mip_opt_out=${String(this._mipOptOut)}`);
    }

    // Add keyterm parameters (can have multiple)
    for (const keyterm of assertGiven(this._settings.keyterm)) {
      params.push(urlencode("keyterm", keyterm));
    }

    // Add tag parameters (can have multiple)
    for (const tagValue of this._tag) {
      params.push(urlencode("tag", tagValue));
    }

    // Add language_hint parameters (only valid on flux-general-multi)
    const hints = this._settings.languageHints;
    if (hints && isGiven(hints) && hints.length > 0) {
      if (this._settings.model === this._cls._MULTILINGUAL_MODEL) {
        for (const code of _prepareLanguageHints(hints)) {
          params.push(urlencode("language_hint", code));
        }
      } else {
        logger.warning(
          `language_hints only supported on ${this._cls._MULTILINGUAL_MODEL}; ` +
            `ignoring hints for model '${this._settings.model}'`,
        );
      }
    }

    return params.join("&");
  }

  /** Send a block of silence of the specified duration (default 500 ms). */
  protected async _sendSilence(durationSecs = 0.5): Promise<void> {
    const sampleWidth = 2; // bytes per sample for 16-bit PCM
    const numChannels = 1; // mono
    const numSamples = Math.trunc(this.sampleRate * durationSecs);
    const silence = new Uint8Array(numSamples * sampleWidth * numChannels);
    await this._transportSendAudio(silence);
    // Watchdog silence is real audio submitted to the service, so it counts
    // toward usage.
    this._recordSttAudioUsage(silence);
  }

  /**
   * Prevent dangling turns by sending silence when audio stops flowing.
   *
   * If we stop sending audio to Flux after receiving a StartOfTurn, we never
   * receive the UserStoppedSpeaking event unless we resume sending audio.
   */
  protected async _watchdogTaskHandler(): Promise<void> {
    while (this._transportIsActive()) {
      const now = monotonic();
      // Send silence if we go more than 500 ms or twice the chunk size
      // without sending new audio to Flux.
      const threshold = Math.max(this._lastAudioChunkDuration * 2, this._watchdogMinTimeout);
      if (this._userIsSpeaking && this._lastSttTime && now - this._lastSttTime > threshold) {
        logger.warning(
          `No audio received for ${(threshold * 1000).toFixed(0)} ms. Sending silence to Flux to prevent a dangling task`,
        );
        try {
          await this._sendSilence();
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Failed to send silence: ${errorMessage(e)}`);
        }
        this._lastSttTime = monotonic();
      }
      // check every 100ms
      await sleep(0.1);
    }
  }

  /**
   * Sends a CloseStream control message to Deepgram Flux.
   *
   * This signals to the server that no more audio data will be sent.
   */
  protected async _sendCloseStream(): Promise<void> {
    try {
      if (this._transportIsActive()) {
        logger.debug("Sending CloseStream message to Deepgram Flux");
        await this._transportSendJson({ type: "CloseStream" });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error sending CloseStream: ${errorMessage(e)}`, { exception: e });
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /**
   * Stop the Deepgram Flux STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Deepgram Flux STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release Deepgram Flux STT resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /**
   * Send a Configure control message to update settings mid-stream.
   *
   * Builds a Configure JSON message containing only the fields that changed
   * and sends it over the existing connection.
   *
   * At most one Configure is ever in flight, since Flux caps the number of
   * un-acked Configure messages. If one is already in flight, `fields` is
   * merged into the pending set and sent once the in-flight one is acked (see
   * `_onConfigureAcked`) instead of being sent now — the message is always
   * built from the current settings, so only the latest values ever need to
   * go out. An in-flight Configure older than `_CONFIGURE_ACK_TIMEOUT` is
   * treated as lost so a missing ack can't permanently block later updates.
   *
   * @param fields Set of changed field names to include in the message.
   */
  protected async _sendConfigure(fields: ReadonlySet<string>): Promise<void> {
    const ackTimeout = this._cls._CONFIGURE_ACK_TIMEOUT;
    if (this._configureInFlight) {
      if (this._configureSentAt === null) {
        throw new Error("AssertionError: _configureSentAt must be set");
      }
      if (monotonic() - this._configureSentAt < ackTimeout) {
        this._configurePendingFields = new Set([
          ...(this._configurePendingFields ?? []),
          ...fields,
        ]);
        return;
      }
      logger.warning(
        `${this}: timed out after ${ackTimeout}s waiting for ` +
          "Configure ack; sending the next Configure anyway",
      );
    }

    const message: Dict = { type: "Configure" };

    if (fields.has("keyterm")) {
      message.keyterms = this._settings.keyterm;
    }

    if (fields.has("numerals")) {
      message.numerals = this._settings.numerals;
    }

    if (fields.has("profanityFilter")) {
      message.profanity_filter = this._settings.profanityFilter;
    }

    const thresholds: Dict = {};
    if (fields.has("eotThreshold")) {
      thresholds.eot_threshold = this._settings.eotThreshold;
    }
    if (fields.has("eagerEotThreshold")) {
      thresholds.eager_eot_threshold = this._settings.eagerEotThreshold;
    }
    if (fields.has("eotTimeoutMs")) {
      thresholds.eot_timeout_ms = this._settings.eotTimeoutMs;
    }
    if (Object.keys(thresholds).length > 0) {
      message.thresholds = thresholds;
    }

    if (fields.has("languageHints")) {
      if (this._settings.model !== this._cls._MULTILINGUAL_MODEL) {
        logger.warning(
          `language_hints only supported on ${this._cls._MULTILINGUAL_MODEL}; ` +
            `skipping Configure update for model '${this._settings.model}'`,
        );
      } else {
        const hints = this._settings.languageHints;
        // Empty list clears hints; NOT_GIVEN/null also treated as clear since
        // we only reach this branch when the user set the field.
        if (hints === null || !isGiven(hints)) {
          message.language_hints = [];
        } else {
          message.language_hints = _prepareLanguageHints(hints);
        }
      }
    }

    this._configureInFlight = true;
    this._configureSentAt = monotonic();
    logger.debug(`${this}: sending Configure message: ${pyJsonDumps(message)}`);
    await this._transportSendJson(message);
  }

  /**
   * Mark the in-flight Configure as acked and flush any pending update.
   *
   * Called when a ConfigureSuccess/ConfigureFailure arrives. If fields were
   * coalesced into `_configurePendingFields` while this Configure was in
   * flight, immediately sends a follow-up Configure covering all of them —
   * unless the transport has since gone inactive, in which case the pending
   * fields are simply dropped, since a reconnect re-applies current settings
   * via the connection URL anyway. Safe to call with nothing in flight (e.g.
   * a stray/duplicate ack), which is a no-op.
   */
  protected async _onConfigureAcked(): Promise<void> {
    this._configureInFlight = false;
    this._configureSentAt = null;
    if (this._configurePendingFields !== null) {
      const fields = this._configurePendingFields;
      this._configurePendingFields = null;
      if (this._transportIsActive()) {
        await this._sendConfigure(fields);
      }
    }
  }

  /**
   * Clear Configure-serialization state during teardown.
   *
   * Called when the connection is torn down (including ahead of a
   * reconnect), since any in-flight or pending Configure can no longer be
   * acked or sent on a dead connection. A reconnect re-applies the current
   * settings via the connection URL, so nothing needs to be replayed.
   */
  protected _resetConfigureState(): void {
    this._configureInFlight = false;
    this._configureSentAt = null;
    this._configurePendingFields = null;
  }

  /**
   * Apply a settings delta.
   *
   * Fields in `_CONFIGURE_FIELDS` are sent to Deepgram via a Configure
   * message. Fields Flux only reads from the connection URL trigger a
   * reconnect, which waits until the user stops speaking.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    const changedKeys = Object.keys(changed);
    if (changedKeys.length === 0) {
      return changed;
    }

    const cls = this._cls;
    const configureFields = new Set(changedKeys.filter((k) => cls._CONFIGURE_FIELDS.has(k)));
    if (configureFields.size > 0 && this._transportIsActive()) {
      await this._sendConfigure(configureFields);
    }

    if (changedKeys.some((k) => cls._CONNECTION_FIELDS.has(k))) {
      await this._requestReconnect();
    }

    this._warnUnhandledUpdatedSettings(
      changedKeys.filter(
        (k) =>
          !cls._CONFIGURE_FIELDS.has(k) &&
          !cls._CONNECTION_FIELDS.has(k) &&
          !cls._LOCAL_FIELDS.has(k),
      ),
    );

    return changed;
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  /**
   * Validate basic message structure from Deepgram Flux.
   *
   * Ensures the received message has the expected structure before
   * processing.
   *
   * @param data The parsed JSON message data to validate.
   * @returns True if the message structure is valid, false otherwise.
   */
  protected _validateMessage(data: unknown): data is Dict {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      logger.warning("Message is not a dictionary");
      return false;
    }

    if (!("type" in data)) {
      logger.warning("Message missing 'type' field");
      return false;
    }

    return true;
  }

  /**
   * Handle a parsed message from Deepgram Flux.
   *
   * Routes messages to appropriate handlers based on their type. Validates
   * message structure before processing.
   *
   * @param data The parsed JSON message data.
   */
  protected async _handleMessage(data: unknown): Promise<void> {
    if (!this._validateMessage(data)) {
      return;
    }

    const messageType = data.type;

    if (typeof messageType !== "string" || !FLUX_MESSAGE_TYPES.has(messageType)) {
      logger.debug(`Unhandled message type: ${messageType || "unknown"}`);
      return;
    }

    switch (messageType as FluxMessageType) {
      case FluxMessageType.RECEIVE_CONNECTED:
        await this._handleConnectionEstablished(data);
        break;
      case FluxMessageType.RECEIVE_FATAL_ERROR:
        await this._handleFatalError(data);
        break;
      case FluxMessageType.TURN_INFO:
        await this._handleTurnInfo(data);
        break;
      case FluxMessageType.CONFIGURE_SUCCESS:
        logger.info(`${this}: Configure accepted: ${pyJsonDumps(data)}`);
        await this._onConfigureAcked();
        break;
      case FluxMessageType.CONFIGURE_FAILURE: {
        const errorCode = data.error_code ?? "unknown";
        const description = data.description ?? "no description";
        const errorMsg = `Configure rejected: [${errorCode}] ${description}`;
        logger.warning(`${this}: ${errorMsg}`);
        await this._onConfigureAcked();
        await this.pushError(errorMsg);
        break;
      }
    }
  }

  /**
   * Handle successful connection establishment to Deepgram Flux.
   *
   * This event is fired when the connection to Deepgram Flux is successfully
   * established and ready to receive audio data for transcription
   * processing.
   */
  protected async _handleConnectionEstablished(data: Dict): Promise<void> {
    const requestId = data.request_id ?? null;
    logger.info(
      `${this}: Connected to Flux - ready to stream audio (request_id=${requestId === null ? "None" : `'${requestId}'`})`,
    );
    // Notify connection is established
    this._connectionEstablishedEvent.set();
  }

  /**
   * Handle fatal error messages from Deepgram Flux.
   *
   * Fatal errors indicate unrecoverable issues with the connection or
   * configuration that require intervention. These errors will cause the
   * connection to be terminated.
   *
   * @param data The error message data containing error details.
   * @throws FluxFatalError always, to trigger error handling in the
   *   transport layer.
   */
  protected async _handleFatalError(data: Dict): Promise<void> {
    const errorCode = data.code ?? "unknown";
    const description = data.description ?? "no description";
    const deepgramError = `${this}: Fatal error [${errorCode}] ${description}`;
    logger.error(deepgramError);
    // Error will be handled by the transport's receive loop error handler
    throw new FluxFatalError(deepgramError, errorCode);
  }

  /**
   * Handle TurnInfo events from Deepgram Flux.
   *
   * TurnInfo messages contain various turn-based events that indicate the
   * state of speech processing, including turn boundaries, interim results,
   * and turn finalization events.
   *
   * @param data The TurnInfo message data containing event type, transcript
   *   and some extra metadata.
   */
  protected async _handleTurnInfo(data: Dict): Promise<void> {
    const event = data.event;
    const transcript: string = data.transcript ?? "";

    if (typeof event !== "string") {
      logger.debug(`Unhandled TurnInfo event (not a string): ${event}`);
      return;
    }

    if (!FLUX_EVENT_TYPES.has(event)) {
      logger.debug(`Unhandled TurnInfo event: ${event}`);
      return;
    }

    switch (event as FluxEventType) {
      case FluxEventType.START_OF_TURN:
        await this._handleStartOfTurn(transcript);
        break;
      case FluxEventType.TURN_RESUMED:
        await this._handleTurnResumed(event);
        break;
      case FluxEventType.END_OF_TURN:
        await this._handleEndOfTurn(transcript, data);
        break;
      case FluxEventType.EAGER_END_OF_TURN:
        await this._handleEagerEndOfTurn(transcript, data);
        break;
      case FluxEventType.UPDATE:
        await this._handleUpdate(transcript, data);
        break;
    }
  }

  /**
   * Handle StartOfTurn events from Deepgram Flux.
   *
   * StartOfTurn events are fired when Deepgram Flux detects the beginning of
   * a new speaking turn.
   *
   * The service will:
   * - Propose a turn start, which the user turn strategies resolve into a
   *   UserStartedSpeakingFrame and an interruption
   *
   * @param transcript Maybe the first few words of the turn.
   */
  protected async _handleStartOfTurn(transcript: string): Promise<void> {
    logger.debug("User started speaking");
    this._userIsSpeaking = true;
    this._turnTranscript = transcript;
    this._turnLanguage = null;
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
    await this._callEventHandler("on_start_of_turn", transcript);
    if (transcript) {
      logger.trace(`Start of turn transcript: ${transcript}`);
    }
  }

  /**
   * Handle TurnResumed events from Deepgram Flux.
   *
   * TurnResumed events indicate that speech has resumed after a brief pause
   * within the same turn, which withdraws the EagerEndOfTurn that preceded
   * it: whatever was generated from that prediction no longer answers the
   * turn the user is still speaking.
   *
   * @param event The event type string for logging purposes.
   */
  protected async _handleTurnResumed(event: string): Promise<void> {
    logger.trace(`Received event TurnResumed: ${event}`);
    await this._cancelEagerEndOfTurn();
    await this._callEventHandler("on_turn_resumed");
  }

  /**
   * Calculate the average confidence from transcript data.
   *
   * Return null if the data is missing or invalid.
   */
  protected _calculateAverageConfidence(transcriptData: Dict): number | null {
    // Example: Assume transcriptData has a list of words with confidence
    const words = transcriptData.words;
    if (!words || !Array.isArray(words) || words.length === 0) {
      return null;
    }
    const confidences: number[] = words
      .map((w: Dict) => w?.confidence)
      .filter((c: unknown): c is number => typeof c === "number");
    if (confidences.length === 0) {
      return null;
    }
    return confidences.reduce((a, b) => a + b, 0) / confidences.length;
  }

  /**
   * Extract the primary detected language from a TurnInfo payload.
   *
   * On `flux-general-multi` the language is read from TurnInfo's `languages`
   * field. On `flux-general-en` the field is absent, so we fall back to
   * `Language.EN` to match the model's fixed language.
   */
  protected _primaryDetectedLanguage(data: Dict): Language | null {
    const codes: unknown[] = data.languages || [];
    if (codes.length > 0) {
      return _codeToPipecatLanguage(String(codes[0]));
    }
    if (this._settings.model === "flux-general-en") {
      return Language.EN;
    }
    return null;
  }

  /**
   * Handle EndOfTurn events from Deepgram Flux.
   *
   * EndOfTurn events are fired when Deepgram Flux determines that a speaking
   * turn has concluded, either due to sufficient silence or end-of-turn
   * confidence thresholds being met. This provides the final transcript for
   * the completed turn.
   *
   * The service will:
   * - Create and send a final TranscriptionFrame with the complete transcript
   * - Trigger transcription handling with tracing for metrics
   * - Propose a turn stop, which the user turn strategies resolve into a
   *   UserStoppedSpeakingFrame
   *
   * @param transcript The final transcript text for the completed turn.
   * @param data The TurnInfo message data containing event type, transcript
   *   and some extra metadata.
   */
  protected async _handleEndOfTurn(transcript: string, data: Dict): Promise<void> {
    logger.debug("User stopped speaking");
    this._userIsSpeaking = false;
    this._turnTranscript = "";
    // The turn is committed, so any eager prediction it followed is resolved.
    this._clearEagerEndOfTurn();

    // Compute the average confidence
    const averageConfidence = this._calculateAverageConfidence(data);
    const detectedLanguage = this._primaryDetectedLanguage(data);

    const minConfidence = assertGiven(this._settings.minConfidence);
    // No threshold (null or 0.0) → accept. Otherwise require confidence data
    // and compare; drop if data is missing.
    if (!minConfidence || (averageConfidence !== null && averageConfidence > minConfidence)) {
      // Report usage before the transcription frame so tracing can attach it
      // to the STT span the frame closes.
      await this.emitSttUsageMetrics();
      // EndOfTurn means Flux has determined the turn is complete, so this
      // TranscriptionFrame is always finalized
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: detectedLanguage,
          result: data,
          finalized: true,
        }),
      );
    } else {
      logger.warning(
        `Transcription confidence below min_confidence threshold: ${averageConfidence === null ? "None" : averageConfidence}`,
      );
    }

    await this._handleTranscription(transcript, true, detectedLanguage);
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    await this._callEventHandler("on_end_of_turn", transcript);
  }

  /**
   * Handle EagerEndOfTurn events from Deepgram Flux.
   *
   * EagerEndOfTurn events are fired when the end-of-turn confidence reaches
   * the EagerEndOfTurn threshold but hasn't yet reached the full end-of-turn
   * threshold, so a response can be generated during the gap.
   *
   * The prediction may not hold: the user may resume speaking, or the
   * committed transcript may differ from this one. Pair the service with
   * `EagerUserTurnStrategies` to have a response generated here and
   * discarded if either happens.
   *
   * @param transcript The predicted transcript for the turn.
   * @param data The TurnInfo message data containing event type, transcript
   *   and some extra metadata.
   */
  protected async _handleEagerEndOfTurn(transcript: string, data: Dict): Promise<void> {
    await this._pushEagerEndOfTurn(transcript, {
      userId: this._userId,
      language: this._primaryDetectedLanguage(data),
      result: data,
    });
    await this._callEventHandler("on_eager_end_of_turn", transcript);
  }

  /**
   * End a turn whose connection closed before Flux sent EndOfTurn.
   *
   * A Flux turn lives in one connection, so a new connection never ends the
   * old one's turn. The transcript received so far is pushed as the turn's
   * transcription, unfinalized since Flux never committed it, and the turn
   * stop is proposed. If the user keeps talking on a new connection, the rest
   * is transcribed as a new turn.
   */
  protected async _endTurnCutShort(): Promise<void> {
    if (!this._userIsSpeaking) {
      return;
    }
    logger.debug(`${this}: connection closed mid-turn, ending the turn`);
    this._userIsSpeaking = false;
    this._clearEagerEndOfTurn();
    const transcript = this._turnTranscript;
    this._turnTranscript = "";
    if (transcript) {
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: this._turnLanguage,
        }),
      );
    }
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Handle Update events from Deepgram Flux.
   *
   * Update events provide incremental transcript updates during an ongoing
   * turn. Each one is pushed as an InterimTranscriptionFrame holding the
   * transcript of the turn so far.
   *
   * @param transcript The current partial transcript text for the ongoing
   *   turn.
   * @param data The TurnInfo message data containing event type, transcript
   *   and some extra metadata.
   */
  protected async _handleUpdate(transcript: string, data: Dict): Promise<void> {
    if (transcript) {
      logger.trace(`Update event: ${transcript}`);
      this._turnTranscript = transcript;
      this._turnLanguage = this._primaryDetectedLanguage(data);
      // TTFB (Time To First Byte) metrics are currently disabled for Deepgram
      // Flux. Ideally, TTFB should measure the time from when a user starts
      // speaking until we receive the first transcript. However, Deepgram Flux
      // delivers both the "user started speaking" event and the first
      // transcript simultaneously, making this timing measurement meaningless
      // in this context.
      // await this.stopTtfbMetrics();
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: this._primaryDetectedLanguage(data),
          result: data,
        }),
      );
      await this._callEventHandler("on_update", transcript);
    }
  }
}
