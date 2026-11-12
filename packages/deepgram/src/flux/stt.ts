// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/flux/stt.py

/**
 * Deepgram Flux speech-to-text service implementation (WebSocket transport).
 *
 * Porting notes:
 * - Connects with the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`, sending the API key as the
 *   `Authorization: Token <key>` header on the opening handshake (Bun, Node
 *   and Deno; on Cloudflare Workers `websocketConnect` opens the socket through
 *   `fetch` so the header is sent there too).
 * - A standard `WebSocket` exposes neither the handshake's HTTP status nor its
 *   response headers, so the `dg-*` headers upstream logs on connect are not
 *   available, and `describeRefusal()` (in `../_errors.ts`) only finds Deepgram's `dg-error`
 *   reason when the error thrown by the connect (e.g. from a custom
 *   `webSocketFactory`) carries a `response` with `headers`.
 * - Deprecated APIs are not ported: `DeepgramFluxSTTService.InputParams` and
 *   the `model` and `params` constructor options.
 */

import { monotonic, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { ErrorFrame, type Frame } from "@pipedog/core/frames/frames";
import {
  State,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  WebsocketService,
  type WebsocketServiceOptions,
} from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { describeRefusal } from "../_errors.ts";
import {
  DeepgramFluxSTTBase,
  type DeepgramFluxSTTBaseOptions,
  DeepgramFluxSTTSettings,
  FluxEventType,
  FluxMessageType,
} from "./stt_base.ts";

// Re-export for backward compatibility
export { DeepgramFluxSTTSettings, FluxEventType, FluxMessageType };

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `type(x)` repr for a received message. */
function pyTypeRepr(message: unknown): string {
  if (message instanceof Uint8Array) return "<class 'bytes'>";
  return `<class '${typeof message}'>`;
}

export interface DeepgramFluxSTTServiceOptions
  extends Omit<DeepgramFluxSTTBaseOptions, "settings" | "encoding">,
    WebsocketServiceOptions {
  /** Deepgram API key for authentication. Required for API access. */
  apiKey: string;
  /**
   * WebSocket URL for the Deepgram Flux API. Defaults to Deepgram's Flux
   * endpoint, "wss://api.deepgram.com/v2/listen".
   */
  url?: string;
  /**
   * Audio encoding format required by Flux API. Must be "linear16". Raw
   * signed little-endian 16-bit PCM encoding.
   */
  fluxEncoding?: string;
  /** Runtime-updatable settings. */
  settings?: DeepgramFluxSTTSettings | null;
  /**
   * Creates the underlying `WebSocket`, to open it some other way (through a
   * proxy, say). Defaults to `websocketConnect`'s, which sends the header on
   * every runtime, Cloudflare Workers included. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Deepgram Flux speech-to-text service.
 *
 * Provides real-time speech recognition using Deepgram's WebSocket API with
 * Flux capabilities. Supports configurable models, VAD events, and various
 * audio processing options including advanced turn detection and
 * EagerEndOfTurn events for improved conversational AI performance.
 *
 * The transcript of a turn in progress is pushed as an
 * `InterimTranscriptionFrame` on every Flux update, and the final transcript
 * as a `TranscriptionFrame` at the end of the turn.
 *
 * For multilingual use, set `model: "flux-general-multi"` and pass
 * `languageHints` to bias detection toward specific languages. Hints can be
 * updated mid-stream via `STTUpdateSettingsFrame` (e.g. to implement a
 * detect-then-lock flow). `TranscriptionFrame.language` reflects whichever
 * language Flux detected for each turn.
 *
 * Event handlers available (in addition to base events):
 *
 * - on_start_of_turn(service, transcript): Deepgram detected start of speech
 * - on_end_of_turn(service, transcript): Deepgram detected end of turn (EOT)
 * - on_eager_end_of_turn(service, transcript): Deepgram predicted end of turn
 *   (EagerEOT)
 * - on_turn_resumed(service): User resumed speaking after EagerEOT
 *
 * @example
 * stt.addEventHandler("on_end_of_turn", async (service, transcript: string) => {
 *   // ...
 * });
 */
export class DeepgramFluxSTTService extends WebsocketService(DeepgramFluxSTTBase) {
  static override Settings: typeof DeepgramFluxSTTSettings = DeepgramFluxSTTSettings;
  declare protected _settings: DeepgramFluxSTTSettings;

  protected _apiKey: string;
  protected _url: string;
  protected _websocketUrl: string | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];

  /**
   * Initialize the Deepgram Flux STT service.
   *
   * @param options.apiKey Deepgram API key for authentication. Required for
   *   API access.
   * @param options.url WebSocket URL for the Deepgram Flux API. Defaults to
   *   Deepgram's Flux endpoint, "wss://api.deepgram.com/v2/listen".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program.
   * @param options.fluxEncoding Audio encoding format required by Flux API.
   *   Must be "linear16". Raw signed little-endian 16-bit PCM encoding.
   * @param options.tag Tags to label requests for identification during
   *   usage reporting.
   * @param options.shouldInterrupt Whether to interrupt the bot when Flux
   *   detects that the user is speaking. Passed along to the user turn
   *   strategies this service recommends, which own the interruption; a
   *   user-supplied `userTurnStrategies` overrides the recommendation and
   *   this setting with it.
   * @param options.watchdogMinTimeout Minimum silence duration in seconds
   *   before the watchdog sends silence to prevent dangling turns. Defaults
   *   to 0.5.
   * @param options.enableEagerEndOfTurn Whether to answer Flux's predicted
   *   end of turn ahead of the committed one, so the gap between the two is
   *   spent generating a response rather than waiting. The response is
   *   discarded if the user resumes speaking or the committed transcript
   *   differs from the predicted one. Off by default: it spends an inference
   *   on every prediction, including the ones Flux withdraws. Turning it on
   *   sets `eagerEotThreshold` to 0.5 when the settings leave it unset, since
   *   Flux reports no prediction without it.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent classes.
   *
   * @example
   * // Basic usage with default parameters
   * const stt = new DeepgramFluxSTTService({ apiKey: "your-api-key" });
   *
   * @example
   * // Advanced usage with custom parameters
   * const stt = new DeepgramFluxSTTService({
   *   apiKey: "your-api-key",
   *   tag: ["production", "voice-agent"],
   *   settings: new DeepgramFluxSTTService.Settings({
   *     model: "flux-general-en",
   *     eagerEotThreshold: 0.5,
   *     eotThreshold: 0.8,
   *     keyterm: ["AI", "machine learning", "neural network"],
   *   }),
   * });
   *
   * @example
   * // Multilingual usage with language hints
   * const stt = new DeepgramFluxSTTService({
   *   apiKey: "your-api-key",
   *   settings: new DeepgramFluxSTTService.Settings({
   *     model: "flux-general-multi",
   *     languageHints: [Language.EN, Language.ES],
   *   }),
   * });
   */
  constructor(options: DeepgramFluxSTTServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof DeepgramFluxSTTService).Settings({
      model: "flux-general-en",
      language: null,
      eagerEotThreshold: null,
      eotThreshold: null,
      eotTimeoutMs: null,
      keyterm: [],
      minConfidence: null,
      numerals: null,
      profanityFilter: null,
      redact: null,
      languageHints: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const baseOptions: DeepgramFluxSTTBaseOptions & WebsocketServiceOptions = {
      ...options,
      encoding: options.fluxEncoding ?? "linear16",
      settings: defaultSettings,
      sampleRate: options.sampleRate ?? null,
    };
    super(baseOptions);

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.deepgram.com/v2/listen";
    this._webSocketFactory = options.webSocketFactory ?? null;
  }

  /** TTFS doesn't apply: Flux defines turn boundaries directly. */
  override get supportsTtfs(): boolean {
    return false;
  }

  // ------------------------------------------------------------------
  // Transport interface implementation
  // ------------------------------------------------------------------

  override async _transportSendAudio(audio: Uint8Array): Promise<void> {
    if (this._websocket === null) {
      // should never happen — caller should gate on _transportIsActive()
      return;
    }
    await this._websocket.send(audio);
  }

  override async _transportSendJson(message: Dict): Promise<void> {
    if (this._websocket === null) {
      // should never happen — caller should gate on _transportIsActive()
      return;
    }
    await this._websocket.send(pyJsonDumps(message));
  }

  override _transportIsActive(): boolean {
    return this._websocket !== null && this._websocket.state === State.OPEN;
  }

  // ------------------------------------------------------------------
  // Connection management
  // ------------------------------------------------------------------

  /**
   * Connect to WebSocket and start the receive loop.
   *
   * The receive loop starts even when the connection fails: with no socket
   * it goes straight to its reconnect path, which retries the connect. It
   * owns reconnection for the session, so audio is never held up waiting on
   * a connection.
   */
  override async _connect(): Promise<void> {
    // `DeepgramFluxSTTBase._connect` is abstract, so this reaches the
    // websocket side (`WebsocketService._connect`).
    await super._connect();
    this._websocketUrl = `${this._url}?${this._buildQueryString()}`;
    await this._connectWebsocket();
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Stop the receive loop and watchdog, then close the connection. */
  override async _disconnect(): Promise<void> {
    // Marks the disconnect as intentional, so the receive loop doesn't
    // reconnect as it winds down.
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask, 2.0);
      this._receiveTask = null;
    }
    if (this._watchdogTask) {
      await this.cancelTask(this._watchdogTask, 2.0);
      this._watchdogTask = null;
      this._lastSttTime = null;
    }

    await this._disconnectWebsocket();
  }

  /**
   * Open the WebSocket to Deepgram Flux.
   *
   * Flux confirms the connection with a `Connected` message, which the
   * receive loop waits for (see `_receiveMessages`).
   */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      this._connectionEstablishedEvent.clear();
      this._userIsSpeaking = false;
      // `_connect` sets `_websocketUrl` before calling us.
      if (this._websocketUrl === null) {
        throw new Error("AssertionError: _websocketUrl must be set");
      }
      this._websocket = await this._websocketConnect(this._websocketUrl, {
        additionalHeaders: { Authorization: `Token ${this._apiKey}` },
        webSocketFactory: this._webSocketFactory,
      });

      logger.debug(`${this}: Websocket connection initialized`);
    } catch (e) {
      rethrowIfCancelled(e);
      const refusal = describeRefusal(e);
      await this.pushError(refusal ?? `Unknown error occurred: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", refusal ?? `${errorMessage(e)}`);
    }
  }

  /**
   * Close the WebSocket connection and reset connection state.
   *
   * Called on its own by the receive loop when it reconnects, so it leaves
   * the receive loop and watchdog running.
   */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      this._connectionEstablishedEvent.clear();
      // Discard any in-flight/pending Configure — the connection is going
      // away (including ahead of a reconnect), so it can no longer be acked
      // or sent; a reconnect re-applies settings via the URL.
      this._resetConfigureState();
      await this.stopAllMetrics();

      if (this._websocket) {
        await this._sendCloseStream();
        logger.debug(`${this}: Disconnecting from Deepgram Flux Websocket`);
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  // ------------------------------------------------------------------
  // Audio sending and receiving
  // ------------------------------------------------------------------

  /**
   * Send audio data to Deepgram Flux for transcription.
   *
   * Transmits raw audio bytes to the Deepgram Flux API for real-time speech
   * recognition. Transcription results are received asynchronously through
   * WebSocket callbacks and processed in the background.
   *
   * Audio that arrives while the connection is down is dropped; the receive
   * loop reconnects in the background.
   *
   * @param audio Raw audio bytes in linear16 format (signed little-endian
   *   16-bit PCM).
   * @returns null (transcription results are delivered via WebSocket
   *   callbacks rather than as return values from this method), or an
   *   ErrorFrame on send failure.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._transportIsActive()) {
      try {
        this._lastSttTime = monotonic();
        this._lastAudioChunkDuration = audio.length / (this.sampleRate * 2);
        await this._transportSendAudio(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        return;
      }
    }

    yield null;
  }

  /**
   * Get the current WebSocket connection.
   *
   * Returns the active WebSocket connection instance, raising an exception
   * if no connection is currently established.
   *
   * @returns The active WebSocket connection instance.
   * @throws Error if no WebSocket connection is currently active.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Receive and process messages from WebSocket.
   *
   * Waits for Flux to confirm the connection with `Connected`, then
   * processes connection status, transcription results, turn information and
   * errors, including StartOfTurn, EndOfTurn, EagerEndOfTurn and Update
   * events.
   *
   * @throws ConnectionError if `Connected` doesn't arrive within
   *   `_CONNECTION_TIMEOUT`. Flux refuses unsupported settings with an HTTP
   *   400 during the handshake, so a connection that opens but never confirms
   *   is retried like a dropped one.
   */
  override async _receiveMessages(): Promise<void> {
    const messages = this._getWebsocket()[Symbol.asyncIterator]();
    if (
      !(await this._receiveUntilConfirmed(
        messages,
        this._connectionEstablishedEvent,
        (message) => this._processMessage(message),
        this._cls._CONNECTION_TIMEOUT,
      ))
    ) {
      // Closed before confirming; the receive loop treats it as a drop.
      return;
    }

    await this._callEventHandler("on_connected");
    // The watchdog stops when its connection closes, so each confirmed
    // connection gets a new one.
    if (!this._watchdogTask || this._watchdogTask.done()) {
      this._watchdogTask = this.createTask(() => this._watchdogTaskHandler());
    }

    try {
      while (true) {
        const next = await messages.next();
        if (next.done) break;
        await this._processMessage(next.value);
      }
    } finally {
      // A turn lives in one connection, so it ends when the connection does,
      // unless the service is stopping.
      if (!this._disconnecting) {
        await this._endTurnCutShort();
      }
    }
  }

  /** Decode and handle one message from the WebSocket. */
  protected async _processMessage(message: string | Uint8Array): Promise<void> {
    if (typeof message !== "string") {
      logger.warning(`Received non-string message: ${pyTypeRepr(message)}`);
      return;
    }
    let data: unknown;
    try {
      data = pyJsonLoads(message);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to decode JSON message: ${errorMessage(e)}`);
      return;
    }
    try {
      await this._handleMessage(data);
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      // Error will be handled inside WebsocketService._receiveTaskHandler
      throw e;
    }
  }

  protected async _reportError(
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> {
    await this._callEventHandler("on_connection_error", error.error);
    await this.pushErrorFrame(error, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  }
}
