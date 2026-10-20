// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/asyncio/task_manager.py

/**
 * Asyncio task management.
 *
 * Provides task management functionality, including abstract base classes and
 * concrete implementations for managing tasks with monitoring and cleanup.
 */

import {
  CancelledError,
  createTask,
  currentTask,
  monotonic,
  type Task,
  type TaskFn,
  TimeoutError,
  waitFor,
} from "@pipecat-ts/asyncio";
import { logger } from "../logger.ts";

/** Stand-in for asyncio's event loop: only its clock is used by pipecat. */
export interface EventLoop {
  /** Monotonic time in seconds. */
  time(): number;
}

const defaultLoop: EventLoop = { time: monotonic };

export function getRunningLoop(): EventLoop {
  return defaultLoop;
}

/**
 * Abstract base class for task management.
 *
 * Provides the interface for creating, monitoring, and managing tasks.
 */
export abstract class BaseTaskManager {
  /** Get the event loop used by this task manager. */
  abstract getEventLoop(): EventLoop;

  /**
   * Creates and schedules a new task that runs the given coroutine function.
   * The task is added to the set of created tasks.
   */
  abstract createTask<T>(coroutine: TaskFn<T>, name: string): Task<T | undefined>;

  /**
   * Cancels the given task and awaits its completion with an optional timeout
   * (seconds). Cancelling the task this call runs on is logged and ignored.
   */
  abstract cancelTask(task: Task<unknown>, timeout?: number | null): Promise<void>;

  /** Returns the list of currently created/registered tasks. */
  abstract currentTasks(): readonly Task<unknown>[];
}

/**
 * Concrete implementation of BaseTaskManager. Manages task lifecycle
 * including creation, monitoring, cancellation, and cleanup.
 */
export class TaskManager extends BaseTaskManager {
  readonly #loop: EventLoop;
  readonly #tasks = new Set<Task<unknown>>();

  constructor(options: { loop?: EventLoop } = {}) {
    super();
    this.#loop = options.loop ?? getRunningLoop();
  }

  getEventLoop(): EventLoop {
    return this.#loop;
  }

  createTask<T>(coroutine: TaskFn<T>, name: string): Task<T | undefined> {
    const runCoroutine = async (): Promise<T | undefined> => {
      try {
        return await coroutine();
      } catch (e) {
        if (e instanceof CancelledError) {
          logger.trace(`${name}: task cancelled`);
          // Re-raise the exception to ensure the task is cancelled.
          throw e;
        }
        logger.error(`${name} unexpected exception: ${errorMessage(e)}`, e);
        return undefined;
      }
    };

    const task = createTask(runCoroutine, name);
    task.addDoneCallback((t) => this.#taskDoneHandler(t));
    this.#tasks.add(task);
    logger.trace(`${name}: task created`);
    return task;
  }

  async cancelTask(task: Task<unknown>, timeout: number | null = null): Promise<void> {
    const name = task.getName();
    const current = currentTask();

    if (task === current) {
      logger.warning(`${name}: ignoring attempt to cancel the running task`);
      return;
    }

    const cancelsRequested = current ? current.cancelling() : 0;
    task.cancel();
    try {
      if (timeout) {
        await waitFor(task, timeout);
      } else {
        await task;
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        logger.warning(`${name}: timed out waiting for task to cancel`);
      } else if (e instanceof CancelledError) {
        // Either `task` finished cancelling, or the calling task was
        // cancelled while we waited. Only the latter may propagate.
        if (current && current.cancelling() > cancelsRequested) {
          throw e;
        }
      } else {
        logger.error(`${name} unexpected exception while cancelling task: ${errorMessage(e)}`, e);
      }
    }
  }

  currentTasks(): readonly Task<unknown>[] {
    return [...this.#tasks];
  }

  #taskDoneHandler(task: Task<unknown>): void {
    if (!this.#tasks.delete(task)) {
      logger.trace(`${task.getName()}: unable to remove task data (already removed?)`);
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
