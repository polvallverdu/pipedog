// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/websocket/client.py

/**
 * WebSocket client transport implementation for Pipecat.
 *
 * This module provides a WebSocket client transport that enables bidirectional
 * communication over WebSocket connections, with support for audio streaming,
 * frame serialization, and connection management.
 *
 * The connection is opened with the global `WebSocket` (see `socket.ts`), so
 * the transport runs on Bun, Node, Deno and Cloudflare Workers. Extra
 * handshake headers (`additionalHeaders`) are sent on all four (Workers open
 * the socket through `fetch` with an `Upgrade: websocket` header); browsers
 * can't send them.
 */

import { monotonic, rethrowIfCancelled, sleep, type Task, TimeoutError } from "@pipedog/asyncio";
import { pcmToWav } from "@pipedog/core/audio/utils";
import {
  type CancelFrame,
  type EndFrame,
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  OutputAudioRawFrame,
  type OutputTransportMessageFrame,
  type OutputTransportMessageUrgentFrame,
  type StartFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import type { FrameSerializer } from "@pipedog/core/serializers/base_serializer";
import { BaseInputTransport } from "@pipedog/core/transports/base_input";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import {
  BaseTransport,
  TransportParams,
  type TransportParamsOptions,
} from "@pipedog/core/transports/base_transport";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import { acquires, releases } from "@pipedog/core/utils/shared";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";

import {
  State,
  type WebsocketConnectFn,
  type WebsocketConnection,
  type WebsocketData,
  websocketConnect,
} from "./socket.ts";

function errorName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

export interface WebsocketClientParamsOptions extends TransportParamsOptions {
  /** Whether to add WAV headers to audio frames. */
  addWavHeader?: boolean;
  /** Extra headers for the WebSocket handshake. */
  additionalHeaders?: Record<string, string> | null;
  /** Frame serializer for encoding/decoding messages. */
  serializer?: FrameSerializer | null;
}

/**
 * Configuration parameters for WebSocket client transport.
 *
 * - `addWavHeader`: Whether to add WAV headers to audio frames.
 * - `additionalHeaders`: Extra headers for the WebSocket handshake.
 * - `serializer`: Frame serializer for encoding/decoding messages.
 */
export class WebsocketClientParams extends TransportParams {
  addWavHeader: boolean;
  additionalHeaders: Record<string, string> | null;
  serializer: FrameSerializer | null;

  constructor(options: WebsocketClientParamsOptions = {}) {
    super(options);
    this.addWavHeader = options.addWavHeader ?? true;
    this.additionalHeaders = options.additionalHeaders ?? null;
    this.serializer = options.serializer ?? null;
  }
}

export interface WebsocketClientCallbacksOptions {
  /** Called when WebSocket connection is established. */
  onConnected: (websocket: WebsocketConnection) => Promise<void>;
  /** Called when WebSocket connection is closed. */
  onDisconnected: (websocket: WebsocketConnection) => Promise<void>;
  /** Called when a message is received from the WebSocket. */
  onMessage: (websocket: WebsocketConnection, message: WebsocketData) => Promise<void>;
}

/**
 * Callback functions for WebSocket client events.
 *
 * - `onConnected`: Called when WebSocket connection is established.
 * - `onDisconnected`: Called when WebSocket connection is closed.
 * - `onMessage`: Called when a message is received from the WebSocket.
 */
export class WebsocketClientCallbacks {
  onConnected: (websocket: WebsocketConnection) => Promise<void>;
  onDisconnected: (websocket: WebsocketConnection) => Promise<void>;
  onMessage: (websocket: WebsocketConnection, message: WebsocketData) => Promise<void>;

  constructor(options: WebsocketClientCallbacksOptions) {
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onMessage = options.onMessage;
  }
}

/**
 * Manages a WebSocket client connection session.
 *
 * Handles connection lifecycle, message sending/receiving, and provides
 * callback mechanisms for connection events.
 */
export class WebsocketClientSession {
  protected _uri: string;
  protected _params: WebsocketClientParams;
  protected _callbacks: WebsocketClientCallbacks;
  protected _transportName: string;

  protected _taskManager: BaseTaskManager | null = null;
  protected _websocket: WebsocketConnection | null = null;
  protected _clientTask: Task<unknown> | null = null;

  /**
   * The function that opens the connection. Replaceable (e.g. in tests);
   * defaults to `websocketConnect` (the global `WebSocket`).
   */
  _connect: WebsocketConnectFn = websocketConnect;

  /**
   * Initialize the WebSocket client session.
   *
   * @param uri The WebSocket URI to connect to.
   * @param params Configuration parameters for the session.
   * @param callbacks Callback functions for session events.
   * @param transportName Name of the parent transport for logging.
   */
  constructor(
    uri: string,
    params: WebsocketClientParams,
    callbacks: WebsocketClientCallbacks,
    transportName: string,
  ) {
    this._uri = uri;
    this._params = params;
    this._callbacks = callbacks;
    this._transportName = transportName;
  }

  /**
   * Get the task manager for this session.
   *
   * @throws Error If task manager is not initialized.
   */
  get taskManager(): BaseTaskManager {
    if (!this._taskManager) {
      throw new Error(
        `${this._transportName}::WebsocketClientSession: TaskManager not initialized (pipeline not started?)`,
      );
    }
    return this._taskManager;
  }

  /**
   * Set up the session with a task manager.
   *
   * @param taskManager The task manager to use for session tasks.
   */
  async setup(taskManager: BaseTaskManager): Promise<void> {
    if (!this._taskManager) {
      this._taskManager = taskManager;
    }
  }

  /**
   * Connect to the WebSocket server.
   *
   * An input and an output transport share this session and both connect
   * while they are set up, concurrently, so only the first of them dials.
   */
  async connect(): Promise<void> {
    try {
      this._websocket = await this._connect(this._uri, {
        openTimeout: 10,
        additionalHeaders: this._params.additionalHeaders,
      });
      const websocket = this._websocket;
      this._clientTask = this.taskManager.createTask(
        () => this._clientTaskHandler(),
        `${this._transportName}::WebsocketClientSession::_client_task_handler`,
      );
      await this._callbacks.onConnected(websocket);
    } catch (e) {
      if (e instanceof TimeoutError) {
        logger.error(`Timeout connecting to ${this._uri}`);
        return;
      }
      throw e;
    }
  }

  /**
   * Disconnect from the WebSocket server.
   *
   * Runs once the last of the transports sharing this session has let go,
   * so neither is left sending over a closed socket.
   */
  async disconnect(): Promise<void> {
    if (!this._websocket) {
      return;
    }

    if (this._clientTask) {
      await this.taskManager.cancelTask(this._clientTask);
    }

    await this._websocket.close();
    this._websocket = null;
  }

  static {
    WebsocketClientSession.prototype.connect = acquires("connection")(
      WebsocketClientSession.prototype.connect,
    ) as WebsocketClientSession["connect"];
    WebsocketClientSession.prototype.disconnect = releases("connection")(
      WebsocketClientSession.prototype.disconnect,
    ) as WebsocketClientSession["disconnect"];
  }

  /**
   * Send a message through the WebSocket connection.
   *
   * @param message The message data to send.
   */
  async send(message: WebsocketData): Promise<boolean> {
    let result = false;
    try {
      if (this._websocket) {
        await this._websocket.send(message);
        result = true;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception sending data: ${errorName(e)} (${e})`);
    }
    return result;
  }

  /** Whether the WebSocket is currently connected. */
  get isConnected(): boolean {
    return this._websocket ? this._websocket.state === State.OPEN : false;
  }

  /** Whether the WebSocket is currently closing. */
  get isClosing(): boolean {
    return this._websocket ? this._websocket.state === State.CLOSING : false;
  }

  /** Handle incoming messages from the WebSocket connection. */
  protected async _clientTaskHandler(): Promise<void> {
    // `connect()` only starts this task after `_websocket` is assigned, and
    // `disconnect()` cancels the task before clearing `_websocket`, so this
    // invariant should always hold when this method runs.
    const websocket = this._websocket;
    if (!websocket) throw new Error("assertion failed: websocket is not set");
    try {
      // Handle incoming messages
      for await (const message of websocket) {
        await this._callbacks.onMessage(websocket, message);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception receiving data: ${errorName(e)} (${e})`);
    }

    await this._callbacks.onDisconnected(websocket);
  }

  /** String representation of the WebSocket client session. */
  toString(): string {
    return `${this._transportName}::WebsocketClientSession`;
  }
}

/**
 * WebSocket client input transport for receiving frames.
 *
 * Handles incoming WebSocket messages, deserializes them to frames,
 * and pushes them downstream in the processing pipeline.
 */
export class WebsocketClientInputTransport extends BaseInputTransport {
  protected _transport: BaseTransport;
  protected _session: WebsocketClientSession;
  declare protected _params: WebsocketClientParams;

  /**
   * Initialize the WebSocket client input transport.
   *
   * @param transport The parent transport instance.
   * @param session The WebSocket session to use for communication.
   * @param params Configuration parameters for the transport.
   */
  constructor(
    transport: BaseTransport,
    session: WebsocketClientSession,
    params: WebsocketClientParams,
  ) {
    super(params);

    this._transport = transport;
    this._session = session;
    this._params = params;
  }

  /**
   * Set up the input transport with the frame processor setup.
   *
   * @param setup The frame processor setup configuration.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    await this._session.setup(setup.taskManager);

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }

    await this._session.connect();
  }

  /** Clean up the input transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._session.disconnect();
    await this._transport.cleanup();
  }

  /**
   * Start the input transport and initialize the WebSocket connection.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /**
   * Stop the input transport and disconnect from WebSocket.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._session.disconnect();
  }

  /**
   * Cancel the input transport and disconnect from WebSocket.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._session.disconnect();
  }

  /**
   * Handle incoming WebSocket messages.
   *
   * @param _websocket The WebSocket connection that received the message.
   * @param message The received message data.
   */
  async onMessage(_websocket: WebsocketConnection, message: WebsocketData): Promise<void> {
    if (!this._params.serializer) {
      return;
    }
    const frame = await this._params.serializer.deserialize(message);
    if (!frame) {
      return;
    }
    if (frame instanceof InputAudioRawFrame && this._params.audioInEnabled) {
      await this.pushAudioFrame(frame);
    } else if (frame instanceof InputTransportMessageFrame) {
      await this.broadcastFrame(InputTransportMessageFrame, { message: frame.message });
    } else {
      await this.pushFrame(frame);
    }
  }
}

/**
 * WebSocket client output transport for sending frames.
 *
 * Handles outgoing frames, serializes them for WebSocket transmission,
 * and manages audio streaming with proper timing simulation.
 */
export class WebsocketClientOutputTransport extends BaseOutputTransport {
  protected _transport: BaseTransport;
  protected _session: WebsocketClientSession;
  declare protected _params: WebsocketClientParams;

  // write_audio_frame() is called quickly, as soon as we get audio
  // (e.g. from the TTS), and since this is just a network connection we
  // would be sending it to quickly. Instead, we want to block to emulate
  // an audio device, this is what the send interval is. It will be
  // computed during setup.
  protected _sendInterval = 0;
  protected _nextSendTime = 0;

  /**
   * Initialize the WebSocket client output transport.
   *
   * @param transport The parent transport instance.
   * @param session The WebSocket session to use for communication.
   * @param params Configuration parameters for the transport.
   */
  constructor(
    transport: BaseTransport,
    session: WebsocketClientSession,
    params: WebsocketClientParams,
  ) {
    super(params);

    this._transport = transport;
    this._session = session;
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

    await this._session.setup(setup.taskManager);

    if (this._params.serializer) {
      await this._params.serializer.setup(setup);
    }

    await this._session.connect();
  }

  /**
   * Start the output transport and initialize the WebSocket connection.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);

    await this.setTransportReady(frame);
  }

  /**
   * Stop the output transport and disconnect from WebSocket.
   *
   * @param frame The end frame signaling transport shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._session.disconnect();
  }

  /**
   * Cancel the output transport and disconnect from WebSocket.
   *
   * @param frame The cancel frame signaling immediate cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._session.disconnect();
  }

  /** Clean up the output transport resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._session.disconnect();
    await this._transport.cleanup();
  }

  /**
   * Send a transport message through the WebSocket.
   *
   * @param frame The transport message frame to send.
   */
  override async sendMessage(
    frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame,
  ): Promise<void> {
    await this._writeFrame(frame);
  }

  /**
   * Write an audio frame to the WebSocket with optional WAV header.
   *
   * @param frame The output audio frame to write.
   * @returns True if the audio frame was written successfully, false otherwise.
   */
  override async writeAudioFrame(frame: OutputAudioRawFrame): Promise<boolean> {
    if (this._session.isClosing || !this._session.isConnected) {
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
   * Write a frame to the WebSocket after serialization.
   *
   * @returns Whether the transport took the frame. A serializer that emits no
   *   payload has still taken it; see `FrameSerializer.serialize`.
   */
  protected async _writeFrame(frame: Frame): Promise<boolean> {
    if (this._session.isClosing || !this._session.isConnected) {
      return false;
    }

    if (!this._params.serializer) {
      return false;
    }

    const payload = await this._params.serializer.serialize(frame);
    if (payload !== null && payload.length > 0) {
      await this._session.send(payload);
    }

    return true;
  }

  /** Simulate audio playback timing with sleep delays. */
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

/**
 * WebSocket client transport for bidirectional communication.
 *
 * Provides a complete WebSocket client transport implementation with
 * input and output capabilities, connection management, and event handling.
 *
 * Event handlers available:
 *
 * - on_connected(transport, websocket): Connected to WebSocket server
 * - on_disconnected(transport, websocket): Disconnected from WebSocket server
 *
 * @example
 * transport.eventHandler("on_connected", async (transport, websocket) => {
 *   ...
 * });
 */
export class WebsocketClientTransport extends BaseTransport {
  protected _params: WebsocketClientParams;
  protected _session: WebsocketClientSession;
  protected _input: WebsocketClientInputTransport | null = null;
  protected _output: WebsocketClientOutputTransport | null = null;

  /**
   * Initialize the WebSocket client transport.
   *
   * @param uri The WebSocket URI to connect to.
   * @param params Optional configuration parameters for the transport.
   */
  constructor(uri: string, params: WebsocketClientParams | null = null) {
    super();

    this._params = params ?? new WebsocketClientParams();
    this._params.serializer = this._params.serializer ?? new ProtobufFrameSerializer();

    const callbacks = new WebsocketClientCallbacks({
      onConnected: (websocket) => this._onConnected(websocket),
      onDisconnected: (websocket) => this._onDisconnected(websocket),
      onMessage: (websocket, message) => this._onMessage(websocket, message),
    });

    this._session = new WebsocketClientSession(uri, this._params, callbacks, this.name);

    // Register supported handlers. The user will only be able to register
    // these handlers.
    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_disconnected");
  }

  /**
   * Get the input transport for receiving frames.
   *
   * @returns The WebSocket client input transport instance.
   */
  input(): WebsocketClientInputTransport {
    if (!this._input) {
      this._input = new WebsocketClientInputTransport(this, this._session, this._params);
    }
    return this._input;
  }

  /**
   * Get the output transport for sending frames.
   *
   * @returns The WebSocket client output transport instance.
   */
  output(): WebsocketClientOutputTransport {
    if (!this._output) {
      this._output = new WebsocketClientOutputTransport(this, this._session, this._params);
    }
    return this._output;
  }

  /** Handle WebSocket connection established event. */
  protected async _onConnected(websocket: WebsocketConnection): Promise<void> {
    await this._callEventHandler("on_connected", websocket);
  }

  /** Handle WebSocket connection closed event. */
  protected async _onDisconnected(websocket: WebsocketConnection): Promise<void> {
    await this._callEventHandler("on_disconnected", websocket);
  }

  /** Handle incoming WebSocket message. */
  protected async _onMessage(
    websocket: WebsocketConnection,
    message: WebsocketData,
  ): Promise<void> {
    if (this._input) {
      await this._input.onMessage(websocket, message);
    }
  }
}
