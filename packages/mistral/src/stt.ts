// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/mistral/stt.py

/**
 * Mistral Speech-to-Text service implementation.
 *
 * This module provides a real-time STT service that integrates with
 * Mistral's Voxtral Realtime transcription API.
 *
 * Porting notes:
 * - Upstream uses the `mistralai` SDK's `RealtimeConnection`
 *   (`client.audio.realtime.connect(...)`). Here the same WebSocket protocol
 *   is spoken directly, through core's `websocketConnect`, so it runs on
 *   every runtime. The protocol follows the SDK (mistralai 3.3.0,
 *   `mistralai/extra/realtime/transcription.py` and `connection.py`; the JS
 *   SDK's `extra/realtime` is the same): the socket is opened at
 *   `{baseUrl}/v1/audio/transcriptions/realtime?model=...` with
 *   `Authorization: Bearer <key>`; the client waits for `session.created`,
 *   then sends `session.update` with `session.audio_format` (and
 *   `session.target_streaming_delay_ms` when set); audio goes out as base64
 *   `input_audio.append` events and `input_audio.flush` flushes. Incoming
 *   events: `session.created`, `session.updated`,
 *   `transcription.text.delta`, `transcription.language`,
 *   `transcription.segment`, `transcription.done` and `error`.
 * - `baseUrl` is the SDK's `server_url` (default `https://api.mistral.ai`).
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { MISTRAL_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import {
  State,
  type WebsocketClientConnection,
  websocketConnect,
} from "@pipedog/core/services/websocket_service";
import type { Language } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven } from "@pipedog/core/utils/types";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The message of an `error` event (`{error: {message, code}}`; the message may be an object). */
function errorText(event: Record<string, any>): string {
  const message = event.error?.message;
  if (message === undefined || message === null) return "Unknown error";
  return typeof message === "string" ? message : pyJsonDumps(message);
}

export interface MistralSTTSettingsOptions extends STTSettingsOptions {}

/**
 * Settings for MistralSTTService.
 *
 * - `model`: STT model identifier.
 * - `language`: Language hint for transcription.
 */
export class MistralSTTSettings extends STTSettings {
  constructor(options: MistralSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface MistralSTTServiceOptions extends STTServiceOptions {
  /** Mistral API key for authentication. */
  apiKey?: string | null;
  /** Custom API endpoint URL. Defaults to `"https://api.mistral.ai"`. */
  baseUrl?: string | null;
  /**
   * Streaming delay for accuracy/latency tradeoff. Higher values may improve
   * accuracy at the cost of latency.
   */
  targetStreamingDelayMs?: number | null;
  /** Runtime-updatable settings. */
  settings?: MistralSTTSettings | null;
}

/**
 * Mistral Speech-to-Text service using the Voxtral Realtime API.
 *
 * This service streams audio and receives transcription events over a
 * WebSocket. It extends STTService directly (rather than
 * WebsocketSTTService), as upstream does, where the SDK manages the WebSocket
 * connection.
 *
 * Event handlers available:
 *
 * - on_connected: Called when a transcription session is created.
 * - on_disconnected: Called when the connection is closed.
 * - on_connection_error: Called when a transcription error occurs.
 *
 * @example
 * stt.addEventHandler("on_connected", async (stt) => {
 *   logger.info("Mistral STT connected");
 * });
 */
export class MistralSTTService extends STTService {
  static Settings: typeof MistralSTTSettings = MistralSTTSettings;
  declare protected _settings: MistralSTTSettings;

  static {
    installTracedStt(MistralSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string | null;
  protected _baseUrl: string;
  protected _targetStreamingDelayMs: number | null;
  protected _connection: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  /** Events received during the handshake, up to `session.created`. */
  protected _initialEvents: Record<string, any>[] = [];
  protected _accumulatedText = "";
  protected _detectedLanguage: Language | null = null;

  /**
   * Initialize Mistral STT service.
   *
   * @param options.apiKey Mistral API key for authentication.
   * @param options.baseUrl Custom API endpoint URL.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.targetStreamingDelayMs Streaming delay for
   *   accuracy/latency tradeoff. Higher values may improve accuracy at the
   *   cost of latency.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to STTService.
   */
  constructor(options: MistralSTTServiceOptions = {}) {
    const defaultSettings = new (new.target as typeof MistralSTTService).Settings({
      model: "voxtral-mini-transcribe-realtime-2602",
      language: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? MISTRAL_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey ?? null;
    this._baseUrl = (options.baseUrl ?? "https://api.mistral.ai").replace(/\/+$/, "");
    this._targetStreamingDelayMs = options.targetStreamingDelayMs ?? null;
  }

  /**
   * Check if the service can generate processing metrics.
   *
   * @returns True, indicating metrics are supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
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
   * Stop the STT service and close connection.
   *
   * @param frame Frame indicating service should stop.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the STT service and close connection.
   *
   * @param frame Frame indicating service should be cancelled.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Clean up resources, closing the connection and cancelling tasks. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * Process incoming frames and handle speech events.
   *
   * @param frame The frame to process.
   * @param direction Direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStartedSpeakingFrame) {
      this._accumulatedText = "";
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      if (this._connection && !this._isClosed(this._connection)) {
        await this._send({ type: "input_audio.flush" });
      }
    }
  }

  /**
   * Send audio data to Mistral for transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns null: transcription results arrive via the receive events task.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (!this._connection || this._isClosed(this._connection)) {
      await this._connect();
    }

    // `_connect` swallows exceptions and may leave `_connection` unset; drop
    // the audio chunk rather than crashing if reconnect failed.
    if (this._connection === null) {
      logger.warning(`${this}: dropping audio chunk — Mistral STT not connected`);
      yield null;
      return;
    }

    await this._send({ type: "input_audio.append", audio: bytesToBase64(audio) });
    yield null;
  }

  protected _isClosed(connection: WebsocketClientConnection): boolean {
    return connection.state === State.CLOSING || connection.state === State.CLOSED;
  }

  protected async _send(event: Record<string, unknown>): Promise<void> {
    await this._connection?.send(pyJsonDumps(event));
  }

  /** The realtime transcription WebSocket URL. */
  protected _realtimeUrl(model: string): string {
    const base = this._baseUrl.replace(/^http(s?):/i, "ws$1:");
    const params = new URLSearchParams({ model });
    return `${base}/v1/audio/transcriptions/realtime?${params}`;
  }

  /** Establish a connection to the Mistral Realtime API. */
  protected async _connect(): Promise<void> {
    try {
      logger.debug(`${this}: Connecting to Mistral STT`);

      const model = assertGiven(this._settings.model);
      if (model === null) {
        throw new Error("Mistral STT model must be specified");
      }
      const headers: Record<string, string> = {};
      if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`;
      const connection = await websocketConnect(this._realtimeUrl(model), {
        additionalHeaders: headers,
      });
      // Like the SDK's `connect()`: wait for `session.created`, keeping the
      // events received until then for the receive task, then send the
      // session settings.
      const initialEvents: Record<string, any>[] = [];
      while (true) {
        const message = await connection.recv();
        if (typeof message !== "string") continue;
        const event = pyJsonLoads(message) as Record<string, any>;
        initialEvents.push(event);
        if (event.type === "error") {
          await connection.close();
          throw new Error(`Realtime transcription error during handshake: ${errorText(event)}`);
        }
        if (event.type === "session.created") break;
      }
      this._connection = connection;
      this._initialEvents = initialEvents;
      const session: Record<string, unknown> = {
        audio_format: { encoding: "pcm_s16le", sample_rate: this.sampleRate },
      };
      if (this._targetStreamingDelayMs !== null) {
        session.target_streaming_delay_ms = this._targetStreamingDelayMs;
      }
      await this._send({ type: "session.update", session });

      this._receiveTask = this.createTask(() => this._receiveEvents(), "mistral_stt_receive");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Mistral STT: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /** Close the connection and cancel the receive task. */
  protected async _disconnect(): Promise<void> {
    // DIVERGENCE: upstream reads `_connection` after cancelling the receive
    // task, whose `finally` has already cleared it, so the connection is never
    // closed there. It is kept here, so the socket is closed and
    // on_disconnected fires.
    const connection = this._connection;
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    if (connection && !this._isClosed(connection)) {
      try {
        logger.debug(`${this}: Disconnecting from Mistral STT`);
        await connection.close();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: Error closing connection: ${errorMessage(e)}`);
      } finally {
        this._connection = null;
        await this._callEventHandler("on_disconnected");
      }
    }
  }

  /** Background task: iterate connection events and handle them. */
  protected async _receiveEvents(): Promise<void> {
    // `_connect` started this task only after assigning `_connection`, so it
    // should not be null here; bail out defensively just in case.
    const connection = this._connection;
    if (connection === null) {
      return;
    }
    try {
      const initialEvents = this._initialEvents;
      this._initialEvents = [];
      for (const event of initialEvents) {
        await this._handleEvent(event);
      }
      for await (const message of connection) {
        if (typeof message !== "string") continue;
        await this._handleEvent(pyJsonLoads(message) as Record<string, any>);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Mistral STT receive error: ${errorMessage(e)}`, { exception: e });
      await this._callEventHandler("on_connection_error", errorMessage(e));
    } finally {
      this._connection = null;
    }
  }

  /** Handle one realtime event. */
  protected async _handleEvent(event: Record<string, any>): Promise<void> {
    const type = event.type;
    if (type === "session.created") {
      logger.debug(`${this}: Session created: ${pyJsonDumps(event.session ?? null)}`);
      await this._callEventHandler("on_connected");
    } else if (type === "transcription.text.delta") {
      this._accumulatedText += event.text ?? "";
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: this._accumulatedText,
          userId: this._userId,
          timestamp: timeNowIso8601(),
        }),
      );
    } else if (type === "transcription.done") {
      if (event.text) {
        // Report usage before the transcription frame so tracing can
        // attach it to the STT span the frame closes.
        await this.emitSttUsageMetrics();
        await this.pushFrame(
          new TranscriptionFrame({
            text: event.text,
            userId: this._userId,
            timestamp: timeNowIso8601(),
            language: this._detectedLanguage,
          }),
        );
        await this._handleTranscription(event.text, true, this._detectedLanguage);
      }
      this._accumulatedText = "";
    } else if (type === "transcription.language") {
      // The API could send a code Language doesn't list yet; Language is a
      // string type, so downstream handles either.
      this._detectedLanguage = (event.audio_language ?? null) as Language | null;
    } else if (type === "error") {
      const msg = errorText(event);
      await this.pushError(`Mistral STT error: ${msg}`);
      await this._callEventHandler("on_connection_error", msg);
    } else if (type === "session.updated" || type === "transcription.segment") {
      // Known SDK events that upstream doesn't act on.
    } else {
      logger.warning(`${this}: Unknown realtime event: ${pyJsonDumps(event)}`);
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null = null,
  ): Promise<void> {}

  /**
   * Apply a settings delta, reconnecting if model or language changes.
   *
   * @param delta An STT settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }
}
