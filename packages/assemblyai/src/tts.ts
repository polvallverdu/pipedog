// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/assemblyai/tts.py

/**
 * AssemblyAI text-to-speech service implementation.
 *
 * This module provides integration with AssemblyAI's Streaming TTS WebSocket API,
 * which synthesizes text into streamed PCM audio with per-word timings.
 *
 * Porting notes:
 * - The socket is opened through `WebsocketService._websocketConnect()` (core's
 *   `websocketConnect`), with the API key in the `Authorization` header of the
 *   opening handshake (sent through `fetch` on Cloudflare Workers).
 * - Generate chunks are cut by code point, as Python's `str` slicing does, so a
 *   surrogate pair is never split across two Generate messages.
 * - DIVERGENCE: upstream tests patch the module constants `_KEEPALIVE_INTERVAL_S`
 *   and `_WORD_BOUNDARIES_GRACE_S` with `monkeypatch`. An ES module export is
 *   read-only, so they are read from the protected instance fields
 *   `_keepaliveIntervalS` and `_wordBoundariesGraceS`, which start at the constants.
 */

import { rethrowIfCancelled, sleep, type Task, time } from "@pipedog/asyncio";
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
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Audrey, a voice from AssemblyAI's public voice library.
export const _DEFAULT_VOICE_ID = "49c443a4-8a1d-5f7e-b70b-98bdbd9823c3";

// Longest text one Generate message accepts, when Begin doesn't report a limit.
const _MAX_GENERATE_CHARS = 2000;

// How long before a session's expires_at to replace it between requests, at
// most half the session's length. The server stops reading text at expires_at,
// which would cut off a reply that straddles it.
const _SESSION_RENEWAL_MARGIN_S = 120.0;

// How often to send KeepAlive. Every session closes after 120 s without a frame
// either way, and a bot can be silent that long while the user speaks.
export const _KEEPALIVE_INTERVAL_S = 30.0;

// How long to wait, after a turn's last FlushDone, for the WordBoundaries frame
// that trails it. It is best-effort, so the turn closes without it after this.
export const _WORD_BOUNDARIES_GRACE_S = 1.0;

// Retryable errors that end a session in the normal course of things.
const _ROUTINE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "inactivity_timeout",
  "session_expired",
  "service_restart",
]);

/**
 * Convert a Language enum to an AssemblyAI Streaming TTS language.
 *
 * The TTS API takes the full English name of the language (`"spanish"`),
 * unlike the STT APIs, which take short codes.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding AssemblyAI TTS language name.
 */
export function languageToAssemblyaiTtsLanguage(language: Language): string | null {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "german",
    [Language.EN]: "english",
    [Language.ES]: "spanish",
    [Language.FR]: "french",
    [Language.IT]: "italian",
    [Language.PT]: "portuguese",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface AssemblyAITTSSettingsOptions extends TTSSettingsOptions {}

/**
 * Settings for AssemblyAITTSService.
 *
 * `voice` is the API's `voice_id`: any voice by its ID, an AssemblyAI
 * voice by its library slug, such as `aai-jane`, or a cloned voice by the
 * slug the AssemblyAI dashboard shows. It defaults to Audrey
 * (`_DEFAULT_VOICE_ID`); `null` leaves the voice to the server.
 * `language` is the language the session speaks, and `model` names the
 * model, such as `assemblyai-tts-1`. Unset, the session speaks the voice's
 * own language and runs on that language's default model.
 */
export class AssemblyAITTSSettings extends TTSSettings {
  constructor(options: AssemblyAITTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Bookkeeping for one audio context.
 *
 * - `audioMs`: Playback length of the context's finished requests, where
 *   the next request's audio starts within the context.
 * - `turnDone`: Whether the turn has ended, so no more text will be sent.
 * - `awaitingWords`: Flush IDs whose WordBoundaries frame is still due,
 *   each with where its request's audio starts within the context.
 * - `graceTask`: Task that closes the context if WordBoundaries never come.
 */
class _ContextState {
  audioMs = 0.0;
  turnDone = false;
  awaitingWords: Map<number, number> = new Map();
  graceTask: Task<unknown> | null = null;
}

export interface AssemblyAITTSServiceOptions extends WebsocketTTSServiceOptions {
  /**
   * AssemblyAI API key. A temporary token opens a single session, so it
   * can't carry the service's reconnects and session renewals.
   */
  apiKey: string;
  /**
   * Streaming TTS WebSocket URL. Use `wss://tts.eu.assemblyai.com/v1/ws` to
   * process text and audio in the EU. A cloned voice works only on the host
   * of the zone it was created in.
   */
  url?: string;
  /** Output sample rate in Hz. If null, uses the pipeline's output rate. */
  sampleRate?: number | null;
  /** Runtime-updatable settings. */
  settings?: AssemblyAITTSSettings | null;
}

/**
 * AssemblyAI Streaming TTS service.
 *
 * Streams text to AssemblyAI over a single WebSocket session and plays the
 * audio as it arrives. Each sentence is sent as its own request (a
 * `Generate` followed by a `Flush`). With `TextAggregationMode.TOKEN`
 * the turn's text streams as it is generated and is flushed when the turn
 * ends. Interruptions send `Cancel`, which keeps the session open, and
 * per-word timings drive word-level `TTSTextFrame` output.
 *
 * The session is configured at connect time, so changing the voice,
 * language or model reconnects. A session lasts at most an hour; the service
 * replaces it between requests before it expires.
 *
 * @example
 * ```ts
 * // Speaks in Audrey, the default voice.
 * const tts = new AssemblyAITTSService({ apiKey: process.env.ASSEMBLYAI_API_KEY! });
 *
 * // Another voice, by its ID: Keegan.
 * const tts2 = new AssemblyAITTSService({
 *   apiKey: process.env.ASSEMBLYAI_API_KEY!,
 *   settings: new AssemblyAITTSService.Settings({ voice: "987db62e-a2c2-569a-9c4d-82460cdea1bd" }),
 * });
 * ```
 */
export class AssemblyAITTSService extends WebsocketTTSService {
  static Settings: typeof AssemblyAITTSSettings = AssemblyAITTSSettings;
  declare protected _settings: AssemblyAITTSSettings;

  static {
    installTracedTts(AssemblyAITTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null = null;

  // Session state reported by Begin. A session ID means Begin arrived.
  protected _sessionId: string | null = null;
  protected _renewAt: number | null = null;
  protected _maxGenerateChars: number = _MAX_GENERATE_CHARS;
  protected _wordBoundaries = false;
  // The wait an Error asked for before the next connection attempt.
  protected _reconnectDelay = 0.0;

  // The server numbers requests from 0 per session, and each Flush and
  // Cancel takes the next number. This is the number of the request text
  // is being written to now.
  protected _nextFlushId = 0;
  // Flush ID -> context, for requests whose FlushDone is still due.
  protected _requests: Map<number, string> = new Map();
  protected _contexts: Map<string, _ContextState> = new Map();
  // Flush ID -> context, for the WordBoundaries that follows a FlushDone.
  protected _wordContexts: Map<number, string> = new Map();
  protected _keepaliveIntervalS: number = _KEEPALIVE_INTERVAL_S;
  protected _wordBoundariesGraceS: number = _WORD_BOUNDARIES_GRACE_S;

  /**
   * Initialize the AssemblyAI TTS service.
   *
   * @param options.apiKey AssemblyAI API key. A temporary token opens a single
   *   session, so it can't carry the service's reconnects and session renewals.
   * @param options.url Streaming TTS WebSocket URL. Use
   *   `wss://tts.eu.assemblyai.com/v1/ws` to process text and audio in the EU.
   *   A cloned voice works only on the host of the zone it was created in.
   * @param options.sampleRate Output sample rate in Hz. If null, uses the
   *   pipeline's output rate.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent WebsocketTTSService.
   */
  constructor(options: AssemblyAITTSServiceOptions) {
    const defaultSettings = new (new.target as typeof AssemblyAITTSService).Settings({
      model: null,
      voice: _DEFAULT_VOICE_ID,
      language: null,
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://tts.us.assemblyai.com/v1/ws";
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as AssemblyAI TTS supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to an AssemblyAI TTS language name.
   *
   * @param language The language to convert.
   * @returns The AssemblyAI TTS language name.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToAssemblyaiTtsLanguage(language);
  }

  /**
   * Set up the service and connect.
   *
   * Connecting here, rather than on the first sentence, keeps the
   * connection setup off the first response's latency.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /**
   * Apply a settings delta, reconnecting if the session's configuration changed.
   *
   * @param delta A TTSSettings (or `AssemblyAITTSService.Settings`) delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (["voice", "language", "model"].some((k) => k in changed)) {
      await this._disconnect();
      await this._connect();
    } else {
      this._warnUnhandledUpdatedSettings(changed);
    }
    return changed;
  }

  /** Build the connect URL, which carries the whole session configuration. */
  protected _buildWebsocketUrl(): string {
    const settings = this._settings;
    const params: Record<string, string> = {
      sample_rate: String(this.sampleRate),
      encoding: "pcm_s16le",
      word_boundaries: "true",
    };
    // Unset values are left to the server's defaults.
    if (isGiven(settings.voice) && settings.voice) {
      params.voice_id = settings.voice;
    }
    if (isGiven(settings.language) && settings.language) {
      params.language = String(settings.language);
    }
    if (isGiven(settings.model) && settings.model) {
      params.model_id = settings.model;
    }
    return `${this._url}?${new URLSearchParams(params).toString()}`;
  }

  // ------------------------------------------------------------------
  // WebSocket connection management
  // ------------------------------------------------------------------

  /** Connect to AssemblyAI and start the receive and keepalive tasks. */
  override async _connect(): Promise<void> {
    await super._connect();
    this._reconnectDelay = 0.0;
    await this._openSession();
    this._createKeepaliveTask(this._keepaliveIntervalS);
  }

  /** Disconnect from AssemblyAI and stop the receive and keepalive tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    await this.stopAllMetrics();
    await this._cancelKeepaliveTask();
    await this._closeSession();
  }

  protected async _openSession(): Promise<void> {
    await this._connectWebsocket();
    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  protected async _closeSession(): Promise<void> {
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask, 1.0);
      this._receiveTask = null;
    }
    await this._disconnectWebsocket();
  }

  /**
   * Replace the session ahead of its expiry, while nothing is in flight.
   *
   * Audio contexts stay open, so a turn in progress carries on in the new
   * session.
   */
  protected async _renewSessionIfExpiring(): Promise<void> {
    if (this._renewAt === null || time() < this._renewAt) {
      return;
    }
    if (this._requests.size > 0 || this._wordContexts.size > 0) {
      return;
    }
    logger.debug(`${this}: session ${this._sessionId} expires soon; opening a new one`);
    await this._closeSession();
    await this._openSession();
  }

  /** Reconnect, first waiting as long as the last Error asked. */
  override async _reconnectWebsocket(attemptNumber: number): Promise<boolean> {
    if (this._reconnectDelay) {
      const delay = this._reconnectDelay;
      this._reconnectDelay = 0.0;
      logger.debug(`${this}: waiting ${delay} s before reconnecting, as the server asked`);
      await sleep(delay);
    }
    return await super._reconnectWebsocket(attemptNumber);
  }

  /** Open the WebSocket session. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const url = this._buildWebsocketUrl();
      logger.debug(`${this}: connecting to ${url}`);
      const headers = {
        Authorization: this._apiKey,
        "User-Agent": `AssemblyAI/1.0 (integration=Pipecat/${pipecatVersion()})`,
      };
      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to AssemblyAI TTS: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /**
   * Close the WebSocket session and forget its state.
   *
   * Closing discards synthesis still in flight, which is what a disconnect
   * wants; by the end of a pipeline every reply has already been played.
   */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug(`${this}: disconnecting`);
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._resetSessionState();
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Forget per-session state, which a new session doesn't carry over. */
  protected _resetSessionState(): void {
    this._nextFlushId = 0;
    this._requests.clear();
    this._wordContexts.clear();
    this._sessionId = null;
    this._renewAt = null;
    this._maxGenerateChars = _MAX_GENERATE_CHARS;
    this._wordBoundaries = false;
  }

  /** Forget the bookkeeping of the contexts a replaced connection closes. */
  protected override async _closeConnectionContexts(): Promise<void> {
    for (const contextId of [...this._contexts.keys()]) {
      await this._forgetContext(contextId);
    }
    await super._closeConnectionContexts();
  }

  /** Return the active WebSocket connection or raise if disconnected. */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  protected async _send(message: Dict): Promise<void> {
    await this._getWebsocket().send(pyJsonDumps(message));
  }

  /** Send KeepAlive so an idle session stays open. */
  protected override async _sendKeepalive(): Promise<void> {
    await this._send({ type: "KeepAlive" });
  }

  // ------------------------------------------------------------------
  // Audio contexts
  // ------------------------------------------------------------------

  protected _contextState(contextId: string): _ContextState {
    let state = this._contexts.get(contextId);
    if (!state) {
      state = new _ContextState();
      this._contexts.set(contextId, state);
    }
    return state;
  }

  /**
   * Close a context once its turn has ended and the server owes it nothing.
   *
   * That is: every Flush answered with FlushDone, and every WordBoundaries
   * frame due arrived, or the grace period for one ran out.
   */
  protected async _maybeCloseContext(contextId: string): Promise<void> {
    const state = this._contexts.get(contextId);
    if (!state?.turnDone) {
      return;
    }
    if ([...this._requests.values()].includes(contextId)) {
      return;
    }
    if (state.awaitingWords.size > 0) {
      if (!state.graceTask) {
        state.graceTask = this.createTask(
          () => this._wordBoundariesGrace(contextId),
          `${this}::word_boundaries_grace`,
        );
      }
      return;
    }
    await this._closeContext(contextId);
  }

  protected async _wordBoundariesGrace(contextId: string): Promise<void> {
    await sleep(this._wordBoundariesGraceS);
    const state = this._contexts.get(contextId);
    if (state) {
      const awaiting = `{${[...state.awaitingWords].map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
      logger.debug(`${this}: no WordBoundaries for flushes ${awaiting}`);
      state.graceTask = null;
      await this._closeContext(contextId);
    }
  }

  /** Drop a context's bookkeeping, including WordBoundaries still due for it. */
  protected async _forgetContext(contextId: string): Promise<void> {
    const state = this._contexts.get(contextId);
    this._contexts.delete(contextId);
    if (state?.graceTask) {
      await this.cancelTask(state.graceTask);
    }
    this._wordContexts = new Map(
      [...this._wordContexts].filter(([, owner]) => owner !== contextId),
    );
  }

  protected async _closeContext(contextId: string): Promise<void> {
    await this._forgetContext(contextId);
    if (this.audioContextAvailable(contextId)) {
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    }
  }

  protected async _sendFlush(): Promise<void> {
    this._nextFlushId += 1;
    await this._send({ type: "Flush" });
  }

  /**
   * Conclude the turn's text so the context can close once it is spoken.
   *
   * In sentence aggregation each sentence is already flushed by `runTts`.
   * When streaming tokens, the turn's text is flushed here.
   *
   * @param contextId The context whose turn has ended.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const ctxId = contextId || this.getActiveAudioContextId();
    if (!ctxId) {
      return;
    }
    if (this._requests.get(this._nextFlushId) === ctxId) {
      try {
        await this._sendFlush();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: error sending Flush: ${errorMessage(e)}`);
      }
    }
    this._contextState(ctxId).turnDone = true;
    await this._maybeCloseContext(ctxId);
  }

  /**
   * Cancel the server's in-flight synthesis when the bot is interrupted.
   *
   * `Cancel` discards everything the server has not yet delivered and
   * keeps the session open, so the next response needs no reconnect.
   *
   * @param contextId The ID of the audio context that was interrupted.
   */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (this._requests.size > 0) {
      // Audio still in transit for these requests is dropped by flush_id.
      this._requests.clear();
      if (this._websocket && this._websocket.state === State.OPEN) {
        this._nextFlushId += 1;
        try {
          await this._send({ type: "Cancel" });
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: error sending Cancel: ${errorMessage(e)}`);
        }
      }
    }
    await this._forgetContext(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Forget a context's bookkeeping once it has finished playing.
   *
   * A context that goes quiet mid-turn ends on the base class's timeout and
   * is recreated when more audio arrives, with word times measured from its
   * new first audio, so its offset starts again from zero.
   *
   * @param contextId The ID of the audio context that finished playing.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await this._forgetContext(contextId);
    await super.onAudioContextCompleted(contextId);
  }

  // ------------------------------------------------------------------
  // Server messages
  // ------------------------------------------------------------------

  /**
   * Receive and dispatch server frames.
   *
   * Called by `WebsocketService._receiveTaskHandler`, which reconnects
   * when the session closes.
   */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let msg: Dict;
      try {
        msg = pyJsonLoads(text) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: invalid JSON message: ${text}`);
        continue;
      }

      const msgType = msg.type;
      if (msgType === "Audio") {
        await this._handleAudio(msg);
      } else if (msgType === "FlushDone") {
        await this._handleFlushDone(msg);
      } else if (msgType === "WordBoundaries") {
        await this._handleWordBoundaries(msg);
      } else if (msgType === "Begin") {
        this._handleBegin(msg);
      } else if (msgType === "Error") {
        await this._handleError(msg);
      } else {
        // The protocol may add frame types, which are safe to ignore.
        logger.trace(`${this}: unhandled message: ${pyJsonDumps(msg)}`);
      }
    }
  }

  protected _handleBegin(msg: Dict): void {
    const configuration: Dict = msg.configuration || {};
    const limits: Dict = configuration.limits || {};
    this._sessionId = msg.id ?? null;
    const expiresAt: number | undefined = msg.expires_at;
    if (expiresAt) {
      const margin = Math.min(_SESSION_RENEWAL_MARGIN_S, (expiresAt - time()) / 2);
      this._renewAt = expiresAt - margin;
    }
    this._maxGenerateChars = limits.max_generate_text_length || _MAX_GENERATE_CHARS;
    this._wordBoundaries = configuration.word_boundaries === true;
    logger.debug(`${this}: session ${this._sessionId} started: ${pyJsonDumps(configuration)}`);
  }

  protected async _handleAudio(msg: Dict): Promise<void> {
    const contextId = this._requests.get(msg.flush_id);
    if (!contextId || !this.audioContextAvailable(contextId)) {
      return;
    }
    const frame = new TTSAudioRawFrame({
      audio: base64ToBytes(msg.audio),
      sampleRate: this.sampleRate,
      numChannels: 1,
      contextId,
    });
    await this.appendToAudioContext(contextId, frame);
  }

  protected async _handleFlushDone(msg: Dict): Promise<void> {
    const flushId: number = msg.flush_id;
    const contextId = this._requests.get(flushId);
    this._requests.delete(flushId);
    if (!contextId) {
      return;
    }
    const state = this._contextState(contextId);
    const durationMs: number = msg.audio_duration_ms || 0;
    if (this._wordBoundaries && durationMs) {
      this._wordContexts.set(flushId, contextId);
      state.awaitingWords.set(flushId, state.audioMs);
    }
    state.audioMs += durationMs;
    await this._maybeCloseContext(contextId);
  }

  protected async _handleWordBoundaries(msg: Dict): Promise<void> {
    const flushId: number = msg.flush_id;
    const contextId = this._wordContexts.get(flushId);
    this._wordContexts.delete(flushId);
    const state = contextId ? this._contexts.get(contextId) : undefined;
    if (!contextId || !state?.awaitingWords.has(flushId)) {
      return;
    }

    // Word times are on the session's timeline; audio_start_ms is where
    // this request's audio starts on it.
    const offsetMs = (state.awaitingWords.get(flushId) as number) - msg.audio_start_ms;
    state.awaitingWords.delete(flushId);
    const words: Dict[] = msg.words ?? [];
    const wordTimes: [string, number][] = words.map((word) => [
      word.word,
      (offsetMs + word.start) / 1000.0,
    ]);
    if (wordTimes.length > 0) {
      await this.addWordTimestamps(wordTimes, contextId);
    }
    await this._maybeCloseContext(contextId);
  }

  /**
   * Report an Error frame. The server closes the session right after it.
   *
   * A refusal before `Begin` that isn't retryable is in the session's own
   * configuration (the credential, voice, model or a parameter), so it
   * leaves the service unusable. Retryable errors are retried by the
   * receive loop's reconnect, after any wait the server asks for, and
   * other errors after `Begin` concern the text sent.
   */
  protected async _handleError(msg: Dict): Promise<void> {
    const code = msg.error_code;
    const errorType = msg.error_type;
    const label = errorType ? `${code} ${errorType}` : `${code}`;
    const text = `AssemblyAI TTS error ${label}: ${msg.error ?? ""}`;

    let category: ErrorCategory;
    if (msg.retryable) {
      this._reconnectDelay = Number(msg.retry_after_seconds || 0);
      if (_ROUTINE_ERROR_TYPES.has(errorType)) {
        logger.debug(`${this}: ${text}`);
        return;
      }
      category = code === 3009 ? ErrorCategory.RATE_LIMIT : ErrorCategory.SERVER;
    } else if (this._sessionId === null) {
      category = code === 1008 ? ErrorCategory.AUTHENTICATION : ErrorCategory.INVALID_REQUEST;
    } else {
      category = ErrorCategory.UNKNOWN;
    }
    await this.pushError(text, { category });
  }

  // ------------------------------------------------------------------
  // TTS generation
  // ------------------------------------------------------------------

  /**
   * Send text to AssemblyAI for synthesis.
   *
   * Audio arrives on the receive task. In sentence aggregation each call is
   * flushed as its own request, since only a flush guarantees the server
   * speaks all of the text.
   *
   * @param text The text to synthesize.
   * @param contextId The audio context the text belongs to.
   * @returns An async generator yielding null, as audio arrives via the
   *   WebSocket receive task.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    if (this._reconnectInProgress) {
      // The receive loop owns the connection until it reconnects.
      yield new ErrorFrame({ error: "AssemblyAI TTS is reconnecting; text not spoken" });
      yield new TTSStoppedFrame({ contextId });
      return;
    }

    let failure: unknown = null;
    let failed = false;
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      } else {
        await this._renewSessionIfExpiring();
      }

      // Recorded before sending, so audio that arrives while the messages
      // are still being sent is attributed to this context.
      this._requests.set(this._nextFlushId, contextId);
      // Consecutive Generate texts are joined exactly as sent.
      const size = this._maxGenerateChars;
      const codePoints = Array.from(text);
      for (let start = 0; start < codePoints.length; start += size) {
        await this._send({
          type: "Generate",
          text: codePoints.slice(start, start + size).join(""),
        });
      }
      if (!this._isStreamingTokens) {
        await this._sendFlush();
      }

      await this.startTtsUsageMetrics(text);
    } catch (e) {
      rethrowIfCancelled(e);
      failed = true;
      failure = e;
    }

    if (failed) {
      yield new ErrorFrame({ error: `AssemblyAI TTS error: ${errorMessage(failure)}` });
      yield new TTSStoppedFrame({ contextId });
      await this._disconnect();
      await this._connect();
      return;
    }

    yield null;
  }
}
