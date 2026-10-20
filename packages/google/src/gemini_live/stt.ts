// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/gemini_live/stt.py

/**
 * Gemini Live speech-to-text service for Pipecat.
 *
 * `GeminiSTTService` streams audio to a Gemini Live transcription model (e.g.
 * `gemini-3.5-transcribe-live`) over the Gemini Live API, with automatic
 * language detection, language hints, adaptation phrases, and a choice of
 * verbatim or smart transcription.
 *
 * Porting notes:
 * - The client is `GoogleGenAI` from `@google/genai`, which talks to the Live
 *   API over the global `WebSocket` and runs on every runtime. Its Live
 *   session is callback based: `live.connect()` resolves with a `Session`
 *   once the socket is open, and server messages arrive through `onmessage`.
 *   The callbacks feed an asyncio `Queue` that the receive task reads, which
 *   is what upstream's `session.receive()` iterator does. A socket error or
 *   close is delivered through the same queue and raised in the receive task,
 *   so it goes through upstream's reconnect / failure counting path.
 * - The SDK's async context manager (`__aenter__` / `__aexit__`) maps to
 *   `live.connect()` / `session.close()`; the JS SDK has no way to tell the
 *   socket why it is being closed, so `_closeSession(exc)` only logs it.
 * - Upstream refuses to construct with a google-genai older than 2.9.0
 *   (`LanguageAuto` / `LanguageHints` missing). The JS SDK sends the config
 *   objects as given, so there is no runtime version check; the
 *   transcription config is built as plain objects with the Live API's
 *   camelCase field names.
 * - Audio is sent base64 encoded (the JS SDK's `Blob.data` is a base64
 *   string).
 */

import { GoogleGenAI, type HttpOptions, type LiveConnectConfig, type Session } from "@google/genai";
import { CancelledError, Queue, rethrowIfCancelled, type Task, time } from "@pipedog/asyncio";
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
import { GEMINI_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { STTService, type STTServiceOptions } from "@pipedog/core/services/stt_service";
import { isLanguage, type Language } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { languageToGoogleSttLanguage } from "../stt.ts";
import { type GoogleClientHttpOptions, updateGoogleClientHttpOptions } from "../utils.ts";

// Connection management constants
const MAX_CONSECUTIVE_FAILURES = 3;
const CONNECTION_ESTABLISHED_THRESHOLD = 10.0; // seconds

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A transcription in a Live server message (`Transcription`). */
interface LiveTranscription {
  text?: string;
  finished?: boolean;
  languageCode?: string;
}

/**
 * The parts of a `LiveServerMessage` this service reads. Newer Live API
 * versions add `interimInputTranscription`, which older SDK typings lack.
 */
interface LiveServerMessageLike {
  serverContent?: {
    inputTranscription?: LiveTranscription;
    interimInputTranscription?: LiveTranscription;
  } | null;
}

/** An item delivered by the Live session callbacks to the receive task. */
type SessionEvent =
  | { kind: "message"; message: LiveServerMessageLike }
  | { kind: "error"; error: unknown }
  | { kind: "close"; code?: number; reason?: string };

export interface GeminiSTTSettingsOptions extends STTSettingsOptions {
  /**
   * List of `Language` values used as language hints for the expected
   * languages in the audio (e.g. `[Language.ES_ES]`).
   */
  languages?: (Language | string)[] | NotGiven;
  /**
   * Enable automatic language detection. `null` (the default) auto-detects
   * unless language hints are given. Set to `false` to disable
   * auto-detection without providing hints.
   */
  languageAuto?: boolean | null | NotGiven;
  /**
   * Phrases to bias recognition toward, improving accuracy for
   * domain-specific terms (e.g. `["oatmilk"]`).
   */
  adaptationPhrases?: string[] | null | NotGiven;
  /**
   * Transcription mode, `"VERBATIM"` (the model's default) or `"SMART"`,
   * which removes disfluencies and applies light grammatical cleanup and
   * formatting.
   */
  mode?: "SMART" | "VERBATIM" | string | null | NotGiven;
}

/**
 * Settings for GeminiSTTService.
 *
 * Language configuration maps to the Live API's `AudioTranscriptionConfig`:
 * when `language`/`languages` are set they are sent as language hints;
 * otherwise the model detects the language automatically. Language hints and
 * automatic detection are mutually exclusive — if both are configured, hints
 * take precedence.
 *
 * - `languages`: list of `Language` values used as language hints for the
 *   expected languages in the audio (e.g. `[Language.ES_ES]`).
 * - `languageAuto`: enable automatic language detection. `null` (the
 *   default) auto-detects unless language hints are given. Set to `false` to
 *   disable auto-detection without providing hints.
 * - `adaptationPhrases`: phrases to bias recognition toward, improving
 *   accuracy for domain-specific terms (e.g. `["oatmilk"]`).
 * - `mode`: transcription mode, `"VERBATIM"` (the model's default) or
 *   `"SMART"`, which removes disfluencies and applies light grammatical
 *   cleanup and formatting.
 */
export class GeminiSTTSettings extends STTSettings {
  languages: (Language | string)[] | NotGiven = NOT_GIVEN;
  languageAuto: boolean | null | NotGiven = NOT_GIVEN;
  adaptationPhrases: string[] | null | NotGiven = NOT_GIVEN;
  mode: "SMART" | "VERBATIM" | string | null | NotGiven = NOT_GIVEN;

  constructor(options: GeminiSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GeminiSTTServiceOptions extends STTServiceOptions {
  /** Google AI (Gemini) API key. */
  apiKey: string;
  /** Optional HTTP options passed to the google-genai client. */
  httpOptions?: GoogleClientHttpOptions | null;
  /**
   * Runtime-updatable settings. Defaults to the `gemini-3.5-transcribe-live`
   * model with automatic language detection.
   */
  settings?: GeminiSTTSettings | null;
}

/**
 * Streaming speech-to-text service using Gemini Live transcription models.
 *
 * Streams raw PCM audio to a Gemini Live transcription model (e.g.
 * `gemini-3.5-transcribe-live`) over the Gemini Live API and pushes interim
 * and final transcription frames as results arrive. Supports automatic
 * language detection, language hints, adaptation phrases, and a choice of
 * verbatim or smart transcription.
 *
 * The model detects utterance boundaries itself, and when the pipeline's VAD
 * signals end of speech the service additionally sends an audio-stream-end
 * signal to flush the utterance, so the final transcript is produced promptly
 * instead of waiting for the model to decide the utterance ended. Without an
 * upstream VAD the model finalizes on its own schedule.
 *
 * Audio is sent at the pipeline's input sample rate; the model performs best
 * with 16 kHz mono PCM.
 */
export class GeminiSTTService extends STTService {
  static Settings = GeminiSTTSettings;
  declare protected _settings: GeminiSTTSettings;

  static {
    installTracedStt(GeminiSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _httpOptions: GoogleClientHttpOptions;
  protected _client!: GoogleGenAI;
  protected _session: Session | null = null;
  // The SDK hands out a session from `live.connect()`. The open session (the
  // counterpart of upstream's session context) and the queue its callbacks
  // feed are held here so _connect() can await the session being live before
  // it returns. `_session` is cleared on a send failure while `_sessionCtx`
  // still owns the socket, so _closeSession() can close it.
  protected _sessionCtx: Session | null = null;
  protected _sessionMessages: Queue<SessionEvent> | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _connectionStartTime: number | null = null;
  protected _consecutiveFailures = 0;

  /**
   * Initialize the Gemini STT service.
   *
   * @param options.apiKey Google AI (Gemini) API key.
   * @param options.httpOptions Optional HTTP options passed to the
   *   google-genai client.
   * @param options.sampleRate The sample rate for audio input. If null, will
   *   be determined from the start frame.
   * @param options.settings Runtime-updatable settings. Defaults to the
   *   `gemini-3.5-transcribe-live` model with automatic language detection.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to the parent STTService.
   */
  constructor(options: GeminiSTTServiceOptions) {
    const defaultSettings = new GeminiSTTSettings({
      model: "gemini-3.5-transcribe-live",
      language: null,
      languages: [],
      languageAuto: null,
      adaptationPhrases: null,
      mode: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? GEMINI_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._httpOptions = updateGoogleClientHttpOptions(
      options.httpOptions ?? null,
    ) as GoogleClientHttpOptions;
    this._createClient();
  }

  /**
   * Create the google-genai client.
   *
   * Subclasses (e.g. a Vertex AI variant) can override this to customize
   * client construction and authentication.
   */
  protected _createClient(): void {
    this._client = new GoogleGenAI({
      apiKey: this._apiKey,
      httpOptions: this._httpOptions as HttpOptions,
    });
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Gemini STT supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to a BCP-47 language code.
   *
   * @param language The Language value to convert.
   * @returns The BCP-47 language code string.
   */
  override languageToServiceLanguage(language: Language): string {
    return languageToGoogleSttLanguage(language);
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
   * Stop the Gemini STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the Gemini STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /** Release Gemini STT resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  /**
   * Send audio data to Gemini for transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @returns null (transcription results arrive via the receive loop).
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    await this._sendAudio(audio);
    yield null;
  }

  /** Send audio to the live session, reconnecting on failure. */
  protected async _sendAudio(audio: Uint8Array): Promise<void> {
    const session = this._session;
    if (session === null) {
      return;
    }

    try {
      session.sendRealtimeInput({
        audio: { data: bytesToBase64(audio), mimeType: `audio/pcm;rate=${this.sampleRate}` },
      });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: audio send failed, reconnecting: ${errorMessage(e)}`);
      this._session = null;
      await this._requestReconnect();
    }
  }

  /**
   * Process frames with Gemini-specific handling.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStartedSpeakingFrame) {
      await this.startProcessingMetrics();
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._sendFinalizationSignal();
    }
  }

  /**
   * Prompt a final transcript for the utterance that just ended.
   *
   * The model's own activity detection stays enabled; the audio-stream-end
   * signal flushes the utterance so it is finalized now instead of when the
   * model decides it ended. The stream resumes when the next audio chunk is
   * sent.
   */
  protected async _sendFinalizationSignal(): Promise<void> {
    if (!this._session) {
      return;
    }
    try {
      this._session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: audio stream end failed, reconnecting: ${errorMessage(e)}`);
      this._session = null;
      await this._requestReconnect();
    }
  }

  /**
   * Apply a settings delta and reconnect if anything changed.
   *
   * All settings (model, languages, adaptation phrases) are connection-time
   * configuration, so any change requires a reconnect.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length > 0) {
      await this._requestReconnect();
    }
    return changed;
  }

  /**
   * Resolve the current language settings to BCP-47 language hint codes.
   *
   * Prefers `languages` over the single `language`. Returns an empty list
   * when no hints are configured (automatic detection).
   */
  protected _getLanguageCodes(): string[] {
    const languages = this._settings.languages;
    if (isGiven(languages) && languages && languages.length > 0) {
      // Upstream's `Language` is a `StrEnum`, so its `isinstance(lang, str)`
      // check is always true there: every entry (Language value or raw
      // string) is sent as-is, without `languageToServiceLanguage`.
      return languages.map((lang) => String(lang));
    }
    const language = this._settings.language;
    if (isGiven(language) && language) {
      // Stored as a service-specific string by the base class.
      return [String(language)];
    }
    return [];
  }

  /** Build the Live API connection config from current settings. */
  protected _buildLiveConfig(): LiveConnectConfig {
    const transcriptionKwargs: Record<string, unknown> = {};

    const languageCodes = this._getLanguageCodes();
    let languageAuto = this._settings.languageAuto;
    if (!isGiven(languageAuto)) {
      languageAuto = null;
    }
    if (languageCodes.length > 0) {
      if (languageAuto) {
        logger.warning(
          `${this}: language_auto and language hints are mutually exclusive; ` +
            "using language hints",
        );
      }
      transcriptionKwargs.languageHints = { languageCodes };
    } else if (languageAuto !== false) {
      transcriptionKwargs.languageAuto = {};
    }

    const adaptationPhrases = this._settings.adaptationPhrases;
    if (isGiven(adaptationPhrases) && adaptationPhrases && adaptationPhrases.length > 0) {
      transcriptionKwargs.adaptationPhrases = [...adaptationPhrases];
    }

    const mode = this._settings.mode;
    if (isGiven(mode) && mode) {
      transcriptionKwargs.mode = mode;
    }

    return {
      responseModalities: ["TEXT"],
      inputAudioTranscription: transcriptionKwargs,
    } as LiveConnectConfig;
  }

  /**
   * Open the Live session, then start receiving on it.
   *
   * Returns once the session can accept audio, so callers never have to
   * wait for it separately.
   */
  protected async _connect(): Promise<void> {
    if (this._receiveTask) {
      return;
    }

    logger.debug(`${this}: connecting to Gemini`);
    await this._openSession();
    this._receiveTask = this.createTask(() => this._receiveHandler(), "_receiveHandler");
    this._createKeepaliveTask();
  }

  protected async _disconnect(): Promise<void> {
    if (!this._receiveTask) {
      return;
    }

    logger.debug(`${this}: disconnecting from Gemini`);
    await this._cancelKeepaliveTask();
    const task = this._receiveTask;
    this._receiveTask = null;
    await this.cancelTask(task, 1.0);
    await this._closeSession();
  }

  /**
   * Open the Live session and record it as usable.
   *
   * @returns The session, which is live and able to accept audio.
   */
  protected async _openSession(): Promise<Session> {
    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("GeminiSTTService requires a model");
    }

    const config = this._buildLiveConfig();
    const messages = new Queue<SessionEvent>();
    this._sessionMessages = messages;
    const session = await this._client.live.connect({
      model,
      config,
      callbacks: {
        onmessage: (message: unknown) => {
          messages.putNowait({ kind: "message", message: message as LiveServerMessageLike });
        },
        onerror: (event: unknown) => {
          messages.putNowait({
            kind: "error",
            error: (event as { error?: unknown }).error ?? event,
          });
        },
        onclose: (event: { code?: number; reason?: string } | null | undefined) => {
          messages.putNowait({ kind: "close", code: event?.code, reason: event?.reason });
        },
      },
    });
    this._sessionCtx = session;
    this._session = session;
    this._connectionStartTime = time();
    await this._callEventHandler("on_connected");
    logger.debug(`${this}: connected to Gemini`);
    return session;
  }

  /**
   * Close the Live session, if one is open.
   *
   * @param exc The error the session is being closed for, if any. The JS SDK
   *   cannot be told the cause, so it is only logged.
   */
  protected async _closeSession(exc: unknown = null): Promise<void> {
    const session = this._sessionCtx;
    this._sessionCtx = null;
    const wasConnected = this._session !== null;
    this._session = null;
    this._sessionMessages = null;

    if (session) {
      try {
        if (exc) {
          logger.debug(`${this}: closing the Gemini session after error: ${errorMessage(exc)}`);
        }
        session.close();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.debug(`${this}: error closing the Gemini session: ${errorMessage(e)}`);
      }
    }

    if (wasConnected) {
      await this._callEventHandler("on_disconnected");
    }
  }

  /**
   * Disconnect and reconnect to Gemini.
   *
   * Called by `STTService._reconnect()` inside the reconnecting guard.
   * `_connect()` returns with the session live, so buffered audio frames are
   * replayed only once the new session can accept them.
   */
  protected override async _doReconnect(): Promise<void> {
    await this._disconnect();
    await this._connect();
  }

  /**
   * Receive server messages, reopening the session after transient errors.
   *
   * Repeated rapid failures are treated as fatal. Exits cleanly when the task
   * is cancelled (i.e. on stop/cancel).
   */
  protected async _receiveHandler(): Promise<void> {
    while (true) {
      try {
        let messages = this._sessionMessages;
        if (this._session === null || messages === null) {
          logger.debug(`${this}: reopening the Gemini session`);
          await this._openSession();
          messages = this._sessionMessages as Queue<SessionEvent> | null;
          if (messages === null) throw new Error("Gemini session closed while opening");
        }

        while (true) {
          const event = await messages.get();
          if (event.kind === "error") {
            throw event.error instanceof Error ? event.error : new Error(String(event.error));
          }
          if (event.kind === "close") {
            throw new Error(
              `Gemini Live connection closed (code ${event.code ?? "unknown"}): ${event.reason ?? ""}`,
            );
          }
          this._checkAndResetFailureCounter();
          await this._handleServerMessage(event.message);
        }
      } catch (e) {
        if (e instanceof CancelledError) {
          throw e;
        }
        await this._closeSession(e);
        this._consecutiveFailures += 1;
        if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const errorMsg =
            `Max consecutive connection failures ` +
            `(${MAX_CONSECUTIVE_FAILURES}) reached: ${errorMessage(e)}`;
          await this._callEventHandler("on_connection_error", errorMessage(e));
          await this.pushError(errorMsg, { exception: e, forceTreatAsPermanent: true });
          return;
        }
        logger.warning(
          `${this}: connection lost, will retry ` +
            `(${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errorMessage(e)}`,
        );
        await this.pushError(`connection error: ${errorMessage(e)}`, { exception: e });
      }
    }
  }

  /** Reset the failure counter once the connection has proven stable. */
  protected _checkAndResetFailureCounter(): void {
    if (
      this._connectionStartTime &&
      this._consecutiveFailures > 0 &&
      time() - this._connectionStartTime >= CONNECTION_ESTABLISHED_THRESHOLD
    ) {
      this._consecutiveFailures = 0;
    }
  }

  protected async _handleServerMessage(message: LiveServerMessageLike): Promise<void> {
    const sc = message.serverContent;
    if (!sc) {
      return;
    }
    if (sc.interimInputTranscription) {
      await this._handleInterimTranscription(sc.interimInputTranscription, message);
    }
    if (sc.inputTranscription) {
      await this._handleInputTranscription(sc.inputTranscription, message);
    }
  }

  /**
   * Push an interim transcription frame.
   *
   * Interim transcriptions carry the complete utterance text so far, so each
   * frame replaces the previous one.
   */
  protected async _handleInterimTranscription(
    transcription: LiveTranscription,
    message: LiveServerMessageLike,
  ): Promise<void> {
    const text = transcription.text;
    if (!text) {
      return;
    }
    await this.pushFrame(
      new InterimTranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language: this._languageFromCode(transcription.languageCode),
        result: message,
      }),
    );
  }

  /**
   * Push a final transcription frame.
   *
   * The model streams interim results via `interimInputTranscription` and
   * delivers each completed utterance as a single `inputTranscription`
   * message carrying the full utterance text.
   */
  protected async _handleInputTranscription(
    transcription: LiveTranscription,
    message: LiveServerMessageLike,
  ): Promise<void> {
    const text = transcription.text;
    if (!text) {
      return;
    }

    const language = this._languageFromCode(transcription.languageCode);
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
    await this._handleTranscription(text, true, language);
    await this.stopProcessingMetrics();
  }

  /** Convert a BCP-47 language code from the server to a Language value. */
  protected _languageFromCode(languageCode: string | null | undefined): Language | null {
    if (!languageCode) {
      return null;
    }
    return isLanguage(languageCode) ? languageCode : null;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  /** Check if the session can accept keepalive audio. */
  protected override _isKeepaliveReady(): boolean {
    return this._session !== null;
  }

  /**
   * Send silent audio to keep the Live session alive.
   *
   * @param silence Silent 16-bit mono PCM audio bytes.
   */
  protected override async _sendKeepalive(silence: Uint8Array): Promise<void> {
    if (this._session) {
      this._session.sendRealtimeInput({
        audio: { data: bytesToBase64(silence), mimeType: `audio/pcm;rate=${this.sampleRate}` },
      });
    }
  }
}
