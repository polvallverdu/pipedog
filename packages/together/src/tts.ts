// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/together/tts.py

/**
 * Together AI text-to-speech service implementation.
 *
 * This module provides a TTS service using Together AI's WebSocket API:
 *
 * - `TogetherTTSService`: WebSocket-based real-time TTS with streaming audio
 *   output.
 *
 * Porting notes:
 * - The socket is opened with the core `WebsocketService._websocketConnect()`,
 *   which sends the `Authorization` header on the handshake on Bun, Node, Deno
 *   and Cloudflare Workers (browsers can't send it).
 * - The query string is encoded as Python's
 *   `urlencode(params, quote_via=quote, safe="/")` encodes it.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const TOGETHER_TTS_SAMPLE_RATE = 24000;

/** Python's `urllib.parse.quote(value, safe="/")`. */
function pyQuote(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, "/");
}

/**
 * Convert a Language enum to a Together AI language code.
 *
 * Together accepts ISO 639-1 codes and lowercase locale codes (`zh-hk`).
 * Regional variants without a verified locale code fall back to their base
 * language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding Together AI language code.
 */
export function languageToTogetherLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FR]: "fr",
    [Language.HI]: "hi",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.PT]: "pt",
    [Language.ZH]: "zh",
    [Language.ZH_HK]: "zh-hk",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface TogetherTTSSettingsOptions extends TTSSettingsOptions {
  /** Maximum partial text length for streaming. */
  maxPartialLength?: number | null | NotGiven;
  /**
   * Model-specific synthesis options sent in the session update, such as
   * `pronunciation_dict`, a list of `"<source>/<replacement>"` entries.
   */
  extraParams?: Record<string, unknown> | null | NotGiven;
}

/**
 * Settings for the Together AI TTS service.
 *
 * - `maxPartialLength`: Maximum partial text length for streaming.
 * - `extraParams`: Model-specific synthesis options sent in the session
 *   update, such as `pronunciation_dict`, a list of
 *   `"<source>/<replacement>"` entries.
 */
export class TogetherTTSSettings extends TTSSettings {
  maxPartialLength: number | null | NotGiven = NOT_GIVEN;
  extraParams: Record<string, unknown> | null | NotGiven = NOT_GIVEN;

  constructor(options: TogetherTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface TogetherTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Together AI API key for authentication. */
  apiKey: string;
  /**
   * WebSocket URL for Together AI TTS API. Defaults to
   * "wss://api.together.ai/v1/audio/speech/websocket".
   */
  url?: string;
  /**
   * Output sample rate for emitted PCM frames. Defaults to 24000; Together
   * streams at 24 kHz and does not support other rates.
   */
  sampleRate?: number | null;
  /** Runtime-updatable settings for the TTS service. */
  settings?: TogetherTTSSettings | null;
}

/**
 * Together AI TTS service with WebSocket streaming.
 *
 * Provides text-to-speech using Together AI's realtime WebSocket API.
 * Supports streaming synthesis with configurable voice and model options.
 *
 * @example
 * const tts = new TogetherTTSService({
 *   apiKey: "your-api-key",
 *   settings: new TogetherTTSService.Settings({
 *     voice: "tara",
 *     model: "canopylabs/orpheus-3b-0.1-ft",
 *   }),
 * });
 */
export class TogetherTTSService extends WebsocketTTSService {
  static Settings: typeof TogetherTTSSettings = TogetherTTSSettings;
  declare protected _settings: TogetherTTSSettings;

  static {
    installTracedTts(TogetherTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _sessionId: string | null = null;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Together AI TTS service.
   *
   * @param options.apiKey Together AI API key for authentication.
   * @param options.url WebSocket URL for Together AI TTS API.
   * @param options.sampleRate Output sample rate for emitted PCM frames.
   *   Defaults to 24000; Together streams at 24 kHz and does not support
   *   other rates.
   * @param options.settings Runtime-updatable settings for the TTS service.
   *   Other options are passed to WebsocketTTSService.
   */
  constructor(options: TogetherTTSServiceOptions) {
    const sampleRate =
      options.sampleRate === undefined ? TOGETHER_TTS_SAMPLE_RATE : options.sampleRate;
    if (sampleRate !== TOGETHER_TTS_SAMPLE_RATE) {
      logger.warning(
        `Together TTS streams at ${TOGETHER_TTS_SAMPLE_RATE} Hz; ` +
          `configured sample_rate=${sampleRate}`,
      );
    }

    const defaultSettings = new (new.target as typeof TogetherTTSService).Settings({
      model: "hexgrad/Kokoro-82M",
      voice: "af_heart",
      language: Language.EN,
      maxPartialLength: null,
      extraParams: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      sampleRate,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.together.ai/v1/audio/speech/websocket";
    this._sessionId = null;
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
   * @returns The Together AI language code.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToTogetherLanguage(language);
  }

  /** Apply a settings delta and reconnect if anything changed. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  /** Build the WebSocket URL with query parameters. */
  _buildWebsocketUrl(): string {
    const params: [string, unknown][] = [
      ["model", this._settings.model],
      ["voice", this._settings.voice],
    ];
    if (isGiven(this._settings.language) && this._settings.language) {
      params.push(["language", this._settings.language]);
    }
    if (this._settings.maxPartialLength !== null) {
      params.push(["max_partial_length", this._settings.maxPartialLength]);
    }
    // Kokoro blends voices with a `+`-separated name such as
    // "af_bella(2)+af_heart(1)", which has to be escaped or the server reads
    // the `+` as a space and rejects the voice.
    const query = params
      .map(([key, value]) => `${pyQuote(key)}=${pyQuote(String(value))}`)
      .join("&");
    return `${this._url}?${query}`;
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
   * Stop the Together AI TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Together AI TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  // ------------------------------------------------------------------
  // WebSocket connection management
  // ------------------------------------------------------------------

  /** Connect to the TTS endpoint and start receiving. */
  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    if (this._websocket && !this._receiveTask) {
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

  /** Establish the WebSocket connection to the Together AI TTS endpoint. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const wsUrl = this._buildWebsocketUrl();
      logger.debug(`Connecting to Together AI TTS: ${wsUrl}`);

      const headers = { Authorization: `Bearer ${this._apiKey}` };
      this._websocket = await this._websocketConnect(wsUrl, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");

      // Ensure voice is set on the server side
      try {
        const session: Dict = { voice: this._settings.voice };
        if (isGiven(this._settings.extraParams) && this._settings.extraParams) {
          session.extra_params = this._settings.extraParams;
        }
        const sessionUpdateMsg = { type: "tts_session.updated", session };
        await this._getWebsocket().send(pyJsonDumps(sessionUpdateMsg));
        logger.debug(`Sent initial voice setting to WebSocket: ${this._settings.voice}`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Error sending initial voice setting: ${errorMessage(e)}`);
      }

      logger.debug("Connected to Together AI TTS");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Together AI TTS: ${errorMessage(e)}`, {
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
      this._sessionId = null;
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

  /** Flush any pending audio by committing the text buffer. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    if (!this._websocket || this._websocket.state === State.CLOSED) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    await this._wsSend({ type: "input_text_buffer.commit" });
  }

  // ------------------------------------------------------------------
  // Server event handling
  // ------------------------------------------------------------------

  /**
   * Receive and dispatch server events from the TTS session.
   *
   * Called by `WebsocketService._receiveTaskHandler` which wraps this method
   * with automatic reconnection on connection errors.
   */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (typeof message !== "string") {
        continue;
      }

      let evt: Dict;
      try {
        evt = pyJsonLoads(message) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this} failed to parse WebSocket message`);
        continue;
      }

      const evtType = evt.type ?? "";

      if (evtType === "session.created") {
        await this._handleSessionCreated(evt);
      } else if (evtType === "session.updated") {
        await this._handleSessionUpdated(evt);
      } else if (evtType === "conversation.item.input_text.received") {
        const text: string = evt.text ?? "";
        logger.debug(`${this} text received: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);
      } else if (evtType === "conversation.item.audio_output.delta") {
        await this._handleAudioDelta(evt);
      } else if (evtType === "conversation.item.audio_output.done") {
        await this._handleAudioDone(evt);
      } else if (evtType === "conversation.item.tts.failed") {
        await this._handleTtsFailed(evt);
      } else if (evtType === "error") {
        await this._handleError(evt);
      } else {
        logger.trace(`${this} unhandled event: ${evtType}`);
      }
    }
  }

  /**
   * Handle `session.created` event.
   *
   * @param evt The session created event from the server.
   */
  protected async _handleSessionCreated(evt: Dict): Promise<void> {
    const session = evt.session ?? {};
    this._sessionId = session.id ?? null;
    logger.debug(`${this} session created: ${this._sessionId}`);
  }

  /**
   * Handle `session.updated` event.
   *
   * @param evt The session updated event from the server.
   */
  protected async _handleSessionUpdated(evt: Dict): Promise<void> {
    const session = evt.session ?? {};
    if ("voice" in session) {
      logger.debug(`${this} voice updated to: ${session.voice}`);
    }
  }

  /**
   * Handle an audio output delta containing a chunk of synthesized audio.
   *
   * @param evt The delta event from the server.
   */
  protected async _handleAudioDelta(evt: Dict): Promise<void> {
    const delta = evt.delta;
    if (delta) {
      try {
        await this.stopTtfbMetrics();
        const contextId = this.getActiveAudioContextId();
        const frame = new TTSAudioRawFrame({
          audio: base64ToBytes(delta),
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
        await this.appendToAudioContext(contextId as string, frame);
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Error processing audio delta: ${errorMessage(e)}`, {
          exception: e,
        });
      }
    }
  }

  /**
   * Handle audio output completion for a speech segment.
   *
   * @param evt The done event from the server.
   */
  protected async _handleAudioDone(evt: Dict): Promise<void> {
    logger.debug(`${this} audio generation complete for: ${evt.item_id}`);
    await this.stopAllMetrics();
    const contextId = this.getActiveAudioContextId();
    if (contextId) {
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    }
  }

  /**
   * Handle a TTS failure.
   *
   * @param evt The failed event containing error details.
   */
  protected async _handleTtsFailed(evt: Dict): Promise<void> {
    const contextId = this.getActiveAudioContextId();
    const error = evt.error ?? {};
    await this.pushError(`TTS error: ${pyJsonDumps(error)}`);
    await this.pushFrame(new TTSStoppedFrame({ contextId }));
    await this.stopAllMetrics();
  }

  /**
   * Handle a fatal error from the TTS session.
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
    const msg = `Together AI TTS error [${errorCode}]: ${errorMsg}`;
    await this.pushError(msg);
    throw new Error(msg);
  }

  // ------------------------------------------------------------------
  // Interruption handling
  // ------------------------------------------------------------------

  /**
   * Clear the Together AI text buffer when the bot is interrupted.
   *
   * @param contextId The ID of the audio context that was interrupted.
   */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (contextId) {
      await this._wsSend({ type: "input_text_buffer.clear" });
    }
    await super.onAudioContextInterrupted(contextId);
  }

  // ------------------------------------------------------------------
  // TTS generation
  // ------------------------------------------------------------------

  /**
   * Generate speech from text using Together AI's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio arrives via the WebSocket receive task.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      try {
        await this._wsSend({ type: "input_text_buffer.append", text });
        await this._wsSend({ type: "input_text_buffer.commit" });
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Together AI TTS send error: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }

      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Together AI TTS error: ${errorMessage(e)}` });
    }
  }
}
