// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/gradium/stt.py

/**
 * Gradium's speech-to-text service implementation.
 *
 * This module provides integration with Gradium's real-time speech-to-text
 * WebSocket API for streaming audio transcription, with optional turn detection
 * from the server's end-pointing signal.
 *
 * Wire format: upstream's, checked against Gradium's API reference
 * (https://docs.gradium.ai/api-reference/endpoint/stt-websocket.md): the
 * `wss://api.gradium.ai/api/speech/asr` endpoint, an `x-api-key` header, and
 * the `setup`, `audio`, `flush`, `ready`, `text`, `step`, `flushed`,
 * `end_of_stream` and `error` messages.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), which sends the `x-api-key` header on every
 *   runtime.
 * - Deprecated upstream APIs are not ported: `InputParams` and the `params`
 *   and `json_config` constructor parameters (use `settings`).
 * - DIVERGENCE: upstream tests patch the module constant
 *   `TRANSCRIPT_AGGREGATION_DELAY` with `monkeypatch`. An ES module export is
 *   read-only, so the delay is read from the protected instance field
 *   `_transcriptAggregationDelay`, which starts at the constant.
 */

import { rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
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
import { GRADIUM_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Seconds to wait after a "flushed" message for trailing text tokens to arrive
 * before finalizing the transcription.
 */
export const TRANSCRIPT_AGGREGATION_DELAY = 0.1;

// Turn detection defaults: the end-pointing horizon watched, the inactivity
// probability that opens and closes a turn, and how many step messages to let
// pass after a flush before the signal is trusted again.
export const DEFAULT_EOT_HORIZON_S = 3.0;
export const DEFAULT_EOT_THRESHOLD = 0.5;
export const DEFAULT_POST_FLUSH_COOLDOWN_FRAMES = 8;

// Settings read on the client as step messages arrive; a change to any of
// them takes effect on the next step without a reconnect.
const _TURN_DETECTION_FIELDS = new Set(["eotHorizonS", "eotThreshold", "postFlushCooldownFrames"]);

/**
 * Where turn detection is in a turn's lifecycle.
 *
 * IDLE waits for the signal to read inactive, ARMED opens a turn on the next
 * dip, OPEN is a turn in progress, and ENDING has proposed the stop and
 * flushed the server, and ignores the signal until the turn's transcript is
 * pushed, then hands over to ARMED.
 */
export const _TurnPhase = {
  IDLE: "IDLE",
  ARMED: "ARMED",
  OPEN: "OPEN",
  ENDING: "ENDING",
} as const;
export type _TurnPhase = (typeof _TurnPhase)[keyof typeof _TurnPhase];

// Gradium's language code asking it to detect the language rather than being
// grounded to one. It is not a Language enum member because it names a mode
// rather than a language, so it is passed through as a plain string.
const _GRADIUM_ANY_LANGUAGE = "any";

/**
 * Pick the PCM sample rate to send audio at.
 *
 * @param sampleRate The pipeline's input sample rate in Hz.
 * @returns The lowest rate Gradium accepts at or above `sampleRate`, or the
 *   highest one it accepts.
 */
export function _gradiumPcmSampleRate(sampleRate: number): number {
  return [8000, 16000, 24000].find((rate) => rate >= sampleRate) ?? 24000;
}

/**
 * Build Gradium input_format from encoding type and sample rate.
 *
 * For PCM encoding, appends the sample rate (e.g., "pcm_16000"). For other
 * encodings (wav, opus), returns the encoding as-is.
 *
 * @param encoding Base encoding type ("pcm", "wav", or "opus").
 * @param sampleRate Audio sample rate in Hz.
 * @returns The full input_format string for the Gradium API.
 */
export function _inputFormatFromEncoding(encoding: string, sampleRate: number): string {
  if (encoding === "pcm") {
    switch (sampleRate) {
      case 8000:
        return "pcm_8000";
      case 16000:
        return "pcm_16000";
      case 24000:
        return "pcm_24000";
    }
    logger.warning(
      `GradiumSTTService: unsupported sample rate ${sampleRate} for PCM encoding, using pcm_16000`,
    );
    return "pcm_16000";
  }
  return encoding;
}

/**
 * Convert a Language enum to Gradium's language code format.
 *
 * @param language The Language enum value to convert, or `"any"`.
 * @returns The corresponding Gradium language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning.
 */
export function languageToGradiumLanguage(language: Language | string): string {
  if (language === _GRADIUM_ANY_LANGUAGE) {
    return _GRADIUM_ANY_LANGUAGE;
  }

  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FR]: "fr",
    [Language.PT]: "pt",
  };

  // A raw string that is not a Language falls through to the base-code
  // branch of resolveLanguage, which handles it as-is.
  return resolveLanguage(language as Language, LANGUAGE_MAP, true);
}

export interface GradiumSTTSettingsOptions extends STTSettingsOptions {
  /** Delay in audio frames before text is generated. See `GradiumSTTSettings`. */
  delayInFrames?: number | null | NotGiven;
  /** End-pointing horizon that drives turn decisions. */
  eotHorizonS?: number | null | NotGiven;
  /** Inactivity probability that opens and closes a turn. */
  eotThreshold?: number | null | NotGiven;
  /** Step messages to ignore after a flush. */
  postFlushCooldownFrames?: number | null | NotGiven;
}

/**
 * Settings for GradiumSTTService.
 *
 * The `eot*` and `postFlushCooldownFrames` fields tune turn detection. They
 * are `null` unless the service is constructed with
 * `enableTurnDetection: true`, which gives them their defaults.
 *
 * - `delayInFrames`: Delay in audio frames (80ms each) before text is
 *   generated. Higher delays allow more context but increase latency. Allowed
 *   values: 7, 8, 10, 12, 14, 16, 20, 24, 36, 48. Default is 12 (960ms).
 *   Lower values like 7-8 give faster response.
 * - `eotHorizonS`: Which end-pointing horizon drives turn decisions; the step
 *   entry with the closest `horizon_s` is used. Default 3.0.
 * - `eotThreshold`: Inactivity probability on that horizon at or above which
 *   an open turn ends, and below which a turn opens once the signal has read
 *   inactive. Default 0.5.
 * - `postFlushCooldownFrames`: Number of step messages to ignore after a
 *   flush completes before the next turn may start or end. A flush feeds the
 *   model `delayInFrames` of silence, and the end-pointing signal is
 *   unreliable on the frames that follow: it can dip as if speech resumed,
 *   then fire again on the first real frames. Default 8.
 */
export class GradiumSTTSettings extends STTSettings {
  delayInFrames: number | null | NotGiven = NOT_GIVEN;
  eotHorizonS: number | null | NotGiven = NOT_GIVEN;
  eotThreshold: number | null | NotGiven = NOT_GIVEN;
  postFlushCooldownFrames: number | null | NotGiven = NOT_GIVEN;

  constructor(options: GradiumSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GradiumSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Gradium API key for authentication. */
  apiKey: string;
  /** WebSocket endpoint URL. Defaults to "wss://api.gradium.ai/api/speech/asr". */
  apiEndpointBaseUrl?: string;
  /**
   * Base audio encoding type. One of "pcm", "wav", or "opus". For PCM, the
   * sample rate is appended automatically from the pipeline's
   * audio_in_sample_rate (e.g., "pcm" becomes "pcm_16000"). Audio at a rate
   * Gradium does not accept is resampled to one it does. Defaults to "pcm".
   */
  encoding?: string;
  /**
   * Whether the server's end-pointing signal decides when user turns start
   * and end, instead of the pipeline's VAD. Off by default.
   */
  enableTurnDetection?: boolean;
  /** Runtime-updatable settings. */
  settings?: GradiumSTTSettings | null;
}

/**
 * Gradium real-time speech-to-text service.
 *
 * Provides real-time speech transcription using Gradium's WebSocket API.
 * Supports both interim and final transcriptions with configurable parameters
 * for audio processing and connection management.
 *
 * Transcribes English by default. Set `settings.language` to one of the other
 * supported languages (German, Spanish, French, Portuguese), or to `"any"` to
 * have Gradium detect the language.
 *
 * By default the pipeline's VAD closes each utterance: a
 * `VADUserStoppedSpeakingFrame` flushes the server and the accumulated text
 * finalizes into a `TranscriptionFrame`.
 *
 * With `enableTurnDetection: true` the server's end-pointing signal drives
 * turns instead. Every "step" message carries, per horizon, the probability
 * that speech stays inactive over the next `horizon_s` seconds, and the
 * service watches the horizon closest to `eotHorizonS`:
 *
 *     step(inactivity >= threshold) -> step(inactivity < threshold: turn opens)
 *         -> text* -> step(inactivity >= threshold: turn ends)
 *         -> ProposedUserStoppedSpeakingFrame -> flush -> TranscriptionFrame
 *         -> step(inactivity < threshold: next turn opens)
 *
 * A connection's first turn opens on the signal falling below the threshold,
 * not on it being there: the estimate reads low on the first steps, before
 * the model has heard anything, then climbs as silence accumulates. After a
 * flush the signal follows the audio, so once a turn's transcript is pushed
 * the next step below the threshold opens a turn, and speech that continues
 * through the flush starts one.
 *
 * A turn start broadcasts a `ProposedUserStartedSpeakingFrame`; a turn end
 * broadcasts a `ProposedUserStoppedSpeakingFrame` and flushes the server, and
 * the final `TranscriptionFrame` follows once the flush is acknowledged. Local
 * VAD frames are ignored, and `serviceMetadataFrame()` recommends
 * `ExternalUserTurnStrategies`, which resolve the proposals into the user turn
 * frames, own the interruption, and hold the turn open until that transcript
 * arrives.
 *
 * Event handlers available (in addition to `on_connected` /
 * `on_disconnected`), fired only with turn detection on:
 *
 * - on_turn_start(service): the end-pointing signal opened a turn
 * - on_turn_end(service): the end-pointing signal closed the turn
 *
 * @example
 * ```ts
 * const stt = new GradiumSTTService({
 *   apiKey: "...",
 *   enableTurnDetection: true,
 *   settings: new GradiumSTTService.Settings({ eotHorizonS: 3.0, eotThreshold: 0.5 }),
 * });
 * ```
 */
export class GradiumSTTService extends WebsocketSTTService {
  static Settings: typeof GradiumSTTSettings = GradiumSTTSettings;
  declare protected _settings: GradiumSTTSettings;

  static {
    installTracedStt(GradiumSTTService.prototype, "_traceTranscription");
  }

  protected _apiKey: string;
  protected _apiEndpointBaseUrl: string;
  protected _encoding: string;
  protected _enableTurnDetection: boolean;
  protected _receiveTask: Task<unknown> | null = null;

  protected _inputFormat = "";
  protected _sendSampleRate = 0;
  protected _resampler: BaseAudioResampler;

  protected _audioBuffer: Uint8Array = new Uint8Array(0);
  protected _chunkSizeMs = 80;
  protected _chunkSizeBytes = 0;

  // Accumulates text fragments within a turn. Each "text" message appends to
  // this list. On "flushed" a short aggregation delay allows trailing tokens
  // to arrive before the full text is joined and pushed as a
  // TranscriptionFrame.
  protected _accumulatedText: string[] = [];
  protected _flushCounter = 0;
  protected _transcriptAggregationTask: Task<unknown> | null = null;
  protected _transcriptAggregationDelay: number = TRANSCRIPT_AGGREGATION_DELAY;

  // Turn detection state: the phase, and how many steps remain in the
  // post-flush cooldown, which outlives the ENDING phase.
  protected _turnPhase: _TurnPhase = _TurnPhase.IDLE;
  protected _flushCooldown = 0;

  /**
   * Initialize the Gradium STT service.
   *
   * @param options.apiKey Gradium API key for authentication.
   * @param options.apiEndpointBaseUrl WebSocket endpoint URL.
   * @param options.encoding Base audio encoding type. One of "pcm", "wav", or
   *   "opus".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.enableTurnDetection Whether the server's end-pointing
   *   signal decides when user turns start and end, instead of the pipeline's
   *   VAD. Off by default.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark.
   *   Other options are passed to the parent STTService.
   */
  constructor(options: GradiumSTTServiceOptions) {
    const enableTurnDetection = options.enableTurnDetection ?? false;

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof GradiumSTTService).Settings({
      model: "default",
      language: Language.EN,
      delayInFrames: 12,
      eotHorizonS: enableTurnDetection ? DEFAULT_EOT_HORIZON_S : null,
      eotThreshold: enableTurnDetection ? DEFAULT_EOT_THRESHOLD : null,
      postFlushCooldownFrames: enableTurnDetection ? DEFAULT_POST_FLUSH_COOLDOWN_FRAMES : null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? GRADIUM_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._apiEndpointBaseUrl = options.apiEndpointBaseUrl ?? "wss://api.gradium.ai/api/speech/asr";
    this._encoding = options.encoding ?? "pcm";
    this._enableTurnDetection = enableTurnDetection;
    this._websocket = null;

    this._resampler = createStreamResampler();

    this._registerEventHandler("on_turn_start");
    this._registerEventHandler("on_turn_end");
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * TTFS applies only while the pipeline's VAD ends utterances.
   *
   * With turn detection on, the server defines the turn boundary, so there is
   * no separate speech-end to final-transcript interval to measure.
   */
  override get supportsTtfs(): boolean {
    return !this._enableTurnDetection;
  }

  /**
   * Recommend external turn strategies when turns are detected server-side.
   *
   * With turn detection on, the service proposes turn boundaries
   * (`ProposedUserStarted/StoppedSpeakingFrame`), so the user aggregator
   * resolves those rather than running local VAD/smart-turn. Otherwise the
   * defaults are left in place. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    if (this._enableTurnDetection) {
      frame.userTurnStrategies = new ExternalUserTurnStrategies();
    }
    return frame;
  }

  /**
   * Apply a settings delta, sync params, and reconnect.
   *
   * The model, language and decoder delay are bound to the connection's setup
   * message, so a change to any of them is applied by reconnecting. The turn
   * detection fields are read as step messages arrive and need no reconnect.
   *
   * @param delta A STTSettings (or `GradiumSTTService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (!Object.keys(changed).some((key) => !_TURN_DETECTION_FIELDS.has(key))) {
      return changed;
    }

    if (this._websocket) {
      await this._disconnect();
      await this._connect();
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
    this._sendSampleRate =
      this._encoding === "pcm" ? _gradiumPcmSampleRate(this.sampleRate) : this.sampleRate;
    this._inputFormat = _inputFormatFromEncoding(this._encoding, this._sendSampleRate);
    this._chunkSizeBytes = Math.trunc((this._chunkSizeMs * this._sendSampleRate * 2) / 1000);
    await this._connect();
  }

  /** Stop the speech-to-text service. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /** Cancel the speech-to-text service. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Process incoming frames and handle speech events.
   *
   * A VAD stop flushes the server, unless turn detection is on: then the
   * server's end-pointing signal decides when a turn ends.
   *
   * @param frame The frame to process.
   * @param direction Direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame && !this._enableTurnDetection) {
      await this._sendFlush();
    }
  }

  /**
   * Send a flush request to process any buffered audio immediately.
   *
   * Sends a flush message to tell the server to process buffered audio. The
   * server responds with text fragments followed by a "flushed"
   * acknowledgment, which triggers finalization.
   *
   * @returns Whether the flush was sent, so a caller waiting on the "flushed"
   *   acknowledgment knows one is coming.
   */
  protected async _sendFlush(): Promise<boolean> {
    if (!this._websocket || this._websocket.state !== State.OPEN) {
      return false;
    }

    this._flushCounter += 1;
    const flushId = String(this._flushCounter);
    const msg = { type: "flush", flush_id: flushId };
    try {
      await this._websocket.send(pyJsonDumps(msg));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to send flush: ${errorMessage(e)}`);
      return false;
    }
    return true;
  }

  /**
   * Process audio data for speech-to-text conversion.
   *
   * @param audio Raw audio bytes to process.
   * @returns Nothing (processing handled via WebSocket messages).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    const resampled = await this._resampler.resample(audio, this.sampleRate, this._sendSampleRate);
    const joined = new Uint8Array(this._audioBuffer.length + resampled.length);
    joined.set(this._audioBuffer, 0);
    joined.set(resampled, this._audioBuffer.length);
    this._audioBuffer = joined;

    while (this._audioBuffer.length >= this._chunkSizeBytes) {
      const chunk = this._audioBuffer.slice(0, this._chunkSizeBytes);
      this._audioBuffer = this._audioBuffer.slice(this._chunkSizeBytes);
      const msg = { type: "audio", audio: bytesToBase64(chunk) };
      if (this._websocket && this._websocket.state === State.OPEN) {
        try {
          await this._websocket.send(pyJsonDumps(msg));
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: send failed: ${errorMessage(e)}`);
          break;
        }
      }
    }

    yield null;
  }

  /** Record transcription event for tracing. */
  protected async _traceTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null,
  ): Promise<void> {}

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

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Gradium STT");

      const headers = {
        "x-api-key": this._apiKey,
        "x-api-source": "pipecat",
      };
      const websocket = await this._websocketConnect(this._apiEndpointBaseUrl, {
        additionalHeaders: headers,
      });
      this._websocket = websocket;
      await this._callEventHandler("on_connected");
      const setupMsg: Dict = {
        type: "setup",
        model_name: this._settings.model,
        input_format: this._inputFormat,
      };
      const jsonConfig: Dict = {};
      // Technically `_settings.language` could be a raw string, but Language
      // is a string enum so downstream handles either.
      const language = assertGiven(this._settings.language) as Language | string | null;
      if (language !== null && language !== undefined) {
        const gradiumLanguage = languageToGradiumLanguage(language);
        if (gradiumLanguage) {
          jsonConfig.language = gradiumLanguage;
        }
      }
      const delayInFrames = this._settings.delayInFrames;
      if (isGiven(delayInFrames) && delayInFrames) {
        jsonConfig.delay_in_frames = delayInFrames;
      }
      if (Object.keys(jsonConfig).length > 0) {
        setupMsg.json_config = jsonConfig;
      }
      await websocket.send(pyJsonDumps(setupMsg));
      const raw = await websocket.recv();
      const readyMsg = pyJsonLoads(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      ) as Dict;
      if (readyMsg.type === "error") {
        throw new Error(`received error ${readyMsg.message}`);
      }
      if (readyMsg.type !== "ready") {
        throw new Error(`unexpected first message type ${readyMsg.type}`);
      }

      logger.debug("Connected to Gradium STT");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to Gradium: ${errorMessage(e)}`, { exception: e });
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    await this._resetConnectionState();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug("Disconnecting from Gradium STT");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Close out the dropped connection's transcript, then reconnect.
   *
   * The server's decoder state goes with the connection, so the text received
   * so far is pushed as the transcript and the new connection starts from a
   * clean state. An open turn stays open: the user may still be speaking, and
   * the new connection's end-pointing signal ends it.
   *
   * @param attemptNumber Current retry attempt number for logging.
   * @returns True if reconnection and verification succeeded.
   */
  override async _reconnectWebsocket(attemptNumber: number): Promise<boolean> {
    if (this._transcriptAggregationTask) {
      await this.cancelTask(this._transcriptAggregationTask);
      this._transcriptAggregationTask = null;
    }
    await this._finalizeAccumulatedText();
    const turnOpen = this._turnPhase === _TurnPhase.OPEN;
    await this._resetConnectionState();
    if (turnOpen) {
      this._turnPhase = _TurnPhase.OPEN;
    }
    return await super._reconnectWebsocket(attemptNumber);
  }

  /** Clear the transcript and turn state tied to the current connection. */
  protected async _resetConnectionState(): Promise<void> {
    if (this._transcriptAggregationTask) {
      await this.cancelTask(this._transcriptAggregationTask);
      this._transcriptAggregationTask = null;
    }

    this._accumulatedText.length = 0;
    this._flushCounter = 0;
    this._turnPhase = _TurnPhase.IDLE;
    this._flushCooldown = 0;
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let msg: Dict;
      try {
        msg = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`Received non-JSON message: ${text}`);
          continue;
        }
        throw e;
      }

      const type = msg.type ?? "";
      if (type === "step") {
        if (this._enableTurnDetection) {
          await this._handleStep(msg);
        }
      } else if (type === "text") {
        await this._handleText(msg.text);
      } else if (type === "flushed") {
        if (this._enableTurnDetection) {
          const cooldown = assertGiven(this._settings.postFlushCooldownFrames);
          this._flushCooldown = cooldown || 0;
          this.confirmFinalize();
        }
        await this._handleFlushed();
      } else if (type === "end_of_stream") {
        logger.debug("Received end_of_stream message from server");
      } else if (type === "error") {
        await this.pushError(`Error: ${pyJsonDumps(msg)}`);
      }
    }
  }

  /**
   * Handle streaming transcription fragment.
   *
   * Accumulates text and pushes an InterimTranscriptionFrame with the full
   * accumulated text so far.
   */
  protected async _handleText(text: string): Promise<void> {
    this._accumulatedText.push(text);
    const accumulated = this._accumulatedText.join(" ");
    await this.pushFrame(
      new InterimTranscriptionFrame({
        text: accumulated,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language: assertGiven(this._settings.language) as Language | null,
      }),
    );
  }

  /**
   * Handle flush completion by starting a transcript aggregation timer.
   *
   * The "flushed" message confirms that buffered audio has been processed, but
   * text tokens may still arrive after this point. A short timer allows
   * trailing tokens to accumulate before finalizing the transcription.
   */
  protected async _handleFlushed(): Promise<void> {
    if (this._transcriptAggregationTask) {
      await this.cancelTask(this._transcriptAggregationTask);
    }
    this._transcriptAggregationTask = this.createTask(
      () => this._transcriptAggregationHandler(),
      "transcript_aggregation",
    );
  }

  /** Wait for trailing tokens then finalize the accumulated transcription. */
  protected async _transcriptAggregationHandler(): Promise<void> {
    await sleep(this._transcriptAggregationDelay);
    try {
      await this._finalizeAccumulatedText();
    } finally {
      if (this._turnPhase === _TurnPhase.ENDING) {
        this._turnPhase = _TurnPhase.ARMED;
      }
    }
  }

  /** Join accumulated text, push TranscriptionFrame, and clear state. */
  protected async _finalizeAccumulatedText(): Promise<void> {
    if (this._accumulatedText.length === 0) {
      return;
    }
    this._transcriptAggregationTask = null;

    const text = this._accumulatedText.join(" ");
    this._accumulatedText.length = 0;
    logger.debug(`Final transcription: [${text}]`);
    // Technically `_settings.language` could be a raw string, but Language is
    // a string enum so downstream handles either.
    const language = assertGiven(this._settings.language) as Language | null;
    // Report usage before the transcription frame so tracing can attach it to
    // the STT span the frame closes.
    await this.emitSttUsageMetrics();
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
      }),
    );
    await this._traceTranscription(text, true, language);
  }

  /**
   * Derive turn boundaries from the server's end-pointing signal.
   *
   * Each step carries, per horizon, the probability that speech stays
   * inactive over the next `horizon_s` seconds; the entry closest to
   * `eotHorizonS` is watched. A step at or above `eotThreshold` arms the
   * detector; the next step below it opens a turn. At or above the threshold
   * while a turn is open, the turn ends.
   */
  protected async _handleStep(msg: Dict): Promise<void> {
    const vad: Dict[] = msg.vad || [];
    if (vad.length === 0) {
      return;
    }
    if (this._flushCooldown > 0) {
      this._flushCooldown -= 1;
      return;
    }

    const horizon = assertGiven(this._settings.eotHorizonS);
    const threshold = assertGiven(this._settings.eotThreshold);
    if (horizon === null || threshold === null) {
      return;
    }
    let entry = vad[0] as Dict;
    let best = Math.abs((entry.horizon_s ?? Number.POSITIVE_INFINITY) - horizon);
    for (const candidate of vad.slice(1)) {
      const distance = Math.abs((candidate.horizon_s ?? Number.POSITIVE_INFINITY) - horizon);
      if (distance < best) {
        best = distance;
        entry = candidate;
      }
    }
    const inactivity = entry.inactivity_prob;
    if (inactivity === null || inactivity === undefined) {
      return;
    }
    logger.trace(`Gradium turn detection: inactivity ${inactivity.toFixed(2)} over ${horizon}s`);

    const inactive = inactivity >= threshold;
    // ENDING ignores the signal: the previous turn's TranscriptionFrame and
    // stop proposal must not arrive after the next turn's start proposal.
    if (this._turnPhase === _TurnPhase.IDLE && inactive) {
      this._turnPhase = _TurnPhase.ARMED;
    } else if (this._turnPhase === _TurnPhase.ARMED && !inactive) {
      await this._startTurn();
    } else if (this._turnPhase === _TurnPhase.OPEN && inactive) {
      await this._endTurn();
    }
  }

  protected async _startTurn(): Promise<void> {
    logger.debug("Gradium turn detection: start of turn");
    this._turnPhase = _TurnPhase.OPEN;
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
    await this._callEventHandler("on_turn_start");
  }

  protected async _endTurn(): Promise<void> {
    logger.debug("Gradium turn detection: end of turn");
    this._turnPhase = _TurnPhase.ENDING;
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    await this._callEventHandler("on_turn_end");
    // The flush pushes the decoder past its lookahead so the turn's tail
    // tokens arrive and the transcript finalizes on the "flushed" ack. Without
    // a flush no ack is coming, so the transcript finalizes on what has
    // arrived.
    this.requestFinalize();
    if (await this._sendFlush()) {
      return;
    }
    this._turnPhase = _TurnPhase.IDLE;
    await this._finalizeAccumulatedText();
  }
}
