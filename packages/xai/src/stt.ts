// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/xai/stt.py

/**
 * xAI speech-to-text service implementation.
 *
 * This module provides integration with xAI's real-time speech-to-text
 * WebSocket API documented at
 * https://docs.x.ai/developers/rest-api-reference/inference/voice.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), with the `Authorization: Bearer` and
 *   `User-Agent` headers on the opening handshake.
 * - Query values are written with `URLSearchParams` (`urlencode` upstream),
 *   so spaces become `+` as in Python.
 */

import { Event, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { XAI_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to the xAI STT language code.
 *
 * xAI STT accepts two-letter language codes (e.g. `en`, `fr`, `de`, `ja`).
 * When set, the server applies Inverse Text Normalization.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning.
 */
export function languageToXaiSttLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AR]: "ar",
    [Language.BN]: "bn",
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.FR]: "fr",
    [Language.HI]: "hi",
    [Language.ID]: "id",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KO]: "ko",
    [Language.PT]: "pt",
    [Language.RU]: "ru",
    [Language.TR]: "tr",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface XAISTTSettingsOptions extends STTSettingsOptions {
  /** When true, partial transcripts are emitted approximately every 500ms. */
  interimResults?: boolean | NotGiven;
  /** Silence in ms that triggers the speech-final event (0-5000). */
  endpointing?: number | null | NotGiven;
  /** When true, transcribes each interleaved channel independently. */
  multichannel?: boolean | null | NotGiven;
  /** Number of interleaved channels (2-8). Required with `multichannel`. */
  channels?: number | null | NotGiven;
  /** When true, the server attaches a `speaker` field to each word. */
  diarize?: boolean | null | NotGiven;
}

/**
 * Settings for XAISTTService.
 *
 * - `interimResults`: when true, partial transcripts are emitted
 *   approximately every 500ms.
 * - `endpointing`: silence duration in milliseconds that triggers the
 *   speech-final event carrying the utterance's `TranscriptionFrame`. Range
 *   0-5000. Server default is 400ms.
 * - `multichannel`: when true, transcribes each interleaved channel
 *   independently. Requires `channels` >= 2.
 * - `channels`: number of interleaved channels (2-8). Required when
 *   `multichannel` is true.
 * - `diarize`: when true, the server attaches a `speaker` field to each word
 *   identifying the detected speaker.
 */
export class XAISTTSettings extends STTSettings {
  interimResults: boolean | NotGiven = NOT_GIVEN;
  endpointing: number | null | NotGiven = NOT_GIVEN;
  multichannel: boolean | null | NotGiven = NOT_GIVEN;
  channels: number | null | NotGiven = NOT_GIVEN;
  diarize: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: XAISTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface XAISTTServiceOptions extends WebsocketSTTServiceOptions {
  /** xAI API key (used as Bearer for the WebSocket handshake). */
  apiKey: string;
  /** WebSocket endpoint URL. Defaults to "wss://api.x.ai/v1/stt". */
  wsUrl?: string;
  /**
   * Audio encoding. One of "pcm" (signed 16-bit LE), "mulaw", or "alaw".
   * Defaults to "pcm".
   */
  encoding?: string;
  /** Runtime-updatable settings overriding defaults. */
  settings?: XAISTTSettings | null;
}

/**
 * xAI real-time speech-to-text service.
 *
 * Streams audio to xAI's WebSocket STT endpoint and emits interim and final
 * transcription frames. The `XAI_API_KEY` is passed directly as a Bearer
 * token on the WebSocket handshake.
 *
 * The connection is persistent: audio is streamed continuously and the server
 * emits `transcript.partial` events with `is_final` and `speech_final` flags.
 * Interim results (`is_final=false`) and chunk finals (`is_final=true,
 * speech_final=false`) are pushed as `InterimTranscriptionFrame`. Only the
 * utterance final (`speech_final=true`) is pushed as a `TranscriptionFrame`,
 * because it restates the entire utterance, including the text of every
 * earlier chunk final. If the connection drops mid-session, the base class
 * reconnects automatically.
 */
export class XAISTTService extends WebsocketSTTService {
  static Settings: typeof XAISTTSettings = XAISTTSettings;
  declare protected _settings: XAISTTSettings;

  static {
    installTracedStt(XAISTTService.prototype, "_traceTranscription");
  }

  protected _apiKey: string;
  protected _wsUrl: string;
  protected _encoding: string;
  protected _receiveTask: Task<unknown> | null = null;
  protected _sessionReady: Event;

  /**
   * Initialize the xAI STT service.
   *
   * @param options.apiKey xAI API key (used as Bearer for the WebSocket
   *   handshake).
   * @param options.wsUrl WebSocket endpoint URL. Defaults to
   *   "wss://api.x.ai/v1/stt".
   * @param options.sampleRate Audio sample rate in Hz. Supported values: 8000,
   *   16000, 22050, 24000, 44100, 48000. If null, uses the input sample rate
   *   from the start frame.
   * @param options.encoding Audio encoding. One of "pcm" (signed 16-bit LE),
   *   "mulaw", or "alaw". Defaults to "pcm".
   * @param options.settings Runtime-updatable settings overriding defaults.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. See https://github.com/pipecat-ai/stt-benchmark.
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: XAISTTServiceOptions) {
    const defaultSettings = new (new.target as typeof XAISTTService).Settings({
      model: "grok-voice-transcribe-2.0",
      language: Language.EN,
      interimResults: true,
      endpointing: null,
      multichannel: null,
      channels: null,
      diarize: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
      ttfsP99Latency: options.ttfsP99Latency === undefined ? XAI_TTFS_P99 : options.ttfsP99Latency,
    });

    this._apiKey = options.apiKey;
    this._wsUrl = options.wsUrl ?? "wss://api.x.ai/v1/stt";
    this._encoding = options.encoding ?? "pcm";

    this._receiveTask = null;
    this._sessionReady = new Event();
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Convert a Language enum to the xAI STT language code. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToXaiSttLanguage(language);
  }

  /**
   * Apply a settings delta and reconnect to apply changes.
   *
   * xAI STT configures the session via WebSocket query parameters, so any
   * change requires a fresh connection.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }
    await this._disconnect();
    await this._connect();
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
   * Forward raw audio bytes to the xAI STT WebSocket.
   *
   * Transcription frames are pushed from the receive task, not yielded from
   * this generator.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._websocket && this._websocket.state === State.OPEN && this._sessionReady.isSet()) {
      try {
        await this._websocket.send(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`xAI STT send failed: ${errorMessage(e)}`, { exception: e });
      }
    }
    yield null;
  }

  /** Build the WebSocket URL with session query parameters. */
  _buildWsUrl(): string {
    const s = this._settings;
    const params = new URLSearchParams();
    params.append("sample_rate", String(this.sampleRate));
    params.append("encoding", this._encoding);

    if (s.language !== null) {
      params.append("language", String(s.language));
    }

    const optionalFields: [string, unknown][] = [
      ["model", s.model],
      ["interim_results", s.interimResults],
      ["endpointing", s.endpointing],
      ["multichannel", s.multichannel],
      ["channels", s.channels],
      ["diarize", s.diarize],
    ];
    for (const [key, val] of optionalFields) {
      if (val === null || val === NOT_GIVEN) {
        continue;
      }
      params.append(key, typeof val === "boolean" ? String(val).toLowerCase() : String(val));
    }

    return `${this._wsUrl}?${params.toString()}`;
  }

  /** Establish the WebSocket connection and start the receive task. */
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

  /** Tear down the WebSocket connection and cancel the receive task. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        await this._websocket.send(pyJsonDumps({ type: "audio.done" }));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.debug(`${this} error sending audio.done during disconnect: ${errorMessage(e)}`);
    }

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Open a WebSocket connection to the xAI STT endpoint. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to xAI STT WebSocket");
      this._sessionReady.clear();

      const wsUrl = this._buildWsUrl();
      const headers = {
        Authorization: `Bearer ${this._apiKey}`,
        "User-Agent": `xAI/1.0 (integration=Pipecat/${pipecatVersion()})`,
      };
      this._websocket = await this._websocketConnect(wsUrl, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");
      logger.debug(`${this} connected to xAI STT WebSocket`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      this._sessionReady.clear();
      await this.pushError(`Unable to connect to xAI STT: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Close the WebSocket connection. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("Disconnecting from xAI STT WebSocket");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing xAI STT websocket: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      this._sessionReady.clear();
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Receive and dispatch xAI STT WebSocket messages. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let data: unknown;
      try {
        data = pyJsonLoads(text);
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`${this} received non-JSON message: ${text}`);
          continue;
        }
        throw e;
      }
      await this._handleMessage(data as Dict);
    }
  }

  /** Branch on xAI STT event type. */
  async _handleMessage(message: Dict): Promise<void> {
    const msgType = message.type;

    if (msgType === "transcript.created") {
      this._sessionReady.set();
      logger.debug(`${this} xAI STT session ready`);
    } else if (msgType === "transcript.partial") {
      await this._handleTranscript(message);
    } else if (msgType === "transcript.done") {
      if (message.text) {
        await this._pushFinalTranscript(message);
      }
    } else if (msgType === "error") {
      await this.pushError(`xAI STT error: ${message.message ?? pyJsonDumps(message)}`, {
        exception: new Error(pyJsonDumps(message)),
      });
    } else {
      logger.debug(`${this} unhandled xAI STT message: ${pyJsonDumps(message)}`);
    }
  }

  protected async _handleTranscript(message: Dict): Promise<void> {
    const text: string = message.text ?? "";
    if (!text) {
      return;
    }

    const isFinal = Boolean(message.is_final);
    const speechFinal = Boolean(message.speech_final);
    const language = this._languageForFrame();

    if (isFinal && speechFinal) {
      await this._pushFinalTranscript(message, { language, text });
    } else {
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language,
          result: message,
        }),
      );
    }
  }

  protected async _pushFinalTranscript(
    message: Dict,
    options: { language?: Language | null; text?: string | null } = {},
  ): Promise<void> {
    const text: string =
      options.text !== undefined && options.text !== null ? options.text : (message.text ?? "");
    if (!text) {
      return;
    }
    const language =
      options.language !== undefined && options.language !== null
        ? options.language
        : this._languageForFrame();

    // Report usage before the transcription frame so tracing can attach it
    // to the STT span the frame closes.
    await this.emitSttUsageMetrics();
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: message,
        finalized: true,
      }),
    );
    await this._traceTranscription(text, true, language);
  }

  /**
   * Return a Language enum suitable for transcription frames.
   *
   * Settings stores the service-specific string (e.g. "en"); frames carry
   * the enum value.
   */
  protected _languageForFrame(): Language {
    const lang = this._settings.language;
    if (typeof lang === "string" && isLanguage(lang)) {
      return lang;
    }
    return Language.EN;
  }

  /** Record transcription event for tracing. */
  protected async _traceTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language,
  ): Promise<void> {}
}
