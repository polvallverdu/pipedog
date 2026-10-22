// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/speechmatics/stt.py

/**
 * Speechmatics STT service integration.
 *
 * Talks to the Speechmatics Agent STT WebSocket API (`/v2/agent`) through
 * `AgentSttClient` (`./agent_stt.ts`), a port of the part of the Python
 * `speechmatics-agent-stt` SDK that Pipecat uses.
 *
 * Porting notes:
 * - Deprecated upstream APIs are not ported: `InputParams` and the `params`
 *   argument, the legacy constructor keyword arguments
 *   (`_check_deprecated_args`), the `operating_point` setting, and
 *   `_apply_legacy_params`. `model` is the only way to pick the model.
 * - DIVERGENCE: `_resolveModel` takes only `model` (there is no
 *   `operating_point` to reconcile it with).
 * - DIVERGENCE: the client is built by `_createClient()` and the reconnect
 *   backoff sleeps in `_sleep()`, so tests can replace them on an instance
 *   (upstream monkeypatches the SDK class and `asyncio.sleep`).
 * - DIVERGENCE: the transcription config is built after `super()` (upstream
 *   builds it before; JS has no `this` ahead of `super()`). Nothing in the base
 *   constructor reads it.
 */

import {
  CancelledError,
  currentTask,
  Queue,
  rethrowIfCancelled,
  sleep,
  type Task,
} from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  type StartFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { SPEECHMATICS_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { getEnv } from "@pipedog/core/utils/env";
import { logger } from "@pipedog/core/utils/logger";
import { exponentialBackoffTime } from "@pipedog/core/utils/network";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type AdditionalVocabEntry,
  AgentSttClient,
  AudioEncoding,
  AudioFormat,
  AuthenticationError,
  ConfigurationError,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MODEL,
  Model,
  Segment,
  ServerMessageType,
  SessionError,
  SpeakerDiarizationConfig,
  type SpeakerIdentifier,
  SUPPORTED_SAMPLE_RATES,
  TranscriptionConfig,
  TranscriptionError,
  TurnConfig,
  TurnDetectionMode,
} from "./agent_stt.ts";

export type { AdditionalVocabEntry, SpeakerIdentifier };
export { AudioEncoding, Model, TurnDetectionMode };

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Connect-time failures that will never clear on retry (auth, bad config, rejected session).
// These are reported as permanent, leaving the service unusable, and never trigger a
// reconnect; every other connect exception is treated as a transient drop and retried with
// backoff.
const PERMANENT_CONNECT_ERRORS = [
  AuthenticationError,
  ConfigurationError,
  TranscriptionError,
  SessionError,
];

// HTTP statuses a WebSocket handshake returns when the credentials are rejected.
const AUTH_REJECTION_STATUSES: readonly number[] = [401, 403];

// Server `Error` types that reject the request or the account, so a fresh session with
// the same configuration would fail the same way. Every other type (idle/session timeouts,
// buffer, data, and internal errors) ends the session, but a new one can succeed.
// `invalid_language` and `start_recognition_timeout` come from the Agent STT API reference.
const PERMANENT_SERVER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_message",
  "invalid_model",
  "invalid_language",
  "invalid_config",
  "invalid_audio_type",
  "invalid_output_format",
  "not_authorised",
  "insufficient_funds",
  "not_allowed",
  "protocol_error",
  "quota_exceeded",
]);

/**
 * Whether `exc` is a WebSocket handshake rejected for authentication (HTTP 401/403).
 *
 * A rejected credential surfaces as a `ConnectionError` carrying the underlying
 * handshake error in its cause chain. The status is read from that error
 * (`response.status_code`, `response.status`, `statusCode`, `status_code` or
 * `status`), with the status in the message text as a fallback (core's
 * Cloudflare Workers connect reports `HTTP <status>` in its message).
 */
export function _isAuthRejection(exc: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = exc;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const c = current as Dict;
    const response = c.response as Dict | undefined;
    const status =
      response?.status_code ??
      response?.statusCode ??
      response?.status ??
      c.status_code ??
      c.statusCode ??
      c.status;
    if (typeof status === "number" && AUTH_REJECTION_STATUSES.includes(status)) return true;
    current = c.cause;
  }
  const text = errorMessage(exc);
  return AUTH_REJECTION_STATUSES.some((status) => text.includes(`HTTP ${status}`));
}

/**
 * Resolve the transcription model from `model`.
 *
 * Accepts a `Model` member or its wire string; an unset (`NOT_GIVEN`) or null
 * value falls back to the default model.
 */
export function _resolveModel(model: Model | string | null | NotGiven | undefined): string {
  const given = isGiven(model) ? model : null;
  return given || DEFAULT_MODEL;
}

export const _DEFAULT_TURN_DETECTION_MODE: TurnDetectionMode = TurnDetectionMode.EXTERNAL;

export interface SpeechmaticsSTTSettingsOptions extends STTSettingsOptions {
  /** Domain for Speechmatics API. */
  domain?: string | null | NotGiven;
  /** Endpoint handling mode. */
  turnDetectionMode?: TurnDetectionMode | NotGiven;
  /** Formatter for speaker ID. */
  speakerActiveFormat?: string | NotGiven;
  /** List of known speaker labels and identifiers. */
  knownSpeakers?: SpeakerIdentifier[] | NotGiven;
  /** List of additional vocabulary entries. */
  additionalVocab?: AdditionalVocabEntry[] | NotGiven;
  /** Include partial segment fragments. */
  enablePartials?: boolean | null | NotGiven;
  /**
   * Close a segment at every end of sentence, not only at the end of the turn, so each
   * sentence is emitted as its own final transcription.
   */
  emitSentences?: boolean | null | NotGiven;
  /** Punctuation overrides. */
  punctuationOverrides?: Dict | null | NotGiven;
  /** Post-processing applied to the transcript. */
  transcriptFilteringConfig?: Dict | null | NotGiven;
  /** Enable speaker diarization. */
  enableDiarization?: boolean | null | NotGiven;
  /** Diarization sensitivity. */
  speakerSensitivity?: number | null | NotGiven;
  /** Maximum number of speakers to detect. */
  maxSpeakers?: number | null | NotGiven;
  /** Prefer current speaker ID. */
  preferCurrentSpeaker?: boolean | null | NotGiven;
}

/**
 * Settings for SpeechmaticsSTTService.
 *
 * `model` (inherited) is the transcription model, e.g. `"linden-1"`.
 */
export class SpeechmaticsSTTSettings extends STTSettings {
  /** Fields that are purely local (formatting templates): no reconnect and no API call needed. */
  static readonly LOCAL_FIELDS: ReadonlySet<string> = new Set(["speakerActiveFormat"]);

  domain: string | null | NotGiven = NOT_GIVEN;
  turnDetectionMode: TurnDetectionMode | NotGiven = NOT_GIVEN;
  speakerActiveFormat: string | NotGiven = NOT_GIVEN;
  knownSpeakers: SpeakerIdentifier[] | NotGiven = NOT_GIVEN;
  additionalVocab: AdditionalVocabEntry[] | NotGiven = NOT_GIVEN;
  enablePartials: boolean | null | NotGiven = NOT_GIVEN;
  emitSentences: boolean | null | NotGiven = NOT_GIVEN;
  punctuationOverrides: Dict | null | NotGiven = NOT_GIVEN;
  transcriptFilteringConfig: Dict | null | NotGiven = NOT_GIVEN;
  enableDiarization: boolean | null | NotGiven = NOT_GIVEN;
  speakerSensitivity: number | null | NotGiven = NOT_GIVEN;
  maxSpeakers: number | null | NotGiven = NOT_GIVEN;
  preferCurrentSpeaker: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: SpeechmaticsSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Build the wire `speaker_diarization_config` from the diarization settings.
 *
 * Returns null when diarization is off or no diarization knob is set, so an empty
 * config is never sent. Only the fields that were actually set are included.
 */
export function _buildDiarizationConfig(
  s: SpeechmaticsSTTSettings,
): SpeakerDiarizationConfig | null {
  if (!s.enableDiarization) return null;

  const fields: Dict = {};
  if (s.maxSpeakers !== null) fields.maxSpeakers = s.maxSpeakers;
  if (s.speakerSensitivity !== null) fields.speakerSensitivity = s.speakerSensitivity;
  if (s.preferCurrentSpeaker !== null) fields.preferCurrentSpeaker = s.preferCurrentSpeaker;
  if (isGiven(s.knownSpeakers) && s.knownSpeakers.length > 0) fields.speakers = s.knownSpeakers;

  return Object.keys(fields).length > 0 ? new SpeakerDiarizationConfig(fields) : null;
}

/** Python `str(float)` for a number that upstream holds as a float. */
function floatStr(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** Python `str.format` for a template with named fields (`{name}`, `{{`, `}}`). */
function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (match, name?: string) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    const key = name as string;
    if (!(key in values)) throw new Error(`KeyError: '${key}'`);
    return values[key] as string;
  });
}

export interface SpeechmaticsSTTServiceOptions extends STTServiceOptions {
  /**
   * Speechmatics API key for authentication. Uses environment variable
   * `SPEECHMATICS_API_KEY` if not provided.
   */
  apiKey?: string | null;
  /**
   * Base URL for Speechmatics API. Uses environment variable `SPEECHMATICS_RT_URL`
   * or defaults to `wss://eu2.rt.speechmatics.com/v2/agent`.
   */
  baseUrl?: string | null;
  /** Audio encoding format. Defaults to `AudioEncoding.PCM_S16LE`. */
  encoding?: AudioEncoding;
  /**
   * Determine whether the bot should be interrupted when Speechmatics
   * `turnDetectionMode` is configured to detect user speech. Passed along to the
   * user turn strategies this service recommends, which own the interruption; a
   * user-supplied `userTurnStrategies` overrides the recommendation and this
   * setting with it. Defaults to true.
   */
  shouldInterrupt?: boolean;
  /** Runtime-updatable settings. */
  settings?: SpeechmaticsSTTSettings | null;
}

/**
 * Speechmatics STT service implementation.
 *
 * This service provides real-time speech-to-text transcription using the Speechmatics API.
 * It supports partial and final transcriptions, multiple languages, various audio formats,
 * and speaker diarization.
 *
 * Event handlers available (in addition to STTService events):
 *
 * - on_speakers_result(service, speakers): Speaker diarization results received
 *
 * @example
 * ```ts
 * stt.addEventHandler("on_speakers_result", async (service, speakers) => {});
 * ```
 */
export class SpeechmaticsSTTService extends STTService {
  static Settings: typeof SpeechmaticsSTTSettings = SpeechmaticsSTTSettings;
  declare protected _settings: SpeechmaticsSTTSettings;

  // Export related classes as class attributes
  static TurnDetectionMode = TurnDetectionMode;
  static AudioEncoding = AudioEncoding;
  static Model = Model;

  /**
   * Attempts a single reconnect makes before giving up. Audio is buffered for the
   * whole sequence, so the bound also caps how much is held and replayed at once.
   */
  static readonly RECONNECT_MAX_ATTEMPTS = 3;
  get RECONNECT_MAX_ATTEMPTS(): number {
    return (this.constructor as typeof SpeechmaticsSTTService).RECONNECT_MAX_ATTEMPTS;
  }

  static {
    installTracedStt(SpeechmaticsSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _shouldInterrupt: boolean;
  protected _client: AgentSttClient | null = null;
  protected _audioEncoding: AudioEncoding;
  protected _config: TranscriptionConfig;

  // Message queue
  protected _sttMsgQueue: Queue<Dict> = new Queue<Dict>();
  protected _sttMsgTask: Task<unknown> | null = null;

  // Stops reconnect attempts once the session is torn down (stop/cancel/cleanup)
  // or rejected outright.
  protected _closed = false;

  // A reconnect running in the background (see _scheduleReconnect).
  protected _reconnectTask: Task<unknown> | null = null;

  /**
   * Initialize the Speechmatics STT service.
   *
   * @param options.apiKey Speechmatics API key for authentication. Uses environment variable
   *   `SPEECHMATICS_API_KEY` if not provided.
   * @param options.baseUrl Base URL for Speechmatics API. Uses environment variable
   *   `SPEECHMATICS_RT_URL` or defaults to `wss://eu2.rt.speechmatics.com/v2/agent`.
   * @param options.sampleRate Optional audio sample rate in Hz. Speechmatics accepts 8000 and
   *   16000. Defaults to the pipeline's input sample rate.
   * @param options.encoding Audio encoding format. Defaults to `AudioEncoding.PCM_S16LE`.
   * @param options.shouldInterrupt Determine whether the bot should be interrupted when
   *   Speechmatics `turnDetectionMode` is configured to detect user speech.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final transcript in seconds.
   *   Override for your deployment. See https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to STTService.
   */
  constructor(options: SpeechmaticsSTTServiceOptions = {}) {
    // Service parameters
    const apiKey = options.apiKey || getEnv("SPEECHMATICS_API_KEY");
    const baseUrl =
      options.baseUrl || getEnv("SPEECHMATICS_RT_URL") || "wss://eu2.rt.speechmatics.com/v2/agent";

    // Check we have required attributes
    if (!apiKey) {
      throw new Error("Missing Speechmatics API key");
    }
    if (!baseUrl) {
      throw new Error("Missing Speechmatics base URL");
    }

    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof SpeechmaticsSTTService).Settings({
      model: null, // Resolved below
      language: Language.EN,
      domain: null,
      turnDetectionMode: _DEFAULT_TURN_DETECTION_MODE,
      speakerActiveFormat: "{text}",
      knownSpeakers: [],
      additionalVocab: [],
      enablePartials: null,
      emitSentences: null,
      punctuationOverrides: null,
      transcriptFilteringConfig: null,
      enableDiarization: null,
      speakerSensitivity: null,
      maxSpeakers: null,
      preferCurrentSpeaker: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // Default the model (the SDK's default) when none was given.
    defaultSettings.model = _resolveModel(defaultSettings.model);

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? SPEECHMATICS_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = apiKey;
    this._baseUrl = baseUrl;
    this._shouldInterrupt = options.shouldInterrupt ?? true;
    this._audioEncoding = options.encoding ?? AudioEncoding.PCM_S16LE;
    this._config = this._buildConfig(this._settings);

    // Registered unconditionally: diarization can be turned on at runtime, and a
    // handler added while it was off would otherwise be dropped.
    this._registerEventHandler("on_speakers_result");
  }

  /**
   * True when Speechmatics detects turns itself and emits Start/EndOfTurn.
   *
   * Every turn-detection mode except `EXTERNAL` (where the caller drives turns via
   * `finalize()`) has the service close turns. This gates the turn-scoped behavior
   * (turn frames, turn-event subscriptions, and processing metrics) off in EXTERNAL
   * mode, where Pipecat owns endpointing.
   */
  protected get _serviceClosesTurns(): boolean {
    const mode = this._settings.turnDetectionMode;
    return isGiven(mode) && mode !== TurnDetectionMode.EXTERNAL;
  }

  /**
   * Request external turn strategies when Speechmatics endpoints server-side.
   *
   * Every mode other than `EXTERNAL` (which uses Pipecat's own endpointing) has
   * Speechmatics detect turns and propose the boundaries, so the user aggregator
   * resolves those. Applied unless the user passed their own `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._serviceClosesTurns) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /** The Agent STT session id, set once `RecognitionStarted` arrives (else null). */
  get sessionId(): string | null {
    return this._client?.sessionInfo.sessionId ?? null;
  }

  // ============================================================================
  // LIFE-CYCLE / SESSION MANAGEMENT
  // ============================================================================

  /** Called when the new session starts. */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._closed = false;
    await this._connect();
  }

  /**
   * Apply a settings delta, reconnecting only when necessary.
   *
   * LOCAL_FIELDS (formatting templates) take effect immediately with no reconnect.
   * Every other field is baked into the transcription config at connect time, so
   * changing one requires a full disconnect / reconnect.
   *
   * @param delta A settings delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    // `_buildConfig` reads only `model`, which must hold a resolved name.
    if ("model" in changed) {
      this._settings.model = _resolveModel(this._settings.model);
    }

    const cls = this.constructor as typeof SpeechmaticsSTTService;
    if (Object.keys(changed).some((k) => !cls.Settings.LOCAL_FIELDS.has(k))) {
      logger.debug(`${this} settings update requires reconnect: ${Object.keys(changed)}`);
      // Connection-level fields changed: rebuild the config, then reconnect. The
      // new settings may be what a rejected session needed (a supported language,
      // say), so a closed service gets another chance, matching the usability the
      // base class just restored.
      this._config = this._buildConfig(this._settings);
      this._closed = false;
      await this._cancelReconnectTask();
      await this._requestReconnect();
    } else {
      // Only local (formatting) fields changed: effective immediately.
      logger.debug(`${this} local settings update, no reconnect: ${Object.keys(changed)}`);
    }

    return changed;
  }

  /** Called when the session ends. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    this._closed = true;
    await this._cancelReconnectTask();
    await this._disconnect();
  }

  /** Called when the session is cancelled. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    this._closed = true;
    await this._cancelReconnectTask();
    await this._disconnect();
  }

  /** Release Speechmatics resources at pipeline teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    this._closed = true;
    await this._cancelReconnectTask();
    await this._disconnect();
  }

  /**
   * Connect to the STT service, retrying in the background if the attempt fails.
   *
   * Runs from `start()`, ahead of the `StartFrame` reaching the rest of the
   * pipeline, so the backoff loop must not hold that up: audio is buffered while the
   * retry runs. A rejected session marks the service closed, and retrying cannot
   * clear that.
   */
  async _connect(): Promise<void> {
    if (!(await this._openConnection()) && !this._closed) {
      this._scheduleReconnect();
    }
  }

  /** Build the Agent STT client. A seam so tests can substitute a fake. */
  protected _createClient(options: {
    apiKey: string;
    url: string;
    app: string;
    transcriptionConfig: TranscriptionConfig;
    turnConfig: TurnConfig;
    audioFormat: AudioFormat;
  }): AgentSttClient {
    return new AgentSttClient(options);
  }

  /** Sleep between reconnect attempts. A seam so tests can skip the backoff. */
  protected async _sleep(seconds: number): Promise<void> {
    await sleep(seconds);
  }

  /**
   * Build the client, register handlers, and open the connection.
   *
   * - Create STT client
   * - Register handlers for messages
   * - Connect to the client
   * - Start message processing task
   *
   * @param options.reportError Whether to surface a connect failure via `pushError`. The
   *   reconnect loop passes false so retries only log instead of spamming the
   *   pipeline with an error per attempt.
   * @returns True if the connection is live, false if the attempt failed (the caller
   *   decides whether to retry).
   */
  async _openConnection(options: { reportError?: boolean } = {}): Promise<boolean> {
    const reportError = options.reportError ?? true;
    logger.debug(`${this} connecting to Speechmatics STT service`);

    // The client rejects an unsupported sample rate when constructed. Check it here so
    // the rejection is reported as permanent (a retry would fail the same way) rather
    // than raised out of start().
    if (!SUPPORTED_SAMPLE_RATES.includes(this.sampleRate)) {
      await this._failPermanently(
        `Speechmatics STT does not support a sample rate of ${this.sampleRate} Hz ` +
          `(supported: ${SUPPORTED_SAMPLE_RATES.join(", ")})`,
      );
      return false;
    }

    // Agent STT client. Turn detection is a top-level turn_config (sibling of the
    // transcription config); audio encoding / sample rate go via AudioFormat.
    const client = this._createClient({
      apiKey: this._apiKey,
      url: this._baseUrl,
      app: `pipecat/${pipecatVersion()}`,
      transcriptionConfig: this._config,
      turnConfig: new TurnConfig({
        turnDetectionMode: assertGiven(this._settings.turnDetectionMode),
      }),
      audioFormat: new AudioFormat({
        encoding: this._audioEncoding,
        sampleRate: this.sampleRate,
        chunkSize: DEFAULT_CHUNK_SIZE,
      }),
    });
    this._client = client;

    // Message pump: feeds handler callbacks into the ordered processing queue.
    const addMessage = (message: Dict) => this._sttMsgQueue.putNowait(message);
    const on = (type: ServerMessageType) => client.on(type, addMessage);

    // Segment + status listeners.
    on(ServerMessageType.ADD_PARTIAL_SEGMENT);
    on(ServerMessageType.ADD_SEGMENT);
    on(ServerMessageType.ERROR);
    on(ServerMessageType.WARNING);

    // Service-side turn events (only emitted when the service closes turns).
    if (this._serviceClosesTurns) {
      on(ServerMessageType.START_OF_TURN);
      on(ServerMessageType.END_OF_TURN);
    }

    // Speaker diarization results.
    if (this._settings.enableDiarization) {
      on(ServerMessageType.SPEAKERS_RESULT);
    }

    // Connect. Errors reach the pipeline via pushError instead of dying silently, and are
    // split by recoverability: an unrecoverable rejection (auth / bad config / rejected
    // session) is permanent and stops the session, while any other failure is a transient
    // drop the caller retries with backoff.
    try {
      await client.connect();
      logger.debug(`${this} connected`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._client = null;
      if (PERMANENT_CONNECT_ERRORS.some((cls) => e instanceof cls)) {
        await this._failPermanently(`Speechmatics STT rejected the session: ${errorMessage(e)}`, e);
        return false;
      }
      // A rejected credential arrives as a ConnectionError; report it as permanent
      // (like the other unrecoverable rejections) instead of retrying.
      if (_isAuthRejection(e)) {
        await this._failPermanently(
          `Speechmatics STT rejected the credentials: ${errorMessage(e)}`,
          e,
        );
        return false;
      }
      if (reportError) {
        await this.pushError(`Error connecting to STT service: ${errorMessage(e)}`, {
          exception: e,
        });
      } else {
        logger.warning(`${this} reconnect attempt failed: ${errorMessage(e)}`);
      }
      return false;
    }

    // Start message processing task
    if (!this._sttMsgTask) {
      this._sttMsgTask = this.createTask(() => this._processSttMessages());
    }
    return true;
  }

  /**
   * Report an error that will not clear on retry and stop the session reconnecting.
   *
   * The error is pushed as permanent, which marks the service unusable so it is given
   * no more audio and the pipeline worker applies its `ProcessorUnusablePolicy`. The
   * session is also marked closed, which stops `_doReconnect` retrying against it.
   * A later settings update reopens the service (see `_updateSettings`).
   */
  async _failPermanently(errorMsg: string, exception?: unknown): Promise<void> {
    this._closed = true;
    await this.pushError(errorMsg, { exception, forceTreatAsPermanent: true });
  }

  /**
   * Re-establish the session, retrying with exponential backoff.
   *
   * Called by `STTService._reconnect()` inside the reconnecting guard, which holds
   * for the whole call, so audio arriving during the retries is buffered and replayed
   * rather than dropped. Exhausting the attempts is reported as a permanent error.
   */
  protected override async _doReconnect(): Promise<void> {
    await this._disconnect();
    for (let attempt = 1; attempt <= this.RECONNECT_MAX_ATTEMPTS; attempt++) {
      // A rejected session, or a stop/cancel that landed during the backoff,
      // marks the service closed: nothing may reopen it.
      if (this._closed) return;
      if (await this._openConnection({ reportError: false })) {
        logger.debug(`${this} reconnected to Speechmatics STT`);
        return;
      }
      if (attempt < this.RECONNECT_MAX_ATTEMPTS && !this._closed) {
        await this._sleep(exponentialBackoffTime(attempt));
      }
    }
    if (this._closed) return;
    await this._failPermanently(
      `Speechmatics STT failed to reconnect after ${this.RECONNECT_MAX_ATTEMPTS} attempts`,
    );
  }

  /**
   * Run a reconnect in the background, unless one is already in flight.
   *
   * For paths that cannot run the reconnect inline: the message pump, which the
   * reconnect tears down, and the initial connect, where the backoff loop would
   * otherwise hold up the rest of the pipeline's start.
   */
  _scheduleReconnect(): void {
    if (this._reconnectTask && !this._reconnectTask.done()) return;
    this._reconnectTask = this.createTask(() => this._requestReconnect(), "reconnect") ?? null;
  }

  /** Cancel a background reconnect, if one is still running. */
  protected async _cancelReconnectTask(): Promise<void> {
    const task = this._reconnectTask;
    this._reconnectTask = null;
    if (task && !task.done() && task !== currentTask()) {
      await this.cancelTask(task);
    }
  }

  /**
   * Disconnect from the STT service.
   *
   * - Cancel message processing task
   * - Disconnect the client
   * - Emit on_disconnected event handler for clients
   */
  async _disconnect(): Promise<void> {
    // Cancel the message processing task
    if (this._sttMsgTask) {
      await this.cancelTask(this._sttMsgTask);
      this._sttMsgTask = null;
    }

    // Drain any messages buffered from this session. The consumer task is cancelled
    // above, so anything still queued would otherwise be replayed into the next
    // session by the fresh consumer started on reconnect (the queue is reused).
    while (!this._sttMsgQueue.empty()) {
      this._sttMsgQueue.getNowait();
    }

    // Disconnect the client
    logger.debug(`${this} disconnecting from Speechmatics STT service`);
    try {
      if (this._client) {
        await this._client.disconnect();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing Speechmatics client: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._client = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Process messages from the STT client.
   *
   * Messages from the STT client are processed in a separate task to avoid blocking the main
   * thread. They are handled in strict order in which they are received.
   */
  protected async _processSttMessages(): Promise<void> {
    try {
      while (true) {
        const message = await this._sttMsgQueue.get();
        await this._handleMessage(message);
      }
    } catch (e) {
      if (e instanceof CancelledError) return;
      throw e;
    }
  }

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  /**
   * Build an Agent STT `TranscriptionConfig` from the given settings.
   *
   * Only fields Agent STT accepts on the wire are set. Audio encoding / sample rate are
   * passed to the client via `AudioFormat`; turn detection is passed to the client via
   * `TurnConfig` (a top-level `turn_config` sibling of `transcription_config`).
   */
  _buildConfig(settings: SpeechmaticsSTTSettings): TranscriptionConfig {
    const s = settings;

    // The stored language may be a plain code rather than a Language, but the
    // mapping keys compare equal either way.
    const language = assertGiven(s.language) as Language;
    const smLanguage = this._languageToSpeechmaticsLanguage(language);

    return new TranscriptionConfig({
      language: smLanguage,
      model: assertGiven(s.model) as string,
      diarization: s.enableDiarization ? "speaker" : null,
      speakerDiarizationConfig: _buildDiarizationConfig(s),
      additionalVocab:
        isGiven(s.additionalVocab) && s.additionalVocab.length > 0 ? [...s.additionalVocab] : null,
      outputLocale: this._localeToSpeechmaticsLocale(smLanguage, language),
      domain: assertGiven(s.domain) || null,
      enablePartials: assertGiven(s.enablePartials),
      emitSentences: assertGiven(s.emitSentences),
      punctuationOverrides: assertGiven(s.punctuationOverrides),
      transcriptFilteringConfig: assertGiven(s.transcriptFilteringConfig),
    });
  }

  // ============================================================================
  // HANDLE ENGINE MESSAGES
  // ============================================================================

  /** Handle a message from the STT client. */
  async _handleMessage(message: Dict): Promise<void> {
    const event = message.message ?? "";

    switch (event) {
      case ServerMessageType.ADD_PARTIAL_SEGMENT:
        await this._handlePartialSegment(message);
        break;
      case ServerMessageType.ADD_SEGMENT:
        await this._handleSegment(message);
        break;
      case ServerMessageType.START_OF_TURN:
        await this._handleStartOfTurn(message);
        break;
      case ServerMessageType.END_OF_TURN:
        await this._handleEndOfTurn(message);
        break;
      case ServerMessageType.SPEAKERS_RESULT:
        await this._handleSpeakersResult(message);
        break;
      case ServerMessageType.ERROR:
        await this._handleError(message);
        break;
      case ServerMessageType.WARNING:
        this._handleWarning(message);
        break;
      default:
        logger.debug(`${this} ${event} -> ${JSON.stringify(message)}`);
    }
  }

  /**
   * Handle AddPartialSegment events.
   *
   * Agent STT sends a single `segment` object (`transcript`/`speaker`) plus
   * message-level `metadata`; `Segment.fromMessage` reads that singular shape.
   */
  async _handlePartialSegment(message: Dict): Promise<void> {
    const segment = Segment.fromMessage(message);
    if (segment.transcript) {
      await this._sendFrame(segment, { finalized: false });
    }
  }

  /**
   * Handle AddSegment events.
   *
   * Agent STT sends a single final `segment` object plus message-level `metadata`.
   */
  async _handleSegment(message: Dict): Promise<void> {
    const segment = Segment.fromMessage(message);
    if (!segment.transcript) {
      return;
    }

    // If a finalize() was requested, confirm it before pushing so this final frame is
    // tagged as the one that was asked for.
    if (this._finalizeRequested) {
      this.confirmFinalize();
    }

    await this._sendFrame(segment, { finalized: true });
  }

  /**
   * Handle StartOfTurn events.
   *
   * When Speechmatics STT detects the start of a new speaking turn, a StartOfTurn
   * event is triggered. The service opens the turn's processing-metrics span and
   * proposes a turn start, which the user turn strategies resolve into a
   * UserStartedSpeakingFrame and, when `shouldInterrupt` is set, an interruption.
   *
   * Only reached when the service closes turns; EXTERNAL mode never subscribes to
   * StartOfTurn, so the span is never opened there.
   */
  async _handleStartOfTurn(_message: Dict): Promise<void> {
    logger.debug(`${this} StartOfTurn received`);
    await this.startProcessingMetrics();
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /**
   * Handle EndOfTurn events.
   *
   * EndOfTurn events are triggered by Speechmatics STT when it concludes a
   * speaking turn. This occurs either due to silence or reaching the
   * end-of-turn confidence thresholds. These events provide the final
   * transcript for the completed turn. The service proposes a turn stop, which
   * the user turn strategies resolve into a UserStoppedSpeakingFrame.
   */
  async _handleEndOfTurn(_message: Dict): Promise<void> {
    logger.debug(`${this} EndOfTurn received`);
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Handle SpeakersResult events.
   *
   * SpeakersResult events are triggered by Speechmatics STT when it provides
   * speaker information for the current speaking turn.
   */
  async _handleSpeakersResult(message: Dict): Promise<void> {
    logger.debug(`${this} speakers result received from STT`);
    await this._callEventHandler("on_speakers_result", message);
  }

  /**
   * Build a human-readable string from a server status message.
   *
   * Error/Warning/Info messages carry a `type` and `reason` (and sometimes a
   * numeric `code`); any may be absent, so fall back to the raw payload.
   */
  static _describeStatus(message: Dict): string {
    const parts = ["type", "code", "reason"]
      .filter((k) => message[k] !== undefined && message[k] !== null)
      .map((k) => String(message[k]));
    return parts.length > 0 ? parts.join(" ") : JSON.stringify(message);
  }

  /**
   * Handle Error events.
   *
   * A server Error always ends the session. One that rejects the request or account
   * is permanent: it is surfaced upstream and the service stops reconnecting. Any
   * other (a timeout, a buffer or internal error) is reported and a new session is
   * opened in the background, since this handler runs on the message pump the
   * reconnect tears down.
   */
  async _handleError(message: Dict): Promise<void> {
    const errorMsg = `Speechmatics STT error: ${SpeechmaticsSTTService._describeStatus(message)}`;
    if (PERMANENT_SERVER_ERROR_TYPES.has(message.type)) {
      await this._failPermanently(errorMsg);
      return;
    }
    await this.pushError(errorMsg);
    this._scheduleReconnect();
  }

  /**
   * Handle Warning events.
   *
   * The session continues (possibly with adjusted config), so log without
   * interrupting the pipeline.
   */
  _handleWarning(message: Dict): void {
    logger.warning(
      `${this} Speechmatics STT warning: ${SpeechmaticsSTTService._describeStatus(message)}`,
    );
  }

  // ============================================================================
  // SEND FRAMES TO PIPELINE
  // ============================================================================

  /** Process frames for VAD and metrics handling. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    // Forward to parent
    await super.processFrame(frame, direction);

    // Force finalization, only when the caller drives turns (EXTERNAL). When the
    // service closes turns itself, a pipeline VAD still feeds the base class's TTFB
    // metrics and reconnect gating, so its frames are expected here and not forwarded.
    if (frame instanceof VADUserStoppedSpeakingFrame) {
      if (this._serviceClosesTurns) {
        logger.debug(
          `${this} VADUserStoppedSpeakingFrame received; the service closes turns itself`,
        );
      } else if (this._client !== null) {
        this.requestFinalize();
        this._client.finalize();
      }
    }
  }

  /**
   * Transform an Agent STT `Segment` into a Pipecat transcription frame.
   *
   * Pure mapping with no side effects. `finalized` picks the frame type.
   * `language` has no wire field, so it comes from the configured setting;
   * `result` has no wire field and is left unset.
   */
  _segmentToFrame(
    segment: Segment,
    options: { finalized: boolean },
  ): TranscriptionFrame | InterimTranscriptionFrame {
    // The stored language may be a plain code rather than a Language; the frame
    // carries it as-is.
    const language = assertGiven(this._settings.language) as Language;
    const activeFormat = assertGiven(this._settings.speakerActiveFormat);
    const text = formatTemplate(activeFormat, {
      speaker_id: segment.speaker || "UU",
      text: segment.transcript,
      ts: floatStr(segment.startTime),
      lang: String(language),
    });

    const FrameCls = options.finalized ? TranscriptionFrame : InterimTranscriptionFrame;
    return new FrameCls({
      text,
      userId: segment.speaker || "",
      timestamp: timeNowIso8601(),
      language,
    });
  }

  /**
   * Emit one transcription frame for a segment, with final-only metrics.
   *
   * @param segment The segment to emit.
   * @param options.finalized Whether this is a final (true) or interim (false) transcript.
   */
  async _sendFrame(segment: Segment, options: { finalized: boolean }): Promise<void> {
    const frame = this._segmentToFrame(segment, options);

    if (options.finalized) {
      await this._handleTranscription(
        segment.transcript,
        true,
        assertGiven(this._settings.language) as Language,
      );
      // Report usage before the transcription frame so tracing can attach it to the
      // STT span the frame closes.
      await this.emitSttUsageMetrics();
      logger.debug(`${this} finalized transcript: ${JSON.stringify(frame.text)}`);
    } else {
      logger.debug(`${this} interim transcript: ${JSON.stringify(frame.text)}`);
    }

    await this.pushFrame(frame);

    // Close the turn's processing-metrics span on the final transcript. Gated so
    // EXTERNAL mode, which never opens the span (no StartOfTurn), emits nothing.
    if (options.finalized && this._serviceClosesTurns) {
      await this.stopProcessingMetrics();
    }
  }

  // ============================================================================
  // PUBLIC FUNCTIONS
  // ============================================================================

  /**
   * Send a message to the STT service.
   *
   * This sends a message to the STT service via the underlying transport. If the session
   * is not running, this will raise an exception. Messages in the wrong format will also
   * cause an error.
   *
   * @param message Message to send to the STT service.
   * @param extra Additional fields merged into the payload.
   * @throws Error if the session is not connected, or the message could not be sent
   *   (e.g. a malformed payload).
   */
  async sendMessage(message: string, extra: Dict = {}): Promise<void> {
    if (this._client === null) {
      throw new Error(`${this} cannot send message: STT session is not connected`);
    }

    const payload = { message, ...extra };
    logger.debug(`${this} sending message to STT: ${JSON.stringify(payload)}`);
    try {
      await this._client.sendMessage(payload);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new Error(`${this} error sending message to STT: ${errorMessage(e)}`, { cause: e });
    }
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Speechmatics STT supports generation of metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Record transcription event for tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language,
  ): Promise<void> {}

  /** Send audio to the Agent STT session. Transcripts are pushed from the message pump. */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    try {
      if (this._client) {
        await this._client.sendAudio(audio);
        // sendAudio swallows transport errors and shuts its own audio gate, so a
        // dropped socket is only visible as the gate being closed. A gate closed
        // with no session error is a broken stream; when the service ended the
        // session itself, _handleError has already reported it.
        if (!this._client.isReadyForAudio && this._client.sessionError === null) {
          logger.warning(`${this} audio stream closed, reconnecting`);
          await this._requestReconnect();
        }
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Speechmatics error: ${errorMessage(e)}` });
      await this._requestReconnect();
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Convert a Language enum to a Speechmatics language code.
   *
   * @param language The Language enum to convert.
   * @returns The Speechmatics language code.
   */
  _languageToSpeechmaticsLanguage(language: Language): string {
    // List of supported input languages
    const BASE_LANGUAGES: Partial<Record<Language, string>> = {
      [Language.AR]: "ar",
      [Language.BA]: "ba",
      [Language.EU]: "eu",
      [Language.BE]: "be",
      [Language.BG]: "bg",
      [Language.BN]: "bn",
      [Language.YUE]: "yue",
      [Language.CA]: "ca",
      [Language.HR]: "hr",
      [Language.CS]: "cs",
      [Language.DA]: "da",
      [Language.NL]: "nl",
      [Language.EN]: "en",
      [Language.EO]: "eo",
      [Language.ET]: "et",
      [Language.FA]: "fa",
      [Language.FI]: "fi",
      [Language.FR]: "fr",
      [Language.GL]: "gl",
      [Language.DE]: "de",
      [Language.EL]: "el",
      [Language.HE]: "he",
      [Language.HI]: "hi",
      [Language.HU]: "hu",
      [Language.IT]: "it",
      [Language.ID]: "id",
      [Language.GA]: "ga",
      [Language.JA]: "ja",
      [Language.KO]: "ko",
      [Language.LV]: "lv",
      [Language.LT]: "lt",
      [Language.MS]: "ms",
      [Language.MT]: "mt",
      [Language.CMN]: "cmn",
      [Language.MR]: "mr",
      [Language.MN]: "mn",
      [Language.NO]: "no",
      [Language.PL]: "pl",
      [Language.PT]: "pt",
      [Language.RO]: "ro",
      [Language.RU]: "ru",
      [Language.SK]: "sk",
      [Language.SL]: "sl",
      [Language.ES]: "es",
      [Language.SV]: "sv",
      [Language.SW]: "sw",
      // Speechmatics' Tagalog pack also covers Filipino, its standardized register,
      // so both map onto the one code the provider offers.
      [Language.TL]: "tl",
      [Language.FIL]: "tl",
      [Language.TA]: "ta",
      [Language.TH]: "th",
      [Language.TR]: "tr",
      [Language.UG]: "ug",
      [Language.UK]: "uk",
      [Language.UR]: "ur",
      [Language.VI]: "vi",
      [Language.CY]: "cy",
    };

    // Get the language code
    const result = resolveLanguage(language, BASE_LANGUAGES, true);

    // Fail if language is not supported
    if (!result) {
      throw new Error(`Unsupported language: ${language}`);
    }

    // Return the language code
    return result;
  }

  /**
   * Convert a Language enum to a Speechmatics language / locale code.
   *
   * @param baseCode The language code.
   * @param locale The Language enum to convert.
   * @returns The Speechmatics output locale code, or null.
   */
  _localeToSpeechmaticsLocale(baseCode: string, locale: Language): string | null {
    // Languages and output locales
    const LOCALES: Record<string, Partial<Record<Language, string>>> = {
      en: {
        [Language.EN_GB]: "en-GB",
        [Language.EN_US]: "en-US",
        [Language.EN_AU]: "en-AU",
      },
    };

    // Ensure language code is in the map
    if (!String(locale).includes("-") || !(baseCode in LOCALES)) {
      return null;
    }

    // Get the locale code
    const result = (LOCALES[baseCode] as Partial<Record<Language, string>>)[locale] ?? null;

    // Fail if locale is not supported.
    if (!result) {
      logger.warning(
        `Unsupported Speechmatics output locale: ${locale}, defaulting to ${baseCode}`,
      );
    }

    // Return the locale code
    return result;
  }
}
