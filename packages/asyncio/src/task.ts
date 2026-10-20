// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// asyncio-style tasks with cooperative cancellation.
//
// Python delivers `CancelledError` *into* a coroutine at the await it is
// suspended on. JavaScript cannot interrupt an arbitrary await, so we emulate
// it: every primitive in this package (sleep, Event.wait, Queue.get, awaiting a
// Task, waitFor, gather...) is a "cancellation point". When a task is
// cancelled:
//
//   - if it is suspended on a cancellation point, that await rejects with
//     CancelledError right away (the request is consumed, as in asyncio);
//   - otherwise the request stays pending and the next cancellation point the
//     task reaches throws it;
//   - `task.signal` is aborted, so foreign awaits (fetch, WebSocket, SDKs) can
//     be made cancellable by passing the signal or wrapping them in
//     `abortable()`.
//
// The current task is tracked with AsyncLocalStorage, which Bun, Node, Deno
// and Cloudflare Workers (nodejs_compat) all provide.

/// <reference path="./async-hooks.d.ts" />
// (The reference keeps the declaration with this file: packages that compile
// it from source through the workspace exports don't include async-hooks.d.ts.)

import { AsyncLocalStorage } from "node:async_hooks";

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor(message = "Task cancelled") {
    super(message);
  }
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
  constructor(message = "Timed out") {
    super(message);
  }
}

export class InvalidStateError extends Error {
  override name = "InvalidStateError";
}

/** Whether `e` is a cancellation. Use it to re-throw in broad `catch` blocks. */
export function isCancelledError(e: unknown): e is CancelledError {
  return e instanceof CancelledError;
}

/**
 * Re-throw `e` if it is a cancellation. Python's `except Exception` does not
 * catch `CancelledError` (it is a BaseException); JavaScript's `catch` catches
 * everything, so ported `except Exception` blocks start with this call.
 */
export function rethrowIfCancelled(e: unknown): void {
  if (e instanceof CancelledError) throw e;
}

const storage = new AsyncLocalStorage<Task<unknown>>();

/** The task the caller is running in, if any (asyncio.current_task). */
export function currentTask(): Task<unknown> | undefined {
  return storage.getStore();
}

type Waiter = (error: CancelledError) => void;

let taskCounter = 0;

export type TaskFn<T> = () => Promise<T> | T;

/**
 * A unit of concurrent work, like asyncio.Task. Created with `createTask()`.
 * Awaiting a Task (it is thenable) is a cancellation point; cancelling the
 * awaiting task also cancels the awaited one, as in asyncio.
 */
export class Task<T> implements PromiseLike<T> {
  readonly #controller = new AbortController();
  readonly #promise: Promise<T>;
  readonly #waiters = new Set<Waiter>();
  readonly #doneCallbacks: ((task: any) => void)[] = [];
  #name: string;
  #state: "pending" | "fulfilled" | "rejected" | "cancelled" = "pending";
  #result: T | undefined;
  #error: unknown;
  #mustCancel = false;
  #cancelMessage: string | undefined;
  #cancelRequests = 0;

  constructor(fn: TaskFn<T>, name?: string) {
    this.#name = name ?? `Task-${++taskCounter}`;
    this.#promise = storage.run(this as Task<unknown>, async () => {
      // Like asyncio, a task never starts running synchronously in the
      // caller: it starts once the caller yields.
      await Promise.resolve();
      this.checkpoint();
      return await fn();
    });
    this.#promise.then(
      (value) => this.#settle("fulfilled", value, undefined),
      (error) =>
        this.#settle(error instanceof CancelledError ? "cancelled" : "rejected", undefined, error),
    );
  }

  get name(): string {
    return this.#name;
  }

  /** asyncio Task.get_name() */
  getName(): string {
    return this.#name;
  }

  setName(name: string): void {
    this.#name = name;
  }

  /** Aborted when cancellation is requested. Pass it to fetch() and friends. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  done(): boolean {
    return this.#state !== "pending";
  }

  cancelled(): boolean {
    return this.#state === "cancelled";
  }

  /** Number of pending cancellation requests (asyncio Task.cancelling()). */
  cancelling(): number {
    return this.#cancelRequests;
  }

  uncancel(): number {
    if (this.#cancelRequests > 0) this.#cancelRequests--;
    if (this.#cancelRequests === 0) this.#mustCancel = false;
    return this.#cancelRequests;
  }

  result(): T {
    if (this.#state === "pending") throw new InvalidStateError("Result is not set.");
    if (this.#state === "fulfilled") return this.#result as T;
    throw this.#error;
  }

  exception(): unknown {
    if (this.#state === "pending") throw new InvalidStateError("Exception is not set.");
    if (this.#state === "cancelled") throw this.#error;
    return this.#state === "rejected" ? this.#error : undefined;
  }

  addDoneCallback(callback: (task: Task<T>) => void): void {
    if (this.done()) {
      queueMicrotask(() => callback(this));
    } else {
      this.#doneCallbacks.push(callback);
    }
  }

  removeDoneCallback(callback: (task: Task<T>) => void): number {
    const before = this.#doneCallbacks.length;
    for (let i = this.#doneCallbacks.length - 1; i >= 0; i--) {
      if (this.#doneCallbacks[i] === callback) this.#doneCallbacks.splice(i, 1);
    }
    return before - this.#doneCallbacks.length;
  }

  /**
   * Request cancellation. Returns false if the task is already done.
   */
  cancel(message?: string): boolean {
    if (this.done()) return false;
    this.#cancelRequests++;
    this.#cancelMessage = message;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new CancelledError(message));
    }
    if (this.#waiters.size > 0) {
      // Deliver to the await the task is suspended on; consumed.
      const waiters = [...this.#waiters];
      this.#waiters.clear();
      for (const waiter of waiters) waiter(new CancelledError(message));
    } else {
      this.#mustCancel = true;
    }
    return true;
  }

  /**
   * Throw CancelledError if a cancellation request is pending. Every
   * primitive calls this before suspending.
   */
  checkpoint(): void {
    if (this.#mustCancel) {
      this.#mustCancel = false;
      throw new CancelledError(this.#cancelMessage);
    }
  }

  /** @internal Register the rejecter of the await this task is suspended on. */
  _addWaiter(waiter: Waiter): void {
    this.#waiters.add(waiter);
  }

  /** @internal */
  _removeWaiter(waiter: Waiter): void {
    this.#waiters.delete(waiter);
  }

  /** A promise that settles with the task, without being a cancellation point. */
  get promise(): Promise<T> {
    return this.#promise;
  }

  // biome-ignore lint/suspicious/noThenProperty: Tasks are awaitable by design, like asyncio.
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const awaited = suspend<T>(
      (resolve, reject) => {
        this.#promise.then(resolve, reject);
        return () => {};
      },
      () => {
        // asyncio: cancelling a task that awaits another task cancels the latter.
        this.cancel();
      },
    );
    return awaited.then(onfulfilled, onrejected);
  }

  toString(): string {
    return this.#name;
  }

  #settle(state: "fulfilled" | "rejected" | "cancelled", value: T | undefined, error: unknown) {
    this.#state = state;
    this.#result = value;
    this.#error = error;
    this.#waiters.clear();
    const callbacks = this.#doneCallbacks.splice(0);
    for (const callback of callbacks) {
      try {
        callback(this);
      } catch (e) {
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }
}

/**
 * Suspend the current task until `register` resolves or rejects, making the
 * wait a cancellation point. `register` returns a disposer that undoes the
 * registration (clear a timer, remove a listener...) when the wait is
 * cancelled. `onCancel` runs after the disposer, e.g. to cancel a child task.
 */
export function suspend<T>(
  register: (resolve: (value: T) => void, reject: (error: unknown) => void) => () => void,
  onCancel?: () => void,
): Promise<T> {
  const task = currentTask();
  try {
    task?.checkpoint();
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let dispose: () => void = () => {};
    const waiter: Waiter = (error) => {
      if (settled) return;
      settled = true;
      dispose();
      onCancel?.();
      reject(error);
    };
    task?._addWaiter(waiter);
    dispose = register(
      (value) => {
        if (settled) return;
        settled = true;
        task?._removeWaiter(waiter);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        task?._removeWaiter(waiter);
        reject(error);
      },
    );
  });
}

/** Create and schedule a task (asyncio.create_task). */
export function createTask<T>(fn: TaskFn<T>, name?: string): Task<T> {
  const task = new Task(fn, name);
  // Errors are observed through the task; never surface as unhandled rejections.
  task.promise.catch(() => {});
  return task;
}

/** Throw if the current task has a pending cancellation (an explicit `await asyncio.sleep(0)`). */
export function checkCancelled(): void {
  currentTask()?.checkpoint();
}

/**
 * Await a foreign promise (fetch, SDK call...) as a cancellation point: if the
 * current task is cancelled while waiting, this rejects with CancelledError.
 * The foreign operation keeps running unless it was also given `task.signal`.
 */
export function abortable<T>(promise: PromiseLike<T>): Promise<T> {
  return suspend<T>((resolve, reject) => {
    promise.then(resolve, reject);
    return () => {};
  });
}

/** The current task's abort signal, or a never-aborting one outside tasks. */
export function currentSignal(): AbortSignal {
  return currentTask()?.signal ?? new AbortController().signal;
}
