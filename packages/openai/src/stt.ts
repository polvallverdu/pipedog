// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/stt.py

/**
 * OpenAI Speech-to-Text service implementations.
 *
 * Provides two STT services:
 *
 * - `OpenAISTTService`: REST-based transcription using the Audio API
 *   (Whisper / GPT transcription models).
 * - `OpenAIRealtimeSTTService`: WebSocket-based streaming transcription
 *   using the Realtime API in transcription-only mode.
 *
 * Porting notes:
 * - `OpenAISTTService` uses the `openai` JS SDK client built by
 *   `BaseWhisperSTTService` (`@pipedog/whisper`).
 * - `OpenAIRealtimeSTTService` uses the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`. The `Authorization` header is sent
 *   on the opening handshake on Bun, Node, Deno and Cloudflare Workers (where
 *   core opens the socket through `fetch` with an `Upgrade: websocket`
 *   header); browsers can't send it.
 * - Deprecated APIs are not ported: the `model`, `language`, `prompt`,
 *   `temperature` (`OpenAISTTService`) and `model`, `language`, `prompt`,
 *   `noiseReduction` (`OpenAIRealtimeSTTService`) constructor options.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { OPENAI_REALTIME_TTFS_P99, OPENAI_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  BaseWhisperSTTService,
  type BaseWhisperSTTServiceOptions,
  BaseWhisperSTTSettings,
  type BaseWhisperSTTSettingsOptions,
  type Transcription,
} from "@pipedog/whisper/base_stt";
import { toFile } from "openai";
import { OPENAI_REALTIME_WHISPER_MODEL, OPENAI_SAMPLE_RATE } from "./_constants.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OpenAISTTSettingsOptions extends BaseWhisperSTTSettingsOptions {
  /**
   * Words or phrases that guide transcription of the input audio, such as
   * product names or acronyms. Supported by "gpt-transcribe".
   */
  keywords?: string[] | null | NotGiven;
}

/**
 * Settings for the OpenAI STT service.
 *
 * - `keywords`: words or phrases that guide transcription of the input
 *   audio, such as product names or acronyms. Supported by
 *   "gpt-transcribe".
 */
export class OpenAISTTSettings extends BaseWhisperSTTSettings {
  keywords: string[] | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAISTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface OpenAISTTServiceOptions extends BaseWhisperSTTServiceOptions {
  /** Runtime-updatable settings. */
  settings?: OpenAISTTSettings | null;
}

/**
 * OpenAI Speech-to-Text service that generates text from audio.
 *
 * Uses OpenAI's transcription API to convert audio to text. Requires an
 * OpenAI API key set via the apiKey option or OPENAI_API_KEY environment
 * variable.
 *
 * With `includeProbMetrics: true`, GPT transcription models report per-token
 * logprobs and Whisper models report per-segment logprobs. Diarization models
 * support neither, so they report no probabilities.
 */
export class OpenAISTTService extends BaseWhisperSTTService {
  static override Settings: typeof OpenAISTTSettings = OpenAISTTSettings;
  declare protected _settings: OpenAISTTSettings;

  /**
   * Model already reported as unable to supply probabilities, so that warning
   * is logged once per model rather than once per utterance.
   */
  protected _probMetricsWarnedModel: string | null = null;

  /**
   * Initialize OpenAI STT service.
   *
   * @param options.apiKey OpenAI API key. Defaults to null.
   * @param options.baseUrl API base URL. Defaults to null.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-transcribe", language English).
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to BaseWhisperSTTService.
   */
  constructor(options: OpenAISTTServiceOptions = {}) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof OpenAISTTService).Settings({
      model: "gpt-transcribe",
      language: Language.EN,
      prompt: null,
      temperature: null,
      keywords: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      settings: defaultSettings,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? OPENAI_TTFS_P99 : options.ttfsP99Latency,
    });
  }

  protected override async _transcribe(audio: Uint8Array): Promise<Transcription> {
    if (this._settings.language === null) {
      throw new Error("AssertionError: language must be set");
    }

    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("AssertionError: model must be set");
    }

    // Build kwargs dict with only set parameters
    const kwargs: Dict = {
      file: await toFile(audio, "audio.wav", { type: "audio/wav" }),
      model,
      language: this._settings.language,
    };

    if (this._includeProbMetrics) {
      // GPT transcription models return logprobs alongside a "json" response;
      // Whisper models carry per-segment logprobs in "verbose_json" instead.
      // Diarization models support neither and reject the logprobs request.
      if (model.startsWith("whisper")) {
        kwargs.response_format = "verbose_json";
      } else if (model.includes("diarize")) {
        if (this._probMetricsWarnedModel !== model) {
          this._probMetricsWarnedModel = model;
          logger.warning(
            `${this}: ${model} does not support probability metrics; ` +
              "transcription results will carry no probability.",
          );
        }
      } else {
        kwargs.response_format = "json";
        kwargs.include = ["logprobs"];
      }
    }

    if (this._settings.prompt !== null) {
      kwargs.prompt = this._settings.prompt;
    }

    if (this._settings.temperature !== null) {
      kwargs.temperature = this._settings.temperature;
    }

    const keywords = this._settings.keywords;
    if (Array.isArray(keywords) && keywords.length > 0) {
      kwargs.keywords = keywords;
    }

    return (await this._client.audio.transcriptions.create(kwargs as any)) as Transcription;
  }
}

export type OpenAIRealtimeNoiseReduction = "near_field" | "far_field";
export type OpenAIRealtimeDelay = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenAIRealtimeSTTSettingsOptions extends STTSettingsOptions {
  /**
   * Optional prompt text to guide transcription style. Not supported by
   * "gpt-realtime-whisper".
   */
  prompt?: string | null | NotGiven;
  /**
   * Noise reduction mode. "near_field" for close microphones, "far_field"
   * for distant microphones, or null to disable.
   */
  noiseReduction?: OpenAIRealtimeNoiseReduction | null | NotGiven;
  /**
   * How long the model waits before emitting transcription text, trading
   * latency for accuracy. Only supported by "gpt-realtime-whisper".
   */
  delay?: OpenAIRealtimeDelay | null | NotGiven;
}

/**
 * Settings for OpenAIRealtimeSTTService.
 *
 * - `prompt`: optional prompt text to guide transcription style. Not
 *   supported by "gpt-realtime-whisper".
 * - `noiseReduction`: noise reduction mode. "near_field" for close
 *   microphones, "far_field" for distant microphones, or null to disable.
 * - `delay`: how long the model waits before emitting transcription text,
 *   trading latency for accuracy. Only supported by "gpt-realtime-whisper".
 */
export class OpenAIRealtimeSTTSettings extends STTSettings {
  prompt: string | null | NotGiven = NOT_GIVEN;
  noiseReduction: OpenAIRealtimeNoiseReduction | null | NotGiven = NOT_GIVEN;
  delay: OpenAIRealtimeDelay | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAIRealtimeSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface OpenAIRealtimeSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** OpenAI API key for authentication. */
  apiKey: string;
  /**
   * WebSocket base URL for the Realtime API. Defaults to
   * "wss://api.openai.com/v1/realtime".
   */
  baseUrl?: string;
  /**
   * Server-side VAD configuration. Defaults to `false` (disabled), which
   * relies on a local VAD processor in the pipeline. Pass an object to enable
   * it — at minimum `{ type: "server_vad" }`, optionally with custom settings
   * (e.g. `{ type: "server_vad", threshold: 0.5 }`). Requires a model that
   * supports turn detection. `null` omits the field entirely, leaving the
   * session's own default in place.
   */
  turnDetection?: Dict | false | null;
  /**
   * Whether to interrupt bot output when speech is detected by server-side
   * VAD. Only applies when turn detection is enabled. Passed along to the
   * user turn strategies this service recommends, which own the
   * interruption; a user-supplied `userTurnStrategies` overrides the
   * recommendation and this setting with it. Defaults to true.
   */
  shouldInterrupt?: boolean;
  /** Runtime-updatable settings. */
  settings?: OpenAIRealtimeSTTSettings | null;
}

/**
 * OpenAI Realtime Speech-to-Text service using WebSocket transcription sessions.
 *
 * Uses OpenAI's Realtime API in transcription-only mode for real-time
 * streaming speech recognition with optional server-side VAD and noise
 * reduction. The model does not generate conversational responses — only
 * transcription output.
 *
 * This service supports two VAD modes:
 *
 * **Local VAD** (default): Disable server-side VAD and use a local VAD
 * processor in the pipeline instead. When a `VADUserStoppedSpeakingFrame` is
 * received, the service commits the audio buffer so that the server begins
 * transcription for the completed speech segment.
 *
 * **Server-side VAD** (`turnDetection: { type: "server_vad" }`): The OpenAI
 * server performs voice-activity detection. The service proposes turn
 * boundaries when the server detects them, and recommends the external user
 * turn strategies that resolve those proposals into turn frames. Do **not**
 * use a separate VAD processor in the pipeline in this mode. Requires a model
 * that supports turn detection — `gpt-transcribe` does, the default
 * `gpt-realtime-whisper` does not.
 *
 * Audio is sent as 24 kHz 16-bit mono PCM as required by the OpenAI Realtime
 * API. If the pipeline runs at a different sample rate (e.g. 16 kHz for
 * Silero VAD compatibility), audio is automatically upsampled before sending.
 *
 * @example
 * const stt = new OpenAIRealtimeSTTService({
 *   apiKey: "sk-...",
 *   settings: new OpenAIRealtimeSTTService.Settings({
 *     model: "gpt-realtime-whisper",
 *     noiseReduction: "near_field",
 *   }),
 * });
 */
export class OpenAIRealtimeSTTService extends WebsocketSTTService {
  static Settings: typeof OpenAIRealtimeSTTSettings = OpenAIRealtimeSTTSettings;
  declare protected _settings: OpenAIRealtimeSTTSettings;

  static {
    installTracedStt(OpenAIRealtimeSTTService.prototype, "_handleTranscriptionTrace");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _turnDetection: Dict | false | null;
  protected _shouldInterrupt: boolean;
  protected _receiveTask: Task<unknown> | null = null;
  protected _sessionReady = false;
  protected _resampler: BaseAudioResampler;
  protected _serverVadEnabled: boolean;

  /**
   * Initialize the OpenAI Realtime STT service.
   *
   * @param options.apiKey OpenAI API key for authentication.
   * @param options.baseUrl WebSocket base URL for the Realtime API. Defaults
   *   to "wss://api.openai.com/v1/realtime".
   * @param options.turnDetection Server-side VAD configuration. Defaults to
   *   `false` (disabled).
   * @param options.shouldInterrupt Whether to interrupt bot output when speech
   *   is detected by server-side VAD. Defaults to true.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-realtime-whisper", language English).
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to parent WebsocketSTTService.
   */
  constructor(options: OpenAIRealtimeSTTServiceOptions) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof OpenAIRealtimeSTTService).Settings({
      model: OPENAI_REALTIME_WHISPER_MODEL,
      language: Language.EN,
      prompt: null,
      noiseReduction: null,
      delay: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    OpenAIRealtimeSTTService._omitUnsupportedPrompt(defaultSettings);

    super({
      ...options,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? OPENAI_REALTIME_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "wss://api.openai.com/v1/realtime";

    const turnDetection = options.turnDetection === undefined ? false : options.turnDetection;
    this._turnDetection = turnDetection;
    this._shouldInterrupt = options.shouldInterrupt ?? true;

    this._resampler = createStreamResampler();

    // Server-side VAD is disabled by default (turnDetection: false).
    // Set to null or an object to enable server-side VAD.
    this._serverVadEnabled = turnDetection !== false;
  }

  /** Drop prompt settings that are not accepted by the selected model. */
  static _omitUnsupportedPrompt(settings: OpenAIRealtimeSTTSettings): Record<string, unknown> {
    if (settings.model === OPENAI_REALTIME_WHISPER_MODEL && settings.prompt) {
      const oldPrompt = settings.prompt;
      settings.prompt = null;
      logger.warning(
        `${OPENAI_REALTIME_WHISPER_MODEL} does not support the prompt parameter; ` +
          "omitting prompt from OpenAI Realtime transcription session.",
      );
      return { prompt: oldPrompt };
    }
    return {};
  }

  /**
   * Convert a Language value to an ISO-639-1 code.
   *
   * @param language The Language value.
   * @returns Two-letter ISO-639-1 language code.
   */
  static _languageToCode(language: Language | string): string {
    // Language value is e.g. "en", "en-US", "fr", "zh".
    return String(language).split("-")[0]!.toLowerCase();
  }

  /**
   * Check if the service can generate processing metrics.
   *
   * @returns True, as this service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Request external turn strategies when server-side VAD drives turns.
   *
   * With server-side VAD enabled the OpenAI server detects speech boundaries
   * and this service proposes turns from them, so the user aggregator
   * resolves those rather than running local VAD/smart-turn. With
   * `turnDetection: false` (the default) the server emits no VAD events and
   * the defaults are left in place. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._serverVadEnabled) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies({
        enableInterruptions: this._shouldInterrupt,
      });
    }
    return frame;
  }

  /**
   * Apply a settings delta and send session update if needed.
   *
   * Sends a `session.update` to the server when the session is active.
   *
   * @param delta An STTSettings (or `OpenAIRealtimeSTTService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    for (const [fieldName, previousValue] of Object.entries(
      OpenAIRealtimeSTTService._omitUnsupportedPrompt(this._settings),
    )) {
      if (!Object.hasOwn(changed, fieldName)) {
        changed[fieldName] = previousValue;
      }
    }

    if (Object.keys(changed).length > 0 && this._sessionReady) {
      await this._sendSessionUpdate();
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
   * Stop the service and close WebSocket connection.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and close WebSocket connection.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Send audio data to the transcription session.
   *
   * Audio is streamed over the WebSocket. Transcription results arrive
   * asynchronously via the receive task and are pushed as
   * `InterimTranscriptionFrame` or `TranscriptionFrame`.
   *
   * @param audio Raw audio bytes (16-bit mono PCM at the pipeline sample
   *   rate). Automatically resampled to 24 kHz.
   * @returns null — results are delivered via the WebSocket receive task.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    await this._sendAudio(audio);
    yield null;
  }

  /**
   * Process frames from the pipeline.
   *
   * Extends the base STT service to handle local VAD events when server-side
   * VAD is disabled. On `VADUserStoppedSpeakingFrame`, commits the audio
   * buffer so the server begins transcription for the completed speech
   * segment.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Handle local VAD events when server-side VAD is disabled.
    if (!this._serverVadEnabled) {
      if (frame instanceof VADUserStoppedSpeakingFrame) {
        await this._commitAudioBuffer();
      }
    }
  }

  // ------------------------------------------------------------------
  // WebSocket connection management
  // ------------------------------------------------------------------

  /** Connect to the transcription endpoint and start receiving. */
  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Disconnect and clean up background tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask, 1.0);
      this._receiveTask = null;
    }
    await this._disconnectWebsocket();
  }

  /** Establish the WebSocket connection to the transcription endpoint. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      this._sessionReady = false;
      const url = `${this._baseUrl}?intent=transcription`;
      this._websocket = await this._websocketConnect(url, {
        additionalHeaders: {
          Authorization: `Bearer ${this._apiKey}`,
        },
      });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to OpenAI Realtime STT: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
    }
  }

  /** Close the WebSocket connection. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      this._sessionReady = false;
      if (this._websocket) {
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Send a JSON message over the WebSocket.
   *
   * @param message The message object to serialize and send.
   */
  protected async _wsSend(message: Dict): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps(message));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error sending message: ${errorMessage(e)}`, { exception: e });
    }
  }

  // ------------------------------------------------------------------
  // Client events
  // ------------------------------------------------------------------

  /** Send `session.update` to configure the transcription session. */
  protected async _sendSessionUpdate(): Promise<void> {
    const transcription: Dict = { model: this._settings.model };

    // Technically `_settings.language` could be a raw string, but Language
    // values are strings so downstream handles either.
    const language = assertGiven(this._settings.language);
    const languageCode = language ? OpenAIRealtimeSTTService._languageToCode(language) : null;
    if (languageCode) {
      transcription.language = languageCode;
    }

    if (this._settings.prompt) {
      transcription.prompt = this._settings.prompt;
    }

    if (this._settings.delay) {
      transcription.delay = this._settings.delay;
    }

    const inputAudio: Dict = {
      format: {
        type: "audio/pcm",
        rate: OPENAI_SAMPLE_RATE,
      },
      transcription,
    };

    // Turn detection
    if (this._turnDetection === false) {
      inputAudio.turn_detection = null;
    } else if (this._turnDetection !== null) {
      inputAudio.turn_detection = this._turnDetection;
    }

    // Noise reduction
    if (this._settings.noiseReduction) {
      inputAudio.noise_reduction = {
        type: this._settings.noiseReduction,
      };
    }

    await this._wsSend({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: inputAudio,
        },
      },
    });
  }

  /**
   * Send audio data via `input_audio_buffer.append`.
   *
   * Resamples from the pipeline sample rate to 24 kHz if needed.
   *
   * @param audio Raw audio bytes at the pipeline sample rate.
   */
  protected async _sendAudio(audio: Uint8Array): Promise<void> {
    const resampled = await this._resampler.resample(audio, this.sampleRate, OPENAI_SAMPLE_RATE);
    if (!resampled || resampled.length === 0) {
      return;
    }
    const payload = bytesToBase64(resampled);
    await this._wsSend({
      type: "input_audio_buffer.append",
      audio: payload,
    });
  }

  /** Commit the current audio buffer for transcription. */
  protected async _commitAudioBuffer(): Promise<void> {
    await this._wsSend({ type: "input_audio_buffer.commit" });
  }

  /** Clear the current audio buffer. */
  protected async _clearAudioBuffer(): Promise<void> {
    await this._wsSend({ type: "input_audio_buffer.clear" });
  }

  // ------------------------------------------------------------------
  // Server event handling
  // ------------------------------------------------------------------

  /**
   * Receive and dispatch server events from the transcription session.
   *
   * Called by `WebsocketService._receiveTaskHandler` which wraps this method
   * with automatic reconnection on connection errors.
   */
  override async _receiveMessages(): Promise<void> {
    if (!this._websocket) {
      throw new Error("Websocket not connected");
    }
    for await (const message of this._websocket) {
      let evt: Dict;
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        evt = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning("Failed to parse WebSocket message");
        continue;
      }

      const evtType = evt.type ?? "";

      if (evtType === "session.created") {
        await this._handleSessionCreated(evt);
      } else if (evtType === "session.updated") {
        await this._handleSessionUpdated(evt);
      } else if (evtType === "conversation.item.input_audio_transcription.delta") {
        await this._handleTranscriptionDelta(evt);
      } else if (evtType === "conversation.item.input_audio_transcription.completed") {
        await this._handleTranscriptionCompleted(evt);
      } else if (evtType === "conversation.item.input_audio_transcription.failed") {
        await this._handleTranscriptionFailed(evt);
      } else if (evtType === "input_audio_buffer.speech_started") {
        await this._handleSpeechStarted(evt);
      } else if (evtType === "input_audio_buffer.speech_stopped") {
        await this._handleSpeechStopped(evt);
      } else if (evtType === "input_audio_buffer.committed") {
        logger.trace(`Audio buffer committed: item_id=${evt.item_id ?? ""}`);
      } else if (evtType === "error") {
        await this._handleError(evt);
      } else {
        logger.trace(`Unhandled event: ${evtType}`);
      }
    }
  }

  /**
   * Handle `session.created`.
   *
   * Sent immediately after connecting. We respond by configuring the session
   * with our desired settings.
   *
   * @param _evt The session created event from the server.
   */
  protected async _handleSessionCreated(_evt: Dict): Promise<void> {
    logger.debug("Transcription session created, sending configuration");
    await this._sendSessionUpdate();
  }

  /**
   * Handle `session.updated`.
   *
   * The session is now fully configured and ready to transcribe.
   *
   * @param _evt The session updated event from the server.
   */
  protected async _handleSessionUpdated(_evt: Dict): Promise<void> {
    logger.debug("Transcription session configured and ready");
    this._sessionReady = true;
  }

  /**
   * Handle incremental transcription text.
   *
   * For "gpt-realtime-whisper", "gpt-live-transcribe", and "gpt-transcribe",
   * deltas contain low-latency streaming partial text.
   *
   * @param evt The delta event from the server.
   */
  protected async _handleTranscriptionDelta(evt: Dict): Promise<void> {
    const delta = evt.delta ?? "";
    if (delta) {
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: delta,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          result: evt,
        }),
      );
    }
  }

  /**
   * Handle a completed transcription for a speech segment.
   *
   * Pushes a `TranscriptionFrame` and records the result for tracing.
   *
   * @param evt The completed event containing the full transcript.
   */
  protected async _handleTranscriptionCompleted(evt: Dict): Promise<void> {
    const transcript = evt.transcript ?? "";
    if (transcript) {
      // Report usage before the transcription frame so tracing can attach it
      // to the STT span the frame closes.
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          result: evt,
        }),
      );
      await this._handleTranscriptionTrace(transcript, true);
    }
  }

  /**
   * Record transcription result for tracing.
   *
   * @param _transcript The transcribed text.
   * @param _isFinal Whether this is a final transcription result.
   * @param _language Optional language of the transcription.
   */
  protected async _handleTranscriptionTrace(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /**
   * Handle server-side VAD speech start.
   *
   * Proposes a turn start, which the user turn strategies resolve into a
   * `UserStartedSpeakingFrame` and an interruption.
   *
   * @param _evt The `input_audio_buffer.speech_started` event.
   */
  protected async _handleSpeechStarted(_evt: Dict): Promise<void> {
    logger.debug("Server VAD: speech started");
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
  }

  /**
   * Handle server-side VAD speech stop.
   *
   * Proposes a turn stop. The audio buffer is automatically committed by the
   * server when VAD is enabled.
   *
   * @param _evt The `input_audio_buffer.speech_stopped` event.
   */
  protected async _handleSpeechStopped(_evt: Dict): Promise<void> {
    logger.debug("Server VAD: speech stopped");
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /**
   * Handle a transcription failure for a speech segment.
   *
   * Logs the error but does not treat it as fatal — the session remains
   * active for subsequent turns.
   *
   * @param evt The failed event containing error details.
   */
  protected async _handleTranscriptionFailed(evt: Dict): Promise<void> {
    const error = evt.error ?? {};
    const errorMsg = error.message ?? "Transcription failed";
    await this.pushError(`OpenAI Realtime STT error: ${errorMsg}`);
  }

  /**
   * Handle a fatal error from the transcription session.
   *
   * Throws so that `WebsocketService` can decide whether to attempt
   * reconnection.
   *
   * @param evt The error event.
   */
  protected async _handleError(evt: Dict): Promise<void> {
    const error = evt.error ?? {};
    const errorMsg = error.message ?? "Unknown error";
    const errorCode = error.code ?? "";
    const msg = `OpenAI Realtime STT error [${errorCode}]: ${errorMsg}`;
    await this.pushError(msg);
    throw new Error(msg);
  }
}
