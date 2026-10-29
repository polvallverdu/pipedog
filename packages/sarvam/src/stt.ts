// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/sarvam/stt.py

/**
 * Sarvam AI Speech-to-Text service implementations.
 *
 * Both services stream audio to Sarvam's WebSocket API for Indian language
 * speech recognition. `SarvamSTTService` covers the transcription endpoint,
 * with Voice Activity Detection and a choice of audio formats.
 * `SarvamRealtimeSTTService` targets the realtime endpoint, which adds
 * server-side endpointing and in-band configuration updates.
 *
 * Porting notes:
 * - DIVERGENCE: upstream's `SarvamSTTService` drives Sarvam's `sarvamai`
 *   Python SDK (`AsyncSarvamAI.speech_to_text_streaming.connect`). This port
 *   speaks the same WebSocket protocol directly over core's
 *   `websocketConnect`, so it runs on Bun, Node, Deno and Cloudflare Workers.
 *   The wire format comes from upstream's call sites and from the SDKs'
 *   generated clients (read from the published packages, not from memory):
 *   - `sarvamai` 0.1.37 (PyPI) `speech_to_text_streaming/client.py`:
 *     endpoint `wss://api.sarvam.ai/speech-to-text/ws`, query parameters
 *     `language-code`, `model`, `mode`, `keyterms`, `sample_rate`,
 *     `high_vad_sensitivity`, the VAD tuning parameters, `vad_signals`,
 *     `flush_signal` and `input_audio_codec`; the `Api-Subscription-Key` header.
 *   - `sarvamai` 1.1.12 (npm) `speechToTextStreaming/client/Socket.js`: the
 *     same endpoint and parameters; the audio message
 *     `{"audio": {"data", "sample_rate", "encoding"}}` and the flush message
 *     `{"type": "flush"}`.
 *   - `sarvamai` `types/speech_to_text_streaming_response.py`, `events_data.py`:
 *     responses `{"type": "data" | "events" | "error", "data": {...}}`, where
 *     `data` events carry `transcript` and `language_code`, and `events` carry
 *     `signal_type` (`START_SPEECH` / `END_SPEECH`) and `occured_at`.
 *   Upstream's `ApiError` branch (a rejected handshake) is folded into the
 *   generic connection-failure error, since a raw WebSocket handshake failure
 *   carries no HTTP status object.
 * - DIVERGENCE: `SarvamSTTService` takes a `baseUrl` option (the SDK hardcodes
 *   `wss://api.sarvam.ai`), so tests can point it at a local server.
 * - The SDK's `User-Agent` goes out as a handshake header (`websockets`'
 *   `user_agent_header` keyword upstream) alongside `API-SUBSCRIPTION-KEY`.
 * - The deprecated `model`, `params` (`InputParams`) constructor options and the
 *   deprecated `SarvamRealtimeSTTSettings.language_code` setting are not ported;
 *   use `settings` (and `language`, with `null` for `auto`).
 * - `update_config(**fields)` takes its fields as a plain object keyed by the
 *   wire names (`language_code`, `stream_type`, ...), as Sarvam spells them.
 * - A non-JSON message on the transcription socket is logged and skipped; the
 *   SDK would raise a validation error out of the receive task.
 */

import { Event, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
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
import { SARVAM_REALTIME_TTFS_P99, SARVAM_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  STTService,
  type STTServiceOptions,
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import {
  ConnectionClosedError,
  type ReportErrorCallback,
  State,
  type WebsocketClientConnection,
  type WebsocketData,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { sdkHeaders } from "./_sdk.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to Sarvam's language code format.
 *
 * @param language The Language enum value to convert.
 * @returns The Sarvam language code string.
 */
export function languageToSarvamLanguage(language: Language): string {
  // Mapping of pipecat Language enum to Sarvam language codes
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.KOK]: "kok-IN",
    [Language.KOK_IN]: "kok-IN",
    [Language.MAI]: "mai-IN",
    [Language.MAI_IN]: "mai-IN",
    [Language.BN]: "bn-IN",
    [Language.BN_IN]: "bn-IN",
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    [Language.SD]: "sd-IN",
    [Language.SD_IN]: "sd-IN",
    [Language.UR]: "ur-IN",
    [Language.UR_IN]: "ur-IN",
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    [Language.TA]: "ta-IN",
    [Language.TA_IN]: "ta-IN",
    [Language.TE]: "te-IN",
    [Language.TE_IN]: "te-IN",
    [Language.PA]: "pa-IN",
    [Language.PA_IN]: "pa-IN",
    [Language.OR]: "od-IN",
    [Language.OR_IN]: "od-IN",
    [Language.EN]: "en-IN",
    [Language.EN_IN]: "en-IN",
    [Language.AS]: "as-IN",
    [Language.AS_IN]: "as-IN",
    [Language.BRX]: "brx-IN",
    [Language.BRX_IN]: "brx-IN",
    [Language.DOI]: "doi-IN",
    [Language.DOI_IN]: "doi-IN",
    [Language.KS]: "ks-IN",
    [Language.KS_IN]: "ks-IN",
    [Language.MNI]: "mni-IN",
    [Language.MNI_IN]: "mni-IN",
    [Language.NE]: "ne-IN",
    [Language.NE_IN]: "ne-IN",
    [Language.SA]: "sa-IN",
    [Language.SA_IN]: "sa-IN",
    [Language.SAT]: "sat-IN",
    [Language.SAT_IN]: "sat-IN",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

export type SarvamMode = "transcribe" | "translate" | "verbatim" | "translit" | "codemix";

/**
 * Immutable configuration for a Sarvam STT model.
 *
 * - `supportsMode`: whether the model accepts the mode parameter.
 * - `supportsLanguage`: whether the model accepts the language parameter.
 * - `defaultLanguage`: default language code (null = auto-detect).
 * - `defaultMode`: default mode (null = not applicable).
 */
export interface ModelConfig {
  readonly supportsMode: boolean;
  readonly supportsLanguage: boolean;
  readonly defaultLanguage: string | null;
  readonly defaultMode: SarvamMode | null;
}

export const MODEL_CONFIGS: Readonly<Record<string, ModelConfig>> = {
  "saaras:v3": {
    supportsMode: true,
    supportsLanguage: true,
    defaultLanguage: "unknown",
    defaultMode: "transcribe",
  },
  "saaras:v4": {
    supportsMode: true,
    supportsLanguage: true,
    defaultLanguage: "unknown",
    defaultMode: "transcribe",
  },
};

export interface SarvamSTTSettingsOptions extends STTSettingsOptions {
  vadSignals?: boolean | null | NotGiven;
  highVadSensitivity?: boolean | null | NotGiven;
  positiveSpeechThreshold?: number | null | NotGiven;
  negativeSpeechThreshold?: number | null | NotGiven;
  minSpeechFrames?: number | null | NotGiven;
  firstTurnMinSpeechFrames?: number | null | NotGiven;
  negativeFramesCount?: number | null | NotGiven;
  negativeFramesWindow?: number | null | NotGiven;
  startSpeechVolumeThreshold?: number | null | NotGiven;
  interruptMinSpeechFrames?: number | null | NotGiven;
  preSpeechPadFrames?: number | null | NotGiven;
  numInitialIgnoredFrames?: number | null | NotGiven;
}

/**
 * Settings for SarvamSTTService.
 *
 * - `vadSignals`: enable VAD signals in response.
 * - `highVadSensitivity`: enable high VAD sensitivity.
 * - `positiveSpeechThreshold`: VAD probability threshold (0.0-1.0) above which
 *   a frame is considered speech.
 * - `negativeSpeechThreshold`: VAD probability threshold (0.0-1.0) below which
 *   a frame is considered silence.
 * - `minSpeechFrames`: minimum consecutive speech frames to start a speech
 *   segment.
 * - `firstTurnMinSpeechFrames`: minimum speech frames for the first user turn.
 * - `negativeFramesCount`: number of silence frames within the window to end a
 *   speech segment.
 * - `negativeFramesWindow`: sliding window size (in frames) for counting
 *   negative frames.
 * - `startSpeechVolumeThreshold`: volume level (dB) below which audio is too
 *   quiet to be speech.
 * - `interruptMinSpeechFrames`: minimum speech frames to register a
 *   barge-in/interruption.
 * - `preSpeechPadFrames`: number of audio frames to prepend before detected
 *   speech onset.
 * - `numInitialIgnoredFrames`: number of leading audio frames to skip at
 *   connection start.
 */
export class SarvamSTTSettings extends STTSettings {
  vadSignals: boolean | null | NotGiven = NOT_GIVEN;
  highVadSensitivity: boolean | null | NotGiven = NOT_GIVEN;
  positiveSpeechThreshold: number | null | NotGiven = NOT_GIVEN;
  negativeSpeechThreshold: number | null | NotGiven = NOT_GIVEN;
  minSpeechFrames: number | null | NotGiven = NOT_GIVEN;
  firstTurnMinSpeechFrames: number | null | NotGiven = NOT_GIVEN;
  negativeFramesCount: number | null | NotGiven = NOT_GIVEN;
  negativeFramesWindow: number | null | NotGiven = NOT_GIVEN;
  startSpeechVolumeThreshold: number | null | NotGiven = NOT_GIVEN;
  interruptMinSpeechFrames: number | null | NotGiven = NOT_GIVEN;
  preSpeechPadFrames: number | null | NotGiven = NOT_GIVEN;
  numInitialIgnoredFrames: number | null | NotGiven = NOT_GIVEN;

  constructor(options: SarvamSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SarvamSTTServiceOptions extends STTServiceOptions {
  /** Sarvam API key for authentication. */
  apiKey: string;
  /**
   * Mode of operation. Options: transcribe, translate, verbatim, translit,
   * codemix. Only applicable to models that support it. Defaults to the
   * model's default mode.
   */
  mode?: SarvamMode | null;
  /** Audio sample rate. Defaults to the pipeline's input rate if not specified. */
  sampleRate?: number | null;
  /** Audio codec/format of the input file. Defaults to "wav". */
  inputAudioCodec?: string;
  /**
   * Connection-time recognition hints for saaras:v4. At most 50 terms of 64
   * characters each; put each phrase in a separate item.
   */
  keyterms?: string[] | null;
  /** WebSocket endpoint. Defaults to "wss://api.sarvam.ai/speech-to-text/ws". */
  baseUrl?: string;
  /** Runtime-updatable settings. */
  settings?: SarvamSTTSettings | null;
}

const DEFAULT_STT_URL = "wss://api.sarvam.ai/speech-to-text/ws";

function encodingFor(codec: string): string {
  // Convert input_audio_codec to encoding format (prepend "audio/" if needed)
  return codec.startsWith("audio/") ? codec : `audio/${codec}`;
}

/**
 * Sarvam speech-to-text service.
 *
 * Provides real-time speech recognition using Sarvam's WebSocket API.
 *
 * Event handlers available (in addition to STTService events):
 *
 * - on_connected(service): Connected to Sarvam WebSocket
 * - on_disconnected(service): Disconnected from Sarvam WebSocket
 * - on_connection_error(service, error): Connection error occurred
 *
 * @example
 * stt.addEventHandler("on_connected", async (service) => {
 *   // ...
 * });
 */
export class SarvamSTTService extends STTService {
  static Settings: typeof SarvamSTTSettings = SarvamSTTSettings;
  declare protected _settings: SarvamSTTSettings;

  static {
    installTracedStt(SarvamSTTService.prototype, "_handleTranscription");
  }

  protected _config: ModelConfig;
  protected _apiKey: string;
  protected _baseUrl: string;
  protected _mode: SarvamMode | null;
  protected _keyterms: string[] | null;
  protected _inputAudioCodec: string;
  protected _sdkHeaders: Record<string, string>;
  protected _socketClient: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  // Warn only once per unrecognized language code, so a session stuck
  // detecting one unmapped language doesn't spam a warning per turn.
  _unmappedLanguageCodesWarned = new Set<string>();

  /**
   * Initialize the Sarvam STT service.
   *
   * @param options.apiKey Sarvam API key for authentication.
   * @param options.mode Mode of operation. Options: transcribe, translate,
   *   verbatim, translit, codemix. Only applicable to models that support it.
   *   Defaults to the model's default mode.
   * @param options.sampleRate Audio sample rate. Defaults to the pipeline's
   *   input rate if not specified.
   * @param options.inputAudioCodec Audio codec/format of the input file.
   *   Defaults to "wav".
   * @param options.keyterms Connection-time recognition hints for saaras:v4. At
   *   most 50 terms of 64 characters each; put each phrase in a separate item.
   * @param options.baseUrl WebSocket endpoint. Defaults to
   *   "wss://api.sarvam.ai/speech-to-text/ws".
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark.
   * @param options.keepaliveTimeout Seconds of no audio before sending silence
   *   to keep the connection alive. null disables keepalive.
   * @param options.keepaliveInterval Seconds between idle checks when
   *   keepalive is enabled.
   *   Other options are passed to the parent STTService.
   */
  constructor(options: SarvamSTTServiceOptions) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof SarvamSTTService).Settings({
      model: "saaras:v4",
      language: null,
      vadSignals: null,
      highVadSensitivity: null,
      positiveSpeechThreshold: null,
      negativeSpeechThreshold: null,
      minSpeechFrames: null,
      firstTurnMinSpeechFrames: null,
      negativeFramesCount: null,
      negativeFramesWindow: null,
      startSpeechVolumeThreshold: null,
      interruptMinSpeechFrames: null,
      preSpeechPadFrames: null,
      numInitialIgnoredFrames: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // Resolve model config and validate (after all overrides)
    const resolvedModel = assertGiven(defaultSettings.model);
    if (
      resolvedModel === null ||
      resolvedModel === undefined ||
      !Object.hasOwn(MODEL_CONFIGS, resolvedModel)
    ) {
      const allowed = Object.keys(MODEL_CONFIGS).sort().join(", ");
      throw new Error(`Unsupported model '${resolvedModel}'. Allowed values: ${allowed}.`);
    }

    const config = MODEL_CONFIGS[resolvedModel] as ModelConfig;

    // Validate parameters against model capabilities
    let mode = options.mode ?? null;
    if (mode !== null && !config.supportsMode) {
      throw new Error(`Model '${resolvedModel}' does not support mode parameter.`);
    }
    if (defaultSettings.language !== null && !config.supportsLanguage) {
      throw new Error(
        `Model '${resolvedModel}' does not support language parameter (auto-detects language).`,
      );
    }

    // Resolve mode default from model config
    if (mode === null) {
      mode = config.defaultMode;
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? SARVAM_TTFS_P99 : options.ttfsP99Latency,
    });

    this._config = config;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? DEFAULT_STT_URL;

    // Init-only connection config (not runtime-updatable)
    this._mode = mode;
    this._keyterms =
      options.keyterms !== undefined && options.keyterms !== null ? [...options.keyterms] : null;

    // Store connection parameters
    this._inputAudioCodec = options.inputAudioCodec ?? "wav";

    this._sdkHeaders = sdkHeaders();

    if (defaultSettings.vadSignals) {
      this._registerEventHandler("on_speech_started");
      this._registerEventHandler("on_speech_stopped");
      this._registerEventHandler("on_utterance_end");
    }

    logger.info(`Sarvam STT initialized with SDK headers: ${pyJsonDumps(this._sdkHeaders)}`);
  }

  /**
   * Convert pipecat Language enum to Sarvam's language code.
   *
   * @param language The Language enum value to convert.
   * @returns The Sarvam language code string.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSarvamLanguage(language);
  }

  /** Resolve the current language setting to a Sarvam language code string. */
  _getLanguageString(): string | null {
    // The stored language is a Sarvam code rather than a Language, but the
    // mapping keys compare equal either way.
    const language = assertGiven(this._settings.language) as Language | null;
    if (language) {
      return languageToSarvamLanguage(language);
    }
    return this._config.defaultLanguage;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Sarvam service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies when Sarvam's VAD signals drive turns.
   *
   * With `vadSignals` enabled Sarvam detects speech boundaries server-side
   * and this service proposes turns from them, so the user aggregator resolves
   * those rather than running local VAD/smart-turn. Without it the defaults are
   * left in place. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._settings.vadSignals) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies();
    }
    return frame;
  }

  /**
   * Process incoming frames.
   *
   * Flushes on Pipecat's VAD turn end when Sarvam's built-in VAD signals
   * aren't driving the turn.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Only handle VAD frames when not using Sarvam's VAD signals
    if (!this._settings.vadSignals) {
      if (frame instanceof VADUserStoppedSpeakingFrame) {
        if (this._socketClient && this._socketClient.state === State.OPEN) {
          await this._socketClient.send(pyJsonDumps({ type: "flush" }));
        }
      }
    }
  }

  /**
   * Apply a settings delta, validate, sync state, and reconnect.
   *
   * @param delta A STTSettings (or `SarvamSTTService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   * @throws Error if a setting is not supported by the current model.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    // Validate against model capabilities before applying
    if (isGiven(delta.language) && delta.language !== null) {
      if (!this._config.supportsLanguage) {
        throw new Error(
          `Model '${this._settings.model}' does not support language parameter ` +
            "(auto-detects language).",
        );
      }
    }

    const changed = await super._updateSettings(delta);

    // These are all WebSocket connect-time parameters; reconnect to apply.
    const reconnectFields = new Set([
      "language",
      "positiveSpeechThreshold",
      "negativeSpeechThreshold",
      "minSpeechFrames",
      "firstTurnMinSpeechFrames",
      "negativeFramesCount",
      "negativeFramesWindow",
      "startSpeechVolumeThreshold",
      "interruptMinSpeechFrames",
      "preSpeechPadFrames",
      "numInitialIgnoredFrames",
    ]);
    if (Object.keys(changed).some((k) => reconnectFields.has(k))) {
      await this._disconnect();
      await this._connect();
    }

    const unhandled: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changed)) {
      if (!reconnectFields.has(k)) unhandled[k] = v;
    }
    if (Object.keys(unhandled).length > 0) {
      this._warnUnhandledUpdatedSettings(unhandled);
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
   * Stop the Sarvam STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Sarvam STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** The audio message Sarvam's transcription socket expects. */
  protected _audioMessage(audio: Uint8Array): string {
    return pyJsonDumps({
      audio: {
        data: bytesToBase64(audio),
        sample_rate: this.sampleRate,
        encoding: encodingFor(this._inputAudioCodec),
      },
    });
  }

  /**
   * Send audio data to Sarvam for transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns An async generator yielding null (transcription results come via
   *   WebSocket messages).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (!this._socketClient) {
      yield null;
      return;
    }

    try {
      await this._socketClient.send(this._audioMessage(audio));
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({
        error: `Error sending audio to Sarvam: ${errorMessage(e)}`,
        exception: e,
      });
    }

    yield null;
  }

  /** The WebSocket URL, with the connection parameters as the SDK writes them. */
  _buildWsUrl(): string {
    const s = this._settings;
    const params = new URLSearchParams();
    const add = (key: string, value: unknown) => params.append(key, String(value));

    // Add language_code for models that support it
    const languageString = this._getLanguageString();
    if (languageString !== null) {
      add("language-code", languageString);
    }
    add("model", s.model);
    // Add mode for models that support it
    if (this._config.supportsMode && this._mode !== null) {
      add("mode", this._mode);
    }
    if (this._keyterms !== null) {
      add("keyterms", pyJsonDumps(this._keyterms));
    }
    add("sample_rate", this.sampleRate);

    // Only send vad parameters when explicitly set (avoid overriding server defaults)
    if (s.highVadSensitivity !== null && isGiven(s.highVadSensitivity)) {
      add("high_vad_sensitivity", s.highVadSensitivity ? "true" : "false");
    }

    // Fine-grained VAD parameters (sent as strings per SDK spec)
    const vadParams: [string, unknown][] = [
      ["positive_speech_threshold", s.positiveSpeechThreshold],
      ["negative_speech_threshold", s.negativeSpeechThreshold],
      ["min_speech_frames", s.minSpeechFrames],
      ["first_turn_min_speech_frames", s.firstTurnMinSpeechFrames],
      ["negative_frames_count", s.negativeFramesCount],
      ["negative_frames_window", s.negativeFramesWindow],
      ["start_speech_volume_threshold", s.startSpeechVolumeThreshold],
      ["interrupt_min_speech_frames", s.interruptMinSpeechFrames],
      ["pre_speech_pad_frames", s.preSpeechPadFrames],
      ["num_initial_ignored_frames", s.numInitialIgnoredFrames],
    ];
    for (const [key, value] of vadParams) {
      if (value !== null && isGiven(value)) add(key, value);
    }

    if (s.vadSignals !== null && isGiven(s.vadSignals)) {
      add("vad_signals", s.vadSignals ? "true" : "false");
    }
    // Enable flush signal when using Pipecat's VAD (not Sarvam's) so that
    // the flush message on user-stopped-speaking is honored by the server.
    if (!s.vadSignals) {
      add("flush_signal", "true");
    }

    return `${this._baseUrl}?${params.toString()}`;
  }

  /** Connect to the Sarvam WebSocket API. */
  async _connect(): Promise<void> {
    logger.debug("Connecting to Sarvam");

    try {
      const headers = { "Api-Subscription-Key": this._apiKey, ...this._sdkHeaders };
      this._socketClient = await websocketConnect(this._buildWsUrl(), {
        additionalHeaders: headers,
      });

      // Start receive task using Pipecat's task management
      this._receiveTask = this.createTask(() => this._receiveTaskHandler());

      this._createKeepaliveTask();

      logger.info("Connected to Sarvam successfully");
    } catch (e) {
      rethrowIfCancelled(e);
      this._socketClient = null;
      await this.pushError(`Failed to connect to Sarvam: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Disconnect from the Sarvam WebSocket API. */
  async _disconnect(): Promise<void> {
    await this._cancelKeepaliveTask();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    // Clear references first to prevent runStt from sending audio
    // during the close handshake.
    const socketClient = this._socketClient;
    this._socketClient = null;

    if (socketClient) {
      try {
        await socketClient.close();
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Error closing WebSocket connection: ${errorMessage(e)}`, {
          exception: e,
        });
      } finally {
        logger.debug("Disconnected from Sarvam WebSocket");
      }
    }
  }

  /**
   * Handle incoming messages from the Sarvam WebSocket.
   *
   * Each message is handled in its own task, as upstream's SDK callback does.
   */
  protected async _receiveTaskHandler(): Promise<void> {
    const socketClient = this._socketClient;
    if (!socketClient) {
      return;
    }

    try {
      for await (const raw of socketClient) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        let message: unknown;
        try {
          message = pyJsonLoads(text);
        } catch (e) {
          rethrowIfCancelled(e);
          if (e instanceof SyntaxError) {
            logger.warning(`${this} received non-JSON message: ${text}`);
            continue;
          }
          throw e;
        }
        this.createTask(() => this._handleMessage(message as Dict));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof Error && e.name.startsWith("ConnectionClosed")) {
        // The SDK swallows WebSocket errors here and ends the listener.
        logger.debug(`${this} Sarvam WebSocket closed: ${e.message}`);
        return;
      }
      await this.pushError(`Sarvam receive task error: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Handle an incoming WebSocket message from Sarvam.
   *
   * Processes transcription data and VAD events from the Sarvam service.
   *
   * @param message The parsed response object from the Sarvam WebSocket.
   */
  async _handleMessage(message: Dict): Promise<void> {
    logger.debug(`Received response: ${pyJsonDumps(message, { ensureAscii: false })}`);

    try {
      if (message.type === "events") {
        // VAD event
        const signal = message.data.signal_type;
        const timestamp = message.data.occured_at;
        logger.debug(`VAD Signal: ${signal}, Occurred at: ${timestamp}`);

        if (signal === "START_SPEECH") {
          logger.debug("User started speaking");
          await this._callEventHandler("on_speech_started");
          await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
        } else if (signal === "END_SPEECH") {
          logger.debug("User stopped speaking");
          await this._callEventHandler("on_speech_stopped");
          await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
        }
      } else if (message.type === "data") {
        const transcript: string | null | undefined = message.data.transcript;
        const languageCode: string | null | undefined = message.data.language_code;
        // Prefer language from message (auto-detected for translate models). Fallback to configured.
        // Either can resolve to None -- an unrecognized code, or Sarvam's own
        // "unknown"/auto-detect placeholder -- in which case the frame is left
        // without a language rather than guessing one.
        const language = this._mapLanguageCodeToEnum(languageCode || this._getLanguageString());

        // Emit utterance end event
        await this._callEventHandler("on_utterance_end");

        if (transcript?.trim()) {
          // Record tracing for this transcription event
          await this._handleTranscription(transcript, true, language);
          // Report usage before the transcription frame so tracing
          // can attach it to the STT span the frame closes.
          await this.emitSttUsageMetrics();
          await this.pushFrame(
            new TranscriptionFrame({
              text: transcript,
              userId: this._userId,
              timestamp: timeNowIso8601(),
              language,
              result: message,
              // This service emits one transcript per utterance and
              // no interim frames, so every transcript it produces is
              // final. Without this, turn-stop strategies cannot take
              // their finalized fast path and wait out a timeout meant
              // for partial transcripts instead.
              finalized: true,
            }),
          );
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Failed to handle message: ${errorMessage(e)}`, { exception: e });
      await this.stopAllMetrics();
    }
  }

  /**
   * Handle a transcription result with tracing.
   *
   * This method is traced for observability.
   */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /**
   * Map a Sarvam language code to a pipecat Language, or null if unresolved.
   *
   * Returns null for Sarvam's own "unknown"/auto-detect placeholder and for
   * any code -- present or future -- this table doesn't have an entry for,
   * rather than guessing a specific language. A code that IS recognized but
   * maps to a language this table doesn't carry only logs a warning once,
   * so a long-running session doesn't spam it every turn.
   */
  _mapLanguageCodeToEnum(languageCode: string | null | undefined): Language | null {
    const mapping: Record<string, Language> = {
      "bn-IN": Language.BN_IN,
      "gu-IN": Language.GU_IN,
      "hi-IN": Language.HI_IN,
      "kn-IN": Language.KN_IN,
      "ml-IN": Language.ML_IN,
      "mr-IN": Language.MR_IN,
      "ta-IN": Language.TA_IN,
      "te-IN": Language.TE_IN,
      "pa-IN": Language.PA_IN,
      "od-IN": Language.OR_IN,
      "en-US": Language.EN_US,
      "en-IN": Language.EN_IN,
      "as-IN": Language.AS_IN,
      "ur-IN": Language.UR_IN,
      "mai-IN": Language.MAI_IN,
      "sd-IN": Language.SD_IN,
      "kok-IN": Language.KOK_IN,
      "ne-IN": Language.NE_IN,
      "ks-IN": Language.KS_IN,
      "sa-IN": Language.SA_IN,
      "sat-IN": Language.SAT_IN,
      "mni-IN": Language.MNI_IN,
      "brx-IN": Language.BRX_IN,
      "doi-IN": Language.DOI_IN,
    };
    // "unknown" is Sarvam's own placeholder for "not detected/configured yet"
    // (see MODEL_CONFIGS.defaultLanguage), not a data gap worth warning about.
    if (!languageCode || languageCode === "unknown") {
      return null;
    }
    const language = Object.hasOwn(mapping, languageCode)
      ? (mapping[languageCode] as Language)
      : null;
    if (language === null && !this._unmappedLanguageCodesWarned.has(languageCode)) {
      this._unmappedLanguageCodesWarned.add(languageCode);
      logger.warning(
        `${this} received Sarvam language code '${languageCode}', which has no ` +
          "Language mapping; leaving TranscriptionFrame.language unset for it " +
          "rather than guessing.",
      );
    }
    return language;
  }

  protected override _isKeepaliveReady(): boolean {
    return this._socketClient !== null;
  }

  /**
   * Send silent audio to keep the connection alive.
   *
   * @param silence Silent 16-bit mono PCM audio bytes.
   */
  protected override async _sendKeepalive(silence: Uint8Array): Promise<void> {
    // We know the socket exists because _isKeepaliveReady(), called before
    // _sendKeepalive(), gates on it
    if (!this._socketClient) return;
    await this._socketClient.send(this._audioMessage(silence));
  }
}

//
// Realtime
//

const _REALTIME_MODEL = "saaras:v3-realtime";

// Sarvam's realtime endpoint serves both generations over the same connection
// parameters and event protocol, so only the model string differs. The default
// follows Sarvam's own, which is still v3. The second generation is named
// `saaras:v4` here, without the `-realtime` suffix its predecessor carries: that
// is the name the endpoint accepts, and it rejects `saaras:v4-realtime`.
const _SUPPORTED_REALTIME_MODELS: ReadonlySet<string> = new Set([
  "saaras:v3-realtime",
  "saaras:v4",
]);

export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  "auto",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "or-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "as-IN",
  "ur-IN",
  "ne-IN",
  "kok-IN",
  "ks-IN",
  "sd-IN",
  "sa-IN",
  "sat-IN",
  "mni-IN",
  "brx-IN",
  "mai-IN",
  "doi-IN",
]);
// A plain set: the rate in force can come from the pipeline rather than the
// caller, so it is checked once resolved rather than annotated.
export const SUPPORTED_SAMPLE_RATES: ReadonlySet<number> = new Set([8000, 16000]);

// Sarvam's `stream_type` selects the *server* flush profile; it says nothing
// about how often the client should send. Audio goes out on a fixed cadence so
// transcript latency doesn't scale with the chosen profile.
const _CLIENT_CHUNK_MS = 50;

// Sarvam closes a connection with this code when it rejects a connection
// parameter (model, language, VAD tuning) or the account isn't enabled for it.
const _REJECTED_SETTINGS_CLOSE_CODE = 4000;

// Accepted in a `config.update` message, by their wire names. `Settings.language`
// reaches Sarvam as `language_code`; the rest share their `Settings` names. Of
// these, `language_code`, `stream_type`, `mode`, and `prompt` are boundary-gated:
// the server defers them to the next utterance boundary.
const _RUNTIME_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "language_code",
  "stream_type",
  "mode",
  "prompt",
  "threshold",
  "silence_duration_ms",
  "min_speech_duration_ms",
]);

// The `Settings` field behind each wire name of a `config.update` (other than
// `language_code`, which is the `language` setting).
const _SETTINGS_FIELD_FOR_WIRE_NAME: Readonly<Record<string, string>> = {
  stream_type: "streamType",
  mode: "mode",
  prompt: "prompt",
  threshold: "threshold",
  silence_duration_ms: "silenceDurationMs",
  min_speech_duration_ms: "minSpeechDurationMs",
};

// Only meaningful while the server is doing the endpointing.
const _VAD_TUNING_FIELDS: readonly [string, string][] = [
  ["threshold", "threshold"],
  ["silence_duration_ms", "silenceDurationMs"],
  ["min_speech_duration_ms", "minSpeechDurationMs"],
];

const _SHORT_LANGUAGE_DEFAULTS: ReadonlyMap<string, string> = new Map(
  [...SUPPORTED_LANGUAGES]
    .filter((language) => language !== "auto")
    .map((language) => [language.split("-")[0] as string, language]),
);

/** Convert a Language enum to Sarvam realtime's language code. */
export function languageToSarvamRealtimeLanguage(language: Language): string {
  const languageMap: Partial<Record<Language, string>> = {
    [Language.AS]: "as-IN",
    [Language.AS_IN]: "as-IN",
    [Language.BN]: "bn-IN",
    [Language.BN_IN]: "bn-IN",
    [Language.BRX]: "brx-IN",
    [Language.BRX_IN]: "brx-IN",
    [Language.DOI]: "doi-IN",
    [Language.DOI_IN]: "doi-IN",
    [Language.EN]: "en-IN",
    [Language.EN_IN]: "en-IN",
    [Language.GU]: "gu-IN",
    [Language.GU_IN]: "gu-IN",
    [Language.HI]: "hi-IN",
    [Language.HI_IN]: "hi-IN",
    [Language.KN]: "kn-IN",
    [Language.KN_IN]: "kn-IN",
    [Language.KOK]: "kok-IN",
    [Language.KOK_IN]: "kok-IN",
    [Language.KS]: "ks-IN",
    [Language.KS_IN]: "ks-IN",
    [Language.MAI]: "mai-IN",
    [Language.MAI_IN]: "mai-IN",
    [Language.ML]: "ml-IN",
    [Language.ML_IN]: "ml-IN",
    [Language.MNI]: "mni-IN",
    [Language.MNI_IN]: "mni-IN",
    [Language.MR]: "mr-IN",
    [Language.MR_IN]: "mr-IN",
    [Language.NE]: "ne-IN",
    [Language.NE_IN]: "ne-IN",
    [Language.OR]: "or-IN",
    [Language.OR_IN]: "or-IN",
    [Language.PA]: "pa-IN",
    [Language.PA_IN]: "pa-IN",
    [Language.SA]: "sa-IN",
    [Language.SA_IN]: "sa-IN",
    [Language.SAT]: "sat-IN",
    [Language.SAT_IN]: "sat-IN",
    [Language.SD]: "sd-IN",
    [Language.SD_IN]: "sd-IN",
    [Language.UR]: "ur-IN",
    [Language.UR_IN]: "ur-IN",
    [Language.TA]: "ta-IN",
    [Language.TA_IN]: "ta-IN",
    [Language.TE]: "te-IN",
    [Language.TE_IN]: "te-IN",
  };
  return resolveLanguage(language, languageMap, false);
}

export interface SarvamRealtimeSTTSettingsOptions extends STTSettingsOptions {
  streamType?: "fast" | "balanced" | "simulated" | NotGiven;
  mode?: SarvamMode | NotGiven;
  prompt?: string | null | NotGiven;
  threshold?: number | null | NotGiven;
  silenceDurationMs?: number | null | NotGiven;
  minSpeechDurationMs?: number | null | NotGiven;
}

/**
 * Settings for SarvamRealtimeSTTService.
 *
 * Sarvam reads these from the connection query string but also accepts them
 * in a `config.update`. The values it only reads at connection time are
 * constructor arguments on the service instead. `language=null` asks Sarvam
 * to detect the language of each utterance.
 *
 * - `streamType`: streaming cadence: `fast`, `balanced`, or `simulated`.
 * - `mode`: realtime STT task mode.
 * - `prompt`: optional decoding prompt.
 * - `threshold`: optional VAD sensitivity threshold.
 * - `silenceDurationMs`: optional silence duration for end-of-speech.
 * - `minSpeechDurationMs`: optional minimum speech duration.
 */
export class SarvamRealtimeSTTSettings extends STTSettings {
  streamType: "fast" | "balanced" | "simulated" | NotGiven = NOT_GIVEN;
  mode: SarvamMode | NotGiven = NOT_GIVEN;
  prompt: string | null | NotGiven = NOT_GIVEN;
  threshold: number | null | NotGiven = NOT_GIVEN;
  silenceDurationMs: number | null | NotGiven = NOT_GIVEN;
  minSpeechDurationMs: number | null | NotGiven = NOT_GIVEN;

  constructor(options: SarvamRealtimeSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SarvamRealtimeSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Sarvam API key. */
  apiKey: string;
  /** Realtime STT websocket endpoint. */
  baseUrl?: string;
  /**
   * Which side detects turn boundaries: `vad` for Sarvam's own detection, or
   * `manual` for the pipeline's. Decides the turn strategies this service asks
   * the user aggregator to run, so it is fixed for the life of the service.
   * Defaults to `vad`.
   */
  endpointing?: "vad" | "manual";
  /**
   * Declared input audio sample rate, 8000 or 16000. `null` adopts the
   * pipeline's input rate.
   */
  sampleRate?: number | null;
  /** Whether final transcripts should include segment offsets. Defaults to false. */
  returnTimestamps?: boolean;
  /**
   * Connection-time recognition hints for saaras:v4. At most 50 terms of 64
   * characters each; put each phrase in a separate item.
   */
  keyterms?: string[] | null;
  /** Optional VAD prefix padding, used only under `endpointing="vad"`. */
  prefixPaddingMs?: number | null;
  /** Runtime-updatable realtime settings. */
  settings?: SarvamRealtimeSTTSettings | null;
  /**
   * Determine whether the bot should be interrupted when Sarvam detects user
   * speech. Passed along to the user turn strategies this service recommends,
   * which own the interruption; a user-supplied `userTurnStrategies` overrides
   * the recommendation and this setting with it. Defaults to true.
   */
  shouldInterrupt?: boolean;
}

/**
 * Sarvam realtime Speech-to-Text service.
 *
 * Streams raw audio bytes to Sarvam's realtime websocket endpoint and maps
 * provider VAD and transcript events into Pipecat frames.
 *
 * Serves `saaras:v3-realtime` and `saaras:v4`, selected with
 * `settings: new SarvamRealtimeSTTService.Settings({ model })` and defaulting to
 * `saaras:v3-realtime`, Sarvam's own default.
 *
 * With the default `endpointing="vad"` the server drives turn boundaries. With
 * `endpointing="manual"` the pipeline drives them instead, so the pipeline
 * needs a turn strategy that emits `VADUserStartedSpeakingFrame` and
 * `VADUserStoppedSpeakingFrame`; without one, Sarvam never receives a boundary
 * and never emits a final transcript. The mode is a constructor argument rather
 * than a setting, since it decides which turn strategies the user aggregator
 * runs and those are announced once, at startup.
 *
 * A VAD analyzer is required in either `endpointing` mode. Under `vad` it
 * times transcription latency: TTFB is measured from
 * `VADUserStoppedSpeakingFrame`, which carries the stop delay needed to place
 * the real end of speech, where Sarvam's own `vad.speech_end` arrives only
 * after the server's silence window and would time a shorter interval than
 * every other STT service reports. Under `manual` those same frames also mark
 * the turn for Sarvam, reaching it as `speech_start` and `speech_end`.
 *
 * A dropped socket is reopened with backoff in the background unless
 * `reconnectOnError: false`; audio that arrives while it is down isn't
 * transcribed. An utterance lives in one connection, so one cut short by a
 * drop ends with the transcript received so far, and speech that continues on
 * the new connection is transcribed as a new utterance. Settings Sarvam
 * rejects are a permanent invalid-request error rather than retried. Once the
 * service stops trying it is no longer usable, so a `ServiceSwitcher` can
 * move on.
 */
export class SarvamRealtimeSTTService extends WebsocketSTTService {
  static Settings: typeof SarvamRealtimeSTTSettings = SarvamRealtimeSTTSettings;
  declare protected _settings: SarvamRealtimeSTTSettings;

  static {
    installTracedStt(SarvamRealtimeSTTService.prototype, "_traceTranscription");
  }

  /**
   * How long to wait, in seconds, for the server's `session.begin` after the
   * handshake before treating the connection as failed.
   */
  static _CONNECTION_TIMEOUT = 10.0;

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _returnTimestamps: boolean;
  protected _keyterms: string[] | null;
  protected _prefixPaddingMs: number | null;
  protected _shouldInterrupt: boolean;
  protected _receiveTask: Task<unknown> | null = null;
  protected _connectionEstablishedEvent = new Event();
  _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _requestId: string | null = null;
  // The latest partial transcript with no final after it yet, pushed if its
  // connection closes before the final arrives.
  protected _pendingPartial: Dict | null = null;
  protected _providerSpeechActive = false;
  _speechEndAudioPositionS: number | null = null;
  _audioPositionBytes = 0;
  protected _endpointing: "vad" | "manual";
  // Whether the pipeline has opened a manual-endpointing turn it has not
  // closed yet.
  protected _manualTurnOpen = false;

  /**
   * Initialize Sarvam realtime STT.
   *
   * @param options.apiKey Sarvam API key.
   * @param options.baseUrl Realtime STT websocket endpoint. Defaults to
   *   "wss://api.sarvam.ai/speech-to-text-realtime/ws".
   * @param options.endpointing Which side detects turn boundaries: `vad` for
   *   Sarvam's own detection, or `manual` for the pipeline's. Decides the turn
   *   strategies this service asks the user aggregator to run, so it is fixed
   *   for the life of the service. Defaults to `vad`.
   * @param options.sampleRate Declared input audio sample rate, 8000 or 16000.
   *   `null` adopts the pipeline's input rate.
   * @param options.returnTimestamps Whether final transcripts should include
   *   segment offsets. Defaults to false.
   * @param options.keyterms Connection-time recognition hints for saaras:v4. At
   *   most 50 terms of 64 characters each; put each phrase in a separate item.
   * @param options.prefixPaddingMs Optional VAD prefix padding, used only under
   *   `endpointing="vad"`.
   * @param options.settings Runtime-updatable realtime settings.
   * @param options.shouldInterrupt Determine whether the bot should be
   *   interrupted when Sarvam detects user speech. Defaults to true.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds.
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: SarvamRealtimeSTTServiceOptions) {
    const cls = new.target as typeof SarvamRealtimeSTTService;
    const settingsFields = new Set(
      Object.keys(new cls.Settings()).filter((name) => name !== "extra"),
    );
    const directSettings = Object.keys(options)
      .filter((key) => settingsFields.has(key))
      .sort();
    if (directSettings.length > 0) {
      const names = directSettings.join(", ");
      throw new TypeError(
        `${names} must be passed via ` +
          "settings: new SarvamRealtimeSTTService.Settings(...), not as constructor options",
      );
    }
    const sampleRate = options.sampleRate ?? null;
    if (sampleRate !== null && !SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
      const allowed = [...SUPPORTED_SAMPLE_RATES].sort((a, b) => a - b).join(", ");
      throw new Error(`Unsupported sample_rate '${sampleRate}'. Allowed values: ${allowed}.`);
    }
    const defaultSettings = new cls.Settings({
      model: _REALTIME_MODEL,
      language: Language.EN_IN,
      streamType: "balanced",
      mode: "transcribe",
      prompt: null,
      threshold: null,
      silenceDurationMs: null,
      minSpeechDurationMs: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    SarvamRealtimeSTTService._validateSettings(defaultSettings);

    super({
      ...options,
      sampleRate,
      settings: defaultSettings,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? SARVAM_REALTIME_TTFS_P99 : options.ttfsP99Latency,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws";
    this._returnTimestamps = options.returnTimestamps ?? false;
    this._keyterms =
      options.keyterms !== undefined && options.keyterms !== null ? [...options.keyterms] : null;
    this._prefixPaddingMs = options.prefixPaddingMs ?? null;
    this._shouldInterrupt = options.shouldInterrupt ?? true;
    this._endpointing = options.endpointing ?? "vad";
  }

  /** Check if this service can generate processing and usage metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies when Sarvam endpoints server-side.
   *
   * With `endpointing="vad"` (the default) Sarvam's VAD decides turn
   * boundaries and this service proposes them via
   * `ProposedUserStarted/StoppedSpeakingFrame`, so the user aggregator
   * resolves those rather than running local VAD/smart-turn. In
   * `endpointing="manual"` the pipeline supplies the boundaries, so the
   * defaults are left in place. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._endpointing === "vad") {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /** Convert a Language enum to Sarvam realtime's language code. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSarvamRealtimeLanguage(language);
  }

  /**
   * Set up the service and connect the websocket.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // The rate can come from the pipeline, so it is only settled once the
    // service is set up. It holds for the session, so an unsupported one is
    // a permanent failure that costs the service its usability, letting a
    // `ServiceSwitcher` move on.
    const error = this._resolvedSampleRateError();
    if (error) {
      await this.pushError(error, { category: ErrorCategory.INVALID_REQUEST });
      return;
    }
    await this._connect();
  }

  /** Stop the service and close the websocket. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /** Cancel the service and close the websocket. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Process frames and send manual endpointing boundaries when configured. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (this._endpointing !== "manual") {
      return;
    }
    if (frame instanceof VADUserStartedSpeakingFrame) {
      this._manualTurnOpen = true;
      await this._sendJson({ event: "speech_start" });
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      this._manualTurnOpen = false;
      // The tail of the turn must reach Sarvam before the boundary, or the
      // final transcript is cut short. `speech_end` finalizes the utterance
      // on its own; Sarvam's separate `flush` event force-finalizes
      // buffered audio mid-utterance and has no part in a turn that ends
      // on a boundary.
      await this._flushAudioBuffer();
      await this._sendJson({ event: "speech_end" });
    }
  }

  /** Buffer and send raw audio bytes to Sarvam as base64-encoded JSON messages. */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (!audio || audio.length === 0) {
      yield null;
      return;
    }
    if (!this._isWebsocketOpen()) {
      yield null;
      return;
    }

    const merged = new Uint8Array(this._audioBuffer.length + audio.length);
    merged.set(this._audioBuffer, 0);
    merged.set(audio, this._audioBuffer.length);
    this._audioBuffer = merged;

    const chunkSize = this._chunkSizeBytes();
    while (this._audioBuffer.length >= chunkSize) {
      const chunk = this._audioBuffer.slice(0, chunkSize);
      this._audioBuffer = this._audioBuffer.slice(chunkSize);
      try {
        await this._sendAudioChunk(chunk);
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Sarvam realtime STT send failed: ${errorMessage(e)}`, {
          exception: e,
        });
        break;
      }
    }

    yield null;
  }

  /** Build the Sarvam realtime websocket URL. */
  _buildWsUrl(): string {
    const params = this._queryParams();
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      search.append(key, String(value));
    }
    return `${this._baseUrl}?${search.toString()}`;
  }

  /** Connect to Sarvam realtime and start receive task. */
  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Disconnect from Sarvam realtime. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    if (this._websocket && this._websocket.state === State.OPEN) {
      await this._flushAudioBuffer();
      try {
        await this._sendJson({ event: "end" });
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this} error sending Sarvam end event: ${errorMessage(e)}`);
      }
    }

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /**
   * Open the Sarvam realtime websocket.
   *
   * The server confirms the session with `session.begin`, which the receive
   * loop waits for (see `_receiveMessages`).
   */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      this._connectionEstablishedEvent.clear();
      const url = this._buildWsUrl();
      // DIVERGENCE: upstream passes the User-Agent as `websockets`'
      // `user_agent_header` keyword; here it is a handshake header.
      const headers = { "API-SUBSCRIPTION-KEY": this._apiKey, ...sdkHeaders() };
      logger.debug(`Connecting to Sarvam realtime STT WebSocket: ${url}`);
      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      // Left on the category the failure earns: `_tryReconnect` skips a
      // service that has stopped being usable, so reporting a socket that
      // would not open as permanent bars the retry that could open it.
      await this.pushError(`Unable to connect to Sarvam realtime STT: ${errorMessage(e)}`, {
        exception: e,
      });
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  /** Close the active websocket. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing Sarvam realtime STT websocket: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Mark the service unusable once the receive loop is done.
   *
   * The loop exits for good only when reconnection is off or has given up,
   * so the service has no transcripts left to give.
   *
   * Cancellation is left alone: that only happens during an intentional
   * disconnect, where teardown is already under way.
   */
  override async _receiveTaskHandler(reportError: ReportErrorCallback): Promise<void> {
    await super._receiveTaskHandler(reportError);
    if (!this._disconnecting) {
      await this.setUsable(false);
    }
  }

  /**
   * Carry an open manual turn across the socket swap.
   *
   * Under `manual` the pipeline's turn is still open, and Sarvam ignores a
   * `speech_end` without a matching `speech_start`, so the new session is
   * told the turn has started. Audio positions count from the start of the
   * new session.
   */
  override async _reconnectWebsocket(attemptNumber: number): Promise<boolean> {
    const reconnected = await super._reconnectWebsocket(attemptNumber);
    if (reconnected) {
      this._audioPositionBytes = 0;
      if (this._manualTurnOpen) {
        await this._sendJson({ event: "speech_start" });
      }
    }
    return reconnected;
  }

  /**
   * Receive Sarvam realtime server events.
   *
   * Waits for the server to confirm the session with `session.begin`, then
   * processes VAD, transcript, and error events.
   *
   * @throws Error (Python's `ConnectionError`) if `session.begin` doesn't
   *   arrive within `_CONNECTION_TIMEOUT`.
   * @throws ConnectionClosedError if the connection closes with an error. A
   *   close rejecting the connection's settings is also reported as a
   *   permanent invalid-request error, so it isn't retried.
   */
  override async _receiveMessages(): Promise<void> {
    if (!this._websocket) {
      throw new Error("Websocket not connected");
    }
    const messages = this._websocket[Symbol.asyncIterator]();
    try {
      if (
        !(await this._receiveUntilConfirmed(
          messages,
          this._connectionEstablishedEvent,
          (message) => this._processMessage(message),
          (this.constructor as typeof SarvamRealtimeSTTService)._CONNECTION_TIMEOUT,
        ))
      ) {
        // Closed before confirming; the receive loop treats it as a drop.
        return;
      }

      await this._callEventHandler("on_connected");

      while (true) {
        const next = await messages.next();
        if (next.done) break;
        await this._processMessage(next.value);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosedError && e.code === _REJECTED_SETTINGS_CLOSE_CODE) {
        await this.pushError(`Sarvam realtime STT rejected the connection: ${e.reason}`, {
          exception: e,
          category: ErrorCategory.INVALID_REQUEST,
        });
      }
      throw e;
    } finally {
      // An utterance lives in one connection, so it ends when the connection
      // does, unless the service is stopping.
      if (!this._disconnecting) {
        await this._endUtteranceCutShort();
      }
    }
  }

  /** Decode and handle one message from the WebSocket. */
  protected async _processMessage(message: WebsocketData): Promise<void> {
    if (typeof message !== "string") {
      logger.trace(`${this} ignored non-text Sarvam server message`);
      return;
    }
    let data: unknown;
    try {
      data = pyJsonLoads(message);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof SyntaxError) {
        logger.warning(`${this} received non-JSON Sarvam message: ${message}`);
        return;
      }
      throw e;
    }
    await this._handleMessage(data as Dict);
  }

  /**
   * End an utterance whose connection closed before its final transcript.
   *
   * The new session never sends the old one's `vad.speech_end` or
   * `transcript.final`, so the utterance is closed here, and the latest
   * partial transcript is pushed as its transcription, unfinalized since the
   * server never committed it. Without this, downstream turn aggregation
   * would wait on a boundary that is never coming, and what the user said
   * would be lost.
   */
  protected async _endUtteranceCutShort(): Promise<void> {
    await this._completeActiveUtterance();
    const partial = this._pendingPartial;
    this._pendingPartial = null;
    if (!partial) {
      return;
    }
    logger.debug(`${this}: connection closed before the final transcript, using the partial`);
    await this.emitSttUsageMetrics();
    const text = String(partial.text || "").trim();
    const language = this._languageForFrame(partial.language);
    const result = this._resultPayload(partial);
    result.speech_end_audio_position_s = this._speechEndAudioPositionS;
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result,
      }),
    );
    await this._traceTranscription(text, true, language);
  }

  /** Handle a parsed Sarvam realtime server event. */
  async _handleMessage(message: Dict): Promise<void> {
    const event = message.event;
    if (event === "session.begin") {
      this._requestId = message.request_id ?? null;
      logger.info(`${this} Sarvam realtime session.begin request_id=${this._requestId}`);
      this._connectionEstablishedEvent.set();
    }
    // Only the endpointer in charge gets to set turn boundaries. Under
    // manual endpointing the pipeline owns them, so server VAD telemetry
    // would compete with the boundaries it is already producing.
    else if (event === "vad.speech_start" && this._endpointing === "vad") {
      await this._handleSpeechStart(message);
    } else if (event === "vad.speech_end" && this._endpointing === "vad") {
      await this._handleSpeechEnd(message);
    } else if (event === "transcript.partial") {
      await this._handlePartialTranscript(message);
    } else if (event === "transcript.final") {
      await this._handleFinalTranscript(message);
    } else if (event === "session.end") {
      await this._handleSessionEnd(message);
    } else if (event === "config.updated") {
      logger.trace(`${this} Sarvam realtime acknowledgement: ${pyJsonDumps(message)}`);
    } else if (event === "error") {
      await this._handleError(message);
    } else if (event === "pong") {
      // Answers our keepalive ping; the reply itself is the liveness proof.
      logger.trace(`${this} Sarvam realtime pong`);
    } else {
      logger.trace(`${this} unhandled Sarvam realtime event: ${pyJsonDumps(message)}`);
    }
  }

  /**
   * Send a live Sarvam `config.update` message without reconnecting.
   *
   * @param fields Runtime-updatable Sarvam config values, keyed by their wire
   *   names (`language_code`, `stream_type`, `mode`, `prompt`, `threshold`,
   *   `silence_duration_ms`, `min_speech_duration_ms`). Connection-only values
   *   are rejected; they are fixed for the life of the stream.
   * @throws Error if a connection-only or invalid value is supplied.
   */
  async updateConfig(fields: Dict): Promise<void> {
    if (Object.keys(fields).length === 0) {
      return;
    }
    this._validateConfigUpdate(fields);
    await this._sendConfigUpdate(fields);
  }

  /** Send an already-validated `config.update` and record what was sent. */
  protected async _sendConfigUpdate(fields: Dict): Promise<void> {
    if (!(await this._sendJson({ event: "config.update", ...fields }))) {
      return;
    }
    // The store has to follow what the server was told, or a later delta
    // diffs against a stale value and skips an update the server needs.
    const stored: Dict = { ...fields };
    if ("language_code" in stored) {
      stored.language = _languageFromCode(stored.language_code);
      delete stored.language_code;
    }
    this._settings.applyUpdate(
      (this.constructor as typeof SarvamRealtimeSTTService).Settings.fromMapping(stored),
    );
  }

  /** Apply runtime settings and send supported fields via `config.update`. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }

    const wireNames = Object.keys(_SETTINGS_FIELD_FOR_WIRE_NAME);
    const handled = new Set<string>([
      "language",
      ...wireNames.map((name) => _SETTINGS_FIELD_FOR_WIRE_NAME[name] as string),
    ]);
    const unsupported = Object.keys(changed).filter((key) => !handled.has(key));
    if (unsupported.length > 0) {
      const unhandled: Record<string, unknown> = {};
      for (const key of unsupported) unhandled[key] = changed[key];
      this._warnUnhandledUpdatedSettings(unhandled);
    }

    const payload: Dict = {};
    for (const wireName of wireNames) {
      const field = _SETTINGS_FIELD_FOR_WIRE_NAME[wireName] as string;
      if (field in changed) {
        // Upstream reads the field with getattr(self._settings, name): dynamic by name.
        payload[wireName] = (this._settings as unknown as Dict)[field];
      }
    }
    if ("language" in changed) {
      payload.language_code = this._languageCode();
    }
    if (Object.keys(payload).length > 0) {
      await this._sendJson({ event: "config.update", ...payload });
    }
    return changed;
  }

  /** The `language_code` Sarvam is sent for the configured language. */
  protected _languageCode(): string {
    const language = this._settings.language;
    return isGiven(language) && language ? String(language) : "auto";
  }

  protected async _handleSpeechStart(_message: Dict): Promise<void> {
    if (this._providerSpeechActive) {
      return;
    }
    this._providerSpeechActive = true;
    this._speechEndAudioPositionS = null;
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  protected async _handleSpeechEnd(_message: Dict): Promise<void> {
    await this._completeActiveUtterance();
  }

  /**
   * End the in-flight utterance.
   *
   * Runs on `vad.speech_end`, and on a session or connection ending
   * mid-utterance, where the server will never send that boundary.
   */
  protected async _completeActiveUtterance(): Promise<void> {
    if (!this._providerSpeechActive) {
      return;
    }
    this._providerSpeechActive = false;
    this._speechEndAudioPositionS = this._durationForBytes(this._audioPositionBytes);
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  protected async _handlePartialTranscript(message: Dict): Promise<void> {
    const text = String(message.text || "").trim();
    if (!text) {
      return;
    }
    this._pendingPartial = message;
    const result = this._resultPayload(message);
    const language = this._languageForFrame(message.language);
    await this.pushFrame(
      new InterimTranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result,
      }),
    );
  }

  protected async _handleFinalTranscript(message: Dict): Promise<void> {
    // Report usage before the transcription frame so tracing can attach it
    // to the STT span the frame closes. A blank final still consumed audio.
    this._pendingPartial = null;
    await this.emitSttUsageMetrics();
    const text = String(message.text || "").trim();
    if (text) {
      const language = this._languageForFrame(message.language);
      const result = this._resultPayload(message);
      result.speech_end_audio_position_s = this._speechEndAudioPositionS;
      await this.pushFrame(
        new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result,
          finalized: true,
        }),
      );
      await this._traceTranscription(text, true, language);
    }
  }

  protected async _handleSessionEnd(message: Dict): Promise<void> {
    if (message.request_id) {
      this._requestId = message.request_id;
    }
    await this._completeActiveUtterance();
  }

  protected async _handleError(message: Dict): Promise<void> {
    await this.pushError(
      `Sarvam realtime STT error: ${pyJsonDumps(message, { ensureAscii: false })}`,
    );
  }

  protected async _sendAudioChunk(chunk: Uint8Array): Promise<void> {
    if (!this._websocket) {
      throw new Error("WebSocket not connected");
    }
    const sent = await this._sendJson({ event: "audio_input", audio: bytesToBase64(chunk) });
    if (!sent) {
      return;
    }
    this._audioPositionBytes += chunk.length;
  }

  protected async _flushAudioBuffer(): Promise<void> {
    if (this._audioBuffer.length === 0) {
      return;
    }
    const chunk = this._audioBuffer;
    this._audioBuffer = new Uint8Array(0);
    if (!this._isWebsocketOpen()) {
      return;
    }
    try {
      await this._sendAudioChunk(chunk);
    } catch (e) {
      rethrowIfCancelled(e);
      // Late audio on a socket the server already dropped must not break
      // the turn boundary or teardown.
      await this.pushError(`Sarvam realtime STT flush failed: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /**
   * Hold the connection open with Sarvam's ping event.
   *
   * @param _silence Silent PCM audio bytes, unused. The socket only accepts
   *   JSON events, and Sarvam answers a ping with a pong rather than reading
   *   padding audio.
   */
  protected override async _sendKeepalive(_silence: Uint8Array): Promise<void> {
    await this._sendJson({ event: "ping" });
  }

  /** Send a JSON event, reporting whether it reached the socket. */
  protected async _sendJson(payload: Dict): Promise<boolean> {
    if (!this._isWebsocketOpen()) {
      return false;
    }
    await (this._websocket as WebsocketClientConnection).send(pyJsonDumps(payload));
    return true;
  }

  protected _queryParams(): Dict {
    const s = this._settings;
    const params: Dict = {
      language_code: this._languageCode(),
      stream_type: s.streamType,
      endpointing: this._endpointing,
      encoding: "linear16",
      sample_rate: this.sampleRate,
      model: s.model,
      mode: s.mode,
      return_timestamps: String(this._returnTimestamps).toLowerCase(),
    };
    if (this._keyterms !== null) {
      params.keyterms = pyJsonDumps(this._keyterms);
    }
    const optional: [string, unknown][] = [["prompt", s.prompt]];
    if (this._endpointing === "vad") {
      optional.push(["prefix_padding_ms", this._prefixPaddingMs]);
      for (const [wireName, field] of _VAD_TUNING_FIELDS) {
        // Upstream reads the field with getattr(self._settings, name): dynamic by name.
        optional.push([wireName, (s as unknown as Dict)[field]]);
      }
    }
    for (const [key, value] of optional) {
      if (isGiven(value) && value !== null) {
        params[key] = value;
      }
    }
    return params;
  }

  protected _bytesPerSecond(): number {
    return this.sampleRate * 2;
  }

  protected _chunkSizeBytes(): number {
    return Math.trunc(this._bytesPerSecond() * (_CLIENT_CHUNK_MS / 1000));
  }

  protected _durationForBytes(byteCount: number): number {
    const bytesPerSecond = this._bytesPerSecond();
    if (bytesPerSecond <= 0) {
      return 0.0;
    }
    return byteCount / bytesPerSecond;
  }

  protected _resultPayload(message: Dict): Dict {
    const payload: Dict = { ...message };
    if (this._requestId !== null && !("request_id" in payload)) {
      payload.request_id = this._requestId;
    }
    const confidence = payload.confidence;
    if (typeof confidence !== "number") {
      // `language_confidence` is a LID score and never a recognition score.
      payload.confidence = 1.0;
    }
    return payload;
  }

  protected _languageForFrame(rawLanguage?: string | null): Language | null {
    const configuredLanguageCode = this._languageCode();
    const languageCode = this._normalizeLanguageCode(rawLanguage || configuredLanguageCode);
    if (languageCode === "auto") {
      return null;
    }
    return isLanguage(languageCode) ? languageCode : null;
  }

  protected _normalizeLanguageCode(languageCode: string | null | undefined): string {
    if (!languageCode) {
      return this._languageCode();
    }
    if (!languageCode.includes("-") && languageCode !== "auto") {
      const configured = this._languageCode();
      if (configured !== "auto" && configured.startsWith(`${languageCode}-`)) {
        return configured;
      }
      return _SHORT_LANGUAGE_DEFAULTS.get(languageCode) ?? languageCode;
    }
    return languageCode;
  }

  protected _isWebsocketOpen(): boolean {
    return this._websocket !== null && this._websocket.state === State.OPEN;
  }

  /** Describe why the rate actually in use is unusable, if it is. */
  protected _resolvedSampleRateError(): string | null {
    if (SUPPORTED_SAMPLE_RATES.has(this.sampleRate)) {
      return null;
    }
    const allowed = [...SUPPORTED_SAMPLE_RATES].sort((a, b) => a - b).join(", ");
    return `Unsupported sample_rate '${this.sampleRate}'. Allowed values: ${allowed}.`;
  }

  /** Reject a `config.update` field Sarvam has no setting for. */
  protected _validateConfigUpdate(update: Dict): void {
    const unknown = Object.keys(update)
      .filter((key) => !_RUNTIME_CONFIG_FIELDS.has(key))
      .sort();
    if (unknown.length > 0) {
      const names = unknown.join(", ");
      throw new Error(`Unknown config.update field(s) ${names}.`);
    }
  }

  /**
   * Check the settings this integration itself depends on.
   *
   * Sarvam's own vocabulary -- languages, modes, stream types, VAD tuning
   * ranges -- is left to the server, which rejects a bad value on the wire
   * and reaches the app as an error frame. Repeating those lists here would
   * block values Sarvam adds later.
   */
  protected static _validateSettings(settings: SarvamRealtimeSTTSettings): void {
    const model = assertGiven(settings.model);
    if (model === null || !_SUPPORTED_REALTIME_MODELS.has(model)) {
      const allowed = [..._SUPPORTED_REALTIME_MODELS].sort().join(", ");
      throw new Error(`Unsupported model '${model}'. Allowed values: ${allowed}.`);
    }
  }

  /** Record transcription event for tracing. */
  protected async _traceTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}
}

/** Convert a Sarvam `language_code` to a `language` setting value. */
function _languageFromCode(languageCode: string): string | null {
  return languageCode === "auto" ? null : languageCode;
}
