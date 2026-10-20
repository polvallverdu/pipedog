// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/runner.py

/**
 * Worker runner for managing worker execution and orchestration.
 *
 * This module provides the `WorkerRunner` class. It runs `BaseWorker`
 * instances (including `PipelineWorker`) to completion, owning the shared
 * `WorkerBus`, the worker registry, and the worker manager that backs the
 * entire session.
 *
 * For a typical single-pipeline bot, register the worker with
 * `WorkerRunner.addWorkers` and then call `WorkerRunner.run`:
 *
 * @example
 * ```ts
 * const runner = new WorkerRunner();
 * await runner.addWorkers(worker);
 * await runner.run();
 * ```
 *
 * For multi-worker setups, register every worker the same way:
 *
 * @example
 * ```ts
 * const runner = new WorkerRunner();
 * await runner.addWorkers(new CodeWorker("code-worker", ...), worker);
 * await runner.run();
 * ```
 *
 * By default, `run()` ends once every root worker has finished — so a
 * single-pipeline bot naturally ends when its pipeline does. Multi-worker
 * bots whose helpers run forever (e.g. waiting for bus messages) end by
 * calling `WorkerRunner.end` / `WorkerRunner.cancel` from an event handler
 * (typically on transport disconnect). For long-lived hosts that add and
 * remove workers over many sessions (e.g. an HTTP server), pass
 * `autoEnd: false` to `run()` so the runner does not exit when no workers
 * are left.
 */

import {
  CancelledError,
  createTask,
  Event,
  gather,
  gatherSettled,
  sleep,
  type Task,
} from "@pipedog/asyncio";
import {
  AsyncQueueBus,
  BusAddWorkerMessage,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusEndMessage,
  BusEndWorkerMessage,
  type BusMessage,
  BusWorkerRegistryMessage,
  type WorkerBus,
} from "../bus/index.ts";
import { BusSubscriber } from "../bus/subscriber.ts";
import { PipelineWorker } from "../pipeline/worker.ts";
import { WorkerRegistry } from "../registry/index.ts";
import { WorkerReadyData, WorkerRegistryEntry } from "../registry/types.ts";
import { type BaseTaskManager, TaskManager } from "../utils/asyncio/task_manager.ts";
import { BaseObject } from "../utils/base_object.ts";
import { logger } from "../utils/logger.ts";
import { runSetupHook } from "../utils/startup.ts";
import { type BaseWorker, WorkerParams } from "./base_worker.ts";

/** A worker registered on the runner and its background task. */
class _WorkerEntry {
  worker: BaseWorker;
  runnerTask: Task<unknown> | null;

  constructor(options: { worker: BaseWorker; runnerTask?: Task<unknown> | null }) {
    this.worker = options.worker;
    this.runnerTask = options.runnerTask ?? null;
  }
}

export interface WorkerRunnerOptions {
  /**
   * Optional name for the runner instance. Defaults to a UUID-based name.
   * Must be unique across runners in a distributed setup.
   */
  name?: string | null;
  /** Optional `WorkerBus`. Defaults to a new in-process `AsyncQueueBus`. */
  bus?: WorkerBus | null;
  /** Whether to automatically handle SIGINT signals. */
  handleSigint?: boolean;
  /** Whether to automatically handle SIGTERM signals. */
  handleSigterm?: boolean;
  /** Whether to force garbage collection once every worker has been torn down. */
  forceGc?: boolean;
  /**
   * Whether to warn about tasks left running on the shared task manager once
   * every worker has finished.
   */
  checkDanglingTasks?: boolean;
  /** Optional task manager for handling tasks. */
  taskManager?: BaseTaskManager | null;
}

export interface WorkerRunnerRunOptions {
  /**
   * When true (the default), the runner ends once every root worker has
   * finished. When false, the runner blocks until `end()` or `cancel()` is
   * called.
   */
  autoEnd?: boolean;
}

type SignalName = "SIGINT" | "SIGTERM";

interface SignalProcess {
  on?(signal: SignalName, listener: () => void): unknown;
}

/** The host's `process`, when it has one that delivers signals (Bun, Node, Deno). */
function signalProcess(): SignalProcess | undefined {
  const proc = (globalThis as { process?: SignalProcess }).process;
  return proc && typeof proc.on === "function" ? proc : undefined;
}

/**
 * Manages worker execution.
 *
 * Provides a high-level interface for running workers with automatic signal
 * handling (SIGINT/SIGTERM), optional garbage collection, proper cleanup of
 * resources, and a worker bus + registry for multi-worker orchestration.
 *
 * Two entry points:
 *
 * - `addWorkers(...workers)` — register one or more workers on the runner's
 *   bus and start them in the background. Workers run concurrently and
 *   remaining workers are cancelled when the runner ends.
 * - `run()` — block until the runner ends. By default (`autoEnd: true`) the
 *   runner ends once every root worker has finished; pass `autoEnd: false`
 *   to keep the runner up until `end()` / `cancel()` is called.
 *
 * Event handlers available:
 *
 * - `on_ready` — fired after the runner has finished its initialization and
 *   any added workers have been started.
 * - `on_error` — fired when starting an added worker fails.
 */
export class WorkerRunner extends BusSubscriber(BaseObject) {
  protected _bus: WorkerBus;
  protected _registry: WorkerRegistry;
  protected _checkDanglingTasks: boolean;

  protected _entries = new Map<string, _WorkerEntry>();
  protected _knownRunners = new Set<string>();
  protected _running = false;
  protected _autoEnd = true;
  protected _cancelReason: string | null = null;
  protected _shutdownEvent = new Event();
  protected _sigTask: Task<void> | null = null;

  protected _handleSigint: boolean;
  protected _handleSigterm: boolean;
  protected _forceGc: boolean;

  /**
   * Initialize the worker runner.
   *
   * @param options Runner options (see `WorkerRunnerOptions`).
   */
  constructor(options: WorkerRunnerOptions = {}) {
    const taskManager = options.taskManager || new TaskManager();
    const name = options.name || `runner-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    super({ name, taskManager });

    this._bus = options.bus || new AsyncQueueBus();
    this._registry = new WorkerRegistry(this.name);
    this._checkDanglingTasks = options.checkDanglingTasks ?? true;

    this._handleSigint = options.handleSigint ?? true;
    this._handleSigterm = options.handleSigterm ?? false;
    this._forceGc = options.forceGc ?? false;

    this._registerEventHandler("on_ready");
    this._registerEventHandler("on_error");
  }

  /** The bus this runner hosts; shared across launched workers. */
  get bus(): WorkerBus {
    return this._bus;
  }

  /** The worker registry this runner owns. */
  get registry(): WorkerRegistry {
    return this._registry;
  }

  /**
   * Look up a worker running on this runner by name.
   *
   * Only workers added to this runner have a local instance to return. A
   * worker on another runner is addressable over the bus by name but has no
   * object here, so it looks the same as an unknown name.
   *
   * @param name The name the worker was created with.
   * @returns The worker, or null if this runner has no worker by that name.
   */
  getWorker(name: string): BaseWorker | null {
    const entry = this._entries.get(name);
    return entry ? entry.worker : null;
  }

  /**
   * Add one or more workers to the runner.
   *
   * Adding a worker attaches it to the runner's bus and registry, and starts
   * it in the background. If the runner is not yet running (`addWorkers` was
   * called before `run()`), workers are queued and started during run setup;
   * if the runner is already running, each worker starts immediately.
   *
   * Every added worker is a peer: the runner privileges none of them. They
   * run concurrently, and whichever are still running when the runner ends
   * are cancelled. With `autoEnd: true` the runner ends once every root
   * worker has finished, so a worker that never finishes on its own, such as
   * a bus-only one waiting for messages, keeps it up until `end()` or
   * `cancel()` is called.
   *
   * @param workers One or more workers to add.
   */
  async addWorkers(...workers: BaseWorker[]): Promise<void> {
    for (const worker of workers) {
      if (this._entries.has(worker.name)) {
        logger.error(`WorkerRunner '${this}': worker '${worker.name}' already exists, skipping`);
        continue;
      }
      // `attach` is async because it also subscribes the worker to the bus —
      // eager subscription is required so workers added later are listening
      // before earlier workers emit their first messages.
      await worker.attach({ registry: this._registry, bus: this._bus, workerRunner: this });
      await this._registry.watch(worker.name, (data) => this._onLocalWorkerReady(data));
      const entry = new _WorkerEntry({ worker });
      this._entries.set(worker.name, entry);
      logger.debug(`WorkerRunner '${this}': added worker '${worker.name}'`);

      if (this._running) {
        await this._startWorker(entry);
      }
    }
  }

  /**
   * Run all added workers until the runner is stopped.
   *
   * By default (`autoEnd: true`), the runner ends once every root worker has
   * finished — so a single-pipeline bot naturally ends when its pipeline
   * does. Multi-worker bots whose helpers run forever (e.g. waiting for bus
   * messages) end by calling `end()` / `cancel()` from an event handler
   * (typically on transport disconnect). For long-lived hosts that add and
   * remove workers over many sessions (e.g. an HTTP server), pass
   * `autoEnd: false` so the runner does not exit when no workers are left.
   *
   * @param options.autoEnd When true (the default), the runner ends once
   *   every root worker has finished. When false, the runner blocks until
   *   `end()` or `cancel()` is called.
   */
  async run(options: WorkerRunnerRunOptions = {}): Promise<void> {
    logger.debug(`WorkerRunner '${this}': started running`);
    this._autoEnd = options.autoEnd ?? true;
    this._shutdownEvent.clear();

    await this._setupSession();
    await this._callEventHandler("on_ready");

    // Wait for shutdown. With `autoEnd: true`, `_runWorker` sets
    // `_shutdownEvent` once the last root worker finishes.
    try {
      await this._shutdownEvent.wait();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }

    try {
      // Cancel any worker still going and wait for it to finish.
      await this._cancelSpawnedWorkers();

      // Cleanup base object.
      await this.cleanup();

      // If we are cancelling through a signal, make sure we wait for it so
      // everything gets cleaned up nicely.
      if (this._sigTask) {
        await this._sigTask;
      }
    } finally {
      await this._bus.stop();
      this._running = false;
    }

    if (this._forceGc) {
      await this._gcCollect();
    }

    // Report dangling tasks on the shared task manager after everything has
    // been torn down. Workers sharing this task manager leave the report to
    // us; only workers with their own task manager report themselves.
    this._printDanglingTasks();

    logger.debug(`WorkerRunner '${this}': finished running`);
  }

  /** Schedule all root pipeline workers to stop when their current processing is complete. */
  async stopWhenDone(): Promise<void> {
    logger.debug(`WorkerRunner '${this}': scheduled to stop when all workers are done`);
    await gather(
      ...[...this._entries.values()]
        .filter((entry) => entry.worker instanceof PipelineWorker && entry.worker.parent === null)
        .map((entry) => () => (entry.worker as PipelineWorker).stopWhenDone()),
    );
  }

  /**
   * Gracefully end all running workers.
   *
   * Idempotent; subsequent calls are ignored.
   *
   * @param reason Optional human-readable reason for ending.
   */
  async end(reason: string | null = null): Promise<void> {
    if (this._shutdownEvent.isSet()) {
      return;
    }
    logger.debug(`WorkerRunner '${this}': ending gracefully (reason=${reason})`);
    this._shutdownEvent.set();
    await this._finishRunningWorkers(BusEndWorkerMessage, reason);
  }

  /**
   * Immediately cancel all running workers.
   *
   * Signals shutdown, which `run()` answers by cancelling every worker still
   * going and waiting for it. Idempotent; subsequent calls are ignored.
   *
   * @param reason Optional human-readable reason for cancelling. Reaches each
   *   worker on the cancel message sent as the runner exits.
   */
  async cancel(reason: string | null = null): Promise<void> {
    if (this._shutdownEvent.isSet()) {
      return;
    }
    logger.debug(`WorkerRunner '${this}': cancelling (reason=${reason})`);
    this._cancelReason = reason;
    this._shutdownEvent.set();
  }

  /** Process incoming bus messages for runner-level concerns. */
  override async onBusMessage(message: BusMessage): Promise<void> {
    if (message.source === this.name) {
      return;
    }
    if (message instanceof BusEndMessage) {
      this.createTask(() => this.end(message.reason), "end");
    } else if (message instanceof BusCancelMessage) {
      this.createTask(() => this.cancel(message.reason), "cancel");
    } else if (message instanceof BusAddWorkerMessage && message.worker) {
      await this.addWorkers(message.worker);
    } else if (message instanceof BusWorkerRegistryMessage) {
      await this._handleWorkerRegistry(message);
    }
  }

  /** One-time per-run setup: worker manager, bus, signal handlers, launched workers. */
  protected async _setupSession(): Promise<void> {
    if (this._running) {
      return;
    }
    await this._bus.setup(this.taskManager);

    if (this._handleSigint) {
      this._setupSigint();
    }
    if (this._handleSigterm) {
      this._setupSigterm();
    }

    await this._bus.subscribe(this);
    await this._bus.start();

    await this._loadSetupFiles();

    // Running from here on, so a worker that adds another one while it
    // starts gets it started right away through addWorkers().
    this._running = true;

    for (const entry of [...this._entries.values()]) {
      await this._startWorker(entry);
    }
  }

  /**
   * Cancel every worker still going and wait for it to finish.
   *
   * The one place the runner cancels its workers, reached on every way out:
   * an ended session, a cancelled one, or the last root worker finishing. A
   * worker whose task has already finished is left alone.
   */
  protected async _cancelSpawnedWorkers(): Promise<void> {
    const running = await this._finishRunningWorkers(
      BusCancelWorkerMessage,
      this._cancelReason || "runner exiting",
    );
    await gatherSettled(
      ...running.flatMap((entry) => (entry.runnerTask ? [entry.runnerTask] : [])),
    );
  }

  /**
   * Ask each root worker that has not finished to wind down.
   *
   * Both messages this takes end a worker, gracefully or not. A worker whose
   * task has already finished is skipped; one that has not started yet has
   * not finished either, so it is still told.
   *
   * Sending is all this does. The worker finishes in its own time, which is
   * what the returned entries are for.
   *
   * @param messageClass The per-worker message to send.
   * @param reason Optional human-readable reason, carried on each message.
   * @returns The entries that were messaged, root or otherwise.
   */
  protected async _finishRunningWorkers(
    messageClass: typeof BusEndWorkerMessage | typeof BusCancelWorkerMessage,
    reason: string | null,
  ): Promise<_WorkerEntry[]> {
    // A worker with no task has not started rather than finished, so it is
    // still owed the message.
    const running = [...this._entries.values()].filter((entry) => !entry.runnerTask?.done());
    for (const entry of running) {
      if (entry.worker.parent === null) {
        await this._bus.send(
          new messageClass({ source: this.name, target: entry.worker.name, reason }),
        );
      }
    }
    return running;
  }

  /**
   * Run `setup_worker_runner` from each file in `PIPECAT_SETUP_FILES`.
   *
   * A setup file may define `setup_worker_runner(runner)` (or `setupWorkerRunner`) to add workers,
   * attach event handlers, or wire other runner-level configuration.
   */
  protected async _loadSetupFiles(): Promise<void> {
    await runSetupHook({ target: this, functionName: "setup_worker_runner" });
  }

  /** Run a registered worker as a background task. */
  protected async _startWorker(entry: _WorkerEntry): Promise<void> {
    const worker = entry.worker;
    logger.debug(`WorkerRunner '${this}': starting worker '${worker.name}'`);

    entry.runnerTask = this.createTask(() => this._runWorker(worker), `task_${worker.name}`);
    // Add the worker to event loop right away without needing to `await`.
    await sleep(0);
  }

  /** Drive a registered worker to completion. */
  protected async _runWorker(worker: BaseWorker): Promise<void> {
    try {
      const params = new WorkerParams({ taskManager: this.taskManager });
      await worker.run(params);
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    } finally {
      // End the runner once every root worker has finished. The current
      // worker's task is still "running" (we're inside its body), so exclude
      // it from the check.
      if (this._autoEnd && worker.parent === null) {
        const othersRunning = [...this._entries.values()].some(
          (e) =>
            e.worker.parent === null &&
            e.worker !== worker &&
            e.runnerTask !== null &&
            !e.runnerTask.done(),
        );
        if (!othersRunning) {
          this._shutdownEvent.set();
        }
      }
    }
  }

  /** Called when a local added worker registers as ready. */
  protected async _onLocalWorkerReady(data: WorkerReadyData): Promise<void> {
    if (data.runner !== this.name) {
      return;
    }
    const entry = this._entries.get(data.workerName);
    if (!entry || entry.worker.parent !== null) {
      return;
    }
    await this._sendRegistry();
  }

  /** Broadcast this runner's workers to the bus. */
  protected async _sendRegistry(): Promise<void> {
    const workers = [...this._entries.values()].map(
      (entry) =>
        new WorkerRegistryEntry({
          name: entry.worker.name,
          parent: entry.worker.parent,
          active: entry.worker.active,
          bridged: entry.worker.bridged,
          startedAt: entry.worker.startedAt,
        }),
    );
    if (workers.length > 0) {
      const names = workers.map((w) => w.name);
      logger.debug(
        `WorkerRunner '${this}': broadcasting registry: [${names.map((n) => `'${n}'`).join(", ")}]`,
      );
      await this._bus.send(
        new BusWorkerRegistryMessage({
          source: this.name,
          runner: this.name,
          workers,
        }),
      );
    }
  }

  /** Handle a registry message from a remote runner. */
  protected async _handleWorkerRegistry(message: BusWorkerRegistryMessage): Promise<void> {
    const workerNames = message.workers.map((w) => w.name);
    logger.debug(
      `WorkerRunner '${this}': received registry from '${message.runner}' ` +
        `with workers: [${workerNames.map((n) => `'${n}'`).join(", ")}]`,
    );
    for (const entry of message.workers) {
      await this._registry.register(
        new WorkerReadyData({ workerName: entry.name, runner: message.runner }),
      );
    }
    if (!this._knownRunners.has(message.runner)) {
      this._knownRunners.add(message.runner);
      logger.debug(
        `WorkerRunner '${this}': new runner '${message.runner}', sending our registry back`,
      );
      await this._sendRegistry();
    }
  }

  /**
   * Set up SIGINT handler for graceful shutdown.
   *
   * DIVERGENCE: installed through the host's `process.on` when there is one
   * (Bun, Node, Deno); a no-op on runtimes without process signals (Workers).
   */
  protected _setupSigint(): void {
    signalProcess()?.on?.("SIGINT", () => this._sigHandler());
  }

  /**
   * Set up SIGTERM handler for graceful shutdown.
   *
   * DIVERGENCE: see `_setupSigint`.
   */
  protected _setupSigterm(): void {
    signalProcess()?.on?.("SIGTERM", () => this._sigHandler());
  }

  /** Handle interrupt signals by cancelling the runner. */
  protected _sigHandler(): void {
    if (!this._sigTask) {
      this._sigTask = createTask(() => this._sigCancel());
    }
  }

  /** Cancel the runner due to signal interruption. */
  protected async _sigCancel(): Promise<void> {
    logger.warning(`WorkerRunner '${this}': interruption detected, cancelling.`);
    await this.cancel("interrupt signal");
  }

  /**
   * Force garbage collection and log results.
   *
   * DIVERGENCE: JS has no `gc.collect()` count or `gc.garbage`; this calls
   * the global `gc()` when the runtime exposes one (e.g. Node/Deno with
   * `--expose-gc`).
   */
  protected async _gcCollect(): Promise<void> {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === "function") {
      gc();
      logger.debug("Garbage collector: collected.");
    } else {
      logger.debug("Garbage collector: not exposed by this runtime, skipping.");
    }
  }

  /** Warn about tasks left running on the task manager this runner owns. */
  protected _printDanglingTasks(): void {
    if (this._checkDanglingTasks) {
      const tasks = this.taskManager.currentTasks().map((t) => t.getName());
      if (tasks.length > 0) {
        logger.warning(
          `${this} dangling tasks detected: [${tasks.map((t) => `'${t}'`).join(", ")}]`,
        );
      }
    }
  }
}
