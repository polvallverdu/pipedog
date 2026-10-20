// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/websocket/server.py

/**
 * WebSocket server transport implementation for Pipecat.
 *
 * This module provides WebSocket server transport functionality for real-time
 * audio and data streaming, including client connection management, session
 * handling, and frame serialization.
 *
 * The server listens with the runtime's own server (`Bun.serve`, `Deno.serve`
 * or Node's `ws`; see `serve.ts`), or with any `WebsocketServe` passed in the
 * transport options. Cloudflare Workers can't listen on a port; use
 * `FastAPIWebsocketTransport` with a `WebSocketPair` there.
 *
 * The deprecated `WebsocketServer*` aliases are not ported; use the
 * `SingleClientWebsocketServer*` classes.
 */

import {
  CancelledError,
  Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
} from "@pipedog/asyncio";
import { pcmToWav } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  ClientConnectedFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  type OutputTransportMessageFrame,
  type OutputTransportMessageUrgentFrame,
  type StartFrame,
} from "@pipedog/core/frames/frames";
import type {
  FrameDirection,
  FrameProcessorOptions,
  FrameProcessorSetup,
} from "@pipedog/core/processors/frame_processor";
import type { FrameSerializer } from "@pipedog/core/serializers/base_serializer";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import {
  BaseTransport,
  TransportParams,
  type TransportParamsOptions,
} from "@pipedog/core/transports/base_transport";
import { logger } from "@pipedog/core/utils/logger";
import { defaultAllowedOrigins } from "@pipedog/core/utils/security/allowed_origins";

import { type WebsocketServe, websocketServe } from "./serve.ts";
import { ConnectionClosed, State, type WebsocketConnection } from "./socket.ts";

function errorName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

export interface SingleClientWebsocketServerParamsOptions extends TransportParamsOptions {
  /** Whether to add WAV headers to audio frames. */
  addWavHeader?: boolean;
  /** Frame serializer for message encoding/decoding. */
  serializer?: FrameSerializer | null;
  /** Timeout in seconds for client sessions. */
  sessionTimeout?: number | null;
  /**
   * List of allowed origins. Empty list allows all origins. When set,
   * connections with a missing or disallowed Origin header are rejected.
   * Defaults to `PIPECAT_ALLOWED_ORIGINS` env var (comma-separated).
   */
  allowedOrigins?: string[];
}

/**
 * Configuration parameters for `SingleClientWebsocketServerTransport`.
 *
 * - `addWavHeader`: Whether to add WAV headers to audio frames.
 * - `serializer`: Frame serializer for message encoding/decoding.
 * - `sessionTimeout`: Timeout in seconds for client sessions.
 * - `allowedOrigins`: List of allowed origins. Empty list allows all
 *   origins. When set, connections with a missing or disallowed Origin header
 *   are rejected. Defaults to `PIPECAT_ALLOWED_ORIGINS` env var
 *   (comma-separated).
 */
export class SingleClientWebsocketServerParams extends TransportParams {
  addWavHeader: boolean;
  serializer: FrameSerializer | null;
  sessionTimeout: number | null;
  allowedOrigins: string[];

  constructor(options: SingleClientWebsocketServerParamsOptions = {}) {
    super(options);
    this.addWavHeader = options.addWavHeader ?? false;
    this.serializer = options.serializer ?? null;
    this.sessionTimeout = options.sessionTimeout ?? null;
    this.allowedOrigins = options.allowedOrigins ?? defaultAllowedOrigins();
  }
}

export interface SingleClientWebsocketServerCallbacksOptions {
  /** Called when a client connects to the server. */
  onClientConnected: (websocket: WebsocketConnection) => Promise<void>;
  /** Called when a client disconnects from the server. */
  onClientDisconnected: (websocket: WebsocketConnection) => Promise<void>;
  /** Called when a client session times out. */
  onSessionTimeout: (websocket: WebsocketConnection) => Promise<void>;
  /** Called when the WebSocket server is ready to accept connections. */
  onWebsocketReady: () => Promise<void>;
}

/**
 * Callback functions for WebSocket server events.
 *
 * - `onClientConnected`: Called when a client connects to the server.
 * - `onClientDisconnected`: Called when a client disconnects from the server.
 * - `onSessionTimeout`: Called when a client session times out.
 * - `onWebsocketReady`: Called when the WebSocket server is ready to accept connections.
 */
export class SingleClientWebsocketServerCallbacks {
  onClientConnected: (websocket: WebsocketConnection) => Promise<void>;
  onClientDisconnected: (websocket: WebsocketConnection) => Promise<void>;
  onSessionTimeout: (websocket: WebsocketConnection) => Promise<void>;
  onWebsocketReady: () => Promise<void>;

  constructor(options: SingleClientWebsocketServerCallbacksOptions) {
    this.onClientConnected = options.onClientConnected;
    this.onClientDisconnected = options.onClientDisconnected;
    this.onSessionTimeout = options.onSessionTimeout;
    this.onWebsocketReady = options.onWebsocketReady;
  }
}

export interface SingleClientWebsocketServerInputTransportOptions extends FrameProcessorOptions {
  /**
   * The function that starts the server. Defaults to `websocketServe` (the
   * runtime's own server).
   */
  serve?: WebsocketServe | null;
}

/**
 * WebSocket server input transport for receiving client data.
 *
 * Handles incoming WebSocket connections, message processing, and client
 * session management including timeout monitoring and connection lifecycle.
 */
export class SingleClientWebsocketServerInputTransport extends BaseInputTransport {
  protected _transport: SingleClientWebsocketServerTransport;
  protected _host: string;
  protected _port: number;
  declare protected _params: SingleClientWebsocketServerParams;
  protected _callbacks: SingleClientWebsocketServerCallbacks;
  protected _serve: WebsocketServe;

  protected _websocket: WebsocketConnection | null = null;

  protected _serverTask: Task<unknown> | null = null;

  // This task will monitor the websocket connection periodically.
  protected _monitorTask: Task<unknown> | null = null;

  protected _stopServerEvent = new Event();

  // The server is shared by the input and output transports. It is drained
  // only once both sides have released it (see `releaseServer`), so output
  // still being flushed after the EndFrame passed the input — e.g. a
  // goodbye spoken by the TTS via Flows' `end_conversation` action — isn't
  // cut off. Mirrors the leave-counter used by the FastAPI/Daily transports.
  protected _serverRefs = 0;

  /**
   * Initialize the WebSocket server input transport.
   *
   * @param transport The parent transport instance.
   * @param host Host address to bind the WebSocket server to.
   * @param port Port number to bind the WebSocket server to.
   * @param params WebSocket server configuration parameters.
   * @param callbacks Callback functions for WebSocket events.
   * @param options Additional arguments passed to parent class, and `serve`.
   */
  constructor(
    transport: SingleClientWebsocketServerTransport,
    host: string,
    port: number,
    params: SingleClientWebsocketServerParams,
    callbacks: SingleClientWebsocketServerCallbacks,
    options: SingleClientWebsocketServerInputTransportOptions = {},
  ) {
    super(params, options);

    this._transport = transport;
    this._host = host;
    this._port = port;
    this._params = params;
    this._callbacks = callbacks;
    this._serve = options.serve ?? websocketServe;
  }

  /**
   * Set up the input transport with the frame processor setup.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }
  }

  /**
   * Start the WebSocket server and initialize components.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._serverTask) {
      this._serverTask = this.createTask(() => this._serverTaskHandler(), "_server_task_handler");
    }

    // The input side now holds the server; the output side registers its own
    // hold in its start().
    this._serverRefs += 1;

    await this.setTransportReady(frame);
  }

  /**
   * Register a hold on the shared WebSocket server.
   *
   * Called by the output transport when it starts, so the server stays up
   * until both the input and output sides have released it.
   */
  acquireServer(): void {
    this._serverRefs += 1;
  }

  /**
   * Stop the input side and release its hold on the server.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    // Release our hold, but don't tear the server down while the output side
    // still holds it: it may have frames left to flush (e.g. a goodbye spoken
    // by the TTS after this EndFrame passed the input). Whichever side is last
    // drives the drain.
    await this.releaseServer();
  }

  /**
   * Release one hold on the shared server, draining it once none remain.
   *
   * Called by the input transport when its EndFrame arrives and by the
   * output transport once it has flushed all pending output. The last
   * release drives the graceful drain.
   */
  async releaseServer(): Promise<void> {
    this._serverRefs -= 1;
    if (this._serverRefs > 0) {
      return;
    }
    // Signal the server loop to exit and drain it gracefully before
    // cancelling whatever is left.
    this._stopServerEvent.set();
    if (this._serverTask) {
      await this._serverTask;
      this._serverTask = null;
    }
    await this._stopTasks();
  }

  /**
   * Cancel the WebSocket server and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._stopTasks();
  }

  /** Release input transport resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._stopTasks();
    await this._transport.cleanup();
  }

  /** Cancel the server and monitor tasks. Idempotent. */
  protected async _stopTasks(): Promise<void> {
    if (this._monitorTask) {
      await this.cancelTask(this._monitorTask);
      this._monitorTask = null;
    }
    if (this._serverTask) {
      await this.cancelTask(this._serverTask);
      this._serverTask = null;
    }
  }

  /** Handle WebSocket server startup and client connections. */
  protected async _serverTaskHandler(): Promise<void> {
    logger.info(`Starting websocket server on ${this._host}:${this._port}`);
    const origins = this._params.allowedOrigins.length > 0 ? this._params.allowedOrigins : null;
    const server = await this._serve({
      handler: (websocket) => this._clientHandler(websocket),
      host: this._host,
      port: this._port,
      origins,
    });
    try {
      await this._callbacks.onWebsocketReady();
      await this._stopServerEvent.wait();
    } finally {
      await server.close();
    }
  }

  /** Handle individual client connections and message processing. */
  protected async _clientHandler(websocket: WebsocketConnection): Promise<void> {
    logger.info(`New client connection from ${websocket.remoteAddress}`);

    // This transport only serves a single client at a time. If we already
    // have a live connection, reject the new one and keep the existing
    // client. The current connection's reference is cleared when it
    // disconnects (or something goes wrong), so the next client can connect.
    if (this._websocket && this._websocket.state === State.OPEN) {
      logger.warning(`Rejecting client ${websocket.remoteAddress}: a client is already connected`);
      await websocket.close(1013, "Server already has a connected client");
      return;
    }

    this._websocket = websocket;

    // Notify
    await this._callbacks.onClientConnected(websocket);

    // Create a task to monitor the websocket connection
    if (!this._monitorTask && this._params.sessionTimeout) {
      const sessionTimeout = this._params.sessionTimeout;
      this._monitorTask = this.createTask(
        () => this._monitorWebsocket(websocket, sessionTimeout),
        "_monitor_websocket",
      );
    }

    // Handle incoming messages
    try {
      for await (const message of websocket) {
        if (!this._params.serializer) {
          continue;
        }

        const frame = await this._params.serializer.deserialize(message);

        if (!frame) {
          continue;
        }

        if (frame instanceof InputAudioRawFrame) {
          await this.pushAudioFrame(frame);
        } else if (frame instanceof InputTransportMessageFrame) {
          await this.broadcastFrame(InputTransportMessageFrame, { message: frame.message });
        } else {
          await this.pushFrame(frame);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosed) {
        // The client closed the connection (clean or abrupt). Normal end of a
        // session, not an error.
        logger.debug(`${this}: client disconnected while receiving`);
      } else {
        logger.error(`${this} exception receiving data: ${errorName(e)} (${e})`);
      }
    }

    // Notify disconnection
    await this._callbacks.onClientDisconnected(websocket);

    await websocket.close();
    // Only clear if it's still ours: the next client may have already
    // connected and replaced it (e.g. back-to-back evals on a kept-alive
    // server), and we must not null out their connection.
    if (this._websocket === websocket) {
      this._websocket = null;
    }

    logger.info(`Client ${websocket.remoteAddress} disconnected`);
  }

  /** Monitor WebSocket connection for session timeout. */
  protected async _monitorWebsocket(
    websocket: WebsocketConnection,
    sessionTimeout: number,
  ): Promise<void> {
    try {
      await sleep(sessionTimeout);
      if (websocket.state !== State.CLOSED) {
        await this._callbacks.onSessionTimeout(websocket);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        logger.info(`Monitoring task cancelled for: ${websocket.remoteAddress}`);
      }
      throw e;
    }
  }
}

/**
 * WebSocket server output transport for sending data to clients.
 *
 * Handles outgoing frame serialization, audio streaming with timing control,
 * and client connection management for WebSocket communication.
 */
export class SingleClientWebsocketServerOutputTransport extends BaseOutputTransport {
  protected _transport: SingleClientWebsocketServerTransport;
  declare protected _params: SingleClientWebsocketServerParams;

  protected _websocket: WebsocketConnection | null = null;

  // write_audio_frame() is called quickly, as soon as we get audio
  // (e.g. from the TTS), and since this is just a network connection we
  // would be sending it to quickly. Instead, we want to block to emulate
  // an audio device, this is what the send interval is. It will be
  // computed during setup.
  protected _sendInterval = 0;
  protected _nextSendTime = 0;

  /**
   * Initialize the WebSocket server output transport.
   *
   * @param transport The parent transport instance.
   * @param params WebSocket server configuration parameters.
   * @param options Additional arguments passed to parent class.
   */
  constructor(
    transport: SingleClientWebsocketServerTransport,
    params: SingleClientWebsocketServerParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);

    this._transport = transport;
    this._params = params;
  }

  /**
   * Set the active client WebSocket connection.
   *
   * @param websocket The WebSocket connection to set as active, or null to clear.
   */
  async setClientConnection(websocket: WebsocketConnection | null): Promise<void> {
    // The input transport gates new connections, so by the time we set a new
    // client here the previous one (if any) is already gone. Close any stale
    // reference just in case before tracking the new connection.
    if (this._websocket && this._websocket !== websocket) {
      await this._websocket.close();
    }
    this._websocket = websocket;
  }

  /**
   * Set up the output transport with the frame processor setup.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    this._sendInterval = this.audioChunkSize / this.sampleRate / 2;

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }
  }

  /**
   * Start the output transport and initialize components.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    // Register the output side's hold on the shared server (owned by the
    // input transport), so it stays up until this side has flushed.
    this._transport.input().acquireServer();

    await this.setTransportReady(frame);
  }

  /**
   * Stop the output transport, flushing final output before releasing the server.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._writeFrame(frame);
    // All pending output has been written; release our hold on the shared
    // server. Since the input released its hold as soon as the EndFrame
    // passed it, this last release drives the graceful drain — the client
    // connection stays open until the goodbye has been sent.
    await this._transport.input().releaseServer();
  }

  /**
   * Cancel the output transport and send cancellation frame.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._writeFrame(frame);
  }

  /** Cleanup resources and parent transport. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._transport.cleanup();
  }

  /**
   * Process frames and handle interruption timing.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InterruptionFrame) {
      await this._writeFrame(frame);
      this._nextSendTime = 0;
    }
  }

  /**
   * Send a transport message frame to the client.
   *
   * @param frame The transport message frame to send.
   */
  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    await this._writeFrame(frame);
  }

  /**
   * Write an audio frame to the WebSocket client with timing control.
   *
   * @param frame The output audio frame to write.
   * @returns True if the audio frame was written successfully, false otherwise.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    if (!this._websocket) {
      return false;
    }

    let out = new OutputAudioRawFrame({
      audio: frame.audio,
      sampleRate: this.sampleRate,
      numChannels: this._params.audioOutChannels,
    });

    if (this._params.addWavHeader) {
      out = new OutputAudioRawFrame({
        audio: pcmToWav(out.audio, out.sampleRate, out.numChannels),
        sampleRate: out.sampleRate,
        numChannels: out.numChannels,
      });
    }

    if (!(await this._writeFrame(out))) {
      return false;
    }

    // Simulate audio playback with a sleep.
    await this._writeAudioSleep();

    return true;
  }

  /**
   * Serialize and send a frame to the WebSocket client.
   *
   * @returns Whether the transport took the frame. A serializer that emits no
   *   payload has still taken it; see `FrameSerializer.serialize`.
   */
  protected async _writeFrame(frame: Frame): Promise<boolean> {
    if (!this._params.serializer) {
      return false;
    }

    let success = true;
    try {
      const payload = await this._params.serializer.serialize(frame);
      if (payload !== null && payload.length > 0 && this._websocket) {
        await this._websocket.send(payload);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof ConnectionClosed) {
        // The client went away mid-send (a normal race on disconnect, e.g.
        // while still streaming TTS audio). Not an error.
        logger.debug(`${this}: client disconnected while sending`);
      } else {
        logger.error(`${this} exception sending data: ${errorName(e)} (${e})`);
      }
      success = false;
    }

    return success;
  }

  /** Simulate audio device timing by sleeping between audio chunks. */
  protected async _writeAudioSleep(): Promise<void> {
    // Simulate a clock.
    const currentTime = monotonic();
    const sleepDuration = Math.max(0, this._nextSendTime - currentTime);
    await sleep(sleepDuration);
    if (sleepDuration === 0) {
      this._nextSendTime = monotonic() + this._sendInterval;
    } else {
      this._nextSendTime += this._sendInterval;
    }
  }
}

export interface SingleClientWebsocketServerTransportOptions {
  /** Host address to bind the server to. Defaults to "localhost". */
  host?: string;
  /** Port number to bind the server to. Defaults to 8765. */
  port?: number;
  /** Optional name for the input processor. */
  inputName?: string | null;
  /** Optional name for the output processor. */
  outputName?: string | null;
  /**
   * The function that starts the server. Defaults to `websocketServe` (the
   * runtime's own server).
   */
  serve?: WebsocketServe | null;
}

/**
 * WebSocket server transport that serves a single client at a time.
 *
 * Provides a complete WebSocket server implementation with separate input and
 * output transports, client connection management, and event handling for
 * real-time audio and data streaming applications.
 *
 * Only one client can be connected at a time. While a client is connected, new
 * connection attempts are rejected and the existing client is kept; once that
 * client disconnects, the server accepts a new one. This makes it well suited
 * for local development and single-session bots, but not for serving multiple
 * concurrent clients.
 *
 * Event handlers available:
 *
 * - on_client_connected(transport, websocket): Client WebSocket connected
 * - on_client_disconnected(transport, websocket): Client WebSocket disconnected
 * - on_session_timeout(transport, websocket): Session timed out
 * - on_websocket_ready(transport): WebSocket server is ready to accept connections
 *
 * @example
 * transport.eventHandler("on_client_connected", async (transport, websocket) => {
 *   ...
 * });
 */
export class SingleClientWebsocketServerTransport extends BaseTransport {
  protected _host: string;
  protected _port: number;
  protected _params: SingleClientWebsocketServerParams;
  protected _serve: WebsocketServe | null;
  protected _callbacks: SingleClientWebsocketServerCallbacks;
  protected _input: SingleClientWebsocketServerInputTransport | null = null;
  protected _output: SingleClientWebsocketServerOutputTransport | null = null;
  protected _websocket: WebsocketConnection | null = null;

  /**
   * Initialize the WebSocket server transport.
   *
   * @param params WebSocket server configuration parameters.
   * @param options.host Host address to bind the server to. Defaults to "localhost".
   * @param options.port Port number to bind the server to. Defaults to 8765.
   * @param options.inputName Optional name for the input processor.
   * @param options.outputName Optional name for the output processor.
   * @param options.serve The function that starts the server.
   */
  constructor(
    params: SingleClientWebsocketServerParams,
    options: SingleClientWebsocketServerTransportOptions = {},
  ) {
    super({ inputName: options.inputName ?? null, outputName: options.outputName ?? null });
    this._host = options.host ?? "localhost";
    this._port = options.port ?? 8765;
    this._params = params;
    this._serve = options.serve ?? null;

    this._callbacks = new SingleClientWebsocketServerCallbacks({
      onClientConnected: (websocket) => this._onClientConnected(websocket),
      onClientDisconnected: (websocket) => this._onClientDisconnected(websocket),
      onSessionTimeout: (websocket) => this._onSessionTimeout(websocket),
      onWebsocketReady: () => this._onWebsocketReady(),
    });

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
    this._registerEventHandler("on_session_timeout");
    this._registerEventHandler("on_websocket_ready");
  }

  /**
   * Get the input transport for receiving client data.
   *
   * @returns The WebSocket server input transport instance.
   */
  input(): SingleClientWebsocketServerInputTransport {
    if (!this._input) {
      this._input = new SingleClientWebsocketServerInputTransport(
        this,
        this._host,
        this._port,
        this._params,
        this._callbacks,
        { name: this._inputName, serve: this._serve },
      );
    }
    return this._input;
  }

  /**
   * Get the output transport for sending data to clients.
   *
   * @returns The WebSocket server output transport instance.
   */
  output(): SingleClientWebsocketServerOutputTransport {
    if (!this._output) {
      this._output = new SingleClientWebsocketServerOutputTransport(this, this._params, {
        name: this._outputName,
      });
    }
    return this._output;
  }

  /** Handle client connection events. */
  protected async _onClientConnected(websocket: WebsocketConnection): Promise<void> {
    if (this._output) {
      await this._output.setClientConnection(websocket);
      await this._callEventHandler("on_client_connected", websocket);
      if (this._input) {
        await this._input.pushFrame(new ClientConnectedFrame());
      }
    } else {
      logger.error("A SingleClientWebsocketServerTransport output is missing in the pipeline");
    }
  }

  /** Handle client disconnection events. */
  protected async _onClientDisconnected(websocket: WebsocketConnection): Promise<void> {
    if (this._output) {
      await this._output.setClientConnection(null);
      await this._emitClientDisconnected(websocket);
    } else {
      logger.error("A SingleClientWebsocketServerTransport output is missing in the pipeline");
    }
  }

  /**
   * Fire the `on_client_disconnected` event.
   *
   * Split from the connection teardown above so subclasses can suppress the
   * event without skipping that teardown.
   */
  protected async _emitClientDisconnected(websocket: WebsocketConnection): Promise<void> {
    await this._callEventHandler("on_client_disconnected", websocket);
  }

  /** Handle client session timeout events. */
  protected async _onSessionTimeout(websocket: WebsocketConnection): Promise<void> {
    await this._callEventHandler("on_session_timeout", websocket);
  }

  /** Handle WebSocket server ready events. */
  protected async _onWebsocketReady(): Promise<void> {
    await this._callEventHandler("on_websocket_ready");
  }
}
