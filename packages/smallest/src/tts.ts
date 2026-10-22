// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/smallest/tts.py

/**
 * Smallest AI text-to-speech service implementation.
 *
 * This module provides a WebSocket-based integration with Smallest AI's Waves
 * API for real-time text-to-speech synthesis.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), so the `Authorization` header is sent on every
 *   runtime, Cloudflare Workers included.
 * - `_buildMsg(text, contextId, continueTranscript)` takes its optional
 *   arguments as a trailing options object:
 *   `_buildMsg(text, { contextId, continueTranscript })`.
 * - `X-Pipecat-Version` carries the pipedog version.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  InterruptibleTTSService,
  type InterruptibleTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Available Smallest AI TTS models. */
export const SmallestTTSModel = {
  LIGHTNING_V3_1: "lightning_v3.1",
  LIGHTNING_V3_1_PRO: "lightning_v3.1_pro",
} as const;
export type SmallestTTSModel = (typeof SmallestTTSModel)[keyof typeof SmallestTTSModel];

const _MODEL_DEFAULT_VOICES: Record<SmallestTTSModel, string> = {
  [SmallestTTSModel.LIGHTNING_V3_1]: "sophia",
  [SmallestTTSModel.LIGHTNING_V3_1_PRO]: "meher",
};

/**
 * Convert a Language enum to a Smallest TTS language string.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding Smallest language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning.
 */
export function languageToSmallestTtsLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AR]: "ar",
    [Language.BN]: "bn",
    [Language.DE]: "de",
    [Language.EL]: "el",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FI]: "fi",
    [Language.FR]: "fr",
    [Language.GU]: "gu",
    [Language.HI]: "hi",
    [Language.ID]: "id",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KN]: "kn",
    [Language.KO]: "ko",
    [Language.ML]: "ml",
    [Language.MR]: "mr",
    [Language.MS]: "ms",
    [Language.NL]: "nl",
    [Language.NO]: "no",
    [Language.OR]: "or",
    [Language.PA]: "pa",
    [Language.PL]: "pl",
    [Language.PT]: "pt",
    [Language.RU]: "ru",
    [Language.SV]: "sv",
    [Language.TA]: "ta",
    [Language.TE]: "te",
    [Language.TR]: "tr",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface SmallestTTSSettingsOptions extends TTSSettingsOptions {
  speed?: number | null | NotGiven;
  mathNotation?: boolean | null | NotGiven;
  contentFilter?: "reject" | "flag" | string | null | NotGiven;
}

/**
 * Settings for SmallestTTSService.
 *
 * - `speed`: Speech speed multiplier (0.5–2.0).
 * - `mathNotation`: Read digit-flanked math operators as words (`2 + 2` as
 *   "two plus two") instead of leaving them to the default number reader. If
 *   null, the API default (off) applies.
 * - `contentFilter`: Check the text against Smallest's profanity word list
 *   before synthesis, taking this action on a match: `"reject"` fails the
 *   request with a `CONTENT_FILTER_BLOCKED` error and synthesizes nothing;
 *   `"flag"` synthesizes normally and records the match. The text is never
 *   rewritten. If null, the API default (off) applies.
 */
export class SmallestTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  mathNotation: boolean | null | NotGiven = NOT_GIVEN;
  contentFilter: "reject" | "flag" | string | null | NotGiven = NOT_GIVEN;

  constructor(options: SmallestTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SmallestTTSServiceOptions extends InterruptibleTTSServiceOptions {
  /** Smallest AI API key for authentication. */
  apiKey: string;
  /** Base WebSocket URL for the Smallest API. Defaults to "wss://api.smallest.ai". */
  baseUrl?: string;
  /**
   * Audio format returned by the API. One of `pcm`, `mp3`, `wav`, `ulaw`,
   * `alaw`. Defaults to `pcm`, which is what the pipeline expects internally.
   * Fixed at init time.
   */
  outputFormat?: string;
  /**
   * Whether to request per-word timing events, enabled by default. When true,
   * the server interleaves `word_timestamp` messages and the service emits
   * aligned per-word `TTSTextFrame`s. Supported on base-queue English + Hindi
   * voices (`meher`, `devansh`, `kartik`, `maithili`, `liam`, `avery`); other
   * voices silently emit no word events, so leaving this on is safe regardless
   * of voice. Fixed at init time because it determines whether text frames are
   * produced from word timing or pushed whole.
   */
  wordTimestamps?: boolean;
  /**
   * Upper bound, in milliseconds (0-5000), on how long the server buffers a
   * continuation fragment before speaking it. If null, the server's default
   * (3000ms) applies.
   */
  maxBufferDelayMs?: number | null;
  /** Runtime-updatable settings for the TTS service. */
  settings?: SmallestTTSSettings | null;
}

/**
 * Smallest AI real-time text-to-speech service using WebSocket streaming.
 *
 * Provides real-time text-to-speech synthesis using Smallest AI's WebSocket
 * API. Supports streaming audio generation with configurable voice parameters
 * and language settings. Handles interruptions by reconnecting the WebSocket.
 *
 * Text fragments within the same LLM turn share a continuation context:
 * they're sent with the turn's `context_id` and `continue: true` so the server
 * joins them into one continuous generation instead of resetting prosody on
 * each fragment, and the context is closed with `continue: false` once the
 * turn ends.
 *
 * @example
 * ```ts
 * const tts = new SmallestTTSService({
 *   apiKey: "your-api-key",
 *   settings: new SmallestTTSService.Settings({
 *     voice: "sophia",
 *     language: Language.EN,
 *     speed: 1.0,
 *   }),
 * });
 * ```
 */
export class SmallestTTSService extends InterruptibleTTSService {
  static Settings: typeof SmallestTTSSettings = SmallestTTSSettings;
  declare protected _settings: SmallestTTSSettings;

  static {
    installTracedTts(SmallestTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _outputFormat: string;
  protected _wordTimestamps: boolean;
  protected _maxBufferDelayMs: number | null;
  protected _receiveTask: Task<unknown> | null = null;

  // Word-timestamp offset tracking. Smallest sends one request per runTts()
  // call and reports word timestamps relative to *that request's* audio
  // (resetting to ~0 each request). All requests in an LLM turn share one
  // audio context, so we accumulate each request's duration and offset later
  // requests onto the turn's continuous timeline. Request boundaries are
  // detected by a change in the message `request_id` (Smallest emits a single
  // `complete` for the whole turn, not one per request). Reset per turn in
  // onTurnContextCreated(). This mirrors the cumulative-offset pattern used by
  // the Rime, Inworld, and Hume TTS services.
  _cumulativeTime = 0.0; // offset from prior requests in the turn
  protected _requestEndTime = 0.0; // max word end seen in the in-flight request
  _wtRequestId: string | null = null; // request_id of the in-flight request

  /**
   * Initialize the Smallest AI WebSocket TTS service.
   *
   * @param options.apiKey Smallest AI API key for authentication.
   * @param options.baseUrl Base WebSocket URL for the Smallest API.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses default.
   * @param options.outputFormat Audio format returned by the API.
   * @param options.wordTimestamps Whether to request per-word timing events.
   * @param options.maxBufferDelayMs Upper bound on how long the server buffers
   *   a continuation fragment before speaking it.
   * @param options.settings Runtime-updatable settings for the TTS service.
   *   Other options are passed to the parent InterruptibleTTSService.
   */
  constructor(options: SmallestTTSServiceOptions) {
    const cls = new.target as typeof SmallestTTSService;

    // Resolve the model early so we can pick the right default voice.
    let model: SmallestTTSModel = SmallestTTSModel.LIGHTNING_V3_1_PRO;
    const requested = options.settings?.model;
    if (requested !== undefined && requested !== null && requested !== NOT_GIVEN) {
      if ((Object.values(SmallestTTSModel) as string[]).includes(requested as string)) {
        model = requested as SmallestTTSModel;
      }
    }

    const defaultSettings = new cls.Settings({
      model,
      voice: _MODEL_DEFAULT_VOICES[model],
      language: Language.EN,
      speed: null,
      mathNotation: null,
      contentFilter: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const wordTimestamps = options.wordTimestamps ?? true;

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      // When word timestamps are on, per-word TTSTextFrames are emitted from
      // the word events; otherwise the base class pushes the whole text.
      pushTextFrames: !wordTimestamps,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = (options.baseUrl ?? "wss://api.smallest.ai").replace(/\/+$/, "");
    this._outputFormat = options.outputFormat ?? "pcm";
    this._wordTimestamps = wordTimestamps;
    this._maxBufferDelayMs = options.maxBufferDelayMs ?? null;
    this._receiveTask = null;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Smallest service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Close out a continuation context, releasing any buffered text.
   *
   * @param contextId The context to flush. If null, falls back to the
   *   currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    logger.trace(`${this}: flushing audio`);
    const msg = this._buildMsg("", { contextId: flushId, continueTranscript: false });
    await this._getWebsocket().send(pyJsonDumps(msg));
  }

  /**
   * Convert a Language enum to Smallest service language format.
   *
   * @param language The language to convert.
   * @returns The Smallest-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSmallestTtsLanguage(language);
  }

  /**
   * Build a WebSocket message for the Smallest API.
   *
   * @param text The text to synthesize.
   * @param options.contextId Groups this fragment with others sharing the same
   *   ID so the server buffers and joins them into one continuous generation
   *   instead of resetting prosody on each request.
   * @param options.continueTranscript Whether more fragments are coming for
   *   `contextId`. False marks this as the last fragment, closing the context
   *   once it has been spoken. Defaults to true.
   * @returns Dictionary with the API message payload.
   */
  _buildMsg(
    text: string,
    options: { contextId?: string; continueTranscript?: boolean } = {},
  ): Dict {
    const msg: Dict = {
      text,
      voice_id: this._settings.voice,
      model: this._settings.model,
      language: this._settings.language,
      sample_rate: this.sampleRate,
      context_id: options.contextId ?? "",
      continue: options.continueTranscript ?? true,
    };

    if (this._settings.speed !== null) {
      msg.speed = this._settings.speed;
    }

    if (this._settings.mathNotation !== null) {
      msg.math_notation = this._settings.mathNotation;
    }

    if (this._settings.contentFilter !== null) {
      msg.content_filter = { enabled: true, action: this._settings.contentFilter };
    }

    if (this._wordTimestamps) {
      msg.word_timestamps = true;
    }

    if (this._maxBufferDelayMs !== null) {
      msg.max_buffer_delay_ms = this._maxBufferDelayMs;
    }

    msg.output_format = this._outputFormat;

    return msg;
  }

  /** Build the WebSocket URL. */
  protected _buildWebsocketUrl(): string {
    return `${this._baseUrl}/waves/v1/tts/live`;
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
   * Apply a settings delta.
   *
   * All fields (model, speed, mathNotation, contentFilter, voice, language)
   * take effect on the next `_buildMsg` call without reconnecting.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    return await super._updateSettings(delta);
  }

  /** Connect to Smallest WebSocket and start receive task. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(30);
    }
  }

  /** Disconnect from Smallest WebSocket and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  /** Establish WebSocket connection to the Smallest API. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Smallest TTS");

      this._websocket = await this._websocketConnect(this._buildWebsocketUrl(), {
        additionalHeaders: {
          Authorization: `Bearer ${this._apiKey}`,
          "X-Source": "pipecat",
          "X-Pipecat-Version": pipecatVersion(),
        },
      });

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Smallest TTS connection error: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Close the WebSocket connection and clean up state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from Smallest TTS");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Smallest TTS error closing websocket: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Get the WebSocket connection if available.
   *
   * @returns The active WebSocket connection.
   * @throws Error if no WebSocket connection is available.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Send a silent message to keep the WebSocket connection alive. */
  protected override async _sendKeepalive(): Promise<void> {
    const msg = {
      text: " ",
      voice_id: this._settings.voice,
      model: this._settings.model,
      language: this._settings.language,
    };
    await this._getWebsocket().send(pyJsonDumps(msg));
  }

  /**
   * Roll the turn offset forward when word timestamps cross into a new request.
   *
   * Smallest reports word timestamps relative to each request's own audio and
   * does not emit a per-request `complete`, so a change in `request_id` is what
   * marks the boundary between requests within a turn. When the boundary is
   * crossed, the just-finished request's span (its last word `end`) is folded
   * into the running offset applied to subsequent requests.
   *
   * @param requestId The `request_id` of the current message.
   */
  protected _advanceWordTimestampRequest(requestId: string | null): void {
    if (requestId === this._wtRequestId) {
      return;
    }
    if (this._wtRequestId !== null) {
      this._cumulativeTime += this._requestEndTime;
      this._requestEndTime = 0.0;
    }
    this._wtRequestId = requestId;
  }

  /**
   * Reset the word-timestamp offset at the start of each turn.
   *
   * Each LLM turn gets a fresh audio context, so the per-request offset
   * accumulated for the previous turn must not carry over.
   *
   * @param _contextId The newly created turn context ID.
   */
  override async onTurnContextCreated(_contextId: string): Promise<void> {
    this._cumulativeTime = 0.0;
    this._requestEndTime = 0.0;
    this._wtRequestId = null;
  }

  /** Receive and process messages from the Smallest WebSocket API. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const msg = pyJsonLoads(text) as Dict;
      const status = msg.status;

      if (status === "complete") {
        await this.stopAllMetrics();
      } else if (status === "chunk") {
        await this.stopTtfbMetrics();
        const contextId = this.getActiveAudioContextId();
        const frame = new TTSAudioRawFrame({
          audio: base64ToBytes(msg.data.audio),
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
        await this.appendToAudioContext(contextId as string, frame);
      } else if (status === "word_timestamp") {
        this._advanceWordTimestampRequest(msg.request_id ?? null);
        const data = msg.data ?? {};
        const word = data.word;
        const start = data.start;
        const end = data.end;
        if (word !== undefined && word !== null && start !== undefined && start !== null) {
          const contextId = this.getActiveAudioContextId();
          // Offset this request's relative start onto the turn timeline. The
          // base class consumes only (word, start); `end` is used locally to
          // size the offset for the next request.
          await this.addWordTimestamps([[word, start + this._cumulativeTime]], contextId);
          if (end !== undefined && end !== null) {
            this._requestEndTime = Math.max(this._requestEndTime, end);
          }
        }
      } else if (status === "error") {
        const contextId = this.getActiveAudioContextId();
        await this.pushFrame(new TTSStoppedFrame({ contextId }));
        await this.stopAllMetrics();
        await this.pushError(`Smallest TTS error: ${msg.error ?? pyJsonDumps(msg)}`);
      } else {
        logger.warning(`${this} unknown message status: ${pyJsonDumps(msg)}`);
      }
    }
  }

  /**
   * Generate speech from text using Smallest's WebSocket streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId Unique identifier for this TTS context.
   * @returns Audio arrives via the WebSocket receive task; yields null, or an
   *   ErrorFrame on failure.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      try {
        const msg = this._buildMsg(text, { contextId });
        await this._getWebsocket().send(pyJsonDumps(msg));
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Smallest TTS send error: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Smallest TTS error: ${errorMessage(e)}` });
    }
  }
}
