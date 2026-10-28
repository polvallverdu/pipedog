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
 * - DIVERGENCE: pipedog-only Vertex AI mode (`vertexai: true` with
 *   `location`, and optionally `projectId`, `credentials` or
 *   `credentialsPath`, as the Vertex LLM services take them) instead of
 *   `apiKey`. Vertex's Live API rejects `languageAuto` / `languageHints`, so
 *   in that mode the codes go in `inputAudioTranscription.languageCodes`, and
 *   an empty `inputAudioTranscription` means automatic detection. Credentials
 *   go through google-auth-library, which only the SDK's Node build supports:
 *   Vertex mode runs on Bun, Node and Deno, not on Workers.
 * - DIVERGENCE: pipedog-only. The client is created on first connect, not in
 *   the constructor. Upstream's constructor calls `_create_client()` after
 *   storing its options; in JS a subclass's fields are set only after
 *   `super()` returns, so a `_createClient()` override called from the base
 *   constructor could not read them.
 * - DIVERGENCE: pipedog-only `reportDetectedLanguage` option and
 *   `setLanguageCodes()`. Changed codes are applied by reconnecting on the
 *   next `BotStartedSpeakingFrame` (or after the user's turn, if they are
 *   speaking then), in a background task so frames keep flowing.
 * - DIVERGENCE: upstream connects in `setup()`, so the pipeline's StartFrame
 *   waits for the Live session (about a second on a cold connection). Here
 *   the session is opened in a background task on StartFrame, and audio is
 *   buffered until it is live, as during a reconnect. `awaitConnectionOnStart:
 *   true` (pipedog-only) restores upstream's behaviour.
 */

import {
  GoogleGenAI,
  type GoogleGenAIOptions,
  type HttpOptions,
  type LiveConnectConfig,
  type Session,
} from "@google/genai";
import {
  CancelledError,
  Future,
  Queue,
  rethrowIfCancelled,
  type Task,
  time,
} from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  type InputAudioRawFrame,
  InterimTranscriptionFrame,
  type StartFrame,
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
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
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

/** google-auth-library options, as `GoogleGenAI` takes them. */
export type GoogleAuthOptions = NonNullable<GoogleGenAIOptions["googleAuthOptions"]>;

const CLOUD_PLATFORM_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code, i) => code === b[i]);
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
  /** Google AI (Gemini) API key. Required unless `vertexai` is true. */
  apiKey?: string;
  /**
   * Connect through Vertex AI instead of the Gemini Developer API, with
   * Google Cloud credentials instead of an API key. Requires `location`
   * (pipedog only).
   */
  vertexai?: boolean;
  /**
   * Vertex AI location, e.g. `"eu"` or `"us-central1"`. Required with
   * `vertexai` (pipedog only).
   */
  location?: string;
  /**
   * Google Cloud project ID, with `vertexai`. Defaults to the
   * `GOOGLE_CLOUD_PROJECT` environment variable (pipedog only).
   */
  projectId?: string | null;
  /**
   * JSON string of service account credentials, with `vertexai`. Without it
   * (or `credentialsPath`), Application Default Credentials are used
   * (pipedog only).
   */
  credentials?: string | null;
  /** Path to the service account JSON file, with `vertexai` (pipedog only). */
  credentialsPath?: string | null;
  /** Optional HTTP options passed to the google-genai client. */
  httpOptions?: GoogleClientHttpOptions | null;
  /**
   * Runtime-updatable settings. Defaults to the `gemini-3.5-transcribe-live`
   * model with automatic language detection.
   */
  settings?: GeminiSTTSettings | null;
  /**
   * Put the language the model reports on transcription frames. Defaults to
   * true. When false, frames carry the configured language if exactly one is
   * configured, and `null` otherwise (pipedog only).
   */
  reportDetectedLanguage?: boolean;
  /**
   * Hold the pipeline's StartFrame until the Live session is open, as
   * upstream does. Defaults to false: the session is opened in the
   * background and audio is buffered until it is live (pipedog only).
   */
  awaitConnectionOnStart?: boolean;
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

  protected _apiKey: string | null;
  protected _vertexai: boolean;
  protected _projectId: string | null;
  protected _location: string | null;
  protected _credentials: GoogleAuthOptions | null;
  protected _httpOptions: GoogleClientHttpOptions;
  protected _reportDetectedLanguage: boolean;
  protected _awaitConnectionOnStart: boolean;
  // Created on first connect by _getClient(), so a _createClient() override
  // can read the subclass's own fields.
  protected _client: GoogleGenAI | null = null;
  // The background task opening the session (on StartFrame, or to apply new
  // language codes). Audio is buffered in `_reconnectAudioBuffer` meanwhile.
  protected _connectTask: Task<unknown> | null = null;
  // Codes from setLanguageCodes(), which take precedence over the
  // `language` / `languages` settings until those change.
  protected _languageCodes: string[] | (() => string[]) | null = null;
  // The codes the current session was opened with.
  protected _sessionLanguageCodes: string[] | null = null;
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
   * @param options.apiKey Google AI (Gemini) API key. Required unless
   *   `vertexai` is true.
   * @param options.vertexai Connect through Vertex AI with Google Cloud
   *   credentials instead of an API key. Requires `location`.
   * @param options.location Vertex AI location (e.g. "eu", "us-central1").
   * @param options.projectId Google Cloud project ID for Vertex AI.
   * @param options.credentials JSON string of service account credentials
   *   for Vertex AI. Defaults to Application Default Credentials.
   * @param options.credentialsPath Path to the service account JSON file for
   *   Vertex AI.
   * @param options.httpOptions Optional HTTP options passed to the
   *   google-genai client.
   * @param options.reportDetectedLanguage Put the language the model reports
   *   on transcription frames (default true). When false, frames carry the
   *   configured language if exactly one is configured, else null.
   * @param options.awaitConnectionOnStart Hold the StartFrame until the Live
   *   session is open (default false: connect in the background and buffer
   *   audio until the session is live).
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
    const vertexai = options.vertexai ?? false;
    if (vertexai) {
      if (options.apiKey !== undefined) {
        throw new Error(
          "Invalid parameter 'apiKey' with 'vertexai'. Use 'credentials' or " +
            "'credentialsPath' (or Application Default Credentials) for Vertex AI authentication.",
        );
      }
      if (!options.location) {
        throw new Error("GeminiSTTService with 'vertexai' requires a 'location'");
      }
    } else if (options.apiKey === undefined) {
      throw new Error("GeminiSTTService requires an 'apiKey', or 'vertexai' with a 'location'");
    }

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

    this._apiKey = options.apiKey ?? null;
    this._vertexai = vertexai;
    this._projectId = options.projectId ?? null;
    this._location = options.location ?? null;
    // Inline credentials are parsed here, so bad JSON fails construction;
    // a key file and ADC are loaded by the client on first connect.
    this._credentials = vertexai
      ? GeminiSTTService._getCredentials(
          options.credentials ?? null,
          options.credentialsPath ?? null,
        )
      : null;
    this._httpOptions = updateGoogleClientHttpOptions(
      options.httpOptions ?? null,
    ) as GoogleClientHttpOptions;
    this._reportDetectedLanguage = options.reportDetectedLanguage ?? true;
    this._awaitConnectionOnStart = options.awaitConnectionOnStart ?? false;
  }

  /**
   * Create the google-genai client.
   *
   * Called on first connect, after the constructor (and any subclass
   * constructor) has finished, so overrides can read their own fields.
   * Subclasses can override this to customize client construction and
   * authentication.
   */
  protected _createClient(): void {
    if (this._vertexai) {
      this._client = new GoogleGenAI({
        vertexai: true,
        googleAuthOptions: this._credentials ?? undefined,
        project: this._projectId ?? undefined,
        location: this._location ?? undefined,
        httpOptions: this._httpOptions as HttpOptions,
      });
      return;
    }
    this._client = new GoogleGenAI({
      apiKey: this._apiKey ?? undefined,
      httpOptions: this._httpOptions as HttpOptions,
    });
  }

  /** The google-genai client, created by `_createClient()` on first use. */
  protected _getClient(): GoogleGenAI {
    if (this._client === null) {
      this._createClient();
    }
    if (this._client === null) {
      throw new Error(`${this}: _createClient() did not set _client`);
    }
    return this._client;
  }

  /**
   * Resolve Vertex AI credentials, as the Vertex LLM services do.
   *
   * Supports, in order: a JSON credentials string, a service account JSON
   * file, and Application Default Credentials (ADC).
   *
   * @param credentials JSON string of service account credentials.
   * @param credentialsPath Path to the service account JSON file.
   * @returns google-auth-library options for the client. The file and ADC
   *   are loaded, and the access token refreshed, by the client.
   */
  static _getCredentials(
    credentials: string | null,
    credentialsPath: string | null,
  ): GoogleAuthOptions {
    if (credentials) {
      return {
        credentials: pyJsonLoads(credentials) as GoogleAuthOptions["credentials"],
        scopes: CLOUD_PLATFORM_SCOPES,
      };
    }
    if (credentialsPath) {
      return { keyFilename: credentialsPath, scopes: CLOUD_PLATFORM_SCOPES };
    }
    return { scopes: CLOUD_PLATFORM_SCOPES };
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
    // Upstream connects here, which holds the pipeline's StartFrame until the
    // session is open. By default the session is opened on StartFrame
    // instead, in the background (see start()).
    if (this._awaitConnectionOnStart) {
      await this._connect();
    }
  }

  /**
   * Start the Gemini STT service, opening the Live session in the background.
   *
   * The StartFrame goes on at once; audio is buffered until the session is
   * live, and a failure to connect is reported through
   * `on_connection_error` and an error frame.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (!this._awaitConnectionOnStart) {
      await this._startBackgroundConnect();
    }
  }

  /**
   * Stop the Gemini STT service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._cancelConnectTask();
    await this._disconnect();
  }

  /**
   * Cancel the Gemini STT service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._cancelConnectTask();
    await this._disconnect();
  }

  /** Release Gemini STT resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelConnectTask();
    await this._disconnect();
  }

  /**
   * Set the language codes to transcribe, e.g. when the bot switches language.
   *
   * The codes (BCP-47, sent as-is) take precedence over the `language` and
   * `languages` settings until either of those is updated. An empty list
   * means automatic detection. Pass a function to have the codes read each
   * time they are needed.
   *
   * The session is not reconnected at once: when the codes differ from the
   * ones the session was opened with, the service reconnects on the next
   * `BotStartedSpeakingFrame`, or once the user's turn ends if they are
   * speaking then, so no utterance is cut. Audio that arrives during the
   * reconnect is buffered and sent to the new session.
   *
   * DIVERGENCE: pipedog-only.
   *
   * @param codes The language codes, or a function returning them.
   */
  async setLanguageCodes(codes: string[] | (() => string[])): Promise<void> {
    this._languageCodes = typeof codes === "function" ? codes : [...codes];
    logger.debug(`${this}: language codes set; applied on the next safe reconnect`);
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
    } else if (frame instanceof BotStartedSpeakingFrame) {
      await this._maybeApplyLanguageCodes();
    }
  }

  /**
   * Reconnect if the language codes changed since the session was opened.
   *
   * Called when the bot starts speaking, a moment when the user is usually
   * not. If the user is mid-turn, the reconnect is deferred until the turn
   * ends (`_requestReconnect()` semantics). The reconnect runs in a
   * background task so frames keep flowing; audio is buffered meanwhile.
   *
   * DIVERGENCE: pipedog-only.
   */
  protected async _maybeApplyLanguageCodes(): Promise<void> {
    // Not connected yet: the next connect reads the current codes.
    if (this._sessionLanguageCodes === null) {
      return;
    }
    const codes = this._getLanguageCodes();
    if (sameCodes(codes, this._sessionLanguageCodes)) {
      return;
    }
    logger.debug(`${this}: language codes changed to [${codes.join(", ")}], reconnecting`);
    if (!this._canReconnect) {
      this._needReconnect = true;
      return;
    }
    await this._startBackgroundConnect();
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
    if ("language" in changed || "languages" in changed) {
      // New language settings replace codes set with setLanguageCodes().
      this._languageCodes = null;
    }
    if (Object.keys(changed).length > 0) {
      await this._requestReconnect();
    }
    return changed;
  }

  /**
   * Reconnect now if safe, or once the user's turn ends.
   *
   * While the first session is still being opened in the background, that
   * attempt is restarted instead, so it uses the current settings; the audio
   * buffered so far is kept.
   */
  protected override async _requestReconnect(): Promise<void> {
    if (this._connectTask !== null) {
      await this._startBackgroundConnect();
      return;
    }
    await super._requestReconnect();
  }

  /**
   * Resolve the current language settings to BCP-47 language hint codes.
   *
   * Prefers `languages` over the single `language`. Returns an empty list
   * when no hints are configured (automatic detection).
   */
  protected _getLanguageCodes(): string[] {
    const override = this._languageCodes;
    if (override !== null) {
      return [...(typeof override === "function" ? override() : override)];
    }
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

  /**
   * Build the Live API connection config from current settings.
   *
   * @param languageCodes The language codes to send. Defaults to
   *   `_getLanguageCodes()`.
   */
  protected _buildLiveConfig(
    languageCodes: string[] = this._getLanguageCodes(),
  ): LiveConnectConfig {
    const transcriptionKwargs: Record<string, unknown> = {};

    let languageAuto = this._settings.languageAuto;
    if (!isGiven(languageAuto)) {
      languageAuto = null;
    }
    if (languageCodes.length > 0 && languageAuto) {
      logger.warning(
        `${this}: language_auto and language hints are mutually exclusive; ` +
          "using language hints",
      );
    }
    if (this._vertexai) {
      // Vertex's Live API rejects languageAuto and languageHints: the codes
      // go in languageCodes, and none means automatic detection.
      if (languageCodes.length > 0) {
        transcriptionKwargs.languageCodes = [...languageCodes];
      }
    } else if (languageCodes.length > 0) {
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

  /**
   * Open the session in a background task, replacing any connection.
   *
   * Audio is buffered (as during a reconnect) until the session is live and
   * then sent to it. A connect already in progress is cancelled first. The
   * task is tracked, so stop, cancel and cleanup cancel it.
   */
  protected async _startBackgroundConnect(): Promise<void> {
    await this._cancelConnectTask();
    this._reconnecting = true;
    this._connectTask = this.createTask(() => this._backgroundConnect(), "_backgroundConnect");
  }

  /** Cancel the background connect, if one is in progress. */
  protected async _cancelConnectTask(): Promise<void> {
    const task = this._connectTask;
    if (task === null) {
      return;
    }
    this._connectTask = null;
    await this.cancelTask(task, 1.0);
  }

  /**
   * Close any session and open a new one, then send the buffered audio.
   *
   * On failure the error goes through `on_connection_error` and an error
   * frame, as for a failed reconnect, and the buffered audio is dropped.
   */
  protected async _backgroundConnect(): Promise<void> {
    try {
      await this._disconnect();
      await this._connect();
    } catch (e) {
      rethrowIfCancelled(e);
      this._connectTask = null;
      this._reconnecting = false;
      this._reconnectAudioBuffer.length = 0;
      logger.error(`${this} connection failed: ${errorMessage(e)}`);
      await this._callEventHandler("on_connection_error", errorMessage(e));
      await this.pushError(`${this} connection failed: ${errorMessage(e)}`, { exception: e });
      return;
    }
    this._connectTask = null;
    this._reconnecting = false;

    // Send the audio that arrived while the session was being opened.
    const buffered: [InputAudioRawFrame, FrameDirection][] = this._reconnectAudioBuffer.splice(0);
    for (const [bufferedFrame, bufferedDirection] of buffered) {
      await this.processAudioFrame(bufferedFrame, bufferedDirection);
    }
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

    const languageCodes = this._getLanguageCodes();
    const config = this._buildLiveConfig(languageCodes);
    const messages = new Queue<SessionEvent>();
    this._sessionMessages = messages;

    // `live.connect()` resolves once the socket is open and the server has
    // answered the setup with `setupComplete`. If the socket fails or is
    // closed before that (refused connection, failed handshake, or Google
    // closing it over a bad API key or model) the SDK reports it only through
    // `onerror` / `onclose` and the promise never settles. Upstream's
    // `connect()` raises in those cases, so until the session is open those
    // callbacks fail the connect instead of feeding the receive queue.
    const opened = new Future<Session>();
    let connected = false;
    const failConnect = (error: unknown) => {
      if (!opened.done()) opened.setException(error);
    };
    this._getClient()
      .live.connect({
        model,
        config,
        callbacks: {
          onmessage: (message: unknown) => {
            messages.putNowait({ kind: "message", message: message as LiveServerMessageLike });
          },
          onerror: (event: unknown) => {
            const error = (event as { error?: unknown }).error ?? event;
            if (!connected) {
              failConnect(error instanceof Error ? error : new Error(errorMessage(error)));
              return;
            }
            messages.putNowait({ kind: "error", error });
          },
          onclose: (event: { code?: number; reason?: string } | null | undefined) => {
            if (!connected) {
              failConnect(
                new Error(
                  `Gemini Live connection closed (code ${event?.code ?? "unknown"}): ${event?.reason ?? ""}`,
                ),
              );
              return;
            }
            messages.putNowait({ kind: "close", code: event?.code, reason: event?.reason });
          },
        },
      })
      .then(
        (session) => {
          // Opened after the caller gave up (cancelled, or the socket already
          // failed): nobody owns this session, so close it.
          if (opened.done()) {
            session.close();
            return;
          }
          // From here on, socket errors and closes go to the receive task.
          connected = true;
          opened.setResult(session);
        },
        (e: unknown) => failConnect(e),
      );
    // A Future is a cancellation point; the SDK's promise is not.
    let session: Session;
    try {
      session = await opened;
    } catch (e) {
      // Cancelled after the session opened, before this task resumed.
      if (e instanceof CancelledError && opened.done() && !opened.cancelled()) {
        if (opened.exception() === null || opened.exception() === undefined) {
          opened.result().close();
        }
      }
      throw e;
    }
    this._sessionCtx = session;
    this._session = session;
    this._sessionLanguageCodes = languageCodes;
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
    await this._cancelConnectTask();
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
        language: this._transcriptionLanguage(transcription.languageCode),
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

    const language = this._transcriptionLanguage(transcription.languageCode);
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

  /**
   * The language to put on a transcription frame.
   *
   * The language the model reports, or with `reportDetectedLanguage: false`
   * the configured language when exactly one is configured, else null.
   */
  protected _transcriptionLanguage(languageCode: string | null | undefined): Language | null {
    if (this._reportDetectedLanguage) {
      return this._languageFromCode(languageCode);
    }
    const codes = this._sessionLanguageCodes ?? this._getLanguageCodes();
    return codes.length === 1 ? this._languageFromCode(codes[0]) : null;
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
