// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/bus.py

/**
 * Abstract worker bus for inter-worker pub/sub messaging.
 *
 * Provides the abstract `WorkerBus` base class. Concrete implementations
 * (e.g. `AsyncQueueBus`) live in separate modules.
 */

import { Queue, rethrowIfCancelled, sleep, type Task } from "@pipedog/asyncio";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";
import { logger } from "../utils/logger.ts";
import { BusLocalMessage, type BusMessage, BusSystemMessage } from "./messages.ts";
import { BusMessageQueue } from "./queue.ts";
import type { BusSubscriber } from "./subscriber.ts";

export interface BusSubscriptionOptions {
  /** The subscriber receiving messages. */
  subscriber: BusSubscriber;
  /** Priority queue for incoming messages. */
  queue?: BusMessageQueue;
  /** Secondary queue for data messages dispatched by the router worker. */
  dataQueue?: Queue<BusMessage>;
  /**
   * Task that reads from the priority queue, handles system messages inline,
   * and routes data messages to the data queue.
   */
  routerTask?: Task<unknown> | null;
  /** Task that processes data messages sequentially from the data queue. */
  dataTask?: Task<unknown> | null;
}

/** A single subscriber's state on the bus. */
export class BusSubscription {
  subscriber: BusSubscriber;
  queue: BusMessageQueue;
  dataQueue: Queue<BusMessage>;
  routerTask: Task<unknown> | null;
  dataTask: Task<unknown> | null;

  constructor(options: BusSubscriptionOptions) {
    this.subscriber = options.subscriber;
    this.queue = options.queue ?? new BusMessageQueue();
    this.dataQueue = options.dataQueue ?? new Queue<BusMessage>();
    this.routerTask = options.routerTask ?? null;
    this.dataTask = options.dataTask ?? null;
  }

  toString(): string {
    return `BusSubscription(subscriber=${this.subscriber.name})`;
  }
}

export interface WorkerBusOptions extends BaseObjectOptions {}

/**
 * Abstract base for inter-worker and runner-worker communication.
 *
 * Provides pub/sub messaging where each subscriber receives messages
 * independently through its own priority queue. System messages (e.g.
 * cancel) are delivered before normal data messages.
 *
 * Subclasses implement `publish()` for the specific transport. `send()`
 * handles local-only messages automatically. For network buses, override
 * `start()`/`stop()` to manage connections and call `onMessageReceived()`
 * when messages arrive from the network.
 */
export abstract class WorkerBus extends BaseObject {
  protected _subscriptions = new Map<string, BusSubscription>();
  protected _running = false;

  /**
   * Initialize the WorkerBus.
   *
   * @param options Additional arguments passed to `BaseObject`.
   */
  constructor(options: WorkerBusOptions = {}) {
    super(options);
  }

  /** Start dispatch tasks for all registered subscribers. */
  async start(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;
    for (const sub of this._subscriptions.values()) {
      this._startDispatchTask(sub);
    }
    // Schedule tasks right away.
    await sleep(0);
  }

  /** Stop all dispatch tasks. */
  async stop(): Promise<void> {
    if (!this._running) {
      return;
    }
    this._running = false;
    for (const sub of this._subscriptions.values()) {
      if (sub.routerTask) {
        await this.cancelTask(sub.routerTask);
        sub.routerTask = null;
      }
      if (sub.dataTask) {
        await this.cancelTask(sub.dataTask);
        sub.dataTask = null;
      }
    }
  }

  /**
   * Register a subscriber to receive messages from the bus.
   *
   * Idempotent: re-subscribing an already-registered subscriber is a no-op.
   *
   * @param subscriber The `BusSubscriber` to register.
   */
  async subscribe(subscriber: BusSubscriber): Promise<void> {
    if (this._subscriptions.has(subscriber.name)) {
      return;
    }
    const sub = new BusSubscription({ subscriber });
    if (this._running) {
      this._startDispatchTask(sub);
      // Schedule worker right away.
      await sleep(0);
    }
    this._subscriptions.set(subscriber.name, sub);
  }

  /**
   * Remove a subscriber and cancel its dispatch tasks.
   *
   * @param subscriber The `BusSubscriber` to remove.
   */
  async unsubscribe(subscriber: BusSubscriber): Promise<void> {
    const sub = this._subscriptions.get(subscriber.name);
    this._subscriptions.delete(subscriber.name);
    if (sub) {
      if (sub.routerTask) {
        await this.cancelTask(sub.routerTask);
      }
      if (sub.dataTask) {
        await this.cancelTask(sub.dataTask);
      }
    }
  }

  /**
   * Send a message through the bus.
   *
   * Local-only messages are delivered directly to subscribers. All other
   * messages are passed to `publish()` for transport.
   *
   * @param message The bus message to send.
   */
  async send(message: BusMessage): Promise<void> {
    if (message instanceof BusLocalMessage) {
      this.onMessageReceived(message);
      return;
    }
    await this.publish(message);
  }

  /**
   * Publish a message to the transport.
   *
   * Subclasses implement this for the specific transport. Called by `send()`
   * after filtering local-only messages.
   *
   * @param message The bus message to publish.
   */
  abstract publish(message: BusMessage): Promise<void>;

  /**
   * Deliver a message to all local subscribers via their priority queues.
   *
   * Called by bus implementations when a message arrives (either from a local
   * `send()` or from a network transport).
   */
  onMessageReceived(message: BusMessage): void {
    for (const sub of this._subscriptions.values()) {
      sub.queue.putNowait(message);
    }
  }

  /** Start the router and data dispatch tasks for a subscriber. */
  protected _startDispatchTask(sub: BusSubscription): void {
    sub.routerTask = this.createTask(() => this._routerTask(sub), `bus_router_${sub.subscriber}`);
    sub.dataTask = this.createTask(() => this._dataDispatchTask(sub), `bus_data_${sub.subscriber}`);
  }

  /** Route system messages inline, data messages to the data queue. */
  protected async _routerTask(sub: BusSubscription): Promise<void> {
    while (true) {
      const message = await sub.queue.get();
      if (!sub.subscriber.acceptsBusMessage(message)) {
        continue;
      }
      if (message instanceof BusSystemMessage) {
        // A subscriber exception must not tear down the dispatch task, or the
        // subscriber would silently stop receiving all future messages
        // (including cancel/cleanup). Log and keep going.
        try {
          await sub.subscriber.onBusMessage(message);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.exception(
            `${this}: subscriber '${sub.subscriber.name}' raised handling ` +
              `system message ${message}; keeping dispatch alive`,
            e,
          );
        }
      } else {
        sub.dataQueue.putNowait(message);
      }
    }
  }

  /** Process data messages sequentially from the data queue. */
  protected async _dataDispatchTask(sub: BusSubscription): Promise<void> {
    while (true) {
      const message = await sub.dataQueue.get();
      if (!sub.subscriber.acceptsBusMessage(message)) {
        continue;
      }
      // A subscriber exception must not tear down the dispatch task, or the
      // subscriber would silently stop receiving all future messages
      // (including cancel/cleanup). Log and keep going.
      try {
        await sub.subscriber.onBusMessage(message);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.exception(
          `${this}: subscriber '${sub.subscriber.name}' raised handling ` +
            `data message ${message}; keeping dispatch alive`,
          e,
        );
      }
    }
  }
}
