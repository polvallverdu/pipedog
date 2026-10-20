// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/proxy/websocket/client.py

/**
 * WebSocket client proxy that forwards bus messages to a remote server.
 *
 * Porting notes: upstream connects with the `websockets` library; this port
 * uses `websocketConnect` / `WebsocketClientConnection` from
 * `services/websocket_service.ts`, the stand-in for its asyncio client. The
 * receive loop rethrows `CancelledError` where upstream swallows it, so the
 * task ends as cancelled rather than normally.
 */

import { rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import {
  BusLocalMessage,
  type BusMessage,
  BusWorkerRegistryMessage,
} from "../../../bus/messages.ts";
import type { MessageSerializer } from "../../../bus/serializers/base.ts";
import { JSONMessageSerializer } from "../../../bus/serializers/json.ts";
import {
  ConnectionClosed,
  type WebsocketClientConnection,
  websocketConnect,
} from "../../../services/websocket_service.ts";
import { logger } from "../../../utils/logger.ts";
import { BaseWorker, type BaseWorkerOptions } from "../../base_worker.ts";

type Dict = Record<string, unknown>;

/** A bus message class, as listed in `forwardMessages`. */
export type BusMessageType = abstract new (...args: any[]) => BusMessage;

export interface WebSocketProxyClientOptions extends Omit<BaseWorkerOptions, "name" | "active"> {
  /** Unique name for this worker. */
  name: string;
  /** The WebSocket URL to connect to. */
  url: string;
  /**
   * Name of the worker on the remote server. Only messages targeted at this
   * worker are forwarded.
   */
  remoteWorkerName: string;
  /**
   * Name of the local worker that should receive responses. Only inbound
   * messages targeted at this worker are accepted.
   */
  localWorkerName: string;
  /**
   * Additional message types to forward from the local worker (e.g.
   * `[BusFrameMessage]` for frame routing). These are forwarded based on
   * source worker name only, regardless of target.
   */
  forwardMessages?: readonly BusMessageType[];
  /** Optional HTTP headers sent with the WebSocket handshake (e.g. for authentication). */
  headers?: Record<string, string> | null;
  /** Serializer for bus messages. Defaults to `JSONMessageSerializer`. */
  serializer?: MessageSerializer | null;
  /**
   * Whether the worker starts active. Defaults to false because
   * `onActivated` opens the WebSocket connection, which is almost always a
   * deliberate action triggered by an upstream event (e.g. the local client
   * connecting). Pass true to connect as soon as the worker starts.
   */
  active?: boolean;
}

/**
 * Forwards bus messages to a remote worker over WebSocket.
 *
 * Connects to a WebSocket URL and forwards messages between a local
 * worker and a remote worker. Only messages targeted at the remote worker
 * are sent. Only messages targeted at the local worker are accepted.
 *
 * Event handlers available:
 *
 * - on_connected: Fired when the WebSocket connection is established.
 * - on_disconnected: Fired when the WebSocket connection is closed.
 *
 * @example
 * ```ts
 * const proxy = new WebSocketProxyClient({
 *   name: "proxy",
 *   url: "ws://remote-server:8765/ws",
 *   remoteWorkerName: "worker",
 *   localWorkerName: "voice",
 * });
 *
 * proxy.eventHandler("on_connected", async (worker, websocket) => {
 *   logger.info("Connected to remote server");
 * });
 *
 * proxy.eventHandler("on_disconnected", async (worker, websocket) => {
 *   logger.info("Disconnected from remote server");
 * });
 *
 * await runner.addWorkers(proxy);
 * ```
 */
export class WebSocketProxyClient extends BaseWorker {
  protected _url: string;
  protected _remoteWorkerName: string;
  protected _localWorkerName: string;
  protected _forwardMessages: readonly BusMessageType[];
  protected _headers: Record<string, string>;
  protected _serializer: MessageSerializer;
  protected _ws: WebsocketClientConnection | null = null;
  protected _receiveTask: Task<void> | null = null;

  /** Initialize the WebSocketProxyClient. */
  constructor(options: WebSocketProxyClientOptions) {
    super({ ...options, name: options.name, active: options.active ?? false });
    this._url = options.url;
    this._remoteWorkerName = options.remoteWorkerName;
    this._localWorkerName = options.localWorkerName;
    this._forwardMessages = options.forwardMessages ?? [];
    this._headers = options.headers ?? {};
    this._serializer = options.serializer ?? new JSONMessageSerializer();

    this._registerEventHandler("on_connected");
    this._registerEventHandler("on_disconnected");
  }

  /** Connect to the remote WebSocket server. */
  override async onActivated(args: Dict | null): Promise<void> {
    await super.onActivated(args);

    logger.debug(`Worker '${this}': connecting to ${this._url}`);

    this._ws = await websocketConnect(this._url, { additionalHeaders: this._headers });

    logger.debug(`Worker '${this}': connected to ${this._url}`);

    await this._callEventHandler("on_connected", this._ws);

    this._receiveTask = this.createTask(() => this._receiveLoop());

    // Schedule worker right away.
    await sleep(0);
  }

  /** Cancel the receive loop and close the WebSocket connection. */
  override async stop(): Promise<void> {
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }
    if (this._ws) {
      await this._ws.close();
      logger.debug(`Worker '${this}': WebSocket connection closed`);
      this._ws = null;
    }
    await super.stop();
  }

  /**
   * Forward messages targeted at the remote worker.
   *
   * @param message The bus message to process.
   */
  override async onBusMessage(message: BusMessage): Promise<void> {
    await super.onBusMessage(message);

    if (!this._ws) return;

    if (message instanceof BusLocalMessage) return;

    // Forward targeted messages to the remote worker.
    if (message.target === this._remoteWorkerName) {
      await this._sendWs(message);
    }
    // Forward additional message types from the local worker.
    else if (this._isForwardMessage(message)) {
      if (message.source === this._localWorkerName) {
        await this._sendWs(message);
      }
    }
  }

  /** Whether `message` is one of the `forwardMessages` types. */
  protected _isForwardMessage(message: BusMessage): boolean {
    return this._forwardMessages.some((type) => message instanceof type);
  }

  /** Serialize and send a message over the WebSocket. */
  protected async _sendWs(message: BusMessage): Promise<void> {
    if (!this._ws) return;
    try {
      const data = this._serializer.serialize(message);
      await this._ws.send(data);
      logger.trace(`Worker '${this}': sent ${message}`);
    } catch (e) {
      if (!(e instanceof ConnectionClosed)) throw e;
      logger.warning(`Worker '${this}': connection closed, stopping forwarding`);
      const ws = this._ws;
      this._ws = null;
      await this._callEventHandler("on_disconnected", ws);
    }
  }

  /** Read messages from the WebSocket and put them on the local bus. */
  protected async _receiveLoop(): Promise<void> {
    if (this._ws === null) {
      throw new Error("onActivated() must run before _receiveLoop");
    }
    const encoder = new TextEncoder();
    try {
      for await (const data of this._ws) {
        try {
          const payload = typeof data === "string" ? encoder.encode(data) : data;
          const message = this._serializer.deserialize(payload);
          if (!message) continue;

          // Accept registry messages (target=None) for worker discovery.
          if (message instanceof BusWorkerRegistryMessage) {
            logger.trace(
              `Worker '${this}': received registry from remote: ${JSON.stringify(message.workers)}`,
            );
            await this.sendBusMessage(message);
            continue;
          }

          // Accept additional message types (e.g. BusFrameMessage).
          if (this._forwardMessages.length > 0 && this._isForwardMessage(message)) {
            logger.trace(`Worker '${this}': received ${message} from remote`);
            await this.sendBusMessage(message);
            continue;
          }

          // Only accept other messages targeted at the local worker.
          if (message.target !== this._localWorkerName) {
            logger.warning(
              `Worker '${this}': dropped inbound message with ` +
                `unexpected target '${message.target}'`,
            );
            continue;
          }

          logger.trace(`Worker '${this}': received ${message} from remote`);
          await this.sendBusMessage(message);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Worker '${this}': failed to deserialize remote message`, e);
        }
      }
    } catch (e) {
      if (e instanceof ConnectionClosed) {
        logger.warning(`Worker '${this}': WebSocket connection closed`);
        const ws = this._ws;
        this._ws = null;
        await this._callEventHandler("on_disconnected", ws);
      } else {
        // Upstream swallows `CancelledError` here; it is rethrown so the
        // task ends as cancelled (see the porting notes).
        throw e;
      }
    }
  }
}
