// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/bland/tts.py

/**
 * Bland text-to-speech service implementations.
 *
 * See https://docs.bland.ai/api-v2/post/tts-ws for the realtime WebSocket API and
 * https://docs.bland.ai/api-v2/post/tts for the HTTP API.
 *
 * Porting notes:
 * - The WebSocket connects through core's `websocketConnect` (via
 *   `WebsocketService._websocketConnect()`), with the `Authorization: Bearer` header on
 *   the opening handshake, so it runs on Bun, Node, Deno and Workers.
 * - `BlandHttpTTSService` uses `fetch`. Upstream's optional `aiohttp_session`, and the
 *   session it creates, owns and closes itself when none is given, have no counterpart:
 *   there is no session to open or close, so `fetch` replaces it.
 * - The two timeouts upstream keeps in module constants that its tests patch
 *   (`_READY_TIMEOUT_SECONDS`, `_CLOSE_TIMEOUT_SECONDS`) are instance fields here
 *   (`_readyTimeout`, `_closeTimeout`), because ES module bindings can't be patched.
 */

import {
  abortable,
  currentSignal,
  rethrowIfCancelled,
  type Task,
  TimeoutError,
  timeout,
  waitFor,
} from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TextAggregationMode,
  TTSService,
  type TTSServiceOptions,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { ConnectionClosed, State } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `str(None)` for a missing value. */
function py(value: unknown): string {
  return value === undefined || value === null ? "None" : String(value);
}

// Rates Bland renders directly; asking for one of these avoids a resample.
const _SAMPLE_RATES = [8000, 16000, 24000, 44100, 48000];

// Used when the pipeline rate is not one Bland renders. 48 kHz is what BTTS_V3
// generates natively, so it is the shortest path to audio.
const _DEFAULT_SAMPLE_RATE = 48000;

const _DEFAULT_VOICE_ID = "29158307-9893-4149-8a75-bc9ce313d64e";
const _READY_TIMEOUT_SECONDS = 10.0;
const _CLOSE_TIMEOUT_SECONDS = 5.0;

export interface BlandTTSSettingsOptions extends TTSSettingsOptions {
  /** 0.0-1.0. Higher values produce more varied intonation. */
  expressiveness?: number | null | NotGiven;
  /** 0.0-1.0. Higher values produce more consistent delivery. */
  stability?: number | null | NotGiven;
  /**
   * Rewrite numbers into the form the voice reads best before synthesis. Phone
   * numbers and SSNs, spelled out ("seven three two...") or written as bare
   * digits ("7327412065"), are read digit by digit in groups. Off unless set.
   */
  autoFormatting?: boolean | null | NotGiven;
}

/**
 * Settings for the Bland TTS services.
 *
 * - `expressiveness`: 0.0-1.0. Higher values produce more varied intonation.
 * - `stability`: 0.0-1.0. Higher values produce more consistent delivery.
 * - `autoFormatting`: rewrite numbers into the form the voice reads best
 *   before synthesis. Phone numbers and SSNs, spelled out ("seven three
 *   two...") or written as bare digits ("7327412065"), are read digit
 *   by digit in groups. Off unless set.
 */
export class BlandTTSSettings extends TTSSettings {
  expressiveness: number | null | NotGiven = NOT_GIVEN;
  stability: number | null | NotGiven = NOT_GIVEN;
  autoFormatting: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: BlandTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

function defaultSettings(
  cls: typeof BlandTTSSettings,
  settings: BlandTTSSettings | null | undefined,
): BlandTTSSettings {
  const defaults = new cls({
    model: null,
    voice: _DEFAULT_VOICE_ID,
    language: null,
    expressiveness: null,
    stability: null,
    autoFormatting: null,
  });
  if (settings !== undefined && settings !== null) {
    defaults.applyUpdate(settings);
  }
  return defaults;
}

/**
 * Pick the rate Bland will synthesize at.
 *
 * Bland renders a fixed set of rates. A pipeline running at any other rate is
 * served at 48 kHz and resampled by the output transport, which costs a
 * resample rather than fidelity: the audio frames carry the rate Bland
 * actually produced, not the pipeline's.
 *
 * @param sampleRate The pipeline's output rate.
 * @returns The rate Bland will synthesize at.
 */
export function _resolveSampleRate(sampleRate: number): number {
  if (_SAMPLE_RATES.includes(sampleRate)) {
    return sampleRate;
  }
  logger.warning(
    `Bland cannot render ${sampleRate} Hz (supports [${_SAMPLE_RATES.join(", ")}]); ` +
      `synthesizing at ${_DEFAULT_SAMPLE_RATE} Hz and resampling on output`,
  );
  return _DEFAULT_SAMPLE_RATE;
}

function _controls(settings: BlandTTSSettings): Record<string, number> {
  const controls: Record<string, number> = {};
  const expressiveness = assertGiven(settings.expressiveness);
  if (expressiveness !== null) {
    controls.expressiveness = expressiveness;
  }
  const stability = assertGiven(settings.stability);
  if (stability !== null) {
    controls.stability = stability;
  }
  return controls;
}

/** Add the settings Bland reads from a session's `init` or a `/v2/tts` body. */
function _applyRequestOptions(request: Dict, settings: BlandTTSSettings): void {
  const controls = _controls(settings);
  if (Object.keys(controls).length > 0) {
    request.controls = controls;
  }
  const autoFormatting = assertGiven(settings.autoFormatting);
  if (autoFormatting !== null) {
    request.auto_formatting = autoFormatting;
  }
}

export interface BlandTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Bland API key for authentication. */
  apiKey: string;
  /**
   * WebSocket URL for the Bland realtime TTS API. Defaults to
   * `wss://api.bland.ai/v2/tts/ws`.
   */
  url?: string;
  /**
   * How to aggregate incoming text before sending. Defaults to
   * `TextAggregationMode.TOKEN`, streaming LLM tokens straight to Bland for the
   * lowest latency.
   */
  textAggregationMode?: TextAggregationMode | null;
  /** Runtime-updatable settings. */
  settings?: BlandTTSSettings | null;
}

/**
 * Bland realtime WebSocket text-to-speech service.
 *
 * Streams speech from Bland's `/v2/tts/ws` endpoint over a single connection
 * for the whole conversation. LLM tokens are forwarded as they arrive and Bland
 * buffers them server-side, choosing its own synthesis boundaries, so no
 * sentence tokenizer or character threshold is needed. Pass
 * `textAggregationMode: TextAggregationMode.SENTENCE` to aggregate into
 * sentences before sending instead.
 *
 * Interruptions send Bland's `cancel` message, so barge-in does not tear down
 * the connection.
 *
 * The voice sets the model; `expressiveness` and `stability` are calibrated
 * for `BTTS_V3`.
 *
 * Event handlers:
 *
 * - on_connected: Called when the websocket connection is established.
 * - on_disconnected: Called when the websocket connection is closed.
 * - on_connection_error: Called when a websocket connection error occurs.
 *
 * @example
 * const tts = new BlandTTSService({
 *   apiKey: process.env.BLAND_API_KEY ?? "",
 *   settings: new BlandTTSService.Settings({
 *     voice: "29158307-9893-4149-8a75-bc9ce313d64e",
 *   }),
 * });
 */
export class BlandTTSService extends WebsocketTTSService {
  static Settings: typeof BlandTTSSettings = BlandTTSSettings;
  declare protected _settings: BlandTTSSettings;

  static {
    installTracedTts(BlandTTSService.prototype, "runTts");
  }

  // The rate Bland synthesizes at, resolved in setup() from the pipeline's.
  protected _blandSampleRate = 0;
  protected _apiKey: string;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null = null;
  // Seconds to wait for `ready`, and for `done` when closing (see the module notes).
  protected _readyTimeout = _READY_TIMEOUT_SECONDS;
  protected _closeTimeout = _CLOSE_TIMEOUT_SECONDS;

  /**
   * Initialize the Bland WebSocket TTS service.
   *
   * @param options.apiKey Bland API key for authentication.
   * @param options.url WebSocket URL for the Bland realtime TTS API. Defaults to
   *   `wss://api.bland.ai/v2/tts/ws`.
   * @param options.sampleRate Output sample rate in Hz. If null, uses the pipeline
   *   default. A rate Bland does not render is replaced with 48000 and
   *   resampled by the output transport.
   * @param options.textAggregationMode How to aggregate incoming text before sending.
   *   Defaults to `TextAggregationMode.TOKEN`, streaming LLM tokens
   *   straight to Bland for the lowest latency.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to `WebsocketTTSService`.
   */
  constructor(options: BlandTTSServiceOptions) {
    if (!options.apiKey) {
      throw new Error("Bland API key is required");
    }
    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: false,
      pauseFrameProcessing: true,
      textAggregationMode: options.textAggregationMode ?? TextAggregationMode.TOKEN,
      // Bland appends each `speak.text` verbatim, so consecutive sentences
      // would otherwise glue together. Applies in sentence mode only; when
      // streaming tokens the LLM's own whitespace is used as-is.
      appendTrailingSpace: true,
      settings: defaultSettings((new.target as typeof BlandTTSService).Settings, options.settings),
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.bland.ai/v2/tts/ws";
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set up the service and open the Bland session.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._blandSampleRate = _resolveSampleRate(this.sampleRate);
    await this._connect();
  }

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
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

  /** Open the socket and hold the session at `ready`. */
  override async _connectWebsocket(): Promise<void> {
    let websocket: Awaited<ReturnType<BlandTTSService["_websocketConnect"]>> | null = null;
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Bland");

      websocket = await this._websocketConnect(this._url, {
        additionalHeaders: { Authorization: `Bearer ${this._apiKey}` },
      });

      const init: Dict = {
        type: "init",
        voice: this._settings.voice,
        audio: { encoding: "pcm_s16le", sample_rate: this._blandSampleRate },
      };
      _applyRequestOptions(init, this._settings);
      await websocket.send(pyJsonDumps(init));

      // `ready` confirms wallet and concurrency admission, so a
      // rejected session fails here rather than on the first turn.
      const raw = await waitFor(() => websocket!.recv(), this._readyTimeout);
      const message = pyJsonLoads(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      ) as Dict;
      if (message.type !== "ready") {
        throw new Error(
          `Bland rejected the session: ${py(message.code)}: ${
            Object.hasOwn(message, "message") ? message.message : pyJsonDumps(message)
          }`,
        );
      }
      if (message.encoding !== "pcm_s16le" || message.sample_rate !== this._blandSampleRate) {
        throw new Error(
          "Bland acknowledged an unexpected audio format: " +
            `${py(message.encoding)} at ${py(message.sample_rate)} Hz`,
        );
      }

      logger.debug(`${this}: session ready (session_id: ${py(message.session_id)})`);
      this._websocket = websocket;
      await this._callEventHandler("on_connected");
    } catch (e) {
      // BaseException upstream: the provisional socket is closed on cancellation too.
      if (websocket !== null) {
        try {
          await websocket.close();
        } catch (closeError) {
          rethrowIfCancelled(closeError);
        }
      }
      rethrowIfCancelled(e);
      await this.pushError(`${this} error: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /**
   * Settle and close the socket.
   *
   * Split from `_disconnectWebsocket` so `runTts` can replace a socket
   * Bland closed while idle without stopping the metrics of the turn it is
   * about to send.
   */
  protected async _closeSocket(): Promise<void> {
    const websocket = this._websocket;
    try {
      // Only a live socket can be settled. Bland reaps an idle session after
      // 60s and closes it itself, and teardown runs after that: sending
      // `close` down a corpse raises, and reporting that as a pipeline error
      // turns routine housekeeping into an ErrorFrame the app has to explain.
      if (websocket && websocket.state === State.OPEN) {
        logger.debug("Disconnecting from Bland");
        // `done` is sent only after the server settles outstanding usage.
        // The receive task has already stopped, so consume it here before
        // starting the WebSocket close handshake.
        await websocket.send(pyJsonDumps({ type: "close" }));
        await timeout(this._closeTimeout, async () => {
          for await (const raw of websocket) {
            if (typeof raw === "string") {
              const message = pyJsonLoads(raw) as Dict;
              if (message.type === "done") {
                break;
              }
            }
          }
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof TimeoutError || e instanceof ConnectionClosed) {
        // A settle that does not complete costs nothing here: the server bills
        // on disconnect regardless. Worth a log, not an error frame.
        logger.debug(
          `${this}: close handshake did not complete (${e.constructor.name}: ${errorMessage(e)})`,
        );
      } else {
        await this.pushError(`${this} error: ${errorMessage(e)}`, { exception: e });
      }
    } finally {
      if (websocket) {
        try {
          await websocket.close();
        } catch (e) {
          rethrowIfCancelled(e);
          logger.debug(`${this} failed to close Bland websocket: ${errorMessage(e)}`);
        }
      }
      this._websocket = null;
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    await this.stopAllMetrics();
    await this._closeSocket();
    await this._callEventHandler("on_disconnected");
  }

  protected _getWebsocket() {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Apply a settings delta.
   *
   * @param delta A `TTSSettings` (or `BlandTTSService.Settings`) delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    // `init` fixes the voice, controls and formatting for the life of a
    // session. Nothing else in TTSSettings reaches Bland, so nothing else
    // earns a reconnect.
    const sessionFields = ["voice", "expressiveness", "stability", "autoFormatting"];
    if (Object.keys(changed).some((key) => sessionFields.includes(key))) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  /** Cancel the interrupted turn instead of dropping the connection. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (contextId && this._websocket) {
      try {
        await this._websocket.send(pyJsonDumps({ type: "cancel", context_id: contextId }));
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error sending cancel message: ${errorMessage(e)}`);
      }
    }
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * End the active turn so Bland synthesizes its remaining buffered text.
   *
   * @param contextId The turn to end. Falls back to the active context.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const turnId = contextId || this.getActiveAudioContextId();
    if (!turnId || !this._websocket) {
      return;
    }
    try {
      await this._websocket.send(pyJsonDumps({ type: "end_of_turn", context_id: turnId }));
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} error sending end_of_turn message: ${errorMessage(e)}`);
    }
  }

  /** Stop and close a turn's audio context, if it is still open. */
  protected async _closeTurn(contextId: string | null | undefined): Promise<void> {
    if (contextId && this.audioContextAvailable(contextId)) {
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    }
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (typeof message !== "string") {
        const contextId = this.getActiveAudioContextId();
        await this.stopTtfbMetrics();
        await this.appendToAudioContext(
          contextId,
          new TTSAudioRawFrame({
            audio: message,
            sampleRate: this._blandSampleRate,
            numChannels: 1,
            contextId,
          }),
        );
        continue;
      }

      let msg: Dict;
      try {
        msg = pyJsonLoads(message) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.error(`Invalid JSON message: ${message}`);
          continue;
        }
        throw e;
      }

      const msgType = msg.type;
      const contextId: string | undefined = msg.context_id;

      if (msgType === "utterance_start") {
        logger.trace(`${this}: turn ${py(contextId)} started`);
      } else if (msgType === "utterance_end") {
        const reason = msg.reason;
        if (reason === "failed") {
          // The failure's detail is reported from the `error` message
          // that precedes it.
          logger.warning(`${this}: turn ${py(contextId)} failed`);
        } else {
          logger.trace(`${this}: turn ${py(contextId)} ended as ${py(reason)}`);
        }
        await this._closeTurn(contextId);
      } else if (msgType === "error") {
        const code = msg.code;
        if (code === "idle_timeout") {
          // Bland reaps a session after 60s without a client message,
          // which any conversational pause reaches. Reconnecting is
          // routine housekeeping, not something the app can act on.
          logger.debug(`${this}: session reaped after idle timeout`);
        } else {
          await this.pushError(
            `${this} error ${py(code)}: ${Object.hasOwn(msg, "message") ? msg.message : pyJsonDumps(msg)}`,
          );
        }
        // An error carrying a context_id ends that turn. A refused turn
        // never starts, so no `utterance_end` arrives to close it.
        await this._closeTurn(contextId);
      } else if (msgType === "done") {
        logger.debug(`${this}: session settled (session_id: ${py(msg.session_id)})`);
      } else {
        logger.debug(`Received unknown message type: ${pyJsonDumps(msg)}`);
      }
    }
  }

  /**
   * Append a text delta to the current turn.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        // Bland ends a session after 60s without a client message, which a
        // conversational gap reaches easily. The receive task has finished
        // but is still set after a server close, so it has to be cleared or
        // `_connect()` will not restart it.
        if (this._receiveTask) {
          await this.cancelTask(this._receiveTask);
          this._receiveTask = null;
        }
        await this._closeSocket();
        await this._connect();
      }

      await this._getWebsocket().send(pyJsonDumps({ type: "speak", context_id: contextId, text }));
      await this.startTtsUsageMetrics(text);

      // The audio frames will be handled in _receiveMessages
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

/** Yield a body stream's bytes as they arrive, in chunks of at most `chunkSize` bytes. */
async function* iterChunked(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        yield value.subarray(offset, Math.min(offset + chunkSize, value.length));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

export interface BlandHttpTTSServiceOptions extends TTSServiceOptions {
  /** Bland API key for authentication. */
  apiKey: string;
  /** Base URL for the Bland API. Defaults to `https://api.bland.ai/v2`. */
  baseUrl?: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes an optional shared `aiohttp_session`, and creates and
   * closes one itself when none is given.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: BlandTTSSettings | null;
}

/**
 * Bland HTTP text-to-speech service.
 *
 * Generates speech with Bland's `/v2/tts` endpoint, which takes the complete
 * text in one request. Voice agents should prefer `BlandTTSService`,
 * which streams text into a realtime session.
 */
export class BlandHttpTTSService extends TTSService {
  static Settings: typeof BlandTTSSettings = BlandTTSSettings;
  declare protected _settings: BlandTTSSettings;

  static {
    installTracedTts(BlandHttpTTSService.prototype, "runTts");
  }

  // The rate Bland synthesizes at, resolved in setup() from the pipeline's.
  protected _blandSampleRate = 0;
  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Bland HTTP TTS service.
   *
   * @param options.apiKey Bland API key for authentication.
   * @param options.baseUrl Base URL for the Bland API. Defaults to
   *   `https://api.bland.ai/v2`.
   * @param options.sampleRate Output sample rate in Hz. If null, uses the pipeline
   *   default.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an optional aiohttp session).
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to `TTSService`.
   */
  constructor(options: BlandHttpTTSServiceOptions) {
    if (!options.apiKey) {
      throw new Error("Bland API key is required");
    }
    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings(
        (new.target as typeof BlandHttpTTSService).Settings,
        options.settings,
      ),
    });

    this._apiKey = options.apiKey;
    this._baseUrl = (options.baseUrl ?? "https://api.bland.ai/v2").replace(/\/+$/, "");
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._blandSampleRate = _resolveSampleRate(this.sampleRate);
  }

  /**
   * Generate speech from text using Bland's `/v2/tts` endpoint.
   *
   * @param text The text to synthesize.
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const blandSampleRate = this._blandSampleRate;

    const payload: Dict = {
      text,
      voice: this._settings.voice,
      audio: {
        encoding: "pcm_s16le",
        sample_rate: blandSampleRate,
        // The body is streamed straight into audio frames, so a
        // container's header would be read as the first samples.
        container: "raw",
      },
    };
    _applyRequestOptions(payload, this._settings);

    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
    };

    try {
      const response = await abortable(
        this._fetch(`${this._baseUrl}/tts`, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        yield new ErrorFrame({ error: await _errorMessage(response) });
        return;
      }

      await this.startTtsUsageMetrics(text);

      for await (const frame of this._streamAudioFramesFromIterator(
        iterChunked(response.body, this.chunkSize),
        { inSampleRate: blandSampleRate, contextId },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}

/** Unwrap the v2 `{"error": {"code", "message"}}` envelope, falling back to the raw body. */
async function _errorMessage(response: Response): Promise<string> {
  const body = await abortable(response.text());
  // aiohttp's `response.json()` refuses a body whose content type isn't JSON.
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  let payload: unknown;
  try {
    if (contentType !== "application/json" && !/^application\/.+\+json$/.test(contentType)) {
      throw new SyntaxError("not JSON");
    }
    payload = pyJsonLoads(body);
  } catch (e) {
    rethrowIfCancelled(e);
    return `Error getting audio (status: ${response.status}, error: ${body})`;
  }

  const error =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Dict).error
      : null;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const detail = [error.code, error.message]
      .filter((v) => v)
      .map((v) => String(v))
      .join(": ");
    if (detail) {
      return `Error getting audio (status: ${response.status}, error: ${detail})`;
    }
  }
  return `Error getting audio (status: ${response.status}, error: ${pyJsonDumps(payload)})`;
}
