// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// asyncio-style futures and tasks with cooperative cancellation.
//
// Scheduling follows asyncio (see loop.ts): a task runs until it awaits a
// future that is not done. Completing a future queues its waiters' wakeups on
// the ready queue instead of resuming them, so every fast path (awaiting a
// done future, `get()` on a non-empty queue, `put()` on an unbounded one,
// `wait()` on a set event) completes without letting another task run.
//
// Python delivers `CancelledError` *into* a coroutine at the await it is
// suspended on. JavaScript cannot interrupt an arbitrary await, so we emulate
// it. Every await on a Future (and so on every primitive in this package:
// sleep, Event.wait, Queue.get, awaiting a Task, waitFor, gather...) is a
// "cancellation point". When a task is cancelled:
//
//   - if it is suspended on a future, that future is cancelled and the task
//     resumes (on the ready queue, as in asyncio) with CancelledError; if it
//     awaits another task, that task is cancelled and this one resumes when it
//     finishes;
//   - otherwise the request stays pending: a task already woken up gets the
//     CancelledError when it resumes, and a task inside a foreign await gets
//     it at the next cancellation point it reaches;
//   - `task.signal` is aborted, so foreign awaits (fetch, WebSocket, SDKs) can
//     be made cancellable by passing the signal or wrapping them in
//     `abortable()`.
//
// The current task is tracked with AsyncLocalStorage, which Bun, Node, Deno
// and Cloudflare Workers (nodejs_compat) all provide.

/// <reference path="./async-hooks.d.ts" />
// (The reference keeps the declaration with this file: packages that compile
// it from source through the workspace exports don't include async-hooks.d.ts.)

import { callSoon, taskStorage } from "./loop.ts";

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

/** The task the caller is running in, if any (asyncio.current_task). */
export function currentTask(): Task<unknown> | undefined {
  return taskStorage.getStore() as Task<unknown> | undefined;
}

type FutureState = "pending" | "fulfilled" | "rejected" | "cancelled";

/**
 * asyncio.Future: a result that becomes available later. Awaiting it (it is
 * thenable) suspends the current task until it is done, unless it already is.
 * Done callbacks run on the ready queue, never synchronously.
 */
export class Future<T = unknown> implements PromiseLike<T> {
  #state: FutureState = "pending";
  #result: T | undefined;
  #error: unknown;
  #cancelMessage: string | undefined;
  #callbacks: ((future: any) => void)[] = [];

  done(): boolean {
    return this.#state !== "pending";
  }

  cancelled(): boolean {
    return this.#state === "cancelled";
  }

  result(): T {
    if (this.#state === "pending") throw new InvalidStateError("Result is not set.");
    if (this.#state === "fulfilled") return this.#result as T;
    if (this.#state === "cancelled") throw this._makeCancelledError();
    throw this.#error;
  }

  exception(): unknown {
    if (this.#state === "pending") throw new InvalidStateError("Exception is not set.");
    if (this.#state === "cancelled") throw this._makeCancelledError();
    return this.#state === "rejected" ? this.#error : undefined;
  }

  setResult(value: T): void {
    if (this.#state !== "pending") throw new InvalidStateError(`invalid state: ${this.#state}`);
    this._setDone("fulfilled", value, undefined);
  }

  setException(error: unknown): void {
    if (this.#state !== "pending") throw new InvalidStateError(`invalid state: ${this.#state}`);
    this._setDone("rejected", undefined, error);
  }

  /** Cancel the future. Returns false if it is already done. */
  cancel(message?: string): boolean {
    if (this.#state !== "pending") return false;
    this.#cancelMessage = message;
    this._setDone("cancelled", undefined, undefined);
    return true;
  }

  addDoneCallback(callback: (future: this) => void): void {
    if (this.#state !== "pending") {
      callSoon(() => callback(this));
    } else {
      this.#callbacks.push(callback);
    }
  }

  removeDoneCallback(callback: (future: this) => void): number {
    const before = this.#callbacks.length;
    this.#callbacks = this.#callbacks.filter((c) => c !== callback);
    return before - this.#callbacks.length;
  }

  // biome-ignore lint/suspicious/noThenProperty: Futures are awaitable by design, like asyncio.
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    // `await future` suspends the current task on it, so cancelling the task
    // cancels the future. A plain `future.then(cb)` doesn't suspend anything:
    // the caller keeps running and must stay the target of its own
    // cancellation (pipedog#96).
    const block = !this.done() && isEngineResolver(onfulfilled);
    return awaitFuture(this, block).then(onfulfilled, onrejected);
  }

  /** @internal The CancelledError a cancelled future raises. */
  _makeCancelledError(): CancelledError {
    if (this.#error instanceof CancelledError) return this.#error;
    return new CancelledError(this.#cancelMessage);
  }

  /** @internal Mark the future done and schedule its callbacks. */
  _setDone(state: Exclude<FutureState, "pending">, value: T | undefined, error: unknown): void {
    this.#state = state;
    this.#result = value;
    this.#error = error;
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    for (const callback of callbacks) callSoon(() => callback(this));
  }
}

/**
 * Await `future` from the current task (Future.__await__ plus the task's
 * wakeup). A done future returns at once, without suspending. Otherwise the
 * task resumes on the ready queue once the future is done, and cancelling
 * the task meanwhile cancels the future. With `block` false, the promise
 * settles with the future but the current task isn't suspended on it.
 */
export function awaitFuture<T>(future: Future<T>, block = true): Promise<T> {
  if (future.done()) {
    try {
      return Promise.resolve(future.result());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  const task = block ? currentTask() : undefined;
  return new Promise<T>((resolve, reject) => {
    future.addDoneCallback(() => {
      // `then()` is also how `await` reaches us, so a plain `task.then(cb)`
      // registers its caller as blocked on `task` without suspending it. By
      // the time `future` is done, that caller may be blocked on something
      // else: only the wakeup of the future it is blocked on may touch it.
      if (task && task._futWaiter === future) {
        task._futWaiter = null;
        // A cancellation requested after the wakeup was queued wins (Task.__step).
        const cancelled = task._takeCancelRequest();
        if (cancelled) {
          reject(cancelled);
          return;
        }
      }
      try {
        resolve(future.result());
      } catch (e) {
        reject(e);
      }
    });
    task?._block(future);
  });
}

/**
 * Whether `fn` is a resolving function the engine made: what `await`,
 * `Promise.resolve(thenable)` and `Promise.all` pass to `then()`. Bun, Node,
 * Deno and workerd all give them an empty name and native source; a user
 * callback (or a bound one, named "bound …") never has both.
 */
function isEngineResolver(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    fn.name === "" &&
    Function.prototype.toString.call(fn).endsWith("{ [native code] }")
  );
}

let taskCounter = 0;

export type TaskFn<T> = () => Promise<T> | T;

/**
 * A unit of concurrent work, like asyncio.Task. Created with `createTask()`.
 * Awaiting a Task (it is thenable) is a cancellation point; cancelling the
 * awaiting task also cancels the awaited one, as in asyncio.
 */
export class Task<T> extends Future<T> {
  #controller = new AbortController();
  #name: string;
  #mustCancel = false;
  #cancelMessage: string | undefined;
  #cancelRequests = 0;
  #promise: Promise<T> | undefined;
  /** @internal The future this task is suspended on (Task._fut_waiter). */
  _futWaiter: Future<unknown> | null = null;

  constructor(fn: TaskFn<T>, name?: string) {
    super();
    this.#name = name ?? `Task-${++taskCounter}`;
    let start!: { resolve: () => void; reject: (e: unknown) => void };
    const started = new Promise<void>((resolve, reject) => {
      start = { resolve, reject };
    });
    // Like asyncio, a task never starts running synchronously in the caller:
    // its first step is scheduled on the ready queue.
    callSoon(() => {
      const cancelled = this._takeCancelRequest();
      if (cancelled) start.reject(cancelled);
      else start.resolve();
    });
    taskStorage
      .run(this as Task<unknown>, async () => {
        await started;
        return await fn();
      })
      .then(
        (value) => {
          // Cancelled right before returning: the task ends cancelled.
          const cancelled = this._takeCancelRequest();
          if (cancelled) this._setDone("cancelled", undefined, cancelled);
          else this._setDone("fulfilled", value, undefined);
        },
        (error) =>
          this._setDone(
            error instanceof CancelledError ? "cancelled" : "rejected",
            undefined,
            error,
          ),
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

  /**
   * Aborted when cancellation is requested. Pass it to fetch() and friends.
   * Once every request is withdrawn with `uncancel()`, a fresh signal is used.
   */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Number of pending cancellation requests (asyncio Task.cancelling()). */
  cancelling(): number {
    return this.#cancelRequests;
  }

  uncancel(): number {
    if (this.#cancelRequests > 0) this.#cancelRequests--;
    if (this.#cancelRequests === 0) {
      this.#mustCancel = false;
      if (this.#controller.signal.aborted) this.#controller = new AbortController();
    }
    return this.#cancelRequests;
  }

  override setResult(_value: T): void {
    throw new InvalidStateError("Task does not support setResult()");
  }

  override setException(_error: unknown): void {
    throw new InvalidStateError("Task does not support setException()");
  }

  /** Request cancellation. Returns false if the task is already done. */
  override cancel(message?: string): boolean {
    if (this.done()) return false;
    this.#cancelRequests++;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new CancelledError(message));
    }
    // Cancel what the task is suspended on; it resumes with the outcome.
    if (this._futWaiter?.cancel(message)) return true;
    // Running, woken up but not resumed yet, or inside a foreign await.
    this.#mustCancel = true;
    this.#cancelMessage = message;
    return true;
  }

  /**
   * Throw CancelledError if a cancellation request is pending. Primitives
   * call this on their fast paths, so a task that resumes from a foreign
   * await after being cancelled stops at the next one.
   */
  checkpoint(): void {
    const cancelled = this._takeCancelRequest();
    if (cancelled) throw cancelled;
  }

  /** A promise that settles with the task, without being a cancellation point. */
  get promise(): Promise<T> {
    if (!this.#promise) {
      this.#promise = new Promise<T>((resolve, reject) => {
        this.addDoneCallback(() => {
          try {
            resolve(this.result());
          } catch (e) {
            reject(e);
          }
        });
      });
      // Errors are observed through the task; never an unhandled rejection.
      this.#promise.catch(() => {});
    }
    return this.#promise;
  }

  override toString(): string {
    return this.#name;
  }

  /** @internal Consume a pending cancellation request, returning its error. */
  _takeCancelRequest(): CancelledError | undefined {
    if (!this.#mustCancel) return undefined;
    this.#mustCancel = false;
    return new CancelledError(this.#cancelMessage);
  }

  /** @internal The task suspends on `future` (Task.__step yielding a future). */
  _block(future: Future<unknown>): void {
    this._futWaiter = future;
    if (this.#mustCancel && future.cancel(this.#cancelMessage)) this.#mustCancel = false;
  }
}

/**
 * Suspend the current task until `register` resolves or rejects, making the
 * wait a cancellation point. `register` returns a disposer that undoes the
 * registration (clear a timer, remove a listener...) when the wait is
 * cancelled. `onCancel` runs after the disposer, e.g. to cancel a child task.
 */
export async function suspend<T>(
  register: (resolve: (value: T) => void, reject: (error: unknown) => void) => () => void,
  onCancel?: () => void,
): Promise<T> {
  const future = new Future<T>();
  const dispose = register(
    (value) => {
      if (!future.done()) future.setResult(value);
    },
    (error) => {
      if (!future.done()) future.setException(error);
    },
  );
  try {
    return await awaitFuture(future);
  } catch (e) {
    if (future.cancelled()) {
      dispose();
      onCancel?.();
    }
    throw e;
  }
}

/** Create and schedule a task (asyncio.create_task). */
export function createTask<T>(fn: TaskFn<T>, name?: string): Task<T> {
  return new Task(fn, name);
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
  const future = new Future<T>();
  promise.then(
    (value) => {
      if (!future.done()) future.setResult(value);
    },
    (error) => {
      if (!future.done()) future.setException(error);
    },
  );
  return awaitFuture(future);
}

/** The current task's abort signal, or a never-aborting one outside tasks. */
export function currentSignal(): AbortSignal {
  return currentTask()?.signal ?? new AbortController().signal;
}
