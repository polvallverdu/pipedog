// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/smallest/stt.py

/**
 * Smallest AI speech-to-text service implementation.
 *
 * This module provides a STT service using Smallest AI's Waves API:
 *
 * - `SmallestSTTService`: WebSocket-based real-time STT. Streams audio
 *   continuously and receives interim/final transcripts with low latency.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), so the `Authorization` header is sent on every
 *   runtime, Cloudflare Workers included.
 * - Query values are written with `URLSearchParams` (`urlencode` upstream).
 * - `X-Pipecat-Version` carries the pipedog version.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { SMALLEST_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to Smallest STT language code.
 *
 * @param language The Language enum value to convert.
 * @returns The Smallest language code string.
 */
export function languageToSmallestSttLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.BG]: "bg",
    [Language.BN]: "bn",
    [Language.CS]: "cs",
    [Language.DA]: "da",
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.ET]: "et",
    [Language.FI]: "fi",
    [Language.FR]: "fr",
    [Language.GU]: "gu",
    [Language.HI]: "hi",
    [Language.HU]: "hu",
    [Language.IT]: "it",
    [Language.KN]: "kn",
    [Language.LT]: "lt",
    [Language.LV]: "lv",
    [Language.ML]: "ml",
    [Language.MR]: "mr",
    [Language.MT]: "mt",
    [Language.NL]: "nl",
    [Language.OR]: "or",
    [Language.PA]: "pa",
    [Language.PL]: "pl",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SK]: "sk",
    [Language.SV]: "sv",
    [Language.TA]: "ta",
    [Language.TE]: "te",
    [Language.UK]: "uk",
  };

  return resolveLanguage(language, LANGUAGE_MAP);
}

/** Available Smallest AI STT models. */
export const SmallestSTTModel = {
  PULSE: "pulse",
  PULSE_2: "pulse-2",
} as const;
export type SmallestSTTModel = (typeof SmallestSTTModel)[keyof typeof SmallestSTTModel];

/**
 * Raise if `language` isn't English and `model` is the English-only `pulse-2`.
 *
 * The server rejects this combination by closing the socket, so raise up front
 * with a clear message instead.
 */
function _validatePulse2Language(model: unknown, language: unknown): void {
  if (
    model === SmallestSTTModel.PULSE_2 &&
    language &&
    (String(language).split("-")[0] as string).toLowerCase() !== "en"
  ) {
    throw new Error(`model 'pulse-2' is English-only, got language '${language}'`);
  }
}

export interface SmallestSTTSettingsOptions extends STTSettingsOptions {
  wordTimestamps?: boolean | NotGiven;
  fullTranscript?: boolean | NotGiven;
  sentenceTimestamps?: boolean | NotGiven;
  redactPii?: boolean | NotGiven;
  redactPci?: boolean | NotGiven;
  numerals?: string | NotGiven;
  diarize?: boolean | NotGiven;
  endpointing?: boolean | NotGiven;
  keywords?: string | NotGiven;
  format?: boolean | NotGiven;
  emotionDetection?: boolean | NotGiven;
  genderDetection?: boolean | NotGiven;
  itnNormalize?: boolean | NotGiven;
  noFormatDelay?: boolean | NotGiven;
}

/**
 * Settings for SmallestSTTService.
 *
 * - `wordTimestamps`: Include word-level timestamps.
 * - `fullTranscript`: Include cumulative transcript.
 * - `sentenceTimestamps`: Include sentence-level timestamps.
 * - `redactPii`: Redact personally identifiable information.
 * - `redactPci`: Redact payment card information.
 * - `numerals`: Convert spoken numerals to digits.
 * - `diarize`: Enable speaker diarization.
 * - `endpointing`: Finalize promptly on trailing silence.
 * - `keywords`: Comma-separated `KEYWORD:INTENSIFIER` pairs to boost
 *   recognition of domain-specific words/phrases (e.g. `"NVIDIA:2"`).
 * - `format`: Apply punctuation and capitalization to transcripts.
 * - `emotionDetection`: `model="pulse-2"` only. Adds a six-class
 *   per-utterance `emotion` object to every final transcript. No effect on
 *   `model="pulse"`.
 * - `genderDetection`: `model="pulse-2"` only. Adds an acoustic per-utterance
 *   `gender` estimate to every final transcript. No effect on `model="pulse"`.
 * - `itnNormalize`: Run inverse text normalization so spoken numbers come back
 *   as digits (e.g. "twenty five" -> "25").
 * - `noFormatDelay`: With `itnNormalize` on, a number still being dictated at
 *   the end of a final is held back and merged into the next final so it
 *   normalizes whole. Set to `true` to emit every final as soon as it is ready
 *   instead. No effect unless `itnNormalize` is `true`; text is never dropped
 *   either way.
 */
export class SmallestSTTSettings extends STTSettings {
  wordTimestamps: boolean | NotGiven = NOT_GIVEN;
  fullTranscript: boolean | NotGiven = NOT_GIVEN;
  sentenceTimestamps: boolean | NotGiven = NOT_GIVEN;
  redactPii: boolean | NotGiven = NOT_GIVEN;
  redactPci: boolean | NotGiven = NOT_GIVEN;
  numerals: string | NotGiven = NOT_GIVEN;
  diarize: boolean | NotGiven = NOT_GIVEN;
  endpointing: boolean | NotGiven = NOT_GIVEN;
  keywords: string | NotGiven = NOT_GIVEN;
  format: boolean | NotGiven = NOT_GIVEN;
  emotionDetection: boolean | NotGiven = NOT_GIVEN;
  genderDetection: boolean | NotGiven = NOT_GIVEN;
  itnNormalize: boolean | NotGiven = NOT_GIVEN;
  noFormatDelay: boolean | NotGiven = NOT_GIVEN;

  constructor(options: SmallestSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SmallestSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Smallest AI API key for authentication. */
  apiKey: string;
  /** Base WebSocket URL for the Smallest API. Defaults to "wss://api.smallest.ai". */
  baseUrl?: string;
  /** Audio encoding format. Defaults to "linear16". */
  encoding?: string;
  /** Runtime-updatable settings for the STT service. */
  settings?: SmallestSTTSettings | null;
}

/**
 * Smallest AI real-time speech-to-text service using the Pulse WebSocket API.
 *
 * Streams audio continuously over a WebSocket connection and receives interim
 * and final transcription results with low latency. Best suited for real-time
 * voice applications where immediate feedback is needed.
 *
 * Uses the VAD to detect when the user stops speaking and sends a `finalize`
 * message to flush the final transcript while keeping the session alive for
 * the next utterance.
 *
 * Connects to `wss://api.smallest.ai/waves/v1/stt/live?model=pulse`. Set
 * `model: SmallestSTTModel.PULSE_2` in the settings for Pulse 2.0, an
 * English-only model that adds per-utterance `emotion` and `gender` to final
 * transcripts (see `emotionDetection`/`genderDetection`, on by default). Both
 * appear in the `TranscriptionFrame` `result` and are omitted for very short
 * utterances. Pulse 2.0 also has built-in end-of-turn detection, but the VAD
 * and user turn strategies still decide when the user's turn ends, and the
 * VAD-triggered `finalize` flushes the final transcript as with Pulse.
 * `endpointing` has no effect on this model.
 *
 * @example
 * ```ts
 * const stt = new SmallestSTTService({
 *   apiKey: "your-api-key",
 *   settings: new SmallestSTTService.Settings({
 *     language: Language.EN,
 *     wordTimestamps: true,
 *   }),
 * });
 * ```
 */
export class SmallestSTTService extends WebsocketSTTService {
  static Settings: typeof SmallestSTTSettings = SmallestSTTSettings;
  declare protected _settings: SmallestSTTSettings;

  static {
    installTracedStt(SmallestSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _encoding: string;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Smallest AI STT service.
   *
   * @param options.apiKey Smallest AI API key for authentication.
   * @param options.baseUrl Base WebSocket URL for the Smallest API.
   * @param options.encoding Audio encoding format. Defaults to "linear16".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline's rate.
   * @param options.settings Runtime-updatable settings for the STT service.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds.
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: SmallestSTTServiceOptions) {
    const defaultSettings = new (new.target as typeof SmallestSTTService).Settings({
      model: SmallestSTTModel.PULSE,
      language: Language.EN,
      wordTimestamps: false,
      fullTranscript: false,
      sentenceTimestamps: false,
      redactPii: false,
      redactPci: false,
      numerals: "auto",
      diarize: false,
      endpointing: true,
      keywords: "",
      format: true,
      emotionDetection: true,
      genderDetection: true,
      itnNormalize: false,
      noFormatDelay: false,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    _validatePulse2Language(defaultSettings.model, defaultSettings.language);

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? SMALLEST_TTFS_P99 : options.ttfsP99Latency,
      keepaliveTimeout: 10,
      keepaliveInterval: 5,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = (options.baseUrl ?? "wss://api.smallest.ai").replace(/\/+$/, "");
    this._encoding = options.encoding ?? "linear16";
    this._receiveTask = null;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Smallest service language format.
   *
   * @param language The language to convert.
   * @returns The Smallest-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSmallestSttLanguage(language);
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

  /** Stop the service and disconnect from the WebSocket. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /** Cancel the service and disconnect from the WebSocket. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Process frames, handling VAD events for finalization. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame) {
      if (this._websocket && this._websocket.state === State.OPEN) {
        try {
          await this._websocket.send(pyJsonDumps({ type: "finalize" }));
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this} failed to send finalize: ${errorMessage(e)}`);
        }
      }
    }
  }

  /**
   * Send audio to the Smallest Pulse WebSocket for transcription.
   *
   * @param audio Raw PCM audio bytes.
   * @yields null -- transcription results arrive via WebSocket messages.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    // The receive loop reconnects a dropped socket; audio arriving meanwhile
    // is dropped.
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        await this._websocket.send(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Smallest STT error: ${errorMessage(e)}` });
        return;
      }
    }

    yield null;
  }

  /** Apply a settings delta and reconnect if anything changed. */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const prospectiveModel = isGiven(delta.model) ? delta.model : this._settings.model;
    const prospectiveLanguage = isGiven(delta.language) ? delta.language : this._settings.language;
    _validatePulse2Language(prospectiveModel, prospectiveLanguage);

    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  override async _connect(): Promise<void> {
    await this._connectWebsocket();
    await super._connect();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
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

  /** The WebSocket URL, with the session's query parameters. */
  _buildWsUrl(): string {
    const s = this._settings;
    const bool = (v: unknown) => String(v).toLowerCase();
    const queryParams: Record<string, string> = {
      model: String(s.model),
      language: String(s.language),
      encoding: this._encoding,
      sample_rate: String(this.sampleRate),
      word_timestamps: bool(s.wordTimestamps),
      full_transcript: bool(s.fullTranscript),
      sentence_timestamps: bool(s.sentenceTimestamps),
      redact_pii: bool(s.redactPii),
      redact_pci: bool(s.redactPci),
      numerals: String(s.numerals),
      diarize: bool(s.diarize),
      endpointing: bool(s.endpointing),
      format: bool(s.format),
      emotion_detection: bool(s.emotionDetection),
      gender_detection: bool(s.genderDetection),
      itn_normalize: bool(s.itnNormalize),
      no_format_delay: bool(s.noFormatDelay),
    };

    // An empty `keywords` value would register a single empty keyword, so omit
    // the parameter entirely when no keywords are configured.
    if (s.keywords) {
      queryParams.keywords = String(s.keywords);
    }

    return `${this._baseUrl}/waves/v1/stt/live?${new URLSearchParams(queryParams).toString()}`;
  }

  /** Establish WebSocket connection to the Smallest Pulse STT API. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Smallest STT");

      this._websocket = await this._websocketConnect(this._buildWsUrl(), {
        additionalHeaders: {
          Authorization: `Bearer ${this._apiKey}`,
          "X-Source": "pipecat",
          "X-Pipecat-Version": pipecatVersion(),
        },
      });
      await this._callEventHandler("on_connected");
      logger.debug("Connected to Smallest STT");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Smallest STT connection error: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Close the WebSocket connection. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug("Disconnecting from Smallest STT");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} error closing websocket: ${errorMessage(e)}`);
    } finally {
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

  /** Receive and process messages from the Smallest Pulse WebSocket. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      try {
        let data: Dict;
        try {
          data = pyJsonLoads(text) as Dict;
        } catch (e) {
          rethrowIfCancelled(e);
          if (e instanceof SyntaxError) {
            logger.warning(`${this} received non-JSON message: ${text}`);
            continue;
          }
          throw e;
        }
        await this._processResponse(data);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error processing message: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Process a transcription response from the Pulse API.
   *
   * The response contains:
   * - `transcript`: The recognized text.
   * - `is_final`: Whether this is a final (vs. interim) result.
   * - `is_last`: Whether this is the last message of the session. Only `true`
   *   after `close_stream` is sent at call end.
   * - `language`: The detected or specified language.
   * - `session_id`: Unique identifier for the WebSocket session.
   *
   * @param data Parsed JSON response containing transcript data.
   */
  async _processResponse(data: Dict): Promise<void> {
    const isFinal = data.is_final ?? false;
    const isLast = data.is_last ?? false;
    const text = String(data.transcript ?? "").trim();

    if (isLast) {
      logger.debug(`${this} received is_last; server will close session`);
    }

    if (!text) {
      return;
    }

    if (isFinal) {
      logger.debug(`Smallest final transcript: [${text}]`);
      await this._handleTranscription(text, true, data.language);
      // Report usage before the transcription frame so tracing can attach it
      // to the STT span the frame closes.
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: data.language ?? null,
          result: data,
        }),
      );
    } else {
      logger.trace(`Smallest interim transcript: [${text}]`);
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: data.language ?? null,
          result: data,
        }),
      );
    }
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {}
}
