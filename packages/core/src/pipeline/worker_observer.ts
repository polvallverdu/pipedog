// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/worker_observer.py

/**
 * Worker observer for managing pipeline frame observers.
 *
 * Provides a proxy observer system that manages multiple observers for
 * pipeline frame events, ensuring that observer processing doesn't block the
 * main pipeline execution.
 */

import { currentTask, Queue, rethrowIfCancelled, type Task } from "@pipecat-ts/asyncio";
import type { Frame } from "../frames/frames.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  FrameProcessed,
  FramePushed,
  ProcessorSetUp,
} from "../observers/base_observer.ts";
import type { BaseTaskManager } from "../utils/asyncio/task_manager.ts";
import { logger } from "../utils/logger.ts";

/**
 * Proxy data for managing observer tasks and queues.
 *
 * This represents the data received from the main observer that is queued
 * for later processing.
 *
 * - `queue`: queue for frame data awaiting observer processing.
 * - `task`: task running the observer's frame processing loop.
 * - `observer`: the actual observer instance being proxied.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: upstream name (worker_observer.Proxy).
export class Proxy {
  queue: Queue<unknown>;
  task: Task<unknown>;
  observer: BaseObserver;

  constructor(options: { queue: Queue<unknown>; task: Task<unknown>; observer: BaseObserver }) {
    this.queue = options.queue;
    this.task = options.task;
    this.observer = options.observer;
  }
}

/** Internal sentinel queued to observers when the pipeline has started. */
class _PipelineStartedSignal {}

/**
 * Frames held weakly by id, like Python's `weakref.WeakValueDictionary`: an
 * entry goes away with its frame.
 */
class WeakFrameMap {
  readonly #refs = new Map<number, WeakRef<Frame>>();
  readonly #registry = new FinalizationRegistry<number>((id) => {
    const ref = this.#refs.get(id);
    if (ref && ref.deref() === undefined) this.#refs.delete(id);
  });

  has(id: number): boolean {
    return this.#refs.get(id)?.deref() !== undefined;
  }

  set(id: number, frame: Frame): void {
    this.#refs.set(id, new WeakRef(frame));
    this.#registry.register(frame, id);
  }
}

export interface WorkerObserverOptions extends BaseObserverOptions {
  /** List of observers to manage. Defaults to an empty list. */
  observers?: BaseObserver[] | null;
}

/**
 * Proxy observer that manages multiple observers without blocking the pipeline.
 *
 * This is a pipeline frame observer that is meant to be used as a proxy to
 * the user provided observers. That is, this is the observer that should be
 * passed to the frame processors. Then, every time a frame is pushed this
 * observer will call all the observers registered to the pipeline worker.
 *
 * This observer makes sure that passing frames to observers doesn't block the
 * pipeline by creating a queue and a worker for each user observer. When a
 * frame is received, it will be put in a queue for efficiency and later
 * processed by each worker.
 *
 * It also tells a frame's first push from the ones that follow, and only
 * passes the first one to observers that want a frame once.
 *
 * Dropped from upstream (deprecated): `on_startup_warmup` / `StartupWarmup`.
 */
export class WorkerObserver extends BaseObserver {
  protected _observers: BaseObserver[];
  // Becomes a map after setup() is called.
  protected _proxies: Map<BaseObserver, Proxy> | null = null;
  // Frames pushed so far, held weakly: an entry goes away with its frame, so
  // this tracks the frames in flight, not every frame ever pushed.
  protected _framesPushed = new WeakFrameMap();

  constructor(options: WorkerObserverOptions = {}) {
    super(options);
    this._observers = options.observers ?? [];
  }

  /**
   * Add a new observer to the managed list.
   *
   * @param observer The observer to add.
   */
  addObserver(observer: BaseObserver): void {
    // Add the observer to the list.
    this._observers.push(observer);

    // After setup(), create the proxy immediately; setup() handles earlier additions.
    if (this._proxies !== null) {
      const proxy = this._createProxy(observer);
      this._proxies.set(observer, proxy);
    }
  }

  /**
   * Remove an observer and clean up its resources.
   *
   * @param observer The observer to remove.
   */
  async removeObserver(observer: BaseObserver): Promise<void> {
    // If the observer has a proxy, remove it.
    if (this._proxies && this._proxies.size > 0 && this._proxies.has(observer)) {
      const proxy = this._proxies.get(observer) as Proxy;
      // Remove the proxy so it doesn't get called anymore.
      this._proxies.delete(observer);
      // Cancel the proxy worker right away. An observer removing itself runs
      // on that worker, which can't be cancelled from inside, so the worker
      // ends itself instead.
      if (proxy.task !== currentTask()) {
        await this.cancelTask(proxy.task);
      }
      // Shutdown only cleans up the observers in _proxies.
      await observer.cleanup();
    }

    // Remove the observer from the list.
    const index = this._observers.indexOf(observer);
    if (index >= 0) {
      this._observers.splice(index, 1);
    }
  }

  /**
   * Set up a proxy for every managed observer.
   *
   * Processors report their own setup to observers, so the proxies are in
   * place before any of them is set up.
   *
   * @param taskManager The task manager the proxies run their tasks on.
   */
  override async setup(taskManager: BaseTaskManager | unknown): Promise<void> {
    await super.setup(taskManager);
    this._proxies = this._createProxies(this._observers);

    for (const observer of this._proxies.keys()) {
      await observer.setup(taskManager);
    }
  }

  /**
   * Cleanup all proxy observers.
   *
   * Tearing down is best effort: an observer that raises is logged and the
   * rest are still cleaned up.
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    if (!this._proxies || this._proxies.size === 0) {
      return;
    }

    for (const proxy of this._proxies.values()) {
      await this.cancelTask(proxy.task);
    }

    for (const observer of this._proxies.keys()) {
      try {
        await observer.cleanup();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error cleaning up ${observer}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Forward pipeline started signal to all managed observers. */
  override async onPipelineStarted(): Promise<void> {
    await this._sendToProxy(new _PipelineStartedSignal());
  }

  /**
   * Queue frame data for all managed observers.
   *
   * @param data The frame processing event data to distribute to observers.
   */
  override async onProcessFrame(data: FrameProcessed): Promise<void> {
    await this._sendToProxy(data);
  }

  /**
   * Queue frame data for the managed observers.
   *
   * A repeated push only reaches the observers that want every push.
   *
   * @param data The frame push event data to distribute to observers.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (!this._proxies || this._proxies.size === 0) {
      return;
    }

    const frame = data.frame;
    data.firstPush = !this._framesPushed.has(frame.id);
    if (data.firstPush) {
      this._framesPushed.set(frame.id, frame);
    }

    for (const proxy of this._proxies.values()) {
      if (data.firstPush || proxy.observer.observeEveryPush) {
        await proxy.queue.put(data);
      }
    }
  }

  /**
   * Queue processor setup timing for all managed observers.
   *
   * @param data The processor setup event data to distribute to observers.
   */
  override async onProcessorSetup(data: ProcessorSetUp): Promise<void> {
    await this._sendToProxy(data);
  }

  /** Create a proxy for a single observer. */
  protected _createProxy(observer: BaseObserver): Proxy {
    const queue = new Queue<unknown>();
    const task = this.createTask(
      () => this._proxyTaskHandler(queue, observer),
      "_proxyTaskHandler",
    );
    return new Proxy({ queue, task, observer });
  }

  /** Create proxies for all observers. */
  protected _createProxies(observers: BaseObserver[]): Map<BaseObserver, Proxy> {
    const proxies = new Map<BaseObserver, Proxy>();
    for (const observer of observers) {
      const proxy = this._createProxy(observer);
      proxies.set(observer, proxy);
    }
    return proxies;
  }

  protected async _sendToProxy(data: unknown): Promise<void> {
    if (!this._proxies || this._proxies.size === 0) {
      return;
    }
    for (const proxy of this._proxies.values()) {
      await proxy.queue.put(data);
    }
  }

  /** Handle frame processing for a single observer. */
  protected async _proxyTaskHandler(queue: Queue<unknown>, observer: BaseObserver): Promise<void> {
    while (true) {
      const data = await queue.get();

      if (data instanceof _PipelineStartedSignal) {
        await observer.onPipelineStarted();
      } else if (data instanceof FramePushed) {
        await observer.onPushFrame(data);
      } else if (data instanceof FrameProcessed) {
        await observer.onProcessFrame(data);
      } else if (data instanceof ProcessorSetUp) {
        await observer.onProcessorSetup(data);
      }

      queue.taskDone();

      // Stop once the observer has removed itself (see removeObserver()).
      const proxy = this._proxies && this._proxies.size > 0 ? this._proxies.get(observer) : null;
      if (!proxy || proxy.queue !== queue) {
        break;
      }
    }
  }
}
