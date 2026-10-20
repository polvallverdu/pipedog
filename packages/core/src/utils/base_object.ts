// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/base_object.py

/**
 * Base object class providing event handling and lifecycle management.
 *
 * Offers unique identification, naming, event handling, and async cleanup for
 * all Pipecat components.
 */

import {
  createTask,
  currentTask,
  rethrowIfCancelled,
  type Task,
  type TaskFn,
  wait,
} from "@pipecat-ts/asyncio";
import type { BaseTaskManager } from "./asyncio/task_manager.ts";
import { logger } from "./logger.ts";
import { objCount, objId } from "./utils.ts";

export type EventHandlerFn<Self = any> = (self: Self, ...args: any[]) => unknown;

/** Stores an event name, its handlers, and whether they run inline (sync). */
export interface EventHandler {
  name: string;
  handlers: EventHandlerFn[];
  isSync: boolean;
}

export interface BaseObjectOptions {
  /** Custom name; defaults to `ClassName#count`. */
  name?: string | null;
  /** Task manager for handling tasks. */
  taskManager?: BaseTaskManager | null;
}

/**
 * Abstract base class providing common functionality for Pipecat objects:
 * unique identification, naming, event handling and async lifecycle.
 */
export abstract class BaseObject {
  protected _id: number;
  protected _name: string;
  protected _taskManager: BaseTaskManager | null;

  // Registered event handlers.
  protected _eventHandlers = new Map<string, EventHandler>();

  // Event handler tasks being executed; removed when they finish. Cleanup
  // waits for those still running.
  protected _eventTasks = new Set<[string, Task<unknown>]>();

  constructor(options: BaseObjectOptions = {}) {
    this._id = objId();
    this._name = options.name || `${this.constructor.name}#${objCount(this)}`;
    this._taskManager = options.taskManager ?? null;
  }

  /** The unique identifier for this object. */
  get id(): number {
    return this._id;
  }

  /** The object's name, either custom-provided or auto-generated. */
  get name(): string {
    return this._name;
  }

  /** The task manager. Throws if not initialized. */
  get taskManager(): BaseTaskManager {
    if (!this._taskManager) {
      throw new Error(`${this}: TaskManager is not initialized.`);
    }
    return this._taskManager;
  }

  /**
   * Wire the object up with a task manager. Owners of a BaseObject should
   * call this on their child objects to propagate the task manager down.
   */
  // Typed `unknown` so subclasses can narrow it (FrameProcessor.setup takes a
  // FrameProcessorSetup, as upstream does).
  async setup(taskManager: BaseTaskManager | unknown): Promise<void> {
    this._taskManager = taskManager as BaseTaskManager;
  }

  /** Create a new task managed by this object's task manager. */
  createTask<T>(coroutine: TaskFn<T>, name?: string | null): Task<T | undefined> {
    const taskName = name || coroutine.name || "task";
    return this.taskManager.createTask(coroutine, `${this}::${taskName}`);
  }

  /**
   * Cancel a task managed by this object's task manager. A default timeout of
   * 1 second avoids freezes caused by code that swallows cancellation.
   */
  async cancelTask(task: Task<unknown>, timeout: number | null = 1.0): Promise<void> {
    await this.taskManager.cancelTask(task, timeout);
  }

  /**
   * Clean up resources and wait for running event handlers to complete,
   * except the one it is called from, since a task can't wait for itself.
   */
  async cleanup(): Promise<void> {
    const current = currentTask();
    const eventTasks = [...this._eventTasks].filter(([, task]) => task !== current);
    if (eventTasks.length > 0) {
      const names = eventTasks.map(([name]) => name);
      logger.debug(`${this}: waiting on event handlers to finish [${names.join(", ")}]...`);
      await wait(eventTasks.map(([, task]) => task));
    }
  }

  /**
   * Register a handler for an event. Equivalent of Python's
   * `@obj.event_handler("on_x")` decorator; returns the handler.
   */
  eventHandler<F extends EventHandlerFn<this>>(eventName: string, handler: F): F {
    this.addEventHandler(eventName, handler);
    return handler;
  }

  /** Add an event handler for the specified event. Can be sync or async. */
  addEventHandler(eventName: string, handler: EventHandlerFn<this>): void {
    const eventHandler = this._eventHandlers.get(eventName);
    if (eventHandler) {
      eventHandler.handlers.push(handler);
    } else {
      logger.warning(`${this}: event handler ${eventName} not registered`);
    }
  }

  /** Remove a previously added event handler. No-op if unknown. */
  removeEventHandler(eventName: string, handler: EventHandlerFn<this>): void {
    const eventHandler = this._eventHandlers.get(eventName);
    if (!eventHandler) return;
    const index = eventHandler.handlers.indexOf(handler);
    if (index >= 0) eventHandler.handlers.splice(index, 1);
  }

  /**
   * Register an event handler type.
   *
   * @param sync Whether handlers run inline (awaited) instead of in a task.
   */
  protected _registerEventHandler(eventName: string, sync = false): void {
    if (!this._eventHandlers.has(eventName)) {
      this._eventHandlers.set(eventName, { name: eventName, handlers: [], isSync: sync });
    } else {
      logger.warning(`${this}: event handler ${eventName} already registered`);
    }
  }

  /** Call all registered handlers for the specified event. */
  protected async _callEventHandler(eventName: string, ...args: any[]): Promise<void> {
    const eventHandler = this._eventHandlers.get(eventName);
    if (!eventHandler) return;

    for (const handler of eventHandler.handlers) {
      if (eventHandler.isSync) {
        await this._runHandler(eventHandler.name, handler, ...args);
      } else {
        // A task per handler function. Users can register to an event
        // handler multiple times.
        const task = createTask(() => this._runHandler(eventHandler.name, handler, ...args));
        const entry: [string, Task<unknown>] = [eventName, task];
        this._eventTasks.add(entry);
        task.addDoneCallback(() => this._eventTasks.delete(entry));
      }
    }
  }

  protected async _runHandler(eventName: string, handler: EventHandlerFn, ...args: any[]) {
    try {
      await handler(this, ...args);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(
        `${this}: uncaught exception in event handler '${eventName}': ${e instanceof Error ? e.message : e}`,
        e,
      );
    }
  }

  toString(): string {
    return this.name;
  }
}
