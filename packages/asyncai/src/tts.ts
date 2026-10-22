// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/asyncai/tts.py

/**
 * Async text-to-speech service implementations.
 *
 * Porting notes:
 * - The WebSocket service connects through core's `websocketConnect` (via
 *   `WebsocketService._websocketConnect()`). Async takes its key in the URL's query
 *   string, so no handshake header is needed and it runs on Bun, Node, Deno and Workers.
 * - `AsyncAIHttpTTSService` uses `fetch`. Upstream's required `aiohttp_session` becomes an
 *   optional `fetch` function (defaults to the global `fetch`).
 * - Not ported, as deprecated upstream: `InputParams`, and the `params`, `voice_id`,
 *   `model` and `aggregate_sentences` constructor arguments. Use `settings` and
 *   `textAggregationMode`.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TTSService,
  type TTSServiceOptions,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to Async language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g.,
 *   `en` from `en-US`) and logs a warning (via `resolveLanguage(..., true)`).
 */
export function languageToAsyncLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "en",
    [Language.FR]: "fr",
    [Language.ES]: "es",
    [Language.DE]: "de",
    [Language.IT]: "it",
    [Language.PT]: "pt",
    [Language.NL]: "nl",
    [Language.AR]: "ar",
    [Language.RU]: "ru",
    [Language.RO]: "ro",
    [Language.JA]: "ja",
    [Language.HE]: "he",
    [Language.HY]: "hy",
    [Language.TR]: "tr",
    [Language.HI]: "hi",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface AsyncAITTSSettingsOptions extends TTSSettingsOptions {}

/** Settings for AsyncAITTSService and AsyncAIHttpTTSService. */
export class AsyncAITTSSettings extends TTSSettings {
  constructor(options: AsyncAITTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AsyncAITTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Async API key. */
  apiKey: string;
  /** Async API version. */
  version?: string;
  /** WebSocket URL for Async TTS API. */
  url?: string;
  /** Audio encoding format. */
  encoding?: string;
  /** Audio container format. */
  container?: string;
  /** Runtime-updatable settings. */
  settings?: AsyncAITTSSettings | null;
}

/**
 * Async TTS service with WebSocket streaming.
 *
 * Provides text-to-speech using Async's streaming WebSocket API.
 */
export class AsyncAITTSService extends WebsocketTTSService {
  static Settings: typeof AsyncAITTSSettings = AsyncAITTSSettings;

  /**
   * Settings baked into the websocket init message, and therefore only
   * changeable by starting a new session.
   */
  static _SESSION_INIT_FIELDS: ReadonlySet<string> = new Set(["model", "voice", "language"]);

  declare protected _settings: AsyncAITTSSettings;

  static {
    installTracedTts(AsyncAITTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _apiVersion: string;
  protected _url: string;

  // Init-only audio format config (not runtime-updatable).
  protected _outputContainer: string;
  protected _outputEncoding: string;
  protected _outputSampleRate = 0; // Set in setup()

  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Async TTS service.
   *
   * @param options.apiKey Async API key.
   * @param options.version Async API version.
   * @param options.url WebSocket URL for Async TTS API.
   * @param options.sampleRate Audio sample rate.
   * @param options.encoding Audio encoding format.
   * @param options.container Audio container format.
   * @param options.settings Runtime-updatable settings. `voice` is the UUID of the
   *   voice to use for synthesis. See docs for a full list:
   *   https://docs.async.com/list-voices-16699698e0
   * @param options.textAggregationMode How to aggregate text before synthesis.
   *   Other options are passed to the parent service.
   */
  constructor(options: AsyncAITTSServiceOptions) {
    const defaultSettings = new (new.target as typeof AsyncAITTSService).Settings({
      model: "async_flash_v1.5",
      voice: null,
      language: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._apiVersion = options.version ?? "v1";
    this._url = options.url ?? "wss://api.async.com/text_to_speech/websocket/ws";

    this._outputContainer = options.container ?? "raw";
    this._outputEncoding = options.encoding ?? "pcm_s16le";
  }

  /**
   * Apply a settings delta, reconnecting when a session-init field changes.
   *
   * `model`, `voice` and `language` are sent once in the init message at
   * connect time and are never repeated per utterance (`_buildMsg` carries
   * only the transcript and context id), so a new websocket session is the only
   * way a change to any of them reaches Async.
   *
   * @param delta A settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    const changedKeys = Object.keys(changed);
    if (changedKeys.length === 0) {
      return changed;
    }

    const initFields = (this.constructor as typeof AsyncAITTSService)._SESSION_INIT_FIELDS;
    if (changedKeys.some((key) => initFields.has(key))) {
      await this._disconnect();
      await this._connect();
    }

    this._warnUnhandledUpdatedSettings(changedKeys.filter((key) => !initFields.has(key)));

    return changed;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Async language format.
   *
   * @param language The language to convert.
   * @returns The Async-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAsyncLanguage(language);
  }

  protected _buildMsg(text = "", contextId = "", force = false): string {
    const msg = { transcript: text, context_id: contextId, force };
    return pyJsonDumps(msg);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._outputSampleRate = this.sampleRate;
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(10);
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }
      logger.debug("Connecting to Async");
      this._websocket = await this._websocketConnect(
        `${this._url}?api_key=${this._apiKey}&version=${this._apiVersion}`,
      );
      const initMsg = {
        model_id: this._settings.model,
        voice: { mode: "id", id: this._settings.voice },
        output_format: {
          container: this._outputContainer,
          encoding: this._outputEncoding,
          sample_rate: this._outputSampleRate,
        },
        language: this._settings.language,
      };

      await this._getWebsocket().send(pyJsonDumps(initMsg));

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
        logger.debug("Disconnecting from Async");
        // Close all contexts and the socket
        if (this.hasActiveAudioContext()) {
          await this._websocket.send(pyJsonDumps({ terminate: true }));
        }
        await this._websocket.close();
        logger.debug("Disconnected from Async");
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket() {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Flush any pending audio.
   *
   * @param contextId The specific context to flush. If null, falls back to the
   *   currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    const msg = this._buildMsg(" ", flushId, true);
    await this._websocket.send(msg);
  }

  /**
   * Push a frame downstream with special handling for stop conditions.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushFrame(frame, direction);
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const msg = pyJsonLoads(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      ) as Dict;
      if (!msg || Object.keys(msg).length === 0) {
        continue;
      }

      const receivedCtxId: string | undefined = msg.context_id;
      // Handle final messages first, regardless of context availability
      // At the moment, this message is received AFTER the close_context message is
      // sent, so it doesn't serve any functional purpose. For now, we'll just log it.
      if (msg.final === true) {
        logger.trace(`Received final message for context ${receivedCtxId}`);
        continue;
      }

      // Check if this message belongs to the current context.
      if (!this.audioContextAvailable(receivedCtxId as string)) {
        if (this.getActiveAudioContextId() === receivedCtxId) {
          logger.debug(`Received a delayed message, recreating the context: ${receivedCtxId}`);
          await this.createAudioContext(receivedCtxId as string);
        } else {
          // This can happen if a message is received _after_ we have closed a context
          // due to user interruption but _before_ the `isFinal` message for the context
          // is received.
          logger.debug(`Ignoring message from unavailable context: ${receivedCtxId}`);
          continue;
        }
      }

      if (msg.audio) {
        await this.stopTtfbMetrics();
        const audio = base64ToBytes(msg.audio);
        const frame = new TTSAudioRawFrame({
          audio,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: receivedCtxId ?? null,
        });
        await this.appendToAudioContext(receivedCtxId as string, frame);
      }
    }
  }

  /** Send a blank transcript, on the active context if there is one. */
  protected override async _sendKeepalive(): Promise<void> {
    const contextId = this.getActiveAudioContextId();
    let keepaliveMessage: Dict;
    if (contextId) {
      keepaliveMessage = { transcript: " ", context_id: contextId };
      logger.trace("Sending keepalive message");
    } else {
      // It's possible to have a user interruption which clears the context
      // without generating a new TTS response. In this case, we'll just send
      // an empty message to keep the connection alive.
      keepaliveMessage = { transcript: " " };
      logger.trace("Sending keepalive without context");
    }
    await this._getWebsocket().send(pyJsonDumps(keepaliveMessage));
  }

  protected async _closeContext(contextId: string): Promise<void> {
    // Async AI requires explicit context closure to free server-side resources,
    // both on interruption and on normal completion.
    if (contextId && this._websocket) {
      try {
        await this._websocket.send(
          pyJsonDumps({ context_id: contextId, close_context: true, transcript: "" }),
        );
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this}: Error closing context ${contextId}: ${errorMessage(e)}`);
      }
    }
  }

  /** Close the Async AI context when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this._closeContext(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Close the Async AI context after all audio has been played.
   *
   * Async AI does not send a server-side signal when a context is
   * exhausted, so Pipecat must explicitly close it with
   * `close_context: true` to free server-side resources.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await this._closeContext(contextId);
    await super.onAudioContextCompleted(contextId);
  }

  /**
   * Generate speech from text using Async API websocket endpoint.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      let failure: unknown = null;
      try {
        const msg = this._buildMsg(text, contextId, true);
        await this._getWebsocket().send(msg);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        failure = e;
      }
      if (failure !== null) {
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(failure)}` });
        yield new TTSStoppedFrame({ contextId });
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

/** Yield a body stream's bytes as they arrive, in chunks of at most `chunkSize` bytes. */
async function* iterChunked(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        yield value.subarray(offset, Math.min(offset + chunkSize, value.length));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

export interface AsyncAIHttpTTSServiceOptions extends TTSServiceOptions {
  /** Async API key. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a required shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Base URL for Async API. */
  url?: string;
  /** API version string for Async API. */
  version?: string;
  /** Audio encoding format. */
  encoding?: string;
  /** Audio container format. */
  container?: string;
  /** Runtime-updatable settings. */
  settings?: AsyncAITTSSettings | null;
}

/**
 * HTTP-based Async TTS service.
 *
 * Provides text-to-speech using Async's HTTP streaming API for simpler,
 * non-WebSocket integration. Suitable for use cases where streaming WebSocket
 * connection is not required or desired.
 */
export class AsyncAIHttpTTSService extends TTSService {
  static Settings: typeof AsyncAITTSSettings = AsyncAITTSSettings;
  declare protected _settings: AsyncAITTSSettings;

  static {
    installTracedTts(AsyncAIHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _apiVersion: string;
  protected _fetch: typeof fetch;

  // Init-only audio format config (not runtime-updatable).
  protected _outputContainer: string;
  protected _outputEncoding: string;
  protected _outputSampleRate = 0; // Set in setup()

  /**
   * Initialize the Async TTS service.
   *
   * @param options.apiKey Async API key.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   * @param options.url Base URL for Async API.
   * @param options.version API version string for Async API.
   * @param options.sampleRate Audio sample rate.
   * @param options.encoding Audio encoding format.
   * @param options.container Audio container format.
   * @param options.settings Runtime-updatable settings. `voice` is the ID of the voice
   *   to use for synthesis.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: AsyncAIHttpTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof AsyncAIHttpTTSService).Settings({
      model: "async_flash_v1.5",
      voice: null,
      language: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.url ?? "https://api.async.com";
    this._apiVersion = options.version ?? "v1";
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));

    this._outputContainer = options.container ?? "raw";
    this._outputEncoding = options.encoding ?? "pcm_s16le";
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Async language format.
   *
   * @param language The language to convert.
   * @returns The Async-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAsyncLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._outputSampleRate = this.sampleRate;
  }

  /**
   * Generate speech from text using Async's HTTP streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      const voiceConfig = { mode: "id", id: this._settings.voice };

      const payload = {
        model_id: this._settings.model,
        transcript: text,
        voice: voiceConfig,
        output_format: {
          container: this._outputContainer,
          encoding: this._outputEncoding,
          sample_rate: this._outputSampleRate,
        },
        language: this._settings.language,
      };

      const headers = {
        version: this._apiVersion,
        "x-api-key": this._apiKey,
        "Content-Type": "application/json",
      };
      const url = `${this._baseUrl}/text_to_speech/streaming`;

      const response = await abortable(
        this._fetch(url, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      let audioData: Uint8Array;
      try {
        if (response.status !== 200) {
          const errorText = await abortable(response.text());
          await this.pushError(`Async API error: ${errorText}`);
          throw new Error(`Async API returned status ${response.status}: ${errorText}`);
        }

        // Read streaming bytes; stop TTFB on the *first* received chunk
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of iterChunked(response.body, 64 * 1024)) {
          if (chunk.length === 0) {
            continue;
          }
          await this.stopTtfbMetrics();
          chunks.push(chunk);
          total += chunk.length;
        }
        audioData = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          audioData.set(chunk, offset);
          offset += chunk.length;
        }
      } finally {
        await response.body?.cancel().catch(() => {});
      }

      await this.startTtsUsageMetrics(text);

      const frame = new TTSAudioRawFrame({
        audio: audioData,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });

      yield frame;
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
