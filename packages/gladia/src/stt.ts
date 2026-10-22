// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/gladia/stt.py

/**
 * Gladia Speech-to-Text (STT) service implementation.
 *
 * This module provides a Speech-to-Text service using Gladia's real-time WebSocket API,
 * supporting multiple languages, custom vocabulary, and various audio processing options.
 *
 * Wire format (checked against Gladia's live docs):
 * - Session init: `POST https://api.gladia.io/v2/live[?region=us-west|eu-west]`
 *   with the `x-gladia-key` header and a JSON body; the 201 response carries
 *   `id` and a `wss://` `url` with a temporary token
 *   (https://docs.gladia.io/api-reference/v2/live/init).
 * - Socket: `{"type": "audio_chunk", "data": {"chunk": <base64>}}` to send
 *   audio, `{"type": "stop_recording"}` to end the session, and `transcript`
 *   messages back (https://docs.gladia.io/chapters/live-stt/getting-started).
 * - The `audio_chunk` acknowledgment (`byte_range`), `speech_start`,
 *   `speech_end` and `translation` messages are not in the public docs pages
 *   above; their handling follows upstream's code.
 *
 * Porting notes:
 * - Runs on `fetch` and the global `WebSocket` (through core's
 *   `websocketConnect`); no Gladia SDK, no `node:*` imports.
 * - DIVERGENCE: the deprecated `params` (`GladiaInputParams`) and `model` init
 *   arguments are not ported; use `settings` and the `encoding`, `bitDepth`
 *   and `channels` options.
 * - The session init `fetch` is injectable (`options.fetch`), standing in for
 *   upstream's `aiohttp.ClientSession`.
 */

import { Lock, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
  TranslationFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { GLADIA_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import {
  ConnectionClosed,
  State,
  type WebsocketClientConnection,
} from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

import type {
  LanguageConfig,
  MessagesConfig,
  PreProcessingConfig,
  RealtimeProcessingConfig,
} from "./config.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to Gladia's language code format.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding Gladia language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning.
 */
export function languageToGladiaLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "af",
    [Language.AM]: "am",
    [Language.AR]: "ar",
    [Language.AS]: "as",
    [Language.AZ]: "az",
    [Language.BA]: "ba",
    [Language.BE]: "be",
    [Language.BG]: "bg",
    [Language.BN]: "bn",
    [Language.BO]: "bo",
    [Language.BR]: "br",
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
    [Language.FO]: "fo",
    [Language.FR]: "fr",
    [Language.GL]: "gl",
    [Language.GU]: "gu",
    [Language.HA]: "ha",
    [Language.HAW]: "haw",
    [Language.HE]: "he",
    [Language.HI]: "hi",
    [Language.HR]: "hr",
    [Language.HT]: "ht",
    [Language.HU]: "hu",
    [Language.HY]: "hy",
    [Language.ID]: "id",
    [Language.IS]: "is",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.JV]: "jv",
    [Language.KA]: "ka",
    [Language.KK]: "kk",
    [Language.KM]: "km",
    [Language.KN]: "kn",
    [Language.KO]: "ko",
    [Language.LA]: "la",
    [Language.LB]: "lb",
    [Language.LN]: "ln",
    [Language.LO]: "lo",
    [Language.LT]: "lt",
    [Language.LV]: "lv",
    [Language.MG]: "mg",
    [Language.MI]: "mi",
    [Language.MK]: "mk",
    [Language.ML]: "ml",
    [Language.MN]: "mn",
    [Language.MR]: "mr",
    [Language.MS]: "ms",
    [Language.MT]: "mt",
    [Language.MY_MR]: "mymr",
    [Language.NE]: "ne",
    [Language.NL]: "nl",
    [Language.NN]: "nn",
    [Language.NO]: "no",
    [Language.OC]: "oc",
    [Language.PA]: "pa",
    [Language.PL]: "pl",
    [Language.PS]: "ps",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SA]: "sa",
    [Language.SD]: "sd",
    [Language.SI]: "si",
    [Language.SK]: "sk",
    [Language.SL]: "sl",
    [Language.SN]: "sn",
    [Language.SO]: "so",
    [Language.SQ]: "sq",
    [Language.SR]: "sr",
    [Language.SU]: "su",
    [Language.SV]: "sv",
    [Language.SW]: "sw",
    [Language.TA]: "ta",
    [Language.TE]: "te",
    [Language.TG]: "tg",
    [Language.TH]: "th",
    [Language.TK]: "tk",
    [Language.TL]: "tl",
    [Language.TR]: "tr",
    [Language.TT]: "tt",
    [Language.UK]: "uk",
    [Language.UR]: "ur",
    [Language.UZ]: "uz",
    [Language.VI]: "vi",
    [Language.YI]: "yi",
    [Language.YO]: "yo",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface GladiaSTTSettingsOptions extends STTSettingsOptions {
  /** Language detection and handling configuration. */
  languageConfig?: LanguageConfig | null | NotGiven;
  /** Additional metadata to include with requests. */
  customMetadata?: Dict | null | NotGiven;
  /** Silence duration in seconds to mark end of speech. */
  endpointing?: number | null | NotGiven;
  /** Maximum utterance duration without silence. */
  maximumDurationWithoutEndpointing?: number | null | NotGiven;
  /** Audio pre-processing options. */
  preProcessing?: PreProcessingConfig | null | NotGiven;
  /** Real-time processing features. */
  realtimeProcessing?: RealtimeProcessingConfig | null | NotGiven;
  /** WebSocket message filtering options. */
  messagesConfig?: MessagesConfig | null | NotGiven;
  /** Enable VAD to trigger end of utterance detection. */
  enableVad?: boolean | null | NotGiven;
}

/**
 * Settings for GladiaSTTService.
 *
 * - `languageConfig`: language detection and handling configuration.
 * - `customMetadata`: additional metadata to include with requests.
 * - `endpointing`: silence duration in seconds to mark end of speech.
 * - `maximumDurationWithoutEndpointing`: maximum utterance duration without silence.
 * - `preProcessing`: audio pre-processing options.
 * - `realtimeProcessing`: real-time processing features.
 * - `messagesConfig`: WebSocket message filtering options.
 * - `enableVad`: enable VAD to trigger end of utterance detection.
 */
export class GladiaSTTSettings extends STTSettings {
  languageConfig: LanguageConfig | null | NotGiven = NOT_GIVEN;
  customMetadata: Dict | null | NotGiven = NOT_GIVEN;
  endpointing: number | null | NotGiven = NOT_GIVEN;
  maximumDurationWithoutEndpointing: number | null | NotGiven = NOT_GIVEN;
  preProcessing: PreProcessingConfig | null | NotGiven = NOT_GIVEN;
  realtimeProcessing: RealtimeProcessingConfig | null | NotGiven = NOT_GIVEN;
  messagesConfig: MessagesConfig | null | NotGiven = NOT_GIVEN;
  enableVad: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: GladiaSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GladiaSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Gladia API key for authentication. */
  apiKey: string;
  /** Region used to process audio. eu-west or us-west. Defaults to eu-west. */
  region?: "us-west" | "eu-west" | null;
  /** Gladia API URL. Defaults to "https://api.gladia.io/v2/live". */
  url?: string;
  /** Audio encoding format. Defaults to `"wav/pcm"`. */
  encoding?: string;
  /** Audio bit depth. Defaults to 16. */
  bitDepth?: number;
  /** Number of audio channels. Defaults to 1. */
  channels?: number;
  /** Maximum size of audio buffer in bytes. Defaults to 20MB. */
  maxBufferSize?: number;
  /**
   * Determine whether the bot should be interrupted when Gladia VAD detects
   * user speech. Passed along to the user turn strategies this service
   * recommends, which own the interruption; a user-supplied
   * `userTurnStrategies` overrides the recommendation and this setting with
   * it. Defaults to true.
   */
  shouldInterrupt?: boolean;
  /** Runtime-updatable settings. */
  settings?: GladiaSTTSettings | null;
  /** `fetch` used for the session init request. Defaults to the global one. */
  fetch?: typeof fetch;
}

/**
 * Speech-to-Text service using Gladia's API.
 *
 * This service connects to Gladia's WebSocket API for real-time transcription
 * with support for multiple languages, custom vocabulary, and various processing options.
 * Provides automatic reconnection, audio buffering, and comprehensive error handling.
 *
 * For complete API documentation, see: https://docs.gladia.io/api-reference/v2/live/init
 */
export class GladiaSTTService extends WebsocketSTTService {
  static Settings: typeof GladiaSTTSettings = GladiaSTTSettings;
  declare protected _settings: GladiaSTTSettings;

  static {
    installTracedStt(GladiaSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _region: "us-west" | "eu-west" | null;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null = null;
  protected _encoding: string;
  protected _bitDepth: number;
  protected _channels: number;
  protected _fetch: typeof fetch;

  // Session management
  _sessionUrl: string | null = null;
  _sessionId: string | null = null;
  _connectionActive = false;

  // Audio buffer management
  _audioBuffer: Uint8Array = new Uint8Array(0);
  _bytesSent = 0;
  protected _maxBufferSize: number;
  protected _bufferLock = new Lock();

  // VAD state tracking
  protected _isSpeaking = false;
  protected _shouldInterrupt: boolean;

  /**
   * Initialize the Gladia STT service.
   *
   * @param options.apiKey Gladia API key for authentication.
   * @param options.region Region used to process audio. eu-west or us-west.
   *   Defaults to eu-west.
   * @param options.url Gladia API URL. Defaults to
   *   "https://api.gladia.io/v2/live".
   * @param options.encoding Audio encoding format. Defaults to `"wav/pcm"`.
   * @param options.bitDepth Audio bit depth. Defaults to 16.
   * @param options.channels Number of audio channels. Defaults to 1.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.maxBufferSize Maximum size of audio buffer in bytes.
   *   Defaults to 20MB.
   * @param options.shouldInterrupt Whether the bot is interrupted when Gladia
   *   VAD detects user speech. Defaults to true.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. See https://github.com/pipecat-ai/stt-benchmark.
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: GladiaSTTServiceOptions) {
    // 1. Initialize default settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof GladiaSTTService).Settings({
      model: "solaria-1",
      language: null,
      languageConfig: null,
      customMetadata: null,
      endpointing: null,
      maximumDurationWithoutEndpointing: 5,
      preProcessing: null,
      realtimeProcessing: null,
      messagesConfig: null,
      enableVad: false,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? GLADIA_TTFS_P99 : options.ttfsP99Latency,
      keepaliveTimeout: 20,
      keepaliveInterval: 5,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._region = options.region ?? null;
    this._url = options.url ?? "https://api.gladia.io/v2/live";
    this._receiveTask = null;

    // Init-only connection config
    this._encoding = options.encoding ?? "wav/pcm";
    this._bitDepth = options.bitDepth ?? 16;
    this._channels = options.channels ?? 1;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));

    this._maxBufferSize = options.maxBufferSize ?? 1024 * 1024 * 20;
    this._shouldInterrupt = options.shouldInterrupt ?? true;
  }

  override toString(): string {
    return `${this.name} [${this._sessionId}]`;
  }

  /**
   * Check if the service can generate performance metrics.
   *
   * @returns True, indicating this service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies when Gladia's VAD drives endpointing.
   *
   * With `enableVad` set, Gladia detects end of utterance server-side and
   * emits `ProposedUserStarted/StoppedSpeakingFrame`, so the user aggregator
   * resolves those rather than running local VAD/smart-turn. Without it the
   * defaults are left in place. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._settings.enableVad) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /**
   * Convert a Language enum to Gladia's language code.
   *
   * @returns The Gladia language code string.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToGladiaLanguage(language);
  }

  /** Build the session init request body. */
  _prepareSettings(): Dict {
    const s = this._settings;

    const settings: Dict = {
      encoding: this._encoding || "wav/pcm",
      bit_depth: this._bitDepth || 16,
      sample_rate: this.sampleRate,
      channels: this._channels || 1,
      model: s.model,
    };

    // Add custom_metadata if provided
    const customMetadata: Dict = { ...(assertGiven(s.customMetadata) ?? {}) };
    customMetadata.pipecat = pipecatVersion();
    settings.custom_metadata = customMetadata;

    // Add endpointing parameters if provided
    if (s.endpointing !== null) {
      settings.endpointing = s.endpointing;
    }
    if (s.maximumDurationWithoutEndpointing !== null) {
      settings.maximum_duration_without_endpointing = s.maximumDurationWithoutEndpointing;
    }

    // Add language configuration
    const languageConfig = assertGiven(s.languageConfig);
    if (languageConfig) {
      settings.language_config = languageConfig.modelDump();
    }

    // Add pre_processing configuration if provided
    const preProcessing = assertGiven(s.preProcessing);
    if (preProcessing) {
      settings.pre_processing = preProcessing.modelDump();
    }

    // Add realtime_processing configuration if provided
    const realtimeProcessing = assertGiven(s.realtimeProcessing);
    if (realtimeProcessing) {
      settings.realtime_processing = realtimeProcessing.modelDump();
    }

    // Add messages_config if provided
    const messagesConfig = assertGiven(s.messagesConfig);
    if (messagesConfig) {
      settings.messages_config = messagesConfig.modelDump();
    }

    return settings;
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
   * Apply settings delta.
   *
   * Settings are stored but not applied to the active session.
   *
   * @returns Mapping of changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    // TODO (upstream): someday we could reconnect here to apply updated settings.
    this._warnUnhandledUpdatedSettings(changed);

    return changed;
  }

  /**
   * Stop the Gladia STT websocket connection.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    // stop_recording ends the session server-side and has to reach the
    // socket before teardown closes it. Trailing transcripts are not
    // waited for: Gladia finalizes the session and its stored result
    // either way.
    await this._sendStopRecording();
    await super.stop(frame);
  }

  /**
   * Cancel the Gladia STT websocket connection.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Run speech-to-text on audio data.
   *
   * @param audio Raw audio bytes to transcribe.
   * @yields null (processing is handled asynchronously via WebSocket).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    // Add audio to buffer
    await this._bufferLock.run(async () => {
      const merged = new Uint8Array(this._audioBuffer.length + audio.length);
      merged.set(this._audioBuffer, 0);
      merged.set(audio, this._audioBuffer.length);
      this._audioBuffer = merged;
      // Trim buffer if it exceeds max size
      if (this._audioBuffer.length > this._maxBufferSize) {
        const trimSize = this._audioBuffer.length - this._maxBufferSize;
        this._audioBuffer = this._audioBuffer.slice(trimSize);
        this._bytesSent = Math.max(0, this._bytesSent - trimSize);
        logger.warning(`${this} Audio buffer exceeded max size, trimmed ${trimSize} bytes`);
      }
    });

    // Send audio if connected
    if (this._connectionActive && this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._sendAudio(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof ConnectionClosed) {
          logger.warning(`${this} Websocket closed while sending audio chunk: ${e.message}`);
          this._connectionActive = false;
        } else {
          throw e;
        }
      }
    }

    yield null;
  }

  /**
   * Connect to the Gladia service.
   *
   * Initializes the session if needed and establishes websocket connection.
   */
  override async _connect(): Promise<void> {
    // Initialize session if needed
    if (!this._sessionUrl) {
      const settings = this._prepareSettings();
      const response = await this._setupGladia(settings);
      this._sessionUrl = response.url;
      this._sessionId = response.id;
      logger.info(`${this} Session URL: ${this._sessionUrl}`);
    }

    await this._connectWebsocket();

    await super._connect();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(
        () => this._receiveTaskHandler((error, options) => this._reportError(error, options)),
        "_receive_task_handler",
      );
    }
  }

  /**
   * Disconnect from the Gladia service.
   *
   * Cleans up tasks and closes websocket connection.
   */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    this._connectionActive = false;

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Establish the websocket connection to Gladia. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug(`${this}Connecting to Gladia WebSocket`);

      if (this._sessionUrl === null) {
        throw new Error(`${this} session URL is not initialized`);
      }
      this._websocket = await this._websocketConnect(this._sessionUrl);
      this._connectionActive = true;

      // Reset byte tracking for new connection
      await this._bufferLock.run(async () => {
        this._bytesSent = 0;
      });

      await this._callEventHandler("on_connected");

      // Send buffered audio if any
      await this._sendBufferedAudio();

      logger.debug(`${this} Connected to Gladia WebSocket`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      this._connectionActive = false;
      await this.pushError(`Unable to connect to Gladia: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Close the websocket connection to Gladia. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug(`${this} Disconnecting from Gladia WebSocket`);
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

  /** Initialize a live session: `POST /v2/live`, returning `{id, url}`. */
  async _setupGladia(settings: Dict): Promise<Dict> {
    const url = new URL(this._url);
    if (this._region) {
      url.searchParams.set("region", this._region);
    }
    const response = await this._fetch(url.toString(), {
      method: "POST",
      headers: { "X-Gladia-Key": this._apiKey, "Content-Type": "application/json" },
      body: pyJsonDumps(settings),
    });
    if (response.ok) {
      return (await response.json()) as Dict;
    }
    const errorText = await response.text();
    logger.error(`${this} Gladia error: ${response.status}: ${errorText || response.statusText}`);
    throw new Error(
      `${this} Failed to initialize Gladia session: ${response.status} - ${errorText}`,
    );
  }

  /** Record a transcription for tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {}

  /**
   * Handle speech start event from Gladia.
   *
   * Broadcasts ProposedUserStartedSpeakingFrame when VAD is enabled.
   */
  async _onSpeechStarted(): Promise<void> {
    if (!this._settings.enableVad || this._isSpeaking) {
      return;
    }

    logger.debug(`${this} User started speaking`);
    this._isSpeaking = true;

    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /**
   * Handle speech end event from Gladia.
   *
   * Broadcasts ProposedUserStoppedSpeakingFrame when VAD is enabled.
   */
  async _onSpeechEnded(): Promise<void> {
    if (!this._settings.enableVad || !this._isSpeaking) {
      return;
    }
    this._isSpeaking = false;
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    logger.debug(`${this} User stopped speaking`);
  }

  /** Send audio chunk with proper message format. */
  async _sendAudio(audio: Uint8Array): Promise<void> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      const data = bytesToBase64(audio);
      const message = { type: "audio_chunk", data: { chunk: data } };
      await this._websocket.send(pyJsonDumps(message));
    }
  }

  /** Send any buffered audio after reconnection. */
  async _sendBufferedAudio(): Promise<void> {
    await this._bufferLock.run(async () => {
      if (this._audioBuffer.length > 0) {
        logger.debug(`${this} Sending ${this._audioBuffer.length} bytes of buffered audio`);
        await this._sendAudio(this._audioBuffer.slice());
      }
    });
  }

  async _sendStopRecording(): Promise<void> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      await this._websocket.send(pyJsonDumps({ type: "stop_recording" }));
    }
  }

  /**
   * Get the current WebSocket connection.
   *
   * @throws Error if WebSocket is not connected.
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
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let content: Dict;
      try {
        content = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`${this} Received non-JSON message: ${text}`);
          continue;
        }
        throw e;
      }

      // Handle audio chunk acknowledgments
      if (content.type === "audio_chunk" && content.acknowledged) {
        const byteRange: number[] = content.data.byte_range;
        await this._bufferLock.run(async () => {
          // Update bytes sent and trim acknowledged data from buffer
          const endByte = byteRange[1] as number;
          if (endByte > this._bytesSent) {
            const trimSize = endByte - this._bytesSent;
            this._audioBuffer = this._audioBuffer.slice(trimSize);
            this._bytesSent = endByte;
          }
        });
      } else if (content.type === "audio_chunk") {
        const error = content.error?.message ?? "Unknown error";
        await this.pushError(`Gladia rejected an audio chunk: ${error}`);
      } else if (content.type === "transcript") {
        const utterance = content.data.utterance;
        const language = utterance.language;
        const transcript = utterance.text;
        const isFinal = content.data.is_final;
        if (isFinal) {
          // Report usage before the transcription frame so tracing can
          // attach it to the STT span the frame closes.
          await this.emitSttUsageMetrics();
          await this.pushFrame(
            new TranscriptionFrame({
              text: transcript,
              userId: this._userId,
              timestamp: timeNowIso8601(),
              language,
              result: content,
            }),
          );
          await this._handleTranscription(transcript, isFinal, language);
        } else {
          await this.pushFrame(
            new InterimTranscriptionFrame({
              text: transcript,
              userId: this._userId,
              timestamp: timeNowIso8601(),
              language,
              result: content,
            }),
          );
        }
      } else if (content.type === "translation") {
        if (content.error || content.data === null || content.data === undefined) {
          const error = content.error?.message ?? "Unknown error";
          await this.pushError(`Gladia translation addon error: ${error}`);
          continue;
        }
        const translatedUtterance = content.data.translated_utterance;
        const originalLanguage = content.data.original_language;
        const translatedLanguage = translatedUtterance.language;
        const translation = translatedUtterance.text;
        if (translatedLanguage !== originalLanguage) {
          await this.pushFrame(
            new TranslationFrame({
              text: translation,
              userId: "",
              timestamp: timeNowIso8601(),
              language: translatedLanguage,
            }),
          );
        }
      } else if (content.type === "speech_start") {
        await this._onSpeechStarted();
      } else if (content.type === "speech_end") {
        await this._onSpeechEnded();
      }
    }
  }

  /**
   * Send an empty audio chunk to keep the Gladia connection alive.
   *
   * @param _silence Silent PCM audio bytes (unused, Gladia accepts empty chunks).
   */
  protected override async _sendKeepalive(_silence: Uint8Array): Promise<void> {
    await this._sendAudio(new Uint8Array(0));
  }
}
