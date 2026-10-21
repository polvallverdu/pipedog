// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/flux/tts.py

/**
 * Deepgram Flux text-to-speech service implementation (WebSocket transport).
 *
 * This module provides integration with Deepgram's Flux TTS WebSocket API
 * (`/v2/speak`), a streaming-first speech synthesis service designed for
 * voice agents.
 *
 * Porting notes:
 * - Connects with the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`, sending the API key as the
 *   `Authorization: Token <key>` header on the opening handshake (Bun, Node
 *   and Deno; on Cloudflare Workers `websocketConnect` opens the socket through
 *   `fetch` so the header is sent there too).
 * - A standard `WebSocket` does not expose the handshake's response headers,
 *   so the `dg-*` headers upstream logs on connect are not available.
 */

import { rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { ErrorFrame } from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import {
  State,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
  WebsocketService,
  type WebsocketServiceOptions,
} from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  DeepgramFluxTTSBase,
  type DeepgramFluxTTSBaseOptions,
  DeepgramFluxTTSSettings,
} from "./tts_base.ts";

// `DeepgramFluxTTSSettings` is defined with the base but belongs to this
// service's public API.
export { DeepgramFluxTTSSettings };

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DeepgramFluxTTSServiceOptions
  extends Omit<DeepgramFluxTTSBaseOptions, "settings">,
    WebsocketServiceOptions {
  /** Deepgram API key for authentication. */
  apiKey: string;
  /** WebSocket URL for the Flux TTS API. Defaults to "wss://api.deepgram.com/v2/speak". */
  url?: string;
  /** Runtime-updatable settings. */
  settings?: DeepgramFluxTTSSettings | null;
  /**
   * Creates the underlying `WebSocket`, to open it some other way (through a
   * proxy, say). Defaults to `websocketConnect`'s, which sends the header on
   * every runtime, Cloudflare Workers included. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Deepgram Flux WebSocket text-to-speech service.
 *
 * Provides real-time speech synthesis using Deepgram's Flux TTS API at
 * `wss://api.deepgram.com/v2/speak`. Flux keeps acoustic state across turns
 * on a single connection, so prosody and pacing stay consistent throughout a
 * conversation.
 *
 * By default, LLM tokens are streamed to Flux as they arrive
 * (`TextAggregationMode.TOKEN`) — Flux is built to take raw LLM output and
 * places synthesis boundaries internally, so buffering for sentence
 * punctuation only adds latency. Pass
 * `textAggregationMode: TextAggregationMode.SENTENCE` to aggregate text into
 * sentences before synthesis instead.
 *
 * Event handlers:
 *
 * - on_connected: Called when the websocket connection is established.
 * - on_disconnected: Called when the websocket connection is closed.
 * - on_connection_error: Called when a websocket connection error occurs.
 *
 * @example
 * const tts = new DeepgramFluxTTSService({
 *   apiKey: process.env.DEEPGRAM_API_KEY!,
 *   settings: new DeepgramFluxTTSService.Settings({
 *     voice: "flux-alexis-en",
 *     speed: 1.05,
 *     expressivity: 1,
 *   }),
 * });
 */
export class DeepgramFluxTTSService extends WebsocketService(DeepgramFluxTTSBase) {
  static override Settings: typeof DeepgramFluxTTSSettings = DeepgramFluxTTSSettings;
  declare protected _settings: DeepgramFluxTTSSettings;

  protected _apiKey: string;
  protected _url: string;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Deepgram Flux WebSocket TTS service.
   *
   * @param options.apiKey Deepgram API key for authentication.
   * @param options.url WebSocket URL for the Flux TTS API. Defaults to
   *   "wss://api.deepgram.com/v2/speak".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses the
   *   pipeline default. Must be one of `SUPPORTED_SAMPLE_RATES`.
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program. See https://dpgr.am/deepgram-mip for pricing impacts before
   *   setting to true.
   * @param options.tag Tags to label requests for identification during
   *   usage reporting.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Defaults to `TextAggregationMode.TOKEN`, streaming LLM
   *   tokens straight to Flux for the lowest latency.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent classes.
   */
  constructor(options: DeepgramFluxTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof DeepgramFluxTTSService).Settings({
      model: null,
      voice: "flux-heather-en",
      language: null,
      speed: null,
      expressivity: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const baseOptions: DeepgramFluxTTSBaseOptions & WebsocketServiceOptions = {
      ...options,
      sampleRate: options.sampleRate ?? null,
      textAggregationMode: options.textAggregationMode ?? TextAggregationMode.TOKEN,
      settings: defaultSettings,
    };
    super(baseOptions);

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.deepgram.com/v2/speak";
    this._webSocketFactory = options.webSocketFactory ?? null;
  }

  // ------------------------------------------------------------------
  // Transport interface implementation
  // ------------------------------------------------------------------

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

  /** Connect to the Flux websocket and start the receive task. */
  override async _connect(): Promise<void> {
    // `DeepgramFluxTTSBase._connect` is abstract, so this reaches the
    // websocket side (`WebsocketService._connect`).
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Disconnect from the Flux websocket and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Connect to the Deepgram Flux WebSocket API with configured settings. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Deepgram Flux WebSocket");

      this._validateSampleRate();

      const url = `${this._url}?${this._buildQueryString()}`;

      const headers = { Authorization: `Token ${this._apiKey}` };

      this._websocket = await this._websocketConnect(url, {
        additionalHeaders: headers,
        webSocketFactory: this._webSocketFactory,
      });

      logger.debug(`${this}: Websocket connection initialized`);

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      await this.pushErrorFrame(new ErrorFrame({ error: `${this} error: ${errorMessage(e)}` }));
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Close WebSocket connection and reset state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug(`${this}: Disconnecting from Deepgram Flux WebSocket`);
        // No `Close` message here: in Flux, `Close` asks the server to drain
        // the active turn, generating all of its remaining audio, which a
        // teardown has no use for. Closing the socket ends the session
        // outright.
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      await this.pushErrorFrame(new ErrorFrame({ error: `${this} error: ${errorMessage(e)}` }));
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Get active websocket connection or raise exception. */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Receive and process messages from the Flux WebSocket. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (message instanceof Uint8Array) {
        await this._handleAudio(message);
      } else if (typeof message === "string") {
        let msg: unknown;
        try {
          msg = pyJsonLoads(message);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Invalid JSON message: ${message}`);
          continue;
        }
        await this._handleMessage(msg as Dict);
      }
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
