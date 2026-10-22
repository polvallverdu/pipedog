// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/resembleai/tts.py

/**
 * Resemble AI text-to-speech service implementations.
 *
 * Porting notes:
 * - The WebSocket connects through core's `websocketConnect` (via
 *   `WebsocketService._websocketConnect()`), with the `Authorization: Bearer`
 *   header on the opening handshake, so it runs on Bun, Node, Deno and Workers.
 * - Not ported, as deprecated upstream: the `voice_id` constructor argument. Use
 *   `settings`.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export interface ResembleAITTSSettingsOptions extends TTSSettingsOptions {}

/** Settings for ResembleAITTSService. */
export class ResembleAITTSSettings extends TTSSettings {
  constructor(options: ResembleAITTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ResembleAITTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Resemble AI API key for authentication. */
  apiKey: string;
  /** WebSocket URL for Resemble AI TTS API. */
  url?: string;
  /** PCM bit depth (PCM_32, PCM_24, PCM_16, or MULAW). */
  precision?: string | null;
  /** Audio format (wav or mp3). */
  outputFormat?: string | null;
  /**
   * Project to attach the clips to.
   *
   * DIVERGENCE: not an upstream option. Resemble's WebSocket reference lists
   * `project_uuid` as required, but upstream never sends it. It is sent only
   * when this is set.
   */
  projectUuid?: string | null;
  /** Runtime-updatable settings. */
  settings?: ResembleAITTSSettings | null;
}

/**
 * Resemble AI TTS service with WebSocket streaming and word timestamps.
 *
 * Provides text-to-speech using Resemble AI's streaming WebSocket API.
 * Supports word-level timestamps and audio context management for handling
 * multiple simultaneous synthesis requests with proper interruption support.
 */
export class ResembleAITTSService extends WebsocketTTSService {
  static Settings: typeof ResembleAITTSSettings = ResembleAITTSSettings;
  declare protected _settings: ResembleAITTSSettings;

  static {
    installTracedTts(ResembleAITTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _projectUuid: string | null;

  // Init-only audio format config (not runtime-updatable).
  protected _precision: string;
  protected _outputFormat: string;
  protected _resembleSampleRate = 0; // Set in setup()

  protected _requestIdCounter = 0;
  protected _receiveTask: Task<unknown> | null = null;

  // Map request_id to context_id for tracking TTS requests
  protected _requestIdToContext = new Map<number, string>();

  // Per-request audio buffers to handle concurrent TTS requests
  // ResembleAI may send odd-length data even for PCM_16, so buffering helps us
  // create properly aligned frames while maintaining smooth audio output
  protected _audioBuffers = new Map<string, Uint8Array>();
  protected _bufferThresholdBytes = 2208;

  // Jitter buffer: accumulate audio before starting playback to absorb network latency
  // ResembleAI sends audio in bursts with 300-450ms gaps between them
  // We need to buffer enough to cover these gaps before starting playback
  protected _jitterBufferBytes = 44100; // ~1000ms at 22050Hz to handle 400ms+ network gaps
  protected _playbackStarted = new Map<string, boolean>(); // Track if we've started playback per request

  /**
   * Initialize the Resemble AI TTS service.
   *
   * @param options.apiKey Resemble AI API key for authentication.
   * @param options.url WebSocket URL for Resemble AI TTS API.
   * @param options.precision PCM bit depth (PCM_32, PCM_24, PCM_16, or MULAW).
   * @param options.outputFormat Audio format (wav or mp3).
   * @param options.sampleRate Audio sample rate (8000, 16000, 22050, 32000, or 44100).
   *   Defaults to 22050.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent service.
   */
  constructor(options: ResembleAITTSServiceOptions) {
    const defaultSettings = new (new.target as typeof ResembleAITTSService).Settings({
      model: null,
      voice: null,
      language: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate === undefined ? 22050 : options.sampleRate,
      reuseContextIdWithinTurn: false,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://websocket.cluster.resemble.ai/stream";
    this._projectUuid = options.projectUuid ?? null;

    this._precision = options.precision || "PCM_16";
    this._outputFormat = options.outputFormat || "wav";
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Build a JSON message for the Resemble AI WebSocket API.
   *
   * @param text The text or SSML to synthesize.
   * @returns JSON string containing the request payload.
   */
  protected _buildMsg(text = ""): string {
    const msg: Dict = {
      voice_uuid: this._settings.voice,
      data: text,
      binary_response: false, // Use JSON frames to get timestamps
      request_id: this._requestIdCounter, // ResembleAI only accepts number
      output_format: this._outputFormat,
      sample_rate: this._resembleSampleRate,
      precision: this._precision,
      no_audio_header: true,
    };
    if (this._projectUuid) {
      msg.project_uuid = this._projectUuid;
    }

    this._requestIdCounter += 1;
    return pyJsonDumps(msg);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._resembleSampleRate = this.sampleRate;
    await this._connect();
  }

  /**
   * Stop the Resemble AI TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Resemble AI TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  // Like upstream, `_connect` does not call `super._connect()`.
  override async _connect(): Promise<void> {
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
      logger.debug("Connecting to Resemble AI TTS");
      const headers = { Authorization: `Bearer ${this._apiKey}` };
      // Resemble AI doesn't acknowledge the closing handshake, so don't
      // wait for one.
      this._websocket = await this._websocketConnect(this._url, {
        additionalHeaders: headers,
        closeTimeout: 0,
      });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from Resemble AI");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._audioBuffers.clear();
      this._playbackStarted.clear();
      this._requestIdToContext.clear();
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Get the current WebSocket connection.
   *
   * @returns The active WebSocket connection.
   * @throws Error if websocket is not connected.
   */
  protected _getWebsocket() {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Stop metrics when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Stop metrics after the Resemble AI context finishes playing.
   *
   * No close message is needed: Resemble AI signals completion with an
   * `audio_end` message (handled in `_receiveMessages`), after which
   * the server-side context is already closed.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await super.onAudioContextCompleted(contextId);
  }

  /** Flush any pending audio and finalize the current context. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    logger.trace(`${this}: flushing audio`);
    // For Resemble AI, we just wait for the audio_end message
    // which is handled in _receiveMessages
  }

  /** Process incoming WebSocket messages from Resemble AI. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      let msg: Dict;
      try {
        msg = pyJsonLoads(
          typeof message === "string" ? message : new TextDecoder().decode(message),
        ) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          await this.pushError(`Received invalid JSON: ${String(message)}`);
          continue;
        }
        throw e;
      }

      if (!msg || Object.keys(msg).length === 0) {
        continue;
      }

      const msgType = msg.type;
      const requestId = msg.request_id;

      // Convert request_id to string for audio context tracking
      const contextId: string = this._requestIdToContext.get(requestId) ?? String(requestId);

      // Check if this message belongs to a valid audio context
      if (!this.audioContextAvailable(contextId)) {
        continue;
      }

      if (msgType === "audio") {
        // Decode base64 audio content
        const audioContent: string = msg.audio_content ?? "";
        if (!audioContent) {
          continue;
        }

        const audioBytes = base64ToBytes(audioContent);
        if (audioBytes.length === 0) {
          continue;
        }

        // Get or create buffer for this request
        if (!this._audioBuffers.has(contextId)) {
          this._audioBuffers.set(contextId, new Uint8Array(0));
          this._playbackStarted.set(contextId, false);
        }
        let buffer = concat(this._audioBuffers.get(contextId)!, audioBytes);
        this._audioBuffers.set(contextId, buffer);

        // Wait for jitter buffer to fill before starting playback
        // This absorbs network latency gaps (ResembleAI sends in bursts)
        if (!(this._playbackStarted.get(contextId) ?? false)) {
          if (buffer.length < this._jitterBufferBytes) {
            continue;
          }
          this._playbackStarted.set(contextId, true);
        }

        // Send complete (even-byte) chunks for PCM_16 alignment
        while (buffer.length >= this._bufferThresholdBytes) {
          let chunkSize = this._bufferThresholdBytes;
          if (chunkSize % 2 !== 0) {
            chunkSize -= 1;
          }

          const chunkToSend = buffer.slice(0, chunkSize);
          buffer = buffer.slice(chunkSize);
          this._audioBuffers.set(contextId, buffer);

          if (chunkToSend.length === 0) {
            continue;
          }

          const frame = new TTSAudioRawFrame({
            audio: chunkToSend,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
          await this.appendToAudioContext(contextId, frame);
        }

        // Process timestamps if available
        const timestamps = msg.audio_timestamps ?? {};
        if (timestamps && Object.keys(timestamps).length > 0) {
          const graphChars: string[] = timestamps.graph_chars ?? [];
          const graphTimes: number[][] = timestamps.graph_times ?? [];

          // Convert graph_times (start, end pairs) to word timestamps
          const wordTimes: [string, number][] = [];
          const n = Math.min(graphChars.length, graphTimes.length);
          for (let i = 0; i < n; i++) {
            const times = graphTimes[i];
            if (times && times.length >= 2) {
              wordTimes.push([graphChars[i]!, times[0]!]);
            }
          }

          if (wordTimes.length > 0) {
            await this.addWordTimestamps(wordTimes, contextId);
          }
        }
      } else if (msgType === "audio_end") {
        await this.stopTtfbMetrics();

        // Flush remaining buffer, ensuring even length for PCM_16
        const buffer = this._audioBuffers.get(contextId) ?? new Uint8Array(0);
        if (buffer.length > 0) {
          let remaining = buffer.slice();
          // PCM_16 requires even number of bytes
          if (remaining.length % 2 !== 0) {
            remaining = remaining.slice(0, remaining.length - 1);
          }
          if (remaining.length > 0) {
            const frame = new TTSAudioRawFrame({
              audio: remaining,
              sampleRate: this.sampleRate,
              numChannels: 1,
              contextId,
            });
            await this.appendToAudioContext(contextId, frame);
          }
        }

        // Clean up buffer and playback tracking for this request
        this._audioBuffers.delete(contextId);
        if (this._playbackStarted.has(contextId)) {
          this._playbackStarted.delete(contextId);
          // Clean up request_id mapping
          this._requestIdToContext.delete(requestId);
        }

        await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
        await this.removeAudioContext(contextId);
      } else if (msgType === "error") {
        const errorName = msg.error_name ?? "Unknown";
        const errorMsg = msg.message ?? "Unknown error";
        const statusCode = msg.status_code ?? 0;
        await this.pushError(`Error: ${errorName} (status ${statusCode}): ${errorMsg}`);

        // Clean up buffer and playback tracking for this request
        this._audioBuffers.delete(contextId);
        this._playbackStarted.delete(contextId);

        await this.pushFrame(new TTSStoppedFrame({ contextId }));
        await this.stopAllMetrics();
        await this.pushErrorFrame(
          new ErrorFrame({ error: `${this} error: ${errorName} - ${errorMsg}` }),
        );

        // Check if this is an unrecoverable error (connection-level failure)
        if (statusCode === 401 || statusCode === 403) {
          // Close and reconnect for auth errors
          await this._disconnectWebsocket();
          await this._connectWebsocket();
        }
      } else {
        logger.warning(`${this} unknown message type: ${msgType}`);
      }
    }
  }

  /**
   * Generate speech from text using Resemble AI's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      if (!this.audioContextAvailable(contextId)) {
        await this.createAudioContext(contextId);
        await this.startTtfbMetrics();
        yield new TTSStartedFrame({ contextId });
      }

      // Map request_id to context_id for tracking
      this._requestIdToContext.set(this._requestIdCounter, contextId);

      const msg = this._buildMsg(text);

      let failure: unknown = null;
      try {
        await this._getWebsocket().send(msg);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        failure = e;
      }
      if (failure !== null) {
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(failure)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
