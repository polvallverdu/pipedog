// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/together/stt.py

/**
 * Together AI speech-to-text service implementation.
 *
 * This module provides a STT service using Together AI's WebSocket API:
 *
 * - `TogetherSTTService`: WebSocket-based real-time STT using an
 *   OpenAI-compatible realtime transcription endpoint.
 *
 * Porting notes:
 * - The socket is opened with the core `WebsocketService._websocketConnect()`,
 *   which sends the `Authorization` header on the handshake on Bun, Node, Deno
 *   and Cloudflare Workers (browsers can't send it).
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings } from "@pipedog/core/services/settings";
import { TOGETHER_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Settings for the Together AI STT service. */
export class TogetherSTTSettings extends STTSettings {}

export interface TogetherSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Together AI API key for authentication. */
  apiKey: string;
  /** The URL of the Together AI WebSocket API. Defaults to "wss://api.together.ai/v1". */
  baseUrl?: string;
  /** Runtime-updatable settings for the STT service. */
  settings?: TogetherSTTSettings | null;
}

/**
 * Together AI speech-to-text service.
 *
 * Provides real-time speech recognition using Together AI's WebSocket API
 * with OpenAI-compatible speech-to-text endpoints.
 *
 * @example
 * const stt = new TogetherSTTService({
 *   apiKey: "your-api-key",
 *   settings: new TogetherSTTService.Settings({
 *     model: "openai/whisper-large-v3",
 *     language: Language.EN,
 *   }),
 * });
 */
export class TogetherSTTService extends WebsocketSTTService {
  static Settings: typeof TogetherSTTSettings = TogetherSTTSettings;
  declare protected _settings: TogetherSTTSettings;

  static {
    installTracedStt(TogetherSTTService.prototype, "_handleTranscriptionTrace");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Together AI STT service.
   *
   * @param options.apiKey Together AI API key for authentication.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline's rate.
   * @param options.baseUrl The URL of the Together AI WebSocket API.
   * @param options.settings Runtime-updatable settings for the STT service.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: TogetherSTTServiceOptions) {
    const defaultSettings = new (new.target as typeof TogetherSTTService).Settings({
      model: "openai/whisper-large-v3",
      language: Language.EN,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? TOGETHER_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "wss://api.together.ai/v1";
    this._receiveTask = null;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Together AI language format.
   *
   * @param language The language to convert.
   * @returns The language code string, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return String(language);
  }

  /** Apply a settings delta and reconnect if anything changed. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
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
    await this._connect();
  }

  /**
   * Stop the Together AI STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Together AI STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Send audio data to Together AI for transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns null (transcription results come via WebSocket callbacks).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    await this._sendAudio(audio);
    yield null;
  }

  /**
   * Process frames with Together AI-specific handling.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._commitAudioBuffer();
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

  /** Establish the WebSocket connection to the Together AI endpoint. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const url =
        `${this._baseUrl}/realtime?intent=transcription` +
        `&model=${this._settings.model}` +
        "&turn_detection=none" +
        "&input_audio_format=pcm_s16le_16000";
      const headers = {
        Authorization: `Bearer ${this._apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      };

      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Together AI STT: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
    }
  }

  /** Close the WebSocket connection. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
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

  /** Return the active WebSocket connection or throw if disconnected. */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  // ------------------------------------------------------------------
  // Client events
  // ------------------------------------------------------------------

  /**
   * Send audio data via `input_audio_buffer.append`.
   *
   * @param audio Raw audio bytes at the pipeline sample rate.
   */
  protected async _sendAudio(audio: Uint8Array): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        const payload = bytesToBase64(audio);
        await this._websocket.send(
          pyJsonDumps({ type: "input_audio_buffer.append", audio: payload }),
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error sending audio: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Commit the current audio buffer for transcription. */
  protected async _commitAudioBuffer(): Promise<void> {
    try {
      if (!this._disconnecting && this._websocket) {
        await this._websocket.send(pyJsonDumps({ type: "input_audio_buffer.commit" }));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (this._disconnecting || !this._websocket) {
        return;
      }
      await this.pushError(`Error committing audio buffer: ${errorMessage(e)}`, {
        exception: e,
      });
    }
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
    for await (const message of this._getWebsocket()) {
      let evt: Dict;
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        evt = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} failed to parse WebSocket message`);
        continue;
      }

      const evtType = evt.type ?? "";

      if (evtType === "session.created") {
        logger.debug(`${this} session created`);
      } else if (evtType === "conversation.item.input_audio_transcription.delta") {
        await this._handleTranscriptionDelta(evt);
      } else if (evtType === "conversation.item.input_audio_transcription.completed") {
        await this._handleTranscriptionCompleted(evt);
      } else if (evtType === "conversation.item.input_audio_transcription.failed") {
        await this._handleTranscriptionFailed(evt);
      } else if (evtType === "input_audio_buffer.committed") {
        logger.trace(`Audio buffer committed: item_id=${evt.item_id ?? ""}`);
      } else if (evtType === "error") {
        await this._handleError(evt);
      } else {
        logger.trace(`${this} unhandled event: ${evtType}`);
      }
    }
  }

  /**
   * Handle incremental transcription text.
   *
   * @param evt The delta event from the server.
   */
  protected async _handleTranscriptionDelta(evt: Dict): Promise<void> {
    const delta: string = evt.transcript ?? "";
    if (delta.trim()) {
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
   * @param evt The completed event containing the full transcript.
   */
  protected async _handleTranscriptionCompleted(evt: Dict): Promise<void> {
    const transcript = ((evt.transcript ?? "") as string).trim();
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
      await this._handleTranscriptionTrace(
        transcript,
        true,
        (this._settings.language as Language | null) ?? null,
      );
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
   * Handle a transcription failure for a speech segment.
   *
   * @param evt The failed event containing error details.
   */
  protected async _handleTranscriptionFailed(evt: Dict): Promise<void> {
    const errorInfo = evt.error ?? {};
    await this.pushError(`Transcription failed: ${pyJsonDumps(errorInfo)}`);
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
    const errorInfo = evt.error ?? {};
    const errorMsg = errorInfo.message ?? "Unknown error";
    const errorCode = errorInfo.code ?? "";
    const msg = `Together AI STT error [${errorCode}]: ${errorMsg}`;
    await this.pushError(msg);
    throw new Error(msg);
  }
}
