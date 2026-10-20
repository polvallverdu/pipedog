// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/registry/registry.py

/** Shared registry for tracking known workers across runners. */

import { logger } from "../utils/logger.ts";
import type { WorkerReadyData } from "./types.ts";

export type WatchHandler = (data: WorkerReadyData) => Promise<unknown>;

/**
 * Tracks all known workers across local and remote runners.
 *
 * Owned by a runner and shared with its workers. Organizes workers into
 * local (this runner) and remote (other runners) so they are easy to
 * distinguish. Deduplication is built in: each worker name is
 * registered at most once.
 *
 * Notifications use a targeted watch mechanism: call
 * `watch(workerName, handler)` to be notified when a specific worker
 * registers.
 */
export class WorkerRegistry {
  protected _runnerName: string;
  protected _localWorkers = new Map<string, WorkerReadyData>();
  protected _remoteWorkers = new Map<string, Map<string, WorkerReadyData>>();
  protected _watches = new Map<string, WatchHandler[]>();

  /**
   * Initialize the WorkerRegistry.
   *
   * @param runnerName Name of the runner that owns this registry.
   */
  constructor(runnerName: string) {
    this._runnerName = runnerName;
  }

  /** The name of the runner that owns this registry. */
  get runnerName(): string {
    return this._runnerName;
  }

  /** Names of workers registered under this runner. */
  get localWorkers(): string[] {
    return [...this._localWorkers.keys()];
  }

  /** Names of workers registered under remote runners. */
  get remoteWorkers(): string[] {
    const result: string[] = [];
    for (const workers of this._remoteWorkers.values()) {
      result.push(...workers.keys());
    }
    return result;
  }

  /**
   * Look up a registered worker by name.
   *
   * @param workerName The worker name to look up.
   * @returns The worker's `WorkerReadyData`, or null if not found.
   */
  get(workerName: string): WorkerReadyData | null {
    const local = this._localWorkers.get(workerName);
    if (local) {
      return local;
    }
    for (const workers of this._remoteWorkers.values()) {
      const remote = workers.get(workerName);
      if (remote) {
        return remote;
      }
    }
    return null;
  }

  /** Whether a worker with this name is registered (Python's `in`). */
  has(workerName: string): boolean {
    return this.get(workerName) !== null;
  }

  /**
   * Watch for a specific worker's registration.
   *
   * Idempotent: registering the same `(workerName, handler)` pair more than
   * once is a no-op (otherwise the handler would fire multiple times when the
   * worker registers — e.g. when a parent both calls `addWorkers(child)`
   * (which auto-watches) and declares a `workerReady({ name: child.name })`
   * handler that the framework also installs).
   *
   * If the worker is already registered, the handler fires immediately.
   *
   * @param workerName The worker name to watch for.
   * @param handler Async callable invoked with the worker's data.
   */
  async watch(workerName: string, handler: WatchHandler): Promise<void> {
    let handlers = this._watches.get(workerName);
    if (!handlers) {
      handlers = [];
      this._watches.set(workerName, handlers);
    }
    if (handlers.includes(handler)) {
      return;
    }
    handlers.push(handler);
    const existing = this.get(workerName);
    if (existing) {
      await handler(existing);
    }
  }

  /**
   * Register a worker. Returns true if the worker was new.
   *
   * If the worker is already registered, this is a no-op and returns false.
   * Otherwise the worker is added and watchers are notified.
   *
   * @param workerData Information about the worker to register.
   * @returns True if the worker was newly registered, false if already known.
   */
  async register(workerData: WorkerReadyData): Promise<boolean> {
    const isLocal = workerData.runner === this._runnerName;
    let target: Map<string, WorkerReadyData>;
    if (isLocal) {
      target = this._localWorkers;
    } else {
      let remote = this._remoteWorkers.get(workerData.runner);
      if (!remote) {
        remote = new Map();
        this._remoteWorkers.set(workerData.runner, remote);
      }
      target = remote;
    }

    if (target.has(workerData.workerName)) {
      return false;
    }

    // Warn if the same name exists on a different runner
    const existing = this.get(workerData.workerName);
    if (existing && existing.runner !== workerData.runner) {
      logger.warning(
        `Worker '${workerData.workerName}' registered on both ` +
          `'${existing.runner}' and '${workerData.runner}'`,
      );
    }

    target.set(workerData.workerName, workerData);
    const locality = isLocal ? "local" : workerData.runner;
    logger.debug(`Worker '${workerData.workerName}' ready (${locality})`);
    await this._notify(workerData);
    return true;
  }

  /** Notify watchers of a new registration. */
  protected async _notify(workerData: WorkerReadyData): Promise<void> {
    // Iterate the live list by index, as Python does: handlers appended
    // during notification are visited too.
    const handlers = this._watches.get(workerData.workerName) ?? [];
    for (let i = 0; i < handlers.length; i++) {
      await (handlers[i] as WatchHandler)(workerData);
    }
  }
}
