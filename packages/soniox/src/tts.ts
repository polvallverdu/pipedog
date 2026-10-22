// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/soniox/tts.py

/**
 * Soniox text-to-speech service implementation.
 *
 * This module provides a WebSocket-based TTS service using the Soniox real-time
 * Text-to-Speech API. It streams text to the server incrementally and receives
 * audio back as base64-encoded chunks, multiplexed across multiple concurrent
 * streams by `stream_id`.
 *
 * Soniox API reference: https://soniox.com/docs/api-reference/tts/websocket-api
 * (per-stream config message, `text` / `text_end` / `cancel` messages, `audio`,
 * `timestamps`, `terminated` and error responses; checked 2026-10-22). The
 * `{"keep_alive": true}` message is not on that page and comes from upstream.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (core's
 *   `websocketConnect`), with `Authorization: Bearer <key>` on the opening
 *   handshake (sent through `fetch` on Cloudflare Workers).
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
  type TextAggregationMode,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { classifyErrorCode } from "./errors.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Soniox idle timeout is 20-30s; keepalive cadence must stay well inside it.
export const KEEPALIVE_INTERVAL_SECONDS = 20;

// Soniox-supported sample rates for raw PCM formats
export const VALID_SAMPLE_RATES: ReadonlySet<number> = new Set([8000, 16000, 24000, 44100, 48000]);

/**
 * Convert a pipedog Language to a Soniox TTS language code.
 *
 * For the full list of supported languages, see:
 * https://soniox.com/docs/tts/concepts/languages
 */
export function languageToSonioxTtsLanguage(language: Language): string | null {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "af",
    [Language.AR]: "ar",
    [Language.AZ]: "az",
    [Language.BE]: "be",
    [Language.BG]: "bg",
    [Language.BN]: "bn",
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
    [Language.FR]: "fr",
    [Language.GL]: "gl",
    [Language.GU]: "gu",
    [Language.HE]: "he",
    [Language.HI]: "hi",
    [Language.HR]: "hr",
    [Language.HU]: "hu",
    [Language.ID]: "id",
    [Language.IS]: "is",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KK]: "kk",
    [Language.KN]: "kn",
    [Language.KO]: "ko",
    [Language.LT]: "lt",
    [Language.LV]: "lv",
    [Language.MK]: "mk",
    [Language.ML]: "ml",
    [Language.MR]: "mr",
    [Language.MS]: "ms",
    [Language.NB]: "no",
    [Language.NL]: "nl",
    [Language.NO]: "no",
    [Language.PA]: "pa",
    [Language.PL]: "pl",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SK]: "sk",
    [Language.SL]: "sl",
    [Language.SQ]: "sq",
    [Language.SR]: "sr",
    [Language.SU]: "su",
    [Language.SV]: "sv",
    [Language.SW]: "sw",
    [Language.TA]: "ta",
    [Language.TE]: "te",
    [Language.TH]: "th",
    [Language.TL]: "tl",
    [Language.TR]: "tr",
    [Language.UK]: "uk",
    [Language.UR]: "ur",
    [Language.UZ]: "uz",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface SonioxTTSSettingsOptions extends TTSSettingsOptions {
  speed?: number | null | NotGiven;
  reduceSilence?: boolean | null | NotGiven;
  clientReferenceId?: string | null | NotGiven;
}

/**
 * Settings for SonioxTTSService.
 *
 * `voice`, `model`, `language`, `speed`, `reduceSilence` and
 * `clientReferenceId` travel in the per-stream config message, so changing
 * any of them does not require reconnecting the WebSocket. The current context
 * is flushed so the next stream opens with the new values.
 *
 * - `voice`: voice name (e.g. "Adrian") or the UUID of a cloned voice in the
 *   project owning the API key.
 * - `speed`: speech rate multiplier in the range 0.7-1.3. null leaves it
 *   unset and uses the Soniox server default (1.0).
 * - `reduceSilence`: shorten the pauses between words so the speech flows
 *   more tightly, without changing how fast the words themselves are spoken.
 *   Only models whose catalogue entry reports `supports_silence_reduction`
 *   accept it. null leaves it unset and uses the Soniox server default (false).
 * - `clientReferenceId`: client-defined identifier recorded with each request
 *   in the Soniox usage logs, for attributing usage to a customer or session.
 *   Ignored for temporary API keys.
 */
export class SonioxTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  reduceSilence: boolean | null | NotGiven = NOT_GIVEN;
  clientReferenceId: string | null | NotGiven = NOT_GIVEN;

  constructor(options: SonioxTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SonioxTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Soniox API key for authentication. Create API keys at https://console.soniox.com. */
  apiKey: string;
  /** WebSocket URL for the Soniox TTS endpoint. */
  url?: string;
  /**
   * Output audio format. Defaults to "pcm_s16le", which matches the
   * downstream audio pipeline.
   */
  audioFormat?: string;
  /** Runtime-updatable settings. */
  settings?: SonioxTTSSettings | null;
  /**
   * How to aggregate incoming text before synthesis. Defaults to
   * `TextAggregationMode.SENTENCE`.
   */
  textAggregationMode?: TextAggregationMode | null;
}

/**
 * Soniox WebSocket TTS service with streaming text-in, streaming audio-out.
 *
 * Streams text incrementally to Soniox's real-time TTS endpoint and routes the
 * returned base64-encoded audio back as `TTSAudioRawFrame` frames.
 * Multiple concurrent streams are multiplexed over a single WebSocket
 * connection via the audio-context mechanism (mapped to Soniox's
 * `stream_id`). Supports up to 5 concurrent streams per connection.
 *
 * For complete API documentation, see:
 * https://soniox.com/docs/api-reference/tts/websocket-api
 */
export class SonioxTTSService extends WebsocketTTSService {
  static Settings: typeof SonioxTTSSettings = SonioxTTSSettings;
  declare protected _settings: SonioxTTSSettings;

  static {
    installTracedTts(SonioxTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _audioFormat: string;
  // Tracks which contextIds have had their per-stream config sent.
  // Soniox rejects duplicate config for the same stream_id.
  protected _configuredContexts: Set<string> = new Set();
  // Per-stream word still being assembled across timestamp messages (a word's
  // characters can arrive split across messages). stream_id -> [word, start_s].
  protected _partials: Map<string, [string, number]> = new Map();
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Soniox TTS service.
   *
   * @param options.apiKey Soniox API key for authentication.
   * @param options.url WebSocket URL for the Soniox TTS endpoint.
   * @param options.sampleRate Output sample rate in Hz. Must be one of
   *   {8000, 16000, 24000, 44100, 48000} when using a raw PCM audio format.
   *   If null, inherits from the pipeline.
   * @param options.audioFormat Output audio format. Defaults to "pcm_s16le".
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Defaults to `TextAggregationMode.SENTENCE`.
   *   Other options are passed to the parent service.
   */
  constructor(options: SonioxTTSServiceOptions) {
    // Initialize default settings
    const defaultSettings = new (new.target as typeof SonioxTTSService).Settings({
      model: "tts-rt-v2",
      voice: "Bryce",
      language: Language.EN,
      speed: null,
      reduceSilence: null,
      clientReferenceId: null,
    });

    // Settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      textAggregationMode: options.textAggregationMode ?? null,
      // We emit word-aligned TTSTextFrames from Soniox timestamps as audio
      // plays, so the base class must not push each sentence's text up front.
      pushTextFrames: false,
      // We push TTSStoppedFrame ourselves when Soniox sends `terminated`.
      pushStopFrames: false,
      // Let the base class create audio contexts and emit TTSStartedFrame.
      pushStartFrame: true,
      pauseFrameProcessing: false,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://tts-rt.soniox.com/tts-websocket";

    // Init-only audio format (not runtime-updatable).
    this._audioFormat = options.audioFormat ?? "pcm_s16le";
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Soniox TTS supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to a Soniox TTS language code.
   *
   * @param language The language to convert.
   * @returns The Soniox-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSonioxTtsLanguage(language);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (this._audioFormat.startsWith("pcm_") && !VALID_SAMPLE_RATES.has(this.sampleRate)) {
      logger.warning(
        `${this}: sampleRate=${this.sampleRate} is not in Soniox supported rates ` +
          `[${[...VALID_SAMPLE_RATES].sort((a, b) => a - b).join(", ")}]; the server may reject the stream.`,
      );
    }
    await this._connect();
  }

  /**
   * Stop the Soniox TTS service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Soniox TTS service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Flush any pending audio and finalize the current stream.
   *
   * @param contextId The specific context to flush. If null, falls back to
   *   the currently active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }
    logger.trace(`${this}: flushing audio for stream ${flushId}`);
    const msg = { text: "", text_end: true, stream_id: flushId };
    await this._websocket.send(pyJsonDumps(msg));
  }

  /**
   * Cancel a Soniox stream and forget local state.
   *
   * `cancel: true` works on any currently-open stream (Soniox replies with
   * `terminated`). Gated on `_configuredContexts` because `cancel` on a
   * stream_id Soniox never saw would error. Do not call after
   * `text_end: true`: that already terminates the stream.
   */
  protected async _closeStream(contextId: string): Promise<void> {
    if (this._configuredContexts.has(contextId)) {
      if (this._websocket && this._websocket.state === State.OPEN) {
        try {
          const msg = { stream_id: contextId, cancel: true };
          await this._websocket.send(pyJsonDumps(msg));
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: failed to cancel stream ${contextId}: ${errorMessage(e)}`);
        }
      }
    }
    this._configuredContexts.delete(contextId);
  }

  /**
   * Eagerly open the Soniox stream when a new turn context is created.
   *
   * Overlaps Soniox-side stream creation with sentence aggregation so the
   * stream is ready by the time text reaches `runTts`.
   */
  override async onTurnContextCreated(contextId: string): Promise<void> {
    try {
      await this._sendConfig(contextId);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: failed to pre-open Soniox stream ${contextId}: ${errorMessage(e)}`);
    }
  }

  /**
   * Cancel any eagerly-opened Soniox stream that never received text.
   *
   * The base class sends `text_end: true` (via `flushAudio`) for streams that
   * received text; that already terminates the stream. For an empty turn
   * (e.g., the LLM produced only tool calls), no text reaches `runTts` and the
   * eager-opened stream would otherwise sit until Soniox's per-stream idle
   * timer fires. Cancel it here.
   */
  override async onTurnContextCompleted(): Promise<void> {
    const ctxId = this._turnContextId;
    const wasActive = ctxId !== null && this.audioContextAvailable(ctxId);
    await super.onTurnContextCompleted();
    if (ctxId !== null && !wasActive) {
      await this._closeStream(ctxId);
    }
  }

  /** Cancel the active Soniox stream when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    await this._closeStream(contextId);
    this._partials.delete(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Apply a settings delta, flushing the active stream if needed.
   *
   * All Soniox config fields live in the per-stream config message, so
   * changes take effect on the next stream. The current stream is flushed so
   * subsequent sentences in this turn open a fresh stream with the updated
   * values.
   *
   * @param delta A TTS settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    const keys = Object.keys(changed);
    if (keys.length === 0) {
      return changed;
    }

    const streamFields = [
      "voice",
      "model",
      "language",
      "speed",
      "reduceSilence",
      "clientReferenceId",
    ];
    if (keys.some((k) => streamFields.includes(k))) {
      if (this._turnContextId) {
        // Finalize the old context's still-pending sentence so its
        // already-heard prefix still emits progress frames (mirrors the
        // LLMFullResponseEnd / TTSSpeak close paths). A mid-sentence
        // settings change would otherwise abandon it before promotion,
        // dropping that prefix from the transcript.
        await this._pushSequencerFrames(
          await this._aggregatedFrameSequencer.finalize(this._turnContextId),
          this._turnContextId,
        );
      }
      if (this._turnContextId && this.audioContextAvailable(this._turnContextId)) {
        await this.flushAudio(this._turnContextId);
      }
      // Assign a new turn context ID so subsequent sentences in this turn
      // open a new Soniox stream with the updated settings.
      if (this._turnContextId) {
        this._turnContextId = null;
        this._turnContextId = this.createContextId();
      }
    }

    return changed;
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
      this._createKeepaliveTask(KEEPALIVE_INTERVAL_SECONDS);
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
      logger.debug("Connecting to Soniox TTS");
      this._websocket = await this._websocketConnect(this._url, {
        additionalHeaders: { Authorization: `Bearer ${this._apiKey}` },
      });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to Soniox TTS: ${errorMessage(e)}`, { exception: e });
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      if (this._websocket) {
        logger.debug("Disconnecting from Soniox TTS");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing Soniox websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._configuredContexts.clear();
      this._partials.clear();
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Build the per-stream configuration message for a new stream_id. */
  protected _buildConfigMsg(contextId: string): Dict {
    const s = this._settings;
    const config: Dict = {
      stream_id: contextId,
      model: s.model,
      voice: s.voice,
      audio_format: this._audioFormat,
    };
    if (s.language !== null) {
      config.language = s.language;
    }
    if (s.speed !== null) {
      config.speed = s.speed;
    }
    if (s.reduceSilence !== null) {
      config.reduce_silence = s.reduceSilence;
    }
    if (s.clientReferenceId !== null) {
      config.client_reference_id = s.clientReferenceId;
    }
    // Character-level timestamps drive the word-aligned TTSTextFrames.
    config.return_timestamps = true;
    if (this._audioFormat.startsWith("pcm_")) {
      config.sample_rate = this.sampleRate;
    }
    return config;
  }

  /**
   * Send the per-stream config for `contextId`, idempotently.
   *
   * Soniox rejects duplicate config for the same stream_id, so the set of
   * already-configured contexts gates the send.
   */
  protected async _sendConfig(contextId: string): Promise<void> {
    if (this._configuredContexts.has(contextId)) {
      return;
    }
    const config = this._buildConfigMsg(contextId);
    await this._getWebsocket().send(pyJsonDumps(config));
    this._configuredContexts.add(contextId);
    logger.trace(`${this}: opened Soniox stream ${contextId}`);
  }

  /** Reset Soniox's idle timeout without triggering synthesis. */
  protected override async _sendKeepalive(): Promise<void> {
    await this._getWebsocket().send(pyJsonDumps({ keep_alive: true }));
    logger.trace(`${this}: sent Soniox keepalive`);
  }

  /**
   * Whether the current language is written without spaces between words.
   *
   * Chinese and Japanese never use spaces, so their timestamps are emitted per
   * character.
   */
  _isChineseOrJapaneseLanguage(): boolean {
    const language = this._settings.language;
    if (language === null || language === NOT_GIVEN) {
      return false;
    }
    const code = String(language);
    return ["zh", "ja"].includes((code.split("-")[0] as string).toLowerCase());
  }

  /**
   * Turn one Soniox timestamp message into `[word, startSeconds]` tuples.
   *
   * Soniox emits two parallel arrays:
   *
   *     characters:                    ["H", "i", " ", "y", "o", "u"]
   *     character_start_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
   *
   * which this turns into `[["Hi", 0.1], ["you", 0.4]]`.
   */
  _toWordTimes(streamId: string, timestamps: Dict): [string, number][] {
    const chars: string[] = timestamps.characters ?? [];
    const starts: number[] = timestamps.character_start_times_seconds ?? [];
    if (chars.length !== starts.length) {
      logger.error(`${this}: Soniox timestamp mismatch: ${chars.length} vs ${starts.length}`);
      return [];
    }

    if (this._isChineseOrJapaneseLanguage()) {
      // Python's `str.isalnum()`: letters, digits and other numerics (any script).
      return chars.flatMap((c, i): [string, number][] =>
        c.length > 0 && /^[\p{L}\p{N}]+$/u.test(c) ? [[c, starts[i] as number]] : [],
      );
    }

    let [currentWord, wordStartTime] = this._partials.get(streamId) ?? ["", 0.0];
    const wordsWithStartTimes: [string, number][] = [];
    chars.forEach((char, i) => {
      const start = starts[i] as number;
      if (char === " ") {
        if (currentWord) {
          wordsWithStartTimes.push([currentWord, wordStartTime]);
          currentWord = "";
        }
      } else {
        if (!currentWord) {
          // first character of a new word
          wordStartTime = start;
        }
        currentWord += char;
      }
    });
    this._partials.set(streamId, [currentWord, wordStartTime]);
    return wordsWithStartTimes;
  }

  /**
   * Handle incoming WebSocket messages from Soniox.
   *
   * Routes audio, error, and terminal events to the appropriate audio
   * contexts. A failed stream does not close the WebSocket; other active
   * streams continue uninterrupted.
   */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      let msg: Dict;
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        msg = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: received non-JSON Soniox message: ${String(message)}`);
        continue;
      }

      const streamId: string | null = msg.stream_id ?? null;

      const errorCode = msg.error_code;
      if (errorCode !== undefined && errorCode !== null) {
        const errorMsg = msg.error_message ?? "";
        const errorType = msg.error_type ?? "";
        await this.pushError(
          `Soniox TTS error ${errorCode} ${errorType} (stream ${streamId}): ${errorMsg}`,
          { category: classifyErrorCode(errorCode) },
        );
        if (streamId && this.audioContextAvailable(streamId)) {
          await this.appendToAudioContext(streamId, new TTSStoppedFrame({ contextId: streamId }));
          await this.removeAudioContext(streamId);
        }
        if (streamId !== null) {
          this._partials.delete(streamId);
          this._configuredContexts.delete(streamId);
        }
        continue;
      }

      if (msg.terminated) {
        if (streamId && this.audioContextAvailable(streamId)) {
          // Emit the buffered final word (no trailing space closed it).
          const [finalWord, start] = this._partials.get(streamId) ?? ["", 0.0];
          if (finalWord) {
            await this.addWordTimestamps([[finalWord, start]], streamId);
          }
          await this.appendToAudioContext(streamId, new TTSStoppedFrame({ contextId: streamId }));
          await this.removeAudioContext(streamId);
        }
        if (streamId !== null) {
          this._partials.delete(streamId);
          this._configuredContexts.delete(streamId);
        }
        continue;
      }

      const audioB64: string | undefined = msg.audio;
      if (audioB64 && streamId && this.audioContextAvailable(streamId)) {
        await this.stopTtfbMetrics();
        const audio = base64ToBytes(audioB64);
        const frame = new TTSAudioRawFrame({
          audio,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: streamId,
        });
        await this.appendToAudioContext(streamId, frame);
      }

      const timestamps = msg.timestamps;
      if (timestamps && streamId && this.audioContextAvailable(streamId)) {
        const wordsWithStartTimes = this._toWordTimes(streamId, timestamps);
        if (wordsWithStartTimes.length > 0) {
          await this.addWordTimestamps(wordsWithStartTimes, streamId, {
            includesInterFrameSpaces: this._isChineseOrJapaneseLanguage() ? true : null,
          });
        }
      }

      // audio_end is informational; the real end-of-stream signal is
      // `terminated`, handled above.
    }
  }

  /**
   * Stream text to Soniox and deliver synthesized audio asynchronously.
   *
   * The first `runTts` call for a given `contextId` sends the per-stream
   * config message; subsequent calls within the same stream send only text
   * chunks. Audio arrives via the receive loop and is appended to the
   * matching audio context.
   *
   * @param text The text to synthesize.
   * @param contextId The audio context (maps to Soniox `stream_id`).
   * @returns An async generator yielding null; audio frames are delivered out
   *   of band via the receive task and the audio-context queue.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      try {
        await this._sendConfig(contextId);
        const textMsg = { text, text_end: false, stream_id: contextId };
        await this._getWebsocket().send(pyJsonDumps(textMsg));
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}`, exception: e });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}`, exception: e });
    }
  }
}
