// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/websocket/fastapi.py

/**
 * FastAPI WebSocket transport implementation for Pipecat.
 *
 * This module provides WebSocket-based transport for real-time audio/video streaming
 * using FastAPI and WebSocket connections. Supports binary and text serialization
 * with configurable session timeouts and WAV header generation.
 *
 * Upstream's transport takes the socket a FastAPI endpoint accepted. Here it
 * takes the socket your own server accepted ("bring your own socket"), on any
 * runtime: anything implementing `FastAPIWebSocket`, which a
 * `WebsocketConnection` does. Wrap a standard socket (a Cloudflare
 * `WebSocketPair`, `Deno.upgradeWebSocket`, Node's `ws`, Hono's upgrade) with
 * `WebsocketConnection.fromWebSocket(ws, { headers: request.headers })`.
 */

import {
  createTask,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  wait,
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
import {
  defaultAllowedOrigins,
  isOriginAllowed,
} from "@pipedog/core/utils/security/allowed_origins";

import { WebSocketState, type WebsocketReceiveMessage } from "./socket.ts";

export { WebSocketState } from "./socket.ts";

function errorName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

/**
 * The socket the FastAPI transport talks to: the subset of Starlette's
 * `WebSocket` it uses. `WebsocketConnection` implements it.
 */
export interface FastAPIWebSocket {
  /** The handshake request's headers. */
  readonly headers: { get(name: string): string | null | undefined };
  /** The peer's side of the connection. */
  readonly clientState: WebSocketState;
  /** The application's side of the connection. */
  readonly applicationState: WebSocketState;
  /** Receive the next ASGI-style message. */
  receive(): Promise<WebsocketReceiveMessage>;
  /** Send a binary message. */
  sendBytes(data: Uint8Array): Promise<void>;
  /** Send a text message. */
  sendText(data: string): Promise<void>;
  /** Close the connection. */
  close(code?: number, reason?: string): Promise<void>;
}

// Default time (in seconds) to wait for the WebSocket close handshake in
// `FastAPIWebsocketClient.disconnect()` before proceeding with shutdown.
const _WS_CLOSE_TIMEOUT_DEFAULT = 0.5;

export interface FastAPIWebsocketParamsOptions extends TransportParamsOptions {
  /** Whether to add WAV headers to audio frames. */
  addWavHeader?: boolean;
  /** Frame serializer for encoding/decoding messages. */
  serializer?: FrameSerializer | null;
  /** Session timeout in seconds, null for no timeout. */
  sessionTimeout?: number | null;
  /**
   * Optional fixed-size packetization for raw PCM audio payloads. Useful
   * when the remote WebSocket media endpoint requires strict audio framing.
   */
  fixedAudioPacketSize?: number | null;
  /**
   * List of allowed origins. Empty list allows all origins. When set,
   * connections with a missing or disallowed Origin header are rejected.
   * Defaults to `PIPECAT_ALLOWED_ORIGINS` env var (comma-separated).
   */
  allowedOrigins?: string[];
  /**
   * Maximum time, in seconds, to wait for the WebSocket close handshake
   * during disconnect. See `FastAPIWebsocketParams`.
   */
  wsCloseTimeout?: number;
}

/**
 * Configuration parameters for FastAPI WebSocket transport.
 *
 * - `addWavHeader`: Whether to add WAV headers to audio frames.
 * - `serializer`: Frame serializer for encoding/decoding messages.
 * - `sessionTimeout`: Session timeout in seconds, null for no timeout.
 * - `fixedAudioPacketSize`: Optional fixed-size packetization for raw PCM
 *   audio payloads. Useful when the remote WebSocket media endpoint requires
 *   strict audio framing.
 * - `allowedOrigins`: List of allowed origins. Empty list allows all
 *   origins. When set, connections with a missing or disallowed Origin header
 *   are rejected. Defaults to `PIPECAT_ALLOWED_ORIGINS` env var
 *   (comma-separated).
 * - `wsCloseTimeout`: Maximum time, in seconds, to wait for the WebSocket
 *   close handshake during disconnect. The close is initiated in a
 *   background task before we start waiting, so the close frame is sent
 *   to the peer in the common case; this only bounds how long we wait
 *   for the peer to acknowledge it before letting shutdown proceed.
 *   Prevents a dead or half-closed peer (e.g. a telephony call already
 *   torn down on the provider's side) from stalling pipeline shutdown on
 *   the server's close-handshake timeout. Increase it for high-latency
 *   peers that need longer to complete a graceful close.
 */
export class FastAPIWebsocketParams extends TransportParams {
  addWavHeader: boolean;
  serializer: FrameSerializer | null;
  sessionTimeout: number | null;
  fixedAudioPacketSize: number | null;
  allowedOrigins: string[];
  wsCloseTimeout: number;

  constructor(options: FastAPIWebsocketParamsOptions = {}) {
    super(options);
    this.addWavHeader = options.addWavHeader ?? false;
    this.serializer = options.serializer ?? null;
    this.sessionTimeout = options.sessionTimeout ?? null;
    this.fixedAudioPacketSize = options.fixedAudioPacketSize ?? null;
    this.allowedOrigins = options.allowedOrigins ?? defaultAllowedOrigins();
    this.wsCloseTimeout = options.wsCloseTimeout ?? _WS_CLOSE_TIMEOUT_DEFAULT;
  }
}

export interface FastAPIWebsocketCallbacksOptions {
  /** Called when a client connects to the WebSocket. */
  onClientConnected: (websocket: FastAPIWebSocket) => Promise<void>;
  /** Called when a client disconnects from the WebSocket. */
  onClientDisconnected: (websocket: FastAPIWebSocket) => Promise<void>;
  /** Called when a session timeout occurs. */
  onSessionTimeout: (websocket: FastAPIWebSocket) => Promise<void>;
}

/**
 * Callback functions for WebSocket events.
 *
 * - `onClientConnected`: Called when a client connects to the WebSocket.
 * - `onClientDisconnected`: Called when a client disconnects from the WebSocket.
 * - `onSessionTimeout`: Called when a session timeout occurs.
 */
export class FastAPIWebsocketCallbacks {
  onClientConnected: (websocket: FastAPIWebSocket) => Promise<void>;
  onClientDisconnected: (websocket: FastAPIWebSocket) => Promise<void>;
  onSessionTimeout: (websocket: FastAPIWebSocket) => Promise<void>;

  constructor(options: FastAPIWebsocketCallbacksOptions) {
    this.onClientConnected = options.onClientConnected;
    this.onClientDisconnected = options.onClientDisconnected;
    this.onSessionTimeout = options.onSessionTimeout;
  }
}

/** Async iterator for WebSocket messages that yields both binary and text. */
export class _WebSocketMessageIterator implements AsyncIterableIterator<Uint8Array | string> {
  #websocket: FastAPIWebSocket;

  constructor(websocket: FastAPIWebSocket) {
    this.#websocket = websocket;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<Uint8Array | string>> {
    const message = await this.#websocket.receive();
    if (message.type === "websocket.disconnect") {
      return { done: true, value: undefined };
    }
    if (message.bytes !== undefined && message.bytes !== null) {
      return { done: false, value: message.bytes };
    }
    if (message.text !== undefined && message.text !== null) {
      return { done: false, value: message.text };
    }
    return { done: true, value: undefined };
  }
}

/**
 * WebSocket client wrapper for handling connections and message passing.
 *
 * Manages WebSocket state, message sending/receiving, and connection lifecycle
 * with support for both binary and text message types.
 */
export class FastAPIWebsocketClient {
  protected _websocket: FastAPIWebSocket;
  protected _closing = false;
  protected _callbacks: FastAPIWebsocketCallbacks;
  protected _leaveCounter = 0;
  protected _wsCloseTimeout: number;
  protected _closeTask: Task<void> | null = null;

  /**
   * Initialize the WebSocket client.
   *
   * @param websocket The WebSocket connection.
   * @param callbacks Event callback functions.
   * @param wsCloseTimeout Maximum time, in seconds, to wait for the close
   *   handshake in `disconnect()` before proceeding.
   */
  constructor(
    websocket: FastAPIWebSocket,
    callbacks: FastAPIWebsocketCallbacks,
    wsCloseTimeout: number = _WS_CLOSE_TIMEOUT_DEFAULT,
  ) {
    this._websocket = websocket;
    this._callbacks = callbacks;
    this._wsCloseTimeout = wsCloseTimeout;
  }

  /**
   * Set up the WebSocket client.
   *
   * @param _ The frame processor setup (unused).
   */
  async setup(_: FrameProcessorSetup): Promise<void> {
    this._leaveCounter += 1;
  }

  /**
   * Get an async iterator for receiving WebSocket messages.
   *
   * @returns An async iterator yielding bytes or strings.
   */
  receive(): AsyncIterableIterator<Uint8Array | string> {
    return new _WebSocketMessageIterator(this._websocket);
  }

  /**
   * Send data through the WebSocket connection.
   *
   * @param data The data to send (string or bytes).
   */
  async send(data: string | Uint8Array): Promise<void> {
    try {
      if (this._canSend()) {
        if (data instanceof Uint8Array) {
          await this._websocket.sendBytes(data);
        } else {
          await this._websocket.sendText(data);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(
        `${this} exception sending data: ${errorName(e)} (${e}), application_state: ${this._websocket.applicationState}`,
      );
    }
  }

  /**
   * Disconnect the WebSocket client.
   *
   * The close handshake is bounded by `wsCloseTimeout`. The close is
   * initiated in a background task before we start waiting, so the close
   * frame is sent to the peer in the common case; we then wait at most
   * `wsCloseTimeout` seconds for the peer to acknowledge it. If the peer
   * never replies (e.g. a half-closed connection after the remote side
   * already hung up), we stop waiting and let shutdown proceed instead of
   * blocking on the server's close-handshake timeout. The close task is
   * left running and its eventual result is logged, since the underlying
   * `close()` may not respond to cancellation.
   */
  async disconnect(): Promise<void> {
    this._leaveCounter -= 1;
    if (this._leaveCounter > 0) {
      return;
    }

    if (this.isConnected && !this.isClosing) {
      this._closing = true;
      this._closeTask = createTask(() => this._websocket.close(), "fastapi-ws-close");
      this._closeTask.addDoneCallback((task) => this._onCloseDone(task));
      const [done] = await wait([this._closeTask], { timeout: this._wsCloseTimeout });
      if (done.size === 0) {
        logger.debug(
          `${this} WebSocket close exceeded ${this._wsCloseTimeout}s; proceeding with shutdown`,
        );
      }
    }
  }

  /**
   * Log the outcome of the WebSocket close task.
   *
   * Runs whether the close completed within `wsCloseTimeout` or afterwards,
   * so an error raised by a slow close is still surfaced.
   */
  protected _onCloseDone(task: Task<void>): void {
    if (task.cancelled()) {
      return;
    }
    const e = task.exception();
    if (e !== undefined) {
      logger.error(`${this} exception while closing the websocket: ${e}`);
    }
  }

  /** Trigger the client disconnected callback. */
  async triggerClientDisconnected(): Promise<void> {
    await this._callbacks.onClientDisconnected(this._websocket);
  }

  /** Trigger the client connected callback. */
  async triggerClientConnected(): Promise<void> {
    await this._callbacks.onClientConnected(this._websocket);
  }

  /** Trigger the client timeout callback. */
  async triggerClientTimeout(): Promise<void> {
    await this._callbacks.onSessionTimeout(this._websocket);
  }

  /** Check if data can be sent through the WebSocket. */
  protected _canSend(): boolean {
    return (
      this.isConnected &&
      !this.isClosing &&
      this._websocket.applicationState !== WebSocketState.DISCONNECTED
    );
  }

  /** Whether the WebSocket is currently connected. */
  get isConnected(): boolean {
    return this._websocket.clientState === WebSocketState.CONNECTED;
  }

  /** Whether the WebSocket is currently closing. */
  get isClosing(): boolean {
    return this._closing;
  }

  toString(): string {
    return "FastAPIWebsocketClient";
  }
}

/**
 * Input transport for FastAPI WebSocket connections.
 *
 * Handles incoming WebSocket messages, deserializes frames, and manages
 * connection monitoring with optional session timeouts.
 */
export class FastAPIWebsocketInputTransport extends BaseInputTransport {
  protected _transport: BaseTransport;
  protected _client: FastAPIWebsocketClient;
  declare protected _params: FastAPIWebsocketParams;
  protected _receiveTask: Task<unknown> | null = null;
  protected _monitorWebsocketTask: Task<unknown> | null = null;

  /**
   * Initialize the WebSocket input transport.
   *
   * @param transport The parent transport instance.
   * @param client The WebSocket client wrapper.
   * @param params Transport configuration parameters.
   * @param options Additional arguments passed to parent class.
   */
  constructor(
    transport: BaseTransport,
    client: FastAPIWebsocketClient,
    params: FastAPIWebsocketParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);
    this._transport = transport;
    this._client = client;
    this._params = params;
  }

  /**
   * Set up the input transport with the frame processor setup.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._client.setup(setup);

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }
  }

  /** Clean up transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._teardown();
    await this._transport.cleanup();
  }

  /**
   * Start the input transport and begin message processing.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    if (!this._monitorWebsocketTask && this._params.sessionTimeout) {
      const sessionTimeout = this._params.sessionTimeout;
      this._monitorWebsocketTask = this.createTask(
        () => this._monitorWebsocket(sessionTimeout),
        "_monitor_websocket",
      );
    }

    await this._client.triggerClientConnected();
    await this.pushFrame(new ClientConnectedFrame());

    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() => this._receiveMessages(), "_receive_messages");
    }

    await this.setTransportReady(frame);
  }

  /** Stop all running tasks. */
  protected async _stopTasks(): Promise<void> {
    if (this._monitorWebsocketTask) {
      await this.cancelTask(this._monitorWebsocketTask);
      this._monitorWebsocketTask = null;
    }
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }
  }

  /**
   * Cancel the receive/monitor tasks and disconnect the client.
   *
   * Idempotent and shared by `stop()`, `cancel()`, and `cleanup()` so
   * the independent receive loop is always stopped and the WebSocket always
   * disconnected, regardless of which teardown hook runs.
   */
  protected async _teardown(): Promise<void> {
    await this._stopTasks();
    await this._client.disconnect();
  }

  /**
   * Stop the input transport and cleanup resources.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._teardown();
  }

  /**
   * Cancel the input transport and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._teardown();
  }

  /** Main message receiving loop for WebSocket messages. */
  protected async _receiveMessages(): Promise<void> {
    try {
      for await (const message of this._client.receive()) {
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
      logger.error(`${this} exception receiving data: ${errorName(e)} (${e})`);
    }

    // Trigger `on_client_disconnected` if the client actually disconnects,
    // that is, we are not the ones disconnecting.
    if (!this._client.isClosing) {
      await this._client.triggerClientDisconnected();
    }
  }

  /** Wait for `timeout` seconds, then trigger the client-timeout event if still open. */
  protected async _monitorWebsocket(timeout: number): Promise<void> {
    await sleep(timeout);
    await this._client.triggerClientTimeout();
  }
}

/**
 * Output transport for FastAPI WebSocket connections.
 *
 * Handles outgoing frame serialization, audio streaming with timing simulation,
 * and WebSocket message transmission with optional WAV header generation.
 */
export class FastAPIWebsocketOutputTransport extends BaseOutputTransport {
  protected _transport: BaseTransport;
  protected _client: FastAPIWebsocketClient;
  declare protected _params: FastAPIWebsocketParams;

  // write_audio_frame() is called quickly, as soon as we get audio
  // (e.g. from the TTS), and since this is just a network connection we
  // would be sending it to quickly. Instead, we want to block to emulate
  // an audio device, this is what the send interval is. It will be
  // computed during setup.
  protected _sendInterval = 0;
  protected _nextSendTime = 0;

  // Buffer for optional protocol-level audio packetization.
  // Some serializers may emit arbitrarily sized raw PCM payloads, while
  // certain downstream transports or media endpoints require audio to be
  // sent in fixed-size frames. When `params.fixedAudioPacketSize` is set,
  // this buffer accumulates outgoing audio until a full packet can be
  // emitted, preserving any remainder for subsequent sends.
  protected _audioSendBuffer: Uint8Array = new Uint8Array(0);

  /**
   * Initialize the WebSocket output transport.
   *
   * @param transport The parent transport instance.
   * @param client The WebSocket client wrapper.
   * @param params Transport configuration parameters.
   * @param options Additional arguments passed to parent class.
   */
  constructor(
    transport: BaseTransport,
    client: FastAPIWebsocketClient,
    params: FastAPIWebsocketParams,
    options: FrameProcessorOptions = {},
  ) {
    super(params, options);

    this._transport = transport;
    this._client = client;
    this._params = params;
  }

  /**
   * Set up the output transport with the frame processor setup.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    this._sendInterval = this.audioChunkSize / this.sampleRate / 2;

    await this._client.setup(setup);

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }
  }

  /**
   * Start the output transport and initialize timing.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /**
   * Stop the output transport and cleanup resources.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._writeFrame(frame);
    await this._client.disconnect();
  }

  /**
   * Cancel the output transport and stop all processing.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._writeFrame(frame);
    await this._client.disconnect();
  }

  /** Clean up transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._client.disconnect();
    await this._transport.cleanup();
  }

  /**
   * Process outgoing frames with special handling for interruptions.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InterruptionFrame) {
      // Drop any partially buffered audio to avoid replaying stale PCM
      if (this._params.fixedAudioPacketSize) {
        this._audioSendBuffer = new Uint8Array(0);
      }

      await this._writeFrame(frame);
      this._nextSendTime = 0;
    }
  }

  /**
   * Send a transport message frame.
   *
   * @param frame The transport message frame to send.
   */
  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    await this._writeFrame(frame);
  }

  /**
   * Write an audio frame to the WebSocket with timing simulation.
   *
   * @param frame The output audio frame to write.
   * @returns True if the audio frame was written successfully, false otherwise.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    if (this._client.isClosing || !this._client.isConnected) {
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
   * Serialize and send a frame through the WebSocket.
   *
   * @returns Whether the transport took the frame. A serializer that emits no
   *   payload has still taken it; see `FrameSerializer.serialize`.
   */
  protected async _writeFrame(frame: Frame): Promise<boolean> {
    if (this._client.isClosing || !this._client.isConnected) {
      return false;
    }

    if (!this._params.serializer) {
      return false;
    }

    let success = true;
    try {
      const payload = await this._params.serializer.serialize(frame);
      if (payload !== null && payload.length > 0) {
        // Optional protocol-level audio packetization:
        // If a downstream WebSocket media endpoint requires fixed-size PCM frames,
        // configure params.fixedAudioPacketSize (e.g. 640 for 20ms @ 16kHz PCM16 mono).
        const packetBytes = this._params.fixedAudioPacketSize;

        if (packetBytes && payload instanceof Uint8Array) {
          const buffer = new Uint8Array(this._audioSendBuffer.length + payload.length);
          buffer.set(this._audioSendBuffer, 0);
          buffer.set(payload, this._audioSendBuffer.length);
          this._audioSendBuffer = buffer;

          // Send only full frames; keep remainder for the next call.
          while (this._audioSendBuffer.length >= packetBytes) {
            const chunk = this._audioSendBuffer.slice(0, packetBytes);
            this._audioSendBuffer = this._audioSendBuffer.slice(packetBytes);
            await this._client.send(chunk);
          }
          return true;
        }

        await this._client.send(payload);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception sending data: ${errorName(e)} (${e})`);
      success = false;
    }

    return success;
  }

  /** Simulate audio playback timing with appropriate delays. */
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

export interface FastAPIWebsocketTransportOptions {
  /** Optional name for the input processor. */
  inputName?: string | null;
  /** Optional name for the output processor. */
  outputName?: string | null;
}

/**
 * FastAPI WebSocket transport for real-time audio/video streaming.
 *
 * Provides bidirectional WebSocket communication with frame serialization,
 * session management, and event handling for client connections and timeouts.
 *
 * Event handlers available:
 *
 * - on_client_connected(transport, websocket): Client WebSocket connected
 * - on_client_disconnected(transport, websocket): Client WebSocket disconnected
 * - on_session_timeout(transport, websocket): Session timed out
 *
 * @example
 * transport.eventHandler("on_client_connected", async (transport, websocket) => {
 *   ...
 * });
 */
export class FastAPIWebsocketTransport extends BaseTransport {
  protected _params: FastAPIWebsocketParams;
  protected _callbacks: FastAPIWebsocketCallbacks;
  protected _client: FastAPIWebsocketClient;
  protected _input: FastAPIWebsocketInputTransport;
  protected _output: FastAPIWebsocketOutputTransport;

  /**
   * Initialize the FastAPI WebSocket transport.
   *
   * Throws an `Error` if `params.allowedOrigins` is set and the connection's
   * Origin header is missing or not in the allowed list. The caller is
   * responsible for closing the WebSocket in that case.
   *
   * @param websocket The accepted WebSocket connection.
   * @param params Transport configuration parameters.
   * @param options.inputName Optional name for the input processor.
   * @param options.outputName Optional name for the output processor.
   */
  constructor(
    websocket: FastAPIWebSocket,
    params: FastAPIWebsocketParams,
    options: FastAPIWebsocketTransportOptions = {},
  ) {
    if (params.allowedOrigins.length > 0) {
      const origin = websocket.headers.get("origin") ?? "";
      if (!isOriginAllowed(origin, params.allowedOrigins)) {
        throw new Error(`WebSocket connection rejected: origin '${origin}' not allowed`);
      }
    }

    super({ inputName: options.inputName ?? null, outputName: options.outputName ?? null });

    this._params = params;

    this._callbacks = new FastAPIWebsocketCallbacks({
      onClientConnected: (ws) => this._onClientConnected(ws),
      onClientDisconnected: (ws) => this._onClientDisconnected(ws),
      onSessionTimeout: (ws) => this._onSessionTimeout(ws),
    });

    this._client = new FastAPIWebsocketClient(
      websocket,
      this._callbacks,
      this._params.wsCloseTimeout,
    );

    this._input = new FastAPIWebsocketInputTransport(this, this._client, this._params, {
      name: this._inputName,
    });
    this._output = new FastAPIWebsocketOutputTransport(this, this._client, this._params, {
      name: this._outputName,
    });

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("on_client_connected");
    this._registerEventHandler("on_client_disconnected");
    this._registerEventHandler("on_session_timeout");
  }

  /**
   * Get the input transport processor.
   *
   * @returns The WebSocket input transport instance.
   */
  input(): FastAPIWebsocketInputTransport {
    return this._input;
  }

  /**
   * Get the output transport processor.
   *
   * @returns The WebSocket output transport instance.
   */
  output(): FastAPIWebsocketOutputTransport {
    return this._output;
  }

  /** Handle client connected event. */
  protected async _onClientConnected(websocket: FastAPIWebSocket): Promise<void> {
    await this._callEventHandler("on_client_connected", websocket);
  }

  /** Handle client disconnected event. */
  protected async _onClientDisconnected(websocket: FastAPIWebSocket): Promise<void> {
    await this._callEventHandler("on_client_disconnected", websocket);
  }

  /** Handle session timeout event. */
  protected async _onSessionTimeout(websocket: FastAPIWebSocket): Promise<void> {
    await this._callEventHandler("on_session_timeout", websocket);
  }
}
