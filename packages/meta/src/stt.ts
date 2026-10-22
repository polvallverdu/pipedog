// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/meta/stt.py

/**
 * Meta speech-to-text service implementation.
 *
 * This module provides integration with Meta's Muse Voice realtime
 * transcription WebSocket API documented at
 * https://dev.meta.ai/docs/api-reference/voice/realtime.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`). The credential travels in the handshake frame,
 *   so no handshake header is needed on any runtime.
 * - `asyncio.wait_for(websocket.recv(), HANDSHAKE_TIMEOUT)` →
 *   `waitFor(() => websocket.recv(), HANDSHAKE_TIMEOUT)`.
 */

import { Event, rethrowIfCancelled, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { META_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const META_STT_WS_URL = "wss://api.meta.ai/v1/asr/realtime";
export const META_STT_MODEL = "muse-voice-transcribe-1.0";

// The server drops the connection if the handshake frame doesn't arrive within
// ten seconds of the socket opening; it answers well inside that window.
export const HANDSHAKE_TIMEOUT = 10.0;

// The engine's native rate. Anything else is resampled to 16 kHz, the only
// other rate the API accepts.
export const META_NATIVE_SAMPLE_RATE = 24000;
export const META_FALLBACK_SAMPLE_RATE = 16000;

const _LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AR]: "Arabic",
  [Language.BN]: "Bengali",
  [Language.DE]: "German",
  [Language.EN]: "English",
  [Language.ES]: "Spanish",
  [Language.FR]: "French",
  [Language.HE]: "Hebrew",
  [Language.HI]: "Hindi",
  [Language.ID]: "Indonesian",
  [Language.IT]: "Italian",
  [Language.JA]: "Japanese",
  [Language.KN]: "Kannada",
  [Language.KO]: "Korean",
  [Language.MR]: "Marathi",
  [Language.MS]: "Malay",
  [Language.NL]: "Dutch",
  [Language.PL]: "Polish",
  [Language.PT]: "Portuguese",
  [Language.TA]: "Tamil",
  [Language.TE]: "Telugu",
  [Language.TH]: "Thai",
  [Language.TL]: "Tagalog",
  [Language.TR]: "Turkish",
  [Language.VI]: "Vietnamese",
  [Language.ZH]: "Mandarin Chinese",
};

// Settings store the service's language name; frames carry the enum it came from.
const _LANGUAGE_NAMES = new Map<string, Language>(
  Object.entries(_LANGUAGE_MAP).map(([language, name]) => [name as string, language as Language]),
);

/**
 * Convert a Language enum to the Meta STT language name.
 *
 * Meta biases recognition on English language *names* rather than codes, e.g.
 * `"English"` or `"Mandarin Chinese"`.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language name. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning. Meta ignores a bias it doesn't
 *   recognize, so an unmapped language degrades to auto-detection.
 */
export function languageToMetaLanguage(language: Language): string {
  return resolveLanguage(language, _LANGUAGE_MAP, true);
}

export interface MetaSTTSettingsOptions extends STTSettingsOptions {
  languageBias?: Language[] | null | NotGiven;
  mode?: string | NotGiven;
  keywords?: string[] | null | NotGiven;
  emitAudioProgress?: boolean | NotGiven;
  zdrOverride?: boolean | null | NotGiven;
}

/**
 * Settings for MetaSTTService.
 *
 * - `languageBias`: Languages to bias recognition toward, for speech that
 *   switches between them. When set, it replaces the single `language` bias.
 *   Leave both unset to let the model detect the language.
 * - `mode`: Segmentation mode. `"ENDPOINTING"` has the model mark turn
 *   boundaries; `"PUSH_TO_TALK"` leaves them to the client; `"DIARIZATION"`
 *   attributes turns to speakers.
 * - `keywords`: Terms to bias recognition toward. Biasing raises the odds a
 *   term is recognized but doesn't guarantee its spelling.
 * - `emitAudioProgress`: Whether the server reports progress for every
 *   processed audio chunk.
 * - `zdrOverride`: Forces metadata-only logging when true, or allows content
 *   retention when false. Leave unset to use the account's setting.
 */
export class MetaSTTSettings extends STTSettings {
  languageBias: Language[] | null | NotGiven = NOT_GIVEN;
  mode: string | NotGiven = NOT_GIVEN;
  keywords: string[] | null | NotGiven = NOT_GIVEN;
  emitAudioProgress: boolean | NotGiven = NOT_GIVEN;
  zdrOverride: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: MetaSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface MetaSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** Meta Model API key, sent as a Bearer token in the handshake. */
  apiKey: string;
  /** WebSocket endpoint URL. Defaults to `wss://api.meta.ai/v1/asr/realtime`. */
  url?: string;
  /** Runtime-updatable settings overriding defaults. */
  settings?: MetaSTTSettings | null;
}

/**
 * Meta Muse Voice real-time speech-to-text service.
 *
 * Streams audio to Meta's realtime transcription WebSocket and emits interim
 * and final transcription frames. The API key travels in the handshake frame
 * rather than an HTTP header, and the session's configuration is fixed once
 * the server accepts that handshake, so a settings change reconnects.
 *
 * In the default `ENDPOINTING` mode the server marks turn boundaries itself,
 * emitting `speechStart`, a run of cumulative partial transcripts,
 * `speechEnd`, and finally `speechComplete` with the post-processed text that
 * becomes the `TranscriptionFrame`. Those boundaries segment transcripts only:
 * the VAD and turn strategies still decide when the user's turn ends.
 *
 * Sessions are capped at 60 minutes. The server closes the socket when a
 * session reaches that limit, and the base class reconnects into a fresh one.
 */
export class MetaSTTService extends WebsocketSTTService {
  static Settings: typeof MetaSTTSettings = MetaSTTSettings;
  declare protected _settings: MetaSTTSettings;

  static {
    installTracedStt(MetaSTTService.prototype, "_traceTranscription");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null = null;
  protected _sessionReady: Event;
  protected _sessionId: string | null = null;
  protected _turnId: number | null = null;
  protected _resampler = createStreamResampler();

  /**
   * Initialize the Meta STT service.
   *
   * @param options.apiKey Meta Model API key, sent as a Bearer token in the
   *   handshake.
   * @param options.url WebSocket endpoint URL. Defaults to
   *   `wss://api.meta.ai/v1/asr/realtime`.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate. Audio at anything other than 24000 is resampled to
   *   16000, the only other rate the API accepts.
   * @param options.settings Runtime-updatable settings overriding defaults.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: MetaSTTServiceOptions) {
    const defaultSettings = new (new.target as typeof MetaSTTService).Settings({
      model: META_STT_MODEL,
      language: Language.EN,
      languageBias: null,
      mode: "ENDPOINTING",
      keywords: null,
      emitAudioProgress: false,
      zdrOverride: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
      ttfsP99Latency: options.ttfsP99Latency === undefined ? META_TTFS_P99 : options.ttfsP99Latency,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? META_STT_WS_URL;

    this._receiveTask = null;
    this._sessionReady = new Event();
    this._sessionId = null;
    this._turnId = null;
    this._resampler = createStreamResampler();
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True if metrics generation is supported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Convert a Language enum to the Meta STT language name. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToMetaLanguage(language);
  }

  /** The rate audio is sent at, which the API limits to 24 kHz or 16 kHz. */
  protected get _sendSampleRate(): number {
    if (this.sampleRate === META_NATIVE_SAMPLE_RATE) {
      return META_NATIVE_SAMPLE_RATE;
    }
    return META_FALLBACK_SAMPLE_RATE;
  }

  /**
   * Apply a settings delta and reconnect to apply changes.
   *
   * Meta fixes a session's configuration when it accepts the handshake, so any
   * change needs a fresh connection.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }
    await this._requestReconnect();
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
   * Forward raw audio bytes to the Meta STT WebSocket.
   *
   * Transcription frames are pushed from the receive task, not yielded from
   * this generator.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this.sampleRate !== this._sendSampleRate) {
      audio = await this._resampler.resample(audio, this.sampleRate, this._sendSampleRate);
    }

    if (
      audio.length > 0 &&
      this._websocket &&
      this._websocket.state === State.OPEN &&
      this._sessionReady.isSet()
    ) {
      try {
        await this._websocket.send(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Meta STT send failed: ${errorMessage(e)}`, { exception: e });
      }
    }
    yield null;
  }

  /** Build the handshake frame that opens and configures the session. */
  _buildHandshake(): Dict {
    const s = this._settings;

    const handshake: Dict = {
      authorization: { accessToken: `Bearer ${this._apiKey}` },
      audioEncoding: `PCM_${Math.floor(this._sendSampleRate / 1000)}KHZ`,
      model: assertGiven(s.model),
      mode: assertGiven(s.mode),
      // Every partial carries the complete current hypothesis, which is what
      // the interim frames below replace each other with. DELTA would make
      // each partial a fragment instead.
      partialMode: "CUMULATIVE",
      emitAudioProgress: assertGiven(s.emitAudioProgress),
    };

    const languageBias = assertGiven(s.languageBias);
    if (languageBias && languageBias.length > 0) {
      handshake.languageBias = languageBias.map((lang) => languageToMetaLanguage(lang));
    } else if (s.language !== null) {
      handshake.languageBias = [assertGiven(s.language)];
    }

    const keywords = assertGiven(s.keywords);
    if (keywords && keywords.length > 0) {
      handshake.keywords = keywords;
    }

    const zdrOverride = assertGiven(s.zdrOverride);
    if (zdrOverride !== null) {
      handshake.zdrOverride = zdrOverride;
    }

    return handshake;
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
        // Half-closes the input so the server flushes what it still owes us
        // before the socket goes away.
        await this._websocket.send(pyJsonDumps({ type: "endStream" }));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.debug(`${this} error sending endStream during disconnect: ${errorMessage(e)}`);
    }

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Open a WebSocket connection and complete the Meta STT handshake. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Meta STT WebSocket");
      this._sessionReady.clear();
      this._sessionId = null;

      if (this.sampleRate !== this._sendSampleRate) {
        logger.debug(
          `${this} resampling audio from ${this.sampleRate} to ` +
            `${this._sendSampleRate}: Meta accepts only 16 kHz or 24 kHz`,
        );
      }

      const websocket = await this._websocketConnect(
        `${this._url}?sessionId=stream-${crypto.randomUUID()}`,
      );
      this._websocket = websocket;

      // The credential travels in the handshake frame, so a rejected key
      // surfaces here rather than as a refused HTTP upgrade. Reading the
      // acknowledgement before the receive task starts is what turns that
      // rejection into an error instead of a silently idle connection.
      await websocket.send(pyJsonDumps(this._buildHandshake()));
      const raw = await waitFor(() => websocket.recv(), HANDSHAKE_TIMEOUT);
      const ack = pyJsonLoads(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      ) as Dict;

      if (!("sessionId" in ack)) {
        const message = ack.message ?? pyJsonDumps(ack);
        await websocket.close();
        this._websocket = null;
        await this.pushError(`Meta STT rejected the session: ${message}`, {
          exception: new Error(String(message)),
          category: ErrorCategory.AUTHENTICATION,
          forceTreatAsPermanent: true,
        });
        return;
      }

      this._sessionId = ack.sessionId;
      this._sessionReady.set();
      await this._callEventHandler("on_connected");
      logger.debug(`${this} connected to Meta STT WebSocket (session ${this._sessionId})`);
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      this._sessionReady.clear();
      const detail = e instanceof TimeoutError ? "handshake timed out" : errorMessage(e);
      await this.pushError(`Unable to connect to Meta STT: ${detail}`, { exception: e });
    }
  }

  /** Close the WebSocket connection. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        logger.debug("Disconnecting from Meta STT WebSocket");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing Meta STT websocket: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      this._sessionReady.clear();
      this._sessionId = null;
      this._turnId = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Receive and dispatch Meta STT WebSocket messages. */
  override async _receiveMessages(): Promise<void> {
    if (!this._websocket) {
      throw new Error("Websocket not connected");
    }
    for await (const message of this._websocket) {
      if (typeof message !== "string") {
        continue;
      }
      let data: Dict;
      try {
        data = pyJsonLoads(message) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.warning(`${this} received non-JSON message: ${message}`);
          continue;
        }
        throw e;
      }
      await this._handleMessage(data);
    }
  }

  /** Branch on Meta STT event type. */
  async _handleMessage(message: Dict): Promise<void> {
    const msgType = message.type;

    if (msgType === "transcript") {
      await this._handleTranscript(message);
    } else if (msgType === "speechComplete") {
      this._turnId = message.turnId ?? null;
      await this._pushFinalTranscript(message);
    } else if (msgType === "speechStart" || msgType === "speechEnd") {
      this._turnId = message.turnId ?? null;
      logger.trace(`${this} Meta STT ${msgType} (turn ${this._turnId})`);
    } else if (msgType === "speaker") {
      // Diarization marks a possible new speaker mid-turn rather than a
      // boundary, so the label only rides along on the transcript result.
      logger.trace(`${this} Meta STT speaker ${message.label}`);
    } else if (msgType === "audioProgress") {
      // Only arrives when emitAudioProgress is on, and says nothing the
      // transcript events don't already carry.
    } else if (msgType === "error") {
      await this.pushError(`Meta STT error: ${message.message ?? pyJsonDumps(message)}`, {
        exception: new Error(pyJsonDumps(message)),
      });
    } else {
      logger.debug(`${this} unhandled Meta STT message: ${pyJsonDumps(message)}`);
    }
  }

  /** Push a partial hypothesis, or a final in the client-delimited modes. */
  protected async _handleTranscript(message: Dict): Promise<void> {
    const text: string = message.transcript ?? "";
    if (!text) {
      return;
    }

    // In ENDPOINTING mode the model closes the turn itself and the punctuated
    // text arrives on speechComplete, so every transcript here is still a
    // hypothesis. The other modes have no such event.
    if (message.final && this._settings.mode !== "ENDPOINTING") {
      await this._pushFinalTranscript(message, { text });
      return;
    }

    await this.pushFrame(
      new InterimTranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language: this._languageForFrame(),
        result: message,
      }),
    );
  }

  /** Push the transcript that closes a turn. */
  protected async _pushFinalTranscript(
    message: Dict,
    options: { text?: string | null } = {},
  ): Promise<void> {
    const text: string =
      options.text !== undefined && options.text !== null
        ? options.text
        : (message.transcript ?? "");
    if (!text) {
      return;
    }

    // Report usage before the transcription frame so tracing can attach it to
    // the STT span the frame closes.
    await this.emitSttUsageMetrics();
    const language = this._languageForFrame();
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
   * Meta reports no language of its own, so frames carry whichever language the
   * session was biased toward, or null when it was left to detection.
   */
  protected _languageForFrame(): Language | null {
    const bias = assertGiven(this._settings.languageBias);
    if (bias && bias.length > 0) {
      return bias.length === 1 ? (bias[0] as Language) : null;
    }

    const lang = this._settings.language;
    if (typeof lang === "string") {
      if (isLanguage(lang)) {
        return lang;
      }
      return _LANGUAGE_NAMES.get(lang) ?? null;
    }
    return null;
  }

  /** Record transcription event for tracing. */
  protected async _traceTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null,
  ): Promise<void> {}
}
