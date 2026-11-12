// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/fish/tts.py

/**
 * Fish Audio text-to-speech service implementation.
 *
 * This module provides integration with Fish Audio's real-time TTS WebSocket API
 * for streaming text-to-speech synthesis with customizable voice parameters.
 *
 * Porting notes:
 * - Upstream packs messages with `ormsgpack`. This port uses `@msgpack/msgpack`
 *   (pure TypeScript, no native code, so it runs on Bun, Node, Deno and
 *   Workers). Fish's wire protocol (MessagePack frames with the `start`,
 *   `text`, `flush` and `stop` client events and the `audio` and `finish`
 *   server events; the `Authorization` and `model` handshake headers) is
 *   documented at https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
 *   and matches upstream's code.
 * - The socket is the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`; the handshake headers are sent on
 *   Bun, Node, Deno and (through `fetch`) Workers.
 * - DIVERGENCE: JS numbers do not distinguish `1.0` from `1`, so a whole-number
 *   float setting (`prosody.speed: 1.0`) is packed as a MessagePack integer where
 *   `ormsgpack` packs a float. Fish validates these fields as numbers.
 * - Deprecated APIs are not ported: `InputParams` and the `reference_id`,
 *   `model_id` and `params` constructor parameters.
 */

import { decode, encode } from "@msgpack/msgpack";
import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  type ServiceSettings,
  TTSSettings,
  type TTSSettingsOptions,
} from "@pipedog/core/services/settings";
import {
  InterruptibleTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { FishAudioS2ExpressionAdapter } from "./fish_adapter.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** FishAudio supports various output formats. */
export type FishAudioOutputFormat = "opus" | "mp3" | "pcm" | "wav";

export interface FishAudioTTSSettingsOptions extends TTSSettingsOptions {
  /** Latency mode ("normal" or "balanced"). Defaults to "balanced". */
  latency?: string | null | NotGiven;
  /** Whether to normalize audio output. Defaults to true. */
  normalize?: boolean | null | NotGiven;
  /** Controls randomness in speech generation (0.0-1.0). */
  temperature?: number | null | NotGiven;
  /** Controls diversity via nucleus sampling (0.0-1.0). Wire name `top_p`. */
  topP?: number | null | NotGiven;
  /** Speech speed multiplier (0.5-2.0). Defaults to 1.0. */
  prosodySpeed?: number | null | NotGiven;
  /** Volume adjustment in dB (-20 to 20). Defaults to 0. */
  prosodyVolume?: number | null | NotGiven;
  /**
   * Whether to normalize output loudness for a more consistent perceived
   * volume. Applies to the S2 family and drama-3.
   */
  prosodyNormalizeLoudness?: boolean | null | NotGiven;
  /** Text segment size for processing (100-300). */
  chunkLength?: number | null | NotGiven;
  /** Minimum characters before splitting into a new chunk (0-100). */
  minChunkLength?: number | null | NotGiven;
  /**
   * Whether to use previously generated audio as context, for voice
   * consistency across chunks.
   */
  conditionOnPreviousChunks?: boolean | null | NotGiven;
}

/**
 * Settings for FishAudioTTSService.
 *
 * - `latency`: latency mode ("normal" or "balanced"). Defaults to "balanced".
 * - `normalize`: whether to normalize audio output. Defaults to true.
 * - `temperature`: controls randomness in speech generation (0.0-1.0).
 * - `topP`: controls diversity via nucleus sampling (0.0-1.0).
 * - `prosodySpeed`: speech speed multiplier (0.5-2.0). Defaults to 1.0.
 * - `prosodyVolume`: volume adjustment in dB (-20 to 20). Defaults to 0.
 * - `prosodyNormalizeLoudness`: whether to normalize output loudness for a
 *   more consistent perceived volume. Applies to the S2 family and drama-3.
 * - `chunkLength`: text segment size for processing (100-300).
 * - `minChunkLength`: minimum characters before splitting into a new chunk
 *   (0-100).
 * - `conditionOnPreviousChunks`: whether to use previously generated audio as
 *   context, for voice consistency across chunks.
 */
export class FishAudioTTSSettings extends TTSSettings {
  latency: string | null | NotGiven = NOT_GIVEN;
  normalize: boolean | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;
  topP: number | null | NotGiven = NOT_GIVEN;
  prosodySpeed: number | null | NotGiven = NOT_GIVEN;
  prosodyVolume: number | null | NotGiven = NOT_GIVEN;
  prosodyNormalizeLoudness: boolean | null | NotGiven = NOT_GIVEN;
  chunkLength: number | null | NotGiven = NOT_GIVEN;
  minChunkLength: number | null | NotGiven = NOT_GIVEN;
  conditionOnPreviousChunks: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: FishAudioTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /** Construct settings from a plain dict, destructuring legacy nested `prosody`. */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    const flat: Record<string, unknown> = { ...settings };
    const nested = flat.prosody;
    delete flat.prosody;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      // Keys missing from the nested dict stay unset in the delta.
      for (const [key, name] of [
        ["speed", "prosody_speed"],
        ["volume", "prosody_volume"],
        ["normalize_loudness", "prosody_normalize_loudness"],
      ] as const) {
        if (key in n && !(name in flat)) {
          flat[name] = n[key];
        }
      }
    }
    // biome-ignore lint/complexity/noThisInStatic: classmethod semantics.
    return TTSSettings.fromMapping.call(this, flat) as T;
  }
}

export interface FishAudioTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Fish Audio API key for authentication. */
  apiKey: string;
  /** Audio output format. Defaults to "pcm". */
  outputFormat?: FishAudioOutputFormat;
  /** Runtime-updatable settings (defaults: model "s2.1-pro"). */
  settings?: FishAudioTTSSettings | null;
}

/**
 * Fish Audio text-to-speech service with WebSocket streaming.
 *
 * Provides real-time text-to-speech synthesis using Fish Audio's WebSocket
 * API. Supports various audio formats, customizable prosody controls, and
 * streaming audio generation with interruption handling.
 *
 * Uses the `s2.1-pro` model by default. Set `Settings({ model })` to use
 * another Fish Audio model, such as `s1`, `s2-pro`, or `drama-3`.
 */
export class FishAudioTTSService extends InterruptibleTTSService {
  static Settings: typeof FishAudioTTSSettings = FishAudioTTSSettings;
  declare protected _settings: FishAudioTTSSettings;

  static {
    installTracedTts(FishAudioTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _s2ExpressionAdapter: FishAudioS2ExpressionAdapter;
  protected _receiveTask: Task<unknown> | null;
  protected _fishSampleRate: number;
  protected _outputFormat: FishAudioOutputFormat;

  /**
   * Initialize the Fish Audio TTS service.
   *
   * @param options.apiKey Fish Audio API key for authentication.
   * @param options.outputFormat Audio output format. Defaults to "pcm".
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.settings Runtime-updatable settings. Other options are
   *   passed to the parent service.
   */
  constructor(options: FishAudioTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof FishAudioTTSService).Settings({
      model: "s2.1-pro",
      voice: null,
      language: null,
      latency: "balanced",
      normalize: true,
      temperature: null,
      topP: null,
      prosodySpeed: 1.0,
      prosodyVolume: 0,
      prosodyNormalizeLoudness: null,
      chunkLength: null,
      minChunkLength: null,
      conditionOnPreviousChunks: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = "wss://api.fish.audio/v1/tts/live";
    this._s2ExpressionAdapter = new FishAudioS2ExpressionAdapter();
    this._websocket = null;
    this._receiveTask = null;

    // Init-only audio format config (not runtime-updatable).
    this._fishSampleRate = 0; // Set in setup()
    this._outputFormat = options.outputFormat ?? "pcm";
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Fish Audio service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * The adapter for the model: S2 tags on S2 models, otherwise none.
   *
   * @returns The expression adapter for the current model.
   */
  override getExpressionAdapter(): BaseExpressionAdapter {
    const model = this._settings.model;
    if (typeof model === "string" && model.startsWith("s2")) {
      return this._s2ExpressionAdapter;
    }
    return super.getExpressionAdapter();
  }

  /**
   * Apply a settings delta and reconnect if needed.
   *
   * Any change to voice or model triggers a WebSocket reconnect.
   *
   * @param delta A TTSSettings (or `FishAudioTTSService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
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
    this._fishSampleRate = this.sampleRate;
    await this._connect();
  }

  /**
   * Stop the Fish Audio TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Fish Audio TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Fish Audio");
      const headers: Record<string, string> = { Authorization: `Bearer ${this._apiKey}` };
      const model = assertGiven(this._settings.model);
      if (model !== null) {
        headers.model = model;
      }
      const websocket = await this._websocketConnect(this._baseUrl, {
        additionalHeaders: headers,
      });
      this._websocket = websocket;

      const s = this._settings;
      const prosody: Dict = {
        speed: s.prosodySpeed,
        volume: s.prosodyVolume,
      };
      if (s.prosodyNormalizeLoudness !== null) {
        prosody.normalize_loudness = s.prosodyNormalizeLoudness;
      }

      // Send initial start message with msgpack
      const requestSettings: Dict = {
        sample_rate: this._fishSampleRate,
        latency: s.latency,
        format: this._outputFormat,
        normalize: s.normalize,
        prosody,
        reference_id: s.voice,
      };
      // Fish applies its own defaults to whatever the request leaves out.
      const optional: [string, unknown][] = [
        ["temperature", s.temperature],
        ["top_p", s.topP],
        ["chunk_length", s.chunkLength],
        ["min_chunk_length", s.minChunkLength],
        ["condition_on_previous_chunks", s.conditionOnPreviousChunks],
      ];
      for (const [name, value] of optional) {
        if (value !== null) {
          requestSettings[name] = value;
        }
      }
      const startMessage = { event: "start", request: { text: "", ...requestSettings } };
      await websocket.send(encode(startMessage));
      logger.debug("Sent start message to Fish Audio");

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      if (this._websocket) {
        logger.debug("Disconnecting from Fish Audio");
        // Send stop event with msgpack
        const stopMessage = { event: "stop" };
        await this._websocket.send(encode(stopMessage));
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

  /** Flush any buffered audio by sending a flush event to Fish Audio. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    logger.trace(`${this}: Flushing audio buffers`);
    if (!this._websocket || this._websocket.state === State.CLOSED) {
      return;
    }
    const flushMessage = { event: "flush" };
    await this._getWebsocket().send(encode(flushMessage));
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Stop all metrics when audio context is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    await super.onAudioContextInterrupted(contextId);
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      try {
        if (message instanceof Uint8Array) {
          const msg = decode(message) as unknown;
          if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
            const m = msg as Dict;
            const event = m.event;
            if (event === "audio") {
              const audioData = m.audio;
              if (audioData && audioData.length > 0) {
                const contextId = this.getActiveAudioContextId();
                const frame = new TTSAudioRawFrame({
                  audio: audioData,
                  sampleRate: this.sampleRate,
                  numChannels: 1,
                  contextId,
                });
                await this.appendToAudioContext(contextId as string, frame);
                await this.stopTtfbMetrics();
              }
            } else if (event === "finish") {
              // dict.get(key, default): only a missing key takes the default.
              const reason = "reason" in m ? m.reason : "unknown";
              if (reason === "error") {
                await this.pushError("Fish Audio server error during synthesis");
              } else {
                logger.debug(`Fish Audio session finished: ${reason}`);
              }
            }
          }
        }
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    }
  }

  /**
   * Generate speech from text using Fish Audio's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames and control frames for the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    logger.debug(`${this}: Generating Fish TTS: [${text}]`);
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      // Send the text
      const textMessage = {
        event: "text",
        text,
      };
      try {
        await this._getWebsocket().send(encode(textMessage));
        await this.startTtsUsageMetrics(text);

        // Send flush event to force audio generation
        const flushMessage = { event: "flush" };
        await this._getWebsocket().send(encode(flushMessage));
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
      }

      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
