// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/soniox/stt.py

/**
 * Soniox speech-to-text service implementation.
 *
 * Wire format: Soniox real-time STT WebSocket API,
 * https://soniox.com/docs/stt/api-reference/websocket-api (start message,
 * binary audio frames, empty text frame as end of audio, `finished` /
 * `error_code` responses), https://soniox.com/docs/stt/rt/manual-finalization
 * (`{"type": "finalize"}` and the `<fin>` token) and
 * https://soniox.com/docs/stt/rt/connection-keepalive (`{"type": "keepalive"}`).
 * Checked against the docs on 2026-10-22; the `<end>` token and the way
 * upstream reads it are not on those pages and come from upstream's code.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (core's
 *   `websocketConnect`), with `Authorization: Bearer <key>` on the opening
 *   handshake (sent through `fetch` on Cloudflare Workers).
 * - Deprecated APIs are not ported: `SonioxInputParams`, and the `model` and
 *   `params` constructor parameters.
 * - `SonioxContextObject` is a class with a `modelDump()` that produces
 *   Pydantic's `model_dump()` (snake_case keys, nulls kept), so the context
 *   goes over the wire exactly as upstream sends it.
 */

import { rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { SONIOX_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { classifyErrorCode } from "./errors.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const KEEPALIVE_MESSAGE = '{"type": "keepalive"}';

export const FINALIZE_MESSAGE = '{"type": "finalize"}';

export const END_TOKEN = "<end>";

export const FINALIZED_TOKEN = "<fin>";

/** Represents a key-value pair for structured general context information. */
export interface SonioxContextGeneralItem {
  key: string;
  value: string;
}

/** Represents a custom translation mapping for ambiguous or domain-specific terms. */
export interface SonioxContextTranslationTerm {
  source: string;
  target: string;
}

export interface SonioxContextObjectOptions {
  general?: SonioxContextGeneralItem[] | null;
  text?: string | null;
  terms?: string[] | null;
  translationTerms?: SonioxContextTranslationTerm[] | null;
}

/**
 * Structured context that steers transcription and translation.
 *
 * Every section is optional; supply only the ones that are relevant. Soniox
 * caps the whole object at 8k tokens.
 *
 * Learn more about context in the documentation:
 * https://soniox.com/docs/stt/concepts/context
 */
export class SonioxContextObject {
  general: SonioxContextGeneralItem[] | null;
  text: string | null;
  terms: string[] | null;
  translationTerms: SonioxContextTranslationTerm[] | null;

  constructor(options: SonioxContextObjectOptions = {}) {
    this.general = options.general ?? null;
    this.text = options.text ?? null;
    this.terms = options.terms ?? null;
    this.translationTerms = options.translationTerms ?? null;
  }

  /** The wire form, equal to Pydantic's `model_dump()` (snake_case keys, nulls kept). */
  modelDump(): Dict {
    return {
      general: this.general === null ? null : this.general.map((i) => ({ ...i })),
      text: this.text,
      terms: this.terms === null ? null : [...this.terms],
      translation_terms:
        this.translationTerms === null ? null : this.translationTerms.map((t) => ({ ...t })),
    };
  }
}

/** Determine if a token is an end token. */
export function isEndToken(token: Dict): boolean {
  return token.text === END_TOKEN || token.text === FINALIZED_TOKEN;
}

/**
 * Convert a pipedog Language to a Soniox language code.
 *
 * For a list of all supported languages, see:
 * https://soniox.com/docs/speech-to-text/core-concepts/supported-languages
 */
export function languageToSonioxLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "af",
    [Language.AR]: "ar",
    [Language.AZ]: "az",
    [Language.BE]: "be",
    [Language.BG]: "bg",
    [Language.BN]: "bn",
    [Language.BS]: "bs",
    [Language.CA]: "ca",
    [Language.CS]: "cs",
    [Language.CY]: "cy",
    [Language.DA]: "da",
    [Language.DE]: "de",
    [Language.EL]: "el",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.ET]: "et",
    [Language.EU]: "eu",
    [Language.FA]: "fa",
    [Language.FI]: "fi",
    [Language.FR]: "fr",
    [Language.GL]: "gl",
    [Language.GU]: "gu",
    [Language.HE]: "he",
    [Language.HI]: "hi",
    [Language.HR]: "hr",
    [Language.HU]: "hu",
    [Language.ID]: "id",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KK]: "kk",
    [Language.KN]: "kn",
    [Language.KO]: "ko",
    [Language.LT]: "lt",
    [Language.LV]: "lv",
    [Language.MK]: "mk",
    [Language.ML]: "ml",
    [Language.MR]: "mr",
    [Language.MS]: "ms",
    [Language.NB]: "no",
    [Language.NL]: "nl",
    [Language.NO]: "no",
    [Language.PA]: "pa",
    [Language.PL]: "pl",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SK]: "sk",
    [Language.SL]: "sl",
    [Language.SQ]: "sq",
    [Language.SR]: "sr",
    [Language.SV]: "sv",
    [Language.SW]: "sw",
    [Language.TA]: "ta",
    [Language.TE]: "te",
    [Language.TH]: "th",
    [Language.TL]: "tl",
    [Language.TR]: "tr",
    [Language.UK]: "uk",
    [Language.UR]: "ur",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

function _prepareLanguageHints(languageHints: Language[] | null): string[] | null {
  if (languageHints === null) {
    return null;
  }

  const prepared = languageHints.map((lang) => languageToSonioxLanguage(lang));
  // Remove duplicates (in case of language_hints with multiple regions).
  return Array.from(new Set(prepared));
}

/** The language most tokens carry, or null; the first one reaching the top count wins a tie. */
export function _languageFromTokens(tokens: Dict[]): Language | null {
  const counts = new Map<Language, number>();

  for (const token of tokens) {
    const language = token.language;
    if (!language) {
      continue;
    }
    if (typeof language === "string" && isLanguage(language)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }

  let best: Language | null = null;
  let bestCount = 0;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }
  return best;
}

export interface SonioxSTTSettingsOptions extends STTSettingsOptions {
  languageHints?: Language[] | null | NotGiven;
  languageHintsStrict?: boolean | null | NotGiven;
  context?: SonioxContextObject | string | null | NotGiven;
  enableSpeakerDiarization?: boolean | null | NotGiven;
  enableLanguageIdentification?: boolean | null | NotGiven;
  maxEndpointDelayMs?: number | null | NotGiven;
  endpointSensitivity?: number | null | NotGiven;
  endpointLatencyAdjustmentLevel?: number | null | NotGiven;
  clientReferenceId?: string | null | NotGiven;
}

/**
 * Settings for SonioxSTTService.
 *
 * - `languageHints`: list of language hints to use for transcription.
 * - `languageHintsStrict`: if true, strictly enforce language hints.
 * - `context`: customization for transcription. Either a
 *   `SonioxContextObject` or a plain string of background text.
 * - `enableSpeakerDiarization`: whether to enable speaker diarization.
 * - `enableLanguageIdentification`: whether to enable language identification.
 * - `maxEndpointDelayMs`: max ms before endpoint detection finalizes the turn (500-3000).
 * - `endpointSensitivity`: endpoint detection sensitivity (-1.0 to 1.0); higher finalizes sooner.
 * - `endpointLatencyAdjustmentLevel`: reduces endpoint latency vs. the default (0-3); higher
 *   finalizes sooner but may reduce accuracy.
 * - `clientReferenceId`: client reference ID to use for transcription.
 *
 * The `maxEndpointDelayMs`, `endpointSensitivity` and
 * `endpointLatencyAdjustmentLevel` settings only take effect when
 * `vadForceTurnEndpoint` is false; otherwise Soniox endpoint detection is
 * disabled and these settings are ignored.
 */
export class SonioxSTTSettings extends STTSettings {
  languageHints: Language[] | null | NotGiven = NOT_GIVEN;
  languageHintsStrict: boolean | null | NotGiven = NOT_GIVEN;
  context: SonioxContextObject | string | null | NotGiven = NOT_GIVEN;
  enableSpeakerDiarization: boolean | null | NotGiven = NOT_GIVEN;
  enableLanguageIdentification: boolean | null | NotGiven = NOT_GIVEN;
  maxEndpointDelayMs: number | null | NotGiven = NOT_GIVEN;
  endpointSensitivity: number | null | NotGiven = NOT_GIVEN;
  endpointLatencyAdjustmentLevel: number | null | NotGiven = NOT_GIVEN;
  clientReferenceId: string | null | NotGiven = NOT_GIVEN;

  constructor(options: SonioxSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** A shallow copy of a settings object, of the same class (`dataclasses.replace(x)`). */
function _copySettings<T extends STTSettings>(settings: T): T {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(settings)), settings) as T;
  copy.extra = { ...settings.extra };
  return copy;
}

/**
 * Replace `languageHints` with `delta.language`, the field Soniox reads on connect.
 *
 * Hints given in the same delta win. A string outside `Language` stays in
 * `language` for the base class to handle.
 */
function _moveLanguageToHints(delta: STTSettings): void {
  const language = delta.language;
  if (!isGiven(language) || language === null) {
    return;
  }
  if (isGiven((delta as unknown as Dict).languageHints ?? NOT_GIVEN)) {
    return;
  }
  if (typeof language !== "string" || !isLanguage(language)) {
    return;
  }
  (delta as unknown as Dict).languageHints = [language];
  delta.language = NOT_GIVEN;
}

export interface SonioxSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Soniox API key. */
  apiKey: string;
  /** Soniox WebSocket API URL. */
  url?: string;
  /**
   * Audio format for transcription. Defaults to `"pcm_s16le"`.
   */
  audioFormat?: string;
  /** Number of audio channels. Defaults to 1. */
  numChannels?: number;
  /**
   * Controls turn detection mode.
   * When true (pipedog mode, default): Soniox endpoint detection is
   * disabled and a `VADUserStoppedSpeakingFrame` sends a finalize message to
   * Soniox. When false (Soniox turn detection mode): Soniox endpoint
   * detection is enabled and controls turn endings. Proposes a turn start on
   * the local VAD signal when a VAD analyzer is configured (most responsive)
   * or on the first transcript token otherwise, and a turn stop when the
   * endpoint is detected.
   */
  vadForceTurnEndpoint?: boolean;
  /**
   * Whether to interrupt the bot when the user starts speaking in Soniox turn
   * detection mode (`vadForceTurnEndpoint: false`). Passed along to the user
   * turn strategies this service recommends, which own the interruption; a
   * user-supplied `userTurnStrategies` overrides the recommendation and this
   * setting with it. Defaults to true.
   */
  shouldInterrupt?: boolean;
  /** Runtime-updatable settings. */
  settings?: STTSettings | null;
}

/**
 * Speech-to-Text service using Soniox's WebSocket API.
 *
 * This service connects to Soniox's WebSocket API for real-time transcription
 * with support for multiple languages, custom context, speaker diarization,
 * and more.
 *
 * For complete API documentation, see:
 * https://soniox.com/docs/speech-to-text/api-reference/websocket-api
 */
export class SonioxSTTService extends WebsocketSTTService {
  static Settings: typeof SonioxSTTSettings = SonioxSTTSettings;
  declare protected _settings: SonioxSTTSettings;

  static {
    installTracedStt(SonioxSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _vadForceTurnEndpoint: boolean;
  protected _shouldInterrupt: boolean;
  protected _audioFormat: string;
  protected _numChannels: number;
  protected _finalTranscriptionBuffer: Dict[] = [];
  protected _lastTokensReceived: number | null = null;
  // Turn tracking for Soniox turn-detection mode.
  protected _userTurnOpen = false;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Soniox STT service.
   *
   * @param options.apiKey Soniox API key.
   * @param options.url Soniox WebSocket API URL.
   * @param options.sampleRate Audio sample rate.
   * @param options.audioFormat Audio format for transcription. Defaults to "pcm_s16le".
   * @param options.numChannels Number of audio channels. Defaults to 1.
   * @param options.vadForceTurnEndpoint Controls turn detection mode.
   * @param options.shouldInterrupt Whether to interrupt the bot when the user
   *   starts speaking in Soniox turn detection mode.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: SonioxSTTServiceOptions) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof SonioxSTTService).Settings({
      model: "stt-rt-v5",
      language: null,
      languageHints: null,
      languageHintsStrict: null,
      context: null,
      enableSpeakerDiarization: false,
      enableLanguageIdentification: false,
      maxEndpointDelayMs: null,
      endpointSensitivity: null,
      endpointLatencyAdjustmentLevel: null,
      clientReferenceId: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      const settings = _copySettings(options.settings);
      _moveLanguageToHints(settings);
      defaultSettings.applyUpdate(settings as SonioxSTTSettings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? SONIOX_TTFS_P99 : options.ttfsP99Latency,
      keepaliveTimeout: 1,
      keepaliveInterval: 5,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://stt-rt.soniox.com/transcribe-websocket";
    this._vadForceTurnEndpoint = options.vadForceTurnEndpoint ?? true;
    this._shouldInterrupt = options.shouldInterrupt ?? true;

    // Init-only audio config
    this._audioFormat = options.audioFormat ?? "pcm_s16le";
    this._numChannels = options.numChannels ?? 1;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Soniox STT supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies in Soniox's turn-detection mode.
   *
   * With `vadForceTurnEndpoint: false` Soniox's endpoint detection decides
   * turn endings and this service proposes turn boundaries, so the user
   * aggregator resolves those rather than running local VAD/smart-turn. In
   * the default mode (`vadForceTurnEndpoint: true`) the STT proposes no
   * turns, so the defaults are left in place. Applied unless the user passed
   * their own `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (!this._vadForceTurnEndpoint) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /**
   * Propose a turn start (Soniox turn-detection mode only).
   *
   * Soniox has no speech-started event, so the turn opens on the local VAD
   * signal when available (fast path) or on the first transcript token
   * otherwise; whichever arrives first wins, the other is a no-op. The
   * proposal goes out before any transcription frames for the turn are
   * pushed.
   */
  protected async _userTurnStarted(): Promise<void> {
    if (this._vadForceTurnEndpoint || this._userTurnOpen) {
      return;
    }
    this._userTurnOpen = true;
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /**
   * Propose a turn stop (Soniox turn-detection mode only).
   *
   * Broadcast right after the endpoint's finalized TranscriptionFrame (same
   * downstream queue, so ordering is preserved).
   */
  protected async _userTurnStopped(): Promise<void> {
    if (this._vadForceTurnEndpoint || !this._userTurnOpen) {
      return;
    }
    this._userTurnOpen = false;
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Apply settings delta and reconnect if anything changed.
   *
   * A `language` replaces `languageHints`, the field Soniox reads on connect.
   *
   * @param delta A settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    delta = _copySettings(delta);
    _moveLanguageToHints(delta);
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._requestReconnect();
    }

    return changed;
  }

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
   * Stop the Soniox STT websocket connection.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    // The end-of-audio frame has to reach the socket before teardown closes
    // it. Trailing final tokens are not waited for: that would hold shutdown
    // open for a transcript that generates no further turn.
    await this._sendStopRecording();
    await super.stop(frame);
  }

  /**
   * Cancel the Soniox STT websocket connection.
   *
   * Compared to stop, this closes the connection without sending the
   * end-of-audio frame.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Send audio data to Soniox STT Service.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns An async generator yielding null (transcription results come
   *   via WebSocket callbacks).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._websocket.send(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: send failed: ${errorMessage(e)}`);
      }
    }

    yield null;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /**
   * Process a frame of audio data, either buffering or transcribing it.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStartedSpeakingFrame) {
      // In Soniox turn-detection mode the local VAD signal is the fast
      // path for opening the turn: the first transcript token arrives a
      // full network round-trip plus model TTFB later and remains the
      // fallback when no VAD analyzer is configured. No-op in default mode
      // or mid-turn.
      await this._userTurnStarted();
    } else if (frame instanceof VADUserStoppedSpeakingFrame && this._vadForceTurnEndpoint) {
      // Send finalize message to Soniox so we get the final tokens asap.
      if (this._websocket && this._websocket.state === State.OPEN) {
        await this._websocket.send(FINALIZE_MESSAGE);
        logger.debug(`Triggered finalize event on: ${frame.name}, ${direction}`);
      }
    }
  }

  /** Send the end-of-audio frame, an empty message that ends the session. */
  protected async _sendStopRecording(): Promise<void> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._websocket.send("");
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: end-of-audio send failed: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Connect to the Soniox service.
   *
   * Establishes websocket connection and starts the receive task.
   */
  override async _connect(): Promise<void> {
    await this._connectWebsocket();

    await super._connect();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /**
   * Disconnect from the Soniox service.
   *
   * Cleans up tasks and closes websocket connection.
   */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Establish the websocket connection to Soniox. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Soniox STT");

      this._websocket = await this._websocketConnect(this._url, {
        additionalHeaders: { Authorization: `Bearer ${this._apiKey}` },
      });

      // If vadForceTurnEndpoint is not enabled, we need to enable endpoint detection.
      // Either one or the other is required.
      const enableEndpointDetection = !this._vadForceTurnEndpoint;

      const s = this._settings;

      let context: unknown = s.context;
      if (context instanceof SonioxContextObject) {
        context = context.modelDump();
      }

      // Send the initial configuration message.
      const config = {
        model: s.model,
        audio_format: this._audioFormat,
        num_channels: this._numChannels,
        enable_endpoint_detection: enableEndpointDetection,
        max_endpoint_delay_ms: s.maxEndpointDelayMs,
        endpoint_sensitivity: s.endpointSensitivity,
        endpoint_latency_adjustment_level: s.endpointLatencyAdjustmentLevel,
        sample_rate: this.sampleRate,
        language_hints: _prepareLanguageHints(assertGiven(s.languageHints)),
        language_hints_strict: s.languageHintsStrict,
        context,
        enable_speaker_diarization: s.enableSpeakerDiarization,
        enable_language_identification: s.enableLanguageIdentification,
        client_reference_id: s.clientReferenceId,
      };

      // Send the configuration message.
      await this._websocket.send(pyJsonDumps(config));

      await this._callEventHandler("on_connected");
      logger.debug("Connected to Soniox STT");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to Soniox: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Close the websocket connection to Soniox. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("Disconnecting from Soniox STT");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Get the current WebSocket connection.
   *
   * @returns The WebSocket connection.
   * @throws If the WebSocket is not connected.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Receive and process websocket messages.
   *
   * Continuously processes messages from the websocket connection.
   */
  override async _receiveMessages(): Promise<void> {
    // Transcription frame will be only sent after we get the "endpoint" event.
    this._finalTranscriptionBuffer = [];

    const sendEndpointTranscript = async (): Promise<void> => {
      if (this._finalTranscriptionBuffer.length > 0) {
        const text = this._finalTranscriptionBuffer.map((token) => token.text).join("");
        const language = _languageFromTokens(this._finalTranscriptionBuffer);
        // Report usage before the transcription frame so tracing can
        // attach it to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        // Soniox only pushes TranscriptionFrame when an end token is received,
        // so every TranscriptionFrame is inherently finalized
        await this.pushFrame(
          new TranscriptionFrame({
            text,
            userId: this._userId,
            timestamp: timeNowIso8601(),
            language,
            result: this._finalTranscriptionBuffer,
            finalized: true,
          }),
        );
        await this._handleTranscription(text, true, language);
        this._finalTranscriptionBuffer = [];
      }
    };

    const finalizeTurn = async (): Promise<void> => {
      await sendEndpointTranscript();
      await this._userTurnStopped();
    };

    for await (const message of this._getWebsocket()) {
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const content = pyJsonLoads(text) as Dict;

        const tokens: Dict[] = content.tokens;

        if (tokens.length > 0) {
          if (!(tokens.length === 1 && tokens[0]?.text === FINALIZED_TOKEN)) {
            // Got at least one token, so we can reset the auto finalize delay.
            this._lastTokensReceived = time();
          }
          // else: ignore finalized token, prevent auto-finalize cycling.
        }

        // We will only send the final tokens after we get the "endpoint" event.
        const nonFinalTranscription: Dict[] = [];

        for (const token of tokens) {
          if (!isEndToken(token)) {
            // In Soniox turn-detection mode, the first token of a new
            // turn opens it (no-op in default mode or when a VAD
            // signal already opened the turn).
            await this._userTurnStarted();
          }
          if (token.is_final) {
            if (isEndToken(token)) {
              // Found an endpoint, tokens until here will be sent as transcript,
              // the rest will be sent as interim tokens (even final tokens).
              await finalizeTurn();
            } else {
              this._finalTranscriptionBuffer.push(token);
            }
          } else {
            nonFinalTranscription.push(token);
          }
        }

        if (this._finalTranscriptionBuffer.length > 0 || nonFinalTranscription.length > 0) {
          const finalText = this._finalTranscriptionBuffer.map((token) => token.text).join("");
          const nonFinalText = nonFinalTranscription.map((token) => token.text).join("");

          await this.pushFrame(
            new InterimTranscriptionFrame({
              // Even final tokens are sent as interim tokens as we want to send
              // nicely formatted messages - therefore waiting for the endpoint.
              text: finalText + nonFinalText,
              userId: this._userId,
              timestamp: timeNowIso8601(),
              result: [...this._finalTranscriptionBuffer, ...nonFinalTranscription],
            }),
          );
        }

        const errorCode = content.error_code;
        const errorMsg = content.error_message;
        if (errorCode || errorMsg) {
          // In case of error, still send the final transcript (if any remaining
          // in the buffer) and close any open user turn.
          await finalizeTurn();
          await this.pushError(`Error: ${errorCode} (_receive_messages) - ${errorMsg}`, {
            category: classifyErrorCode(errorCode),
          });
        }

        if (content.finished) {
          // When finished, still send the final transcript (if any remaining
          // in the buffer) and close any open user turn.
          await finalizeTurn();
          logger.debug("Transcription finished.");
          return;
        }
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`Received non-JSON message: ${String(message)}`);
        } else {
          logger.warning(`Error processing message: ${errorMessage(e)}`);
        }
      }
    }
  }

  /**
   * Send a Soniox protocol-level keepalive message.
   *
   * @param _silence Silent PCM audio bytes (unused, Soniox uses a protocol message).
   */
  protected override async _sendKeepalive(_silence: Uint8Array): Promise<void> {
    if (this._websocket === null) {
      logger.warning(`${this}: websocket unavailable, skipping keepalive`);
      return;
    }
    await this._websocket.send(KEEPALIVE_MESSAGE);
  }
}
