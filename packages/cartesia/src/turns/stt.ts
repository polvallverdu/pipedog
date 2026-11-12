// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/cartesia/turns/stt.py

/**
 * Cartesia Ink-2 Streaming ASR (v2 turn-based) speech-to-text service.
 *
 * Porting notes: the socket is the global `WebSocket`, opened through
 * `WebsocketService._websocketConnect()`. The `X-API-Key` header is sent on
 * the opening handshake, which the Bun, Node and Deno `WebSocket` support.
 */

import {
  Event,
  monotonic,
  rethrowIfCancelled,
  shield,
  sleep,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import {
  type CancelFrame,
  type EndFrame,
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  type STTMetadataFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  EagerEndOfTurnSTTServiceMixin,
  type EagerEndOfTurnSTTServiceMixinOptions,
} from "@pipedog/core/turns/eager_end_of_turn_mixin";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { _prepareKeyterms, _urlencode } from "../stt.ts";

// Upstream `dict[str, Any]`: Cartesia JSON payloads are genuinely dynamic.
type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `dict.get(key, default)`: the default only when the key is missing. */
function dictGet(data: Dict, key: string, dflt: unknown = null): any {
  return Object.hasOwn(data, key) ? data[key] : dflt;
}

// Connection-bound turn detection query parameters, named as Cartesia
// documents them, with the settings field that holds each. A change to any of
// them is applied by reconnecting.
const _TURN_DETECTION_FIELDS = [
  ["turn_start_threshold", "turnStartThreshold"],
  ["turn_eager_end_threshold", "turnEagerEndThreshold"],
  ["turn_end_threshold", "turnEndThreshold"],
  ["turn_end_timeout_ms", "turnEndTimeoutMs"],
] as const;

/**
 * Cartesia Ink-2 ASR rejected a connection's settings.
 *
 * Carries the HTTP status code the server reports with the error, so the
 * error is classified like a rejected HTTP request.
 */
export class CartesiaTurnsRequestError extends Error {
  override name = "CartesiaTurnsRequestError";
  /** The HTTP status code the server reported, if any. */
  readonly statusCode: number | null;

  /**
   * Initialize the error.
   *
   * @param message The error message.
   * @param statusCode The HTTP status code the server reported, if any.
   */
  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface CartesiaTurnsSTTSettingsOptions extends STTSettingsOptions {
  /**
   * Key terms or phrases to bias transcription towards, sent as repeated
   * `keyterm` query parameters on the connection URL. Cartesia binds
   * keyterms to a connection, so updating this setting at runtime triggers a
   * reconnect. See https://docs.cartesia.ai/use-the-api/stt/keyterms.
   */
  keyterm?: string[] | null | NotGiven;
  /** Likelihood above which the server emits `turn.start`. 0.5–0.9; Cartesia defaults to 0.8. */
  turnStartThreshold?: number | null | NotGiven;
  /** Likelihood below which the server emits `turn.eager_end`. 0.3–0.8; Cartesia defaults to 0.6. */
  turnEagerEndThreshold?: number | null | NotGiven;
  /** Likelihood below which the server emits `turn.end`. 0.05–0.5; Cartesia defaults to 0.3. */
  turnEndThreshold?: number | null | NotGiven;
  /**
   * Milliseconds to wait after the user stops speaking before emitting
   * `turn.end`. 640–11200; Cartesia defaults to 5600.
   */
  turnEndTimeoutMs?: number | null | NotGiven;
}

/**
 * Settings for CartesiaTurnsSTTService.
 *
 * The ink-2 model family is English-only and does not support runtime model
 * or language switching.
 *
 * The four `turn*` fields tune server-side turn detection. Cartesia binds
 * them to a connection, so updating any of them at runtime triggers a
 * reconnect, and requires the three thresholds to stay in order:
 * `turnStartThreshold` > `turnEagerEndThreshold` > `turnEndThreshold`. See
 * https://docs.cartesia.ai/use-the-api/stt/turns for the Balanced,
 * Responsive and Patient starting profiles.
 *
 * - `keyterm`: key terms or phrases to bias transcription towards, sent as
 *   repeated `keyterm` query parameters on the connection URL. Cartesia
 *   binds keyterms to a connection, so updating this setting at runtime
 *   triggers a reconnect. See
 *   https://docs.cartesia.ai/use-the-api/stt/keyterms.
 * - `turnStartThreshold`: likelihood above which the server emits
 *   `turn.start`. 0.5–0.9; Cartesia defaults to 0.8.
 * - `turnEagerEndThreshold`: likelihood below which the server emits
 *   `turn.eager_end`. 0.3–0.8; Cartesia defaults to 0.6.
 * - `turnEndThreshold`: likelihood below which the server emits `turn.end`.
 *   0.05–0.5; Cartesia defaults to 0.3.
 * - `turnEndTimeoutMs`: milliseconds to wait after the user stops speaking
 *   before emitting `turn.end`. 640–11200; Cartesia defaults to 5600.
 */
export class CartesiaTurnsSTTSettings extends STTSettings {
  keyterm: string[] | null | NotGiven = NOT_GIVEN;
  turnStartThreshold: number | null | NotGiven = NOT_GIVEN;
  turnEagerEndThreshold: number | null | NotGiven = NOT_GIVEN;
  turnEndThreshold: number | null | NotGiven = NOT_GIVEN;
  turnEndTimeoutMs: number | null | NotGiven = NOT_GIVEN;

  constructor(options: CartesiaTurnsSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface CartesiaTurnsSTTServiceOptions
  extends WebsocketSTTServiceOptions,
    EagerEndOfTurnSTTServiceMixinOptions {
  /** Cartesia API key. */
  apiKey: string;
  /** WebSocket URL for the Cartesia Streaming ASR v2 endpoint. */
  url?: string;
  /**
   * Whether to interrupt the bot when the server signals the start of a new
   * turn. Passed along to the user turn strategies this service recommends,
   * which own the interruption; a user-supplied `userTurnStrategies`
   * overrides the recommendation and this setting with it.
   */
  shouldInterrupt?: boolean;
  /**
   * Minimum idle timeout before sending silence to prevent dangling turns.
   * The actual threshold is `max(chunkDuration * 2, watchdogMinTimeout)`.
   * Defaults to 0.5.
   */
  watchdogMinTimeout?: number;
  /** Optional additional HTTP headers to send with the WebSocket handshake. */
  extraHeaders?: Record<string, string> | null;
  /**
   * Runtime-updatable settings. The ink-2 family does not support runtime
   * model or language switching; attempts to update either field will be
   * reported as unhandled.
   */
  settings?: CartesiaTurnsSTTSettings | null;
}

/**
 * Speech-to-text service using the Cartesia Streaming ASR v2 (Ink-2) API.
 *
 * Speaks the v2 turn-based wire protocol exposed by `/stt/turns/websocket`.
 * The server drives the conversation:
 *
 *     connected -> turn.start -> turn.update* -> (turn.eager_end -> turn.resume?)*
 *                             -> turn.end -> ...
 *
 * Transcripts are cumulative per turn; there is no `is_final` flag and no
 * `finalize` command — closing the socket ends the session.
 *
 * Each `turn.start` pushes a `ProposedUserStartedSpeakingFrame`; each
 * `turn.update` pushes an `InterimTranscriptionFrame`; `turn.end` pushes a
 * final `TranscriptionFrame` followed by a `ProposedUserStoppedSpeakingFrame`.
 * `turn.eager_end` pushes an `EagerTranscriptionFrame` and `turn.resume` a
 * `UserTurnResponseCancelFrame`, which `EagerUserTurnStrategies` uses to answer
 * a predicted end of turn ahead of the committed one.
 *
 * Event handlers available (in addition to the base `on_connected` /
 * `on_disconnected` / `on_connection_error`):
 *
 * - on_turn_start(service, transcript): server detected start of a turn
 * - on_turn_update(service, transcript): incremental transcript update
 * - on_turn_eager_end(service, transcript): server eagerly predicted end of turn
 * - on_turn_resume(service): user resumed speaking after an eager end
 * - on_turn_end(service, transcript): final transcript for the completed turn
 *
 * @example
 * stt.addEventHandler("on_turn_end", async (service: CartesiaTurnsSTTService, transcript: string) => {
 *   // ...
 * });
 */
export class CartesiaTurnsSTTService extends EagerEndOfTurnSTTServiceMixin(WebsocketSTTService) {
  static Settings: typeof CartesiaTurnsSTTSettings = CartesiaTurnsSTTSettings;
  declare protected _settings: CartesiaTurnsSTTSettings;

  static {
    installTracedStt(CartesiaTurnsSTTService.prototype, "_handleTranscription");
  }

  /**
   * How long to wait for the server's `connected` frame after the handshake
   * before treating the connection as failed.
   */
  static _CONNECTION_TIMEOUT = 10.0;

  protected _apiKey: string;
  protected _url: string;
  protected _shouldInterrupt: boolean;
  protected _watchdogMinTimeout: number;
  protected _extraHeaders: Record<string, string>;
  // ink-2 is English-only at launch; language on emitted frames is fixed.
  protected _language: Language;

  protected _requestId: string | null = null;
  protected _receiveTask: Task<unknown> | null = null;
  protected _connectionEstablishedEvent = new Event();

  // Watchdog state — see _watchdogTaskHandler for details.
  protected _lastSttTime: number | null = null;
  protected _watchdogTask: Task<unknown> | null = null;
  protected _userIsSpeaking = false;
  protected _lastAudioChunkDuration = 0.0;
  // The transcript of the turn in progress, pushed if its connection closes
  // before turn.end.
  protected _turnTranscript = "";

  /**
   * Initialize the Cartesia Ink-2 STT service.
   *
   * @param options.apiKey Cartesia API key.
   * @param options.url WebSocket URL for the Cartesia Streaming ASR v2
   *   endpoint.
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline sample rate.
   * @param options.shouldInterrupt Whether to interrupt the bot when the
   *   server signals the start of a new turn. Passed along to the user turn
   *   strategies this service recommends, which own the interruption; a
   *   user-supplied `userTurnStrategies` overrides the recommendation and
   *   this setting with it.
   * @param options.watchdogMinTimeout Minimum idle timeout before sending
   *   silence to prevent dangling turns. The actual threshold is
   *   `max(chunkDuration * 2, watchdogMinTimeout)`. Defaults to 0.5.
   * @param options.enableEagerEndOfTurn Whether to answer the server's
   *   predicted end of turn (`turn.eager_end`) ahead of the committed one, so
   *   the gap between the two is spent generating a response rather than
   *   waiting. The response is discarded if the user resumes speaking or the
   *   committed transcript differs from the predicted one. Off by default: it
   *   spends an inference on every prediction, including the ones the server
   *   withdraws.
   * @param options.extraHeaders Optional additional HTTP headers to send with
   *   the WebSocket handshake.
   * @param options.settings Runtime-updatable settings. The ink-2 family does
   *   not support runtime model or language switching; attempts to update
   *   either field will be reported as unhandled.
   *   Other options are passed to the parent WebsocketSTTService.
   */
  constructor(options: CartesiaTurnsSTTServiceOptions) {
    // ink-2 is English-only at launch.
    const defaultSettings = new (new.target as typeof CartesiaTurnsSTTService).Settings({
      model: "ink-2",
      language: null,
      keyterm: null,
      // Left unset so the server applies its own turn detection defaults.
      turnStartThreshold: null,
      turnEagerEndThreshold: null,
      turnEndThreshold: null,
      turnEndTimeoutMs: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // The mixin reads enableEagerEndOfTurn from the same options object.
    const superOptions: CartesiaTurnsSTTServiceOptions = {
      ...options,
      sampleRate: options.sampleRate ?? null,
      enableEagerEndOfTurn: options.enableEagerEndOfTurn ?? false,
      settings: defaultSettings,
    };
    super(superOptions);

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.cartesia.ai/stt/turns/websocket";
    this._shouldInterrupt = options.shouldInterrupt ?? true;
    this._watchdogMinTimeout = options.watchdogMinTimeout ?? 0.5;
    this._extraHeaders = options.extraHeaders ? { ...options.extraHeaders } : {};
    // ink-2 is English-only at launch; language on emitted frames is fixed.
    this._language = Language.EN;

    this._registerEventHandler("on_turn_start");
    this._registerEventHandler("on_turn_update");
    this._registerEventHandler("on_turn_eager_end");
    this._registerEventHandler("on_turn_resume");
    this._registerEventHandler("on_turn_end");
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Cartesia Ink-2 service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** TTFS doesn't apply: the server defines turn boundaries directly. */
  override get supportsTtfs(): boolean {
    return false;
  }

  /**
   * Recommend turn strategies that leave turn detection to the server.
   *
   * Cartesia's turn-detection STT defines turn boundaries on the server and
   * emits `ProposedUserStarted/StoppedSpeakingFrame`, so the user aggregator
   * resolves those rather than running local VAD/smart-turn. With
   * `enableEagerEndOfTurn`, the recommendation also answers the server's
   * predicted end of turn. Applied unless the user passed their own
   * `userTurnStrategies`.
   */
  override serviceMetadataFrame(): STTMetadataFrame {
    const frame = super.serviceMetadataFrame();
    frame.userTurnStrategies = this.recommendedUserTurnStrategies({
      enableInterruptions: this._shouldInterrupt,
    });
    return frame;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

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
   * Stop the STT service and close the WebSocket connection.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the STT service and close the WebSocket connection.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  /**
   * Apply a settings delta.
   *
   * Keyterms and the turn detection thresholds are bound to a connection, so
   * a change to any of them is applied by reconnecting. Ink-2 does not
   * support runtime model or language switching, so those changes are
   * reported as unhandled.
   *
   * @param delta An STTSettings (or CartesiaTurnsSTTSettings) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    const connectionBound = new Set<string>([
      "keyterm",
      ..._TURN_DETECTION_FIELDS.map(([, field]) => field),
    ]);
    const changedKeys = Object.keys(changed);
    this._warnUnhandledUpdatedSettings(changedKeys.filter((key) => !connectionBound.has(key)));

    if (changedKeys.some((key) => connectionBound.has(key))) {
      await this._requestReconnect();
    }

    return changed;
  }

  // ------------------------------------------------------------------
  // Connection management
  // ------------------------------------------------------------------

  /**
   * Connect to the WebSocket and start the receive loop.
   *
   * The receive loop starts even when the connection fails: with no socket it
   * goes straight to its reconnect path, which retries the connect. It owns
   * reconnection for the session, so audio is never held up waiting on a
   * connection.
   */
  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Close the session, letting the server flush pending turn responses first. */
  override async _disconnect(): Promise<void> {
    // Marks the disconnect as intentional, so the receive loop doesn't
    // reconnect as it winds down.
    await super._disconnect();
    try {
      // Cancel the watchdog before sending close so it doesn't keep
      // injecting silence during the drain.
      if (this._watchdogTask) {
        await this.cancelTask(this._watchdogTask, 1.0);
        this._watchdogTask = null;
      }

      // Send close so the server can flush any pending turn responses
      // before it tears the socket down from its side.
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug("Sending close command to Cartesia Ink-2 ASR");
        try {
          await this._websocket.send(pyJsonDumps({ type: "close" }));
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Failed to send close command: ${errorMessage(e)}`);
        }
      }

      // Wait for the receive loop to exit as the server drains responses
      // and closes the socket. Fall back to cancellation if it doesn't
      // complete in time.
      if (this._receiveTask) {
        const receiveTask = this._receiveTask;
        try {
          await waitFor(() => shield(receiveTask), 2.0);
        } catch (e) {
          if (e instanceof TimeoutError) {
            logger.debug("Timed out waiting for server to close; cancelling receive task");
            await this.cancelTask(receiveTask, 1.0);
          } else {
            rethrowIfCancelled(e);
            // Receive task already errored; cancelTask is a no-op on done tasks.
            await this.cancelTask(receiveTask, 1.0);
          }
        }
        this._receiveTask = null;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    }

    await this._disconnectWebsocket();
  }

  protected _websocketUrl(): string {
    // Pipecat pipes 16-bit signed little-endian PCM through the pipeline, so
    // the wire encoding is fixed.
    const params: [string, string][] = [
      ["model", String(this._settings.model)],
      ["encoding", "pcm_s16le"],
      ["sample_rate", String(this.sampleRate)],
    ];
    for (const [name, field] of _TURN_DETECTION_FIELDS) {
      const value = this._settings[field];
      if (isGiven(value) && value !== null) {
        params.push([name, String(value)]);
      }
    }
    for (const term of _prepareKeyterms(this._settings.keyterm)) {
      params.push(["keyterm", term]);
    }
    // Cartesia expects spaces inside a keyterm as %20, which urlencode only
    // emits with quote_via=quote.
    return `${this._url}?${_urlencode(params)}`;
  }

  /**
   * Open the v2 WebSocket.
   *
   * The server confirms the connection with a `connected` frame, which the
   * receive loop waits for (see `_receiveMessages`).
   */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      this._connectionEstablishedEvent.clear();
      this._requestId = null;
      this._userIsSpeaking = false;
      this._lastSttTime = null;

      const headers: Record<string, string> = {
        "X-API-Key": this._apiKey,
        "Cartesia-Version": "2026-03-01",
        ...this._extraHeaders,
      };
      logger.debug(`Connecting to Cartesia Ink-2 ASR: ${this._websocketUrl()}`);
      this._websocket = await this._websocketConnect(this._websocketUrl(), {
        additionalHeaders: headers,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  /**
   * Close the WebSocket and reset connection state.
   *
   * Called on its own by the receive loop when it reconnects, so it leaves
   * the receive loop and watchdog running.
   */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      this._connectionEstablishedEvent.clear();
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug(`${this}: Disconnecting from Cartesia Ink-2 ASR`);
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

  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  // ------------------------------------------------------------------
  // Audio send / receive
  // ------------------------------------------------------------------

  /**
   * Forward raw PCM audio to the server.
   *
   * Transcription results are delivered asynchronously via the receive task
   * and are not yielded from this method.
   *
   * Audio that arrives while the connection is down is dropped; the receive
   * loop reconnects in the background. The server takes audio as soon as the
   * socket opens, ahead of its `connected` frame.
   *
   * @param audio Raw 16-bit signed little-endian PCM audio bytes.
   * @returns null (transcription results are pushed by the receive task), or
   *   an ErrorFrame on send failure.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      try {
        this._lastSttTime = monotonic();
        this._lastAudioChunkDuration = audio.length / (this.sampleRate * 2);
        await this._websocket.send(audio);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Cartesia Ink-2 ASR send error: ${errorMessage(e)}` });
        return;
      }
    }
    yield null;
  }

  /** Send a block of 16-bit PCM mono silence of the specified duration. */
  protected async _sendSilence(durationSecs = 0.5): Promise<void> {
    const sampleWidth = 2; // bytes per sample for 16-bit PCM
    const numChannels = 1; // mono
    const numSamples = Math.trunc(this.sampleRate * durationSecs);
    const silence = new Uint8Array(numSamples * sampleWidth * numChannels);
    await this._getWebsocket().send(silence);
    // Watchdog silence is real audio submitted to the service, so it counts
    // toward usage.
    this._recordSttAudioUsage(silence);
  }

  /**
   * Prevent dangling turns by sending silence when audio stops flowing.
   *
   * If we stop sending audio after a `turn.start`, the server never emits
   * `turn.end` unless we resume sending audio.
   */
  protected async _watchdogTaskHandler(): Promise<void> {
    while (this._websocket && this._websocket.state === State.OPEN) {
      const now = monotonic();
      // Send silence if we go more than watchdogMinTimeout (or twice the
      // chunk size, whichever is larger) without sending new audio.
      const threshold = Math.max(this._lastAudioChunkDuration * 2, this._watchdogMinTimeout);
      if (this._userIsSpeaking && this._lastSttTime) {
        const elapsed = now - this._lastSttTime;
        if (elapsed > threshold) {
          logger.warning(
            `No audio received for ${(elapsed * 1000).toFixed(0)} ms. ` +
              "Sending silence to Cartesia to prevent a dangling turn",
          );
          try {
            await this._sendSilence(elapsed);
          } catch (e) {
            rethrowIfCancelled(e);
            logger.warning(`Failed to send silence: ${errorMessage(e)}`);
          }
          this._lastSttTime = monotonic();
        }
      }
      await sleep(0.1);
    }
  }

  /**
   * Receive and process messages from the WebSocket.
   *
   * Waits for the server to confirm the connection with `connected`, then
   * processes turn events and errors.
   *
   * @throws Error (Python's `ConnectionError`) if `connected` doesn't arrive
   *   within `_CONNECTION_TIMEOUT`.
   * @throws CartesiaTurnsRequestError if the server rejects the connection's
   *   settings.
   */
  override async _receiveMessages(): Promise<void> {
    const messages = this._getWebsocket()[Symbol.asyncIterator]();
    if (
      !(await this._receiveUntilConfirmed(
        messages,
        this._connectionEstablishedEvent,
        (message) => this._processMessage(message),
        (this.constructor as typeof CartesiaTurnsSTTService)._CONNECTION_TIMEOUT,
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
      logger.warning(`Received non-text message: ${message.constructor.name}`);
      return;
    }
    let data: unknown;
    try {
      data = pyJsonLoads(message);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.exception("Failed to decode JSON message", e);
      return;
    }
    try {
      await this._handleMessage(data);
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      // Re-raise so the receive loop handles it: it reconnects, unless the
      // error left the service unusable.
      throw e;
    }
  }

  /**
   * End a turn whose connection closed before the server sent turn.end.
   *
   * A turn lives in one connection, so a new connection never ends the old
   * one's turn. The transcript received so far is pushed as the turn's
   * transcription, unfinalized since the server never committed it, and the
   * turn stop is proposed. If the user keeps talking on a new connection, the
   * rest is transcribed as a new turn.
   */
  protected async _endTurnCutShort(): Promise<void> {
    if (!this._userIsSpeaking) {
      return;
    }
    logger.debug(`${this}: connection closed mid-turn, ending the turn`);
    this._userIsSpeaking = false;
    this._clearEagerEndOfTurn();
    const transcript = this._turnTranscript;
    this._turnTranscript = "";
    if (transcript) {
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: this._language,
        }),
      );
    }
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | null = null,
  ): Promise<void> {}

  // ------------------------------------------------------------------
  // Message dispatch
  // ------------------------------------------------------------------

  protected async _handleMessage(data: unknown): Promise<void> {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      logger.warning("Received non-dict message");
      return;
    }
    const msg = data as Dict;

    const messageType = dictGet(msg, "type");
    if (!messageType) {
      logger.warning("Message missing 'type' field");
      return;
    }

    if (messageType === "connected") {
      await this._handleConnected(msg);
    } else if (messageType === "turn.start") {
      await this._handleTurnStart(msg);
    } else if (messageType === "turn.update") {
      await this._handleTurnUpdate(msg);
    } else if (messageType === "turn.eager_end") {
      await this._handleTurnEagerEnd(msg);
    } else if (messageType === "turn.resume") {
      await this._handleTurnResume(msg);
    } else if (messageType === "turn.end") {
      await this._handleTurnEnd(msg);
    } else if (messageType === "error") {
      await this._handleServerError(msg);
    } else {
      logger.debug(`Unhandled message type: ${messageType}`);
    }
  }

  protected async _handleConnected(data: Dict): Promise<void> {
    this._requestId = dictGet(data, "request_id");
    logger.info(`Cartesia Ink-2 ASR connected (request_id=${this._requestId ?? "None"})`);
    this._connectionEstablishedEvent.set();
  }

  protected async _handleTurnStart(data: Dict): Promise<void> {
    const transcript: string = dictGet(data, "transcript", "");
    logger.debug("Cartesia Ink-2 ASR turn.start");
    this._userIsSpeaking = true;
    this._turnTranscript = transcript;
    await this.broadcastFrame(ProposedUserStartedSpeakingFrame);
    await this._callEventHandler("on_turn_start", transcript);
  }

  protected async _handleTurnUpdate(data: Dict): Promise<void> {
    const transcript: string = dictGet(data, "transcript", "");
    if (transcript) {
      logger.trace(`Cartesia Ink-2 ASR turn.update: ${transcript}`);
      this._turnTranscript = transcript;
      await this.pushFrame(
        new InterimTranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: this._language,
          result: data,
        }),
      );
    }
    await this._callEventHandler("on_turn_update", transcript);
  }

  /**
   * Handle an eagerly predicted end of turn.
   *
   * The prediction may be withdrawn by `turn.resume`, and the transcript
   * committed by `turn.end` may differ from this one. Pair the service with
   * `EagerUserTurnStrategies` to have a response generated here and
   * discarded if either happens.
   */
  protected async _handleTurnEagerEnd(data: Dict): Promise<void> {
    const transcript: string = dictGet(data, "transcript", "");
    await this._pushEagerEndOfTurn(transcript, {
      userId: this._userId,
      language: this._language,
      result: data,
    });
    await this._callEventHandler("on_turn_eager_end", transcript);
  }

  /** Handle the user resuming a turn that was eagerly predicted to have ended. */
  protected async _handleTurnResume(_data: Dict): Promise<void> {
    logger.trace("Cartesia Ink-2 ASR turn.resume");
    await this._cancelEagerEndOfTurn();
    await this._callEventHandler("on_turn_resume");
  }

  protected async _handleTurnEnd(data: Dict): Promise<void> {
    const transcript: string = dictGet(data, "transcript", "");
    logger.debug(`Cartesia Ink-2 ASR turn.end: ${transcript}`);
    this._userIsSpeaking = false;
    this._turnTranscript = "";
    // The turn is committed, so any eager prediction it followed is resolved.
    this._clearEagerEndOfTurn();
    // The watchdog injects silence to force turn.end when audio stops
    // mid-turn, so a turn that captured only silence/noise can end with an
    // empty transcript. Skip the TranscriptionFrame in that case to avoid an
    // empty user message downstream; the lifecycle frames below still fire
    // so the turn closes cleanly.
    if (transcript) {
      // Report usage before the transcription frame so tracing can attach it
      // to the STT span the frame closes.
      await this.emitSttUsageMetrics();
      await this.pushFrame(
        new TranscriptionFrame({
          text: transcript,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: this._language,
          result: data,
          finalized: true,
        }),
      );
      await this._handleTranscription(transcript, true, this._language);
    }
    await this.broadcastFrame(ProposedUserStoppedSpeakingFrame);
    await this._callEventHandler("on_turn_end", transcript);
  }

  protected async _handleServerError(data: Dict): Promise<void> {
    const message = dictGet(data, "message", "Unknown error");
    const errorCode = dictGet(data, "error_code", "unknown");
    const errorMsg = `Cartesia Ink-2 ASR error [${errorCode ?? "None"}]: ${message ?? "None"}`;
    if (!this._connectionEstablishedEvent.isSet()) {
      // The server validates a connection's settings after the handshake,
      // sending this error in place of `connected` and then closing the
      // connection.
      throw new CartesiaTurnsRequestError(errorMsg, dictGet(data, "status_code"));
    }
    await this.pushError(errorMsg);
  }
}
