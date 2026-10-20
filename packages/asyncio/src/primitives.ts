// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// asyncio synchronization primitives and helpers, ported from CPython's
// asyncio (locks.py, queues.py, tasks.py, timeouts.py) on top of Future, so
// they wake waiters exactly as asyncio does: through the ready queue, never
// synchronously. Every wait here is a cancellation point (see task.ts).
// Durations are in seconds, as in Python.

import { callLater, callSoon, type Handle } from "./loop.ts";
import {
  abortable,
  awaitFuture,
  CancelledError,
  createTask,
  currentTask,
  Future,
  type TaskFn,
  TimeoutError,
} from "./task.ts";

/** Monotonic time in seconds (loop.time()). */
export function monotonic(): number {
  return performance.now() / 1000;
}

/** Monotonic time in nanoseconds (time.monotonic_ns()). */
export function monotonicNs(): number {
  return Math.round(performance.now() * 1_000_000);
}

/**
 * Wall-clock time in seconds (time.time()).
 *
 * Sub-millisecond, like Python's: `Date.now()` alone would give successive
 * readings the same value, so intervals between frames pushed back to back
 * would measure as zero. Falls back to `Date.now()` where the runtime has no
 * time origin.
 */
export function time(): number {
  const origin = performance.timeOrigin;
  return origin ? (origin + performance.now()) / 1000 : Date.now() / 1000;
}

function remove<T>(items: T[], item: T): boolean {
  const i = items.indexOf(item);
  if (i < 0) return false;
  items.splice(i, 1);
  return true;
}

/**
 * asyncio.sleep(seconds). `sleep(0)` yields once: the task goes to the back
 * of the ready queue, so everything already scheduled runs first.
 */
export function sleep(seconds: number): Promise<void> {
  if (!(seconds > 0)) return sleep0();
  const future = new Future<void>();
  const handle = callLater(seconds, () => {
    if (!future.done()) future.setResult(undefined);
  });
  const done = awaitFuture(future);
  done.then(
    () => handle.cancel(),
    () => handle.cancel(),
  );
  return done;
}

/** A bare `yield` in a task: reschedule it at the back of the ready queue. */
function sleep0(): Promise<void> {
  const task = currentTask();
  return new Promise<void>((resolve, reject) => {
    callSoon(() => {
      const cancelled = task?._takeCancelRequest();
      if (cancelled) reject(cancelled);
      else resolve();
    });
  });
}

/** asyncio.Event */
export class Event {
  #value = false;
  #waiters: Future<true>[] = [];

  isSet(): boolean {
    return this.#value;
  }

  set(): void {
    if (this.#value) return;
    this.#value = true;
    for (const future of this.#waiters) {
      if (!future.done()) future.setResult(true);
    }
  }

  clear(): void {
    this.#value = false;
  }

  async wait(): Promise<true> {
    if (this.#value) {
      currentTask()?.checkpoint();
      return true;
    }
    const future = new Future<true>();
    this.#waiters.push(future);
    try {
      await future;
      return true;
    } finally {
      remove(this.#waiters, future);
    }
  }
}

export class QueueEmpty extends Error {
  override name = "QueueEmpty";
}

export class QueueFull extends Error {
  override name = "QueueFull";
}

export class QueueShutDown extends Error {
  override name = "QueueShutDown";
}

/**
 * asyncio.Queue. Subclasses override `_init/_put/_get/_size` to change
 * ordering, as Python's PriorityQueue and LifoQueue do.
 */
export class Queue<T> {
  readonly maxsize: number;
  #getters: Future<void>[] = [];
  #putters: Future<void>[] = [];
  #unfinished = 0;
  #finished = new Event();
  #shutdown = false;

  constructor(maxsize = 0) {
    this.maxsize = maxsize;
    this._init();
    this.#finished.set();
  }

  // Storage hooks. FIFO storage is `_items` from index `_head` on: a deque
  // (collections.deque in Python), since Array.shift() is O(n) on V8.
  protected _items: T[] = [];
  protected _head = 0;
  protected _init(): void {
    this._items = [];
    this._head = 0;
  }
  protected _put(item: T): void {
    this._items.push(item);
  }
  protected _get(): T {
    const items = this._items;
    const item = items[this._head] as T;
    items[this._head] = undefined as T;
    this._head++;
    if (this._head === items.length) {
      items.length = 0;
      this._head = 0;
    } else if (this._head >= 1024 && this._head * 2 >= items.length) {
      items.splice(0, this._head);
      this._head = 0;
    }
    return item;
  }
  protected _size(): number {
    return this._items.length - this._head;
  }
  /** The queued items in storage order (for subclasses that inspect them). */
  protected _queued(): readonly T[] {
    return this._head === 0 ? this._items : this._items.slice(this._head);
  }

  #wakeupNext(waiters: Future<void>[]): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (!waiter.done()) {
        waiter.setResult(undefined);
        break;
      }
    }
  }

  qsize(): number {
    return this._size();
  }

  empty(): boolean {
    return this._size() === 0;
  }

  full(): boolean {
    return this.maxsize > 0 && this._size() >= this.maxsize;
  }

  async put(item: T): Promise<void> {
    // A cancellation point even when it doesn't block: after an interruption,
    // a task resuming from a foreign await must not push stale items.
    currentTask()?.checkpoint();
    while (this.full()) {
      if (this.#shutdown) throw new QueueShutDown();
      const putter = new Future<void>();
      this.#putters.push(putter);
      try {
        await putter;
      } catch (e) {
        putter.cancel();
        remove(this.#putters, putter);
        // Woken up by getNowait() but can't take the slot: pass it on.
        if (!this.full() && !putter.cancelled()) this.#wakeupNext(this.#putters);
        throw e;
      }
    }
    this.putNowait(item);
  }

  putNowait(item: T): void {
    if (this.#shutdown) throw new QueueShutDown();
    if (this.full()) throw new QueueFull();
    this._put(item);
    this.#unfinished++;
    this.#finished.clear();
    this.#wakeupNext(this.#getters);
  }

  async get(): Promise<T> {
    if (!this.empty()) currentTask()?.checkpoint();
    while (this.empty()) {
      if (this.#shutdown && this.empty()) throw new QueueShutDown();
      const getter = new Future<void>();
      this.#getters.push(getter);
      try {
        await getter;
      } catch (e) {
        getter.cancel();
        remove(this.#getters, getter);
        // Woken up by putNowait() but can't take the item: pass it on.
        if (!this.empty() && !getter.cancelled()) this.#wakeupNext(this.#getters);
        throw e;
      }
    }
    return this.getNowait();
  }

  getNowait(): T {
    if (this.empty()) {
      if (this.#shutdown) throw new QueueShutDown();
      throw new QueueEmpty();
    }
    const item = this._get();
    this.#wakeupNext(this.#putters);
    return item;
  }

  taskDone(): void {
    if (this.#unfinished <= 0) throw new Error("task_done() called too many times");
    this.#unfinished--;
    if (this.#unfinished === 0) this.#finished.set();
  }

  async join(): Promise<void> {
    if (this.#unfinished > 0) await this.#finished.wait();
  }

  shutdown(immediate = false): void {
    this.#shutdown = true;
    if (immediate) {
      while (!this.empty()) {
        this._get();
        if (this.#unfinished > 0) this.#unfinished--;
      }
      if (this.#unfinished === 0) this.#finished.set();
    }
    // All getters need to re-check queue-empty to raise QueueShutDown.
    for (const getter of this.#getters.splice(0)) {
      if (!getter.done()) getter.setResult(undefined);
    }
    for (const putter of this.#putters.splice(0)) {
      if (!putter.done()) putter.setResult(undefined);
    }
  }
}

/** asyncio.LifoQueue */
export class LifoQueue<T> extends Queue<T> {
  protected override _get(): T {
    return this._items.pop() as T;
  }
}

/** Default ordering for PriorityQueue: compares numbers, strings and tuples (arrays) like Python. */
export function pythonCompare(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = pythonCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  throw new TypeError(`'<' not supported between ${typeof a} and ${typeof b}`);
}

/** heapq.heappush */
export function heapPush<T>(
  heap: T[],
  item: T,
  compare: (a: T, b: T) => number = pythonCompare,
): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (compare(heap[i]!, heap[parent]!) >= 0) break;
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

/** heapq.heappop */
export function heapPop<T>(heap: T[], compare: (a: T, b: T) => number = pythonCompare): T {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && compare(heap[l]!, heap[m]!) < 0) m = l;
      if (r < heap.length && compare(heap[r]!, heap[m]!) < 0) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
  return top;
}

/** asyncio.PriorityQueue backed by a binary heap. Smallest item first. */
export class PriorityQueue<T> extends Queue<T> {
  protected readonly _compare: (a: T, b: T) => number;

  constructor(maxsize = 0, compare: (a: T, b: T) => number = pythonCompare) {
    super(maxsize);
    this._compare = compare;
  }

  protected override _put(item: T): void {
    heapPush(this._items, item, this._compare);
  }

  protected override _get(): T {
    return heapPop(this._items, this._compare);
  }
}

/** asyncio.Lock */
export class Lock {
  #locked = false;
  #waiters: Future<true>[] | null = null;

  locked(): boolean {
    return this.#locked;
  }

  async acquire(): Promise<true> {
    if (!this.#locked && (this.#waiters === null || this.#waiters.every((w) => w.cancelled()))) {
      this.#locked = true;
      return true;
    }
    this.#waiters ??= [];
    const future = new Future<true>();
    this.#waiters.push(future);
    try {
      try {
        await future;
      } finally {
        remove(this.#waiters, future);
      }
    } catch (e) {
      // If the lock is free, make sure the next waiter in line runs.
      if (e instanceof CancelledError && !this.#locked) this.#wakeUpFirst();
      throw e;
    }
    this.#locked = true;
    return true;
  }

  release(): void {
    if (!this.#locked) throw new Error("Lock is not acquired.");
    this.#locked = false;
    this.#wakeUpFirst();
  }

  #wakeUpFirst(): void {
    const first = this.#waiters?.[0];
    // done() means that the waiter is already set to wake up.
    if (first && !first.done()) first.setResult(true);
  }

  /** `async with lock:` → `await lock.run(async () => {...})` */
  async run<R>(fn: () => Promise<R> | R): Promise<R> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** asyncio.Semaphore */
export class Semaphore {
  #value: number;
  #waiters: Future<true>[] | null = null;

  constructor(value = 1) {
    if (value < 0) throw new RangeError("Semaphore initial value must be >= 0");
    this.#value = value;
  }

  /** Due to state, or FIFO rules (must allow others to run first). */
  locked(): boolean {
    return this.#value === 0 || (this.#waiters ?? []).some((w) => !w.cancelled());
  }

  async acquire(): Promise<true> {
    if (!this.locked()) {
      // Maintain FIFO, wait for others to start even if value > 0.
      this.#value--;
      return true;
    }
    this.#waiters ??= [];
    const future = new Future<true>();
    this.#waiters.push(future);
    try {
      try {
        await future;
      } finally {
        remove(this.#waiters, future);
      }
    } catch (e) {
      if (e instanceof CancelledError && future.done() && !future.cancelled()) {
        // Woken up by #wakeUpNext() but not acquiring: undo its bookkeeping.
        this.#value++;
      }
      throw e;
    } finally {
      // New waiters may have arrived but had to wait due to FIFO.
      while (this.#value > 0) {
        if (!this.#wakeUpNext()) break;
      }
    }
    return true;
  }

  release(): void {
    this.#value++;
    this.#wakeUpNext();
  }

  #wakeUpNext(): boolean {
    if (!this.#waiters) return false;
    for (const future of this.#waiters) {
      if (!future.done()) {
        this.#value--;
        future.setResult(true);
        return true;
      }
    }
    return false;
  }

  async run<R>(fn: () => Promise<R> | R): Promise<R> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Something to await: a function (a "coroutine"), a Task or Future, or a foreign promise. */
export type Awaitable<T> = TaskFn<T> | Future<T> | PromiseLike<T>;

/** asyncio.ensure_future: functions and foreign promises run as tasks. */
function ensureFuture<T>(aw: Awaitable<T>, name?: string): Future<T> {
  if (aw instanceof Future) return aw;
  if (typeof aw === "function") return createTask(aw as TaskFn<T>, name);
  return createTask(() => aw as PromiseLike<T> as Promise<T>, name);
}

/** Await `aw` in the current task, as `await aw` would in Python. */
function awaitInline<T>(aw: Awaitable<T>): Promise<T> | T {
  if (aw instanceof Future) return awaitFuture(aw);
  if (typeof aw === "function") return (aw as TaskFn<T>)();
  // A foreign promise: make the wait cancellable.
  return abortable(aw);
}

/** tasks._cancel_and_wait: cancel `future` and wait until it is done. */
async function cancelAndWait(future: Future<unknown>): Promise<void> {
  const waiter = new Future<void>();
  const release = () => {
    if (!waiter.done()) waiter.setResult(undefined);
  };
  future.addDoneCallback(release);
  try {
    future.cancel();
    // Not waiting on `future` directly keeps this reliably cancellable.
    await waiter;
  } finally {
    future.removeDoneCallback(release);
  }
}

/**
 * asyncio.timeout(seconds) around `fn`, run in the current task: on expiry
 * the task is cancelled and the CancelledError becomes TimeoutError
 * (timeouts.Timeout). `seconds` null never expires.
 */
async function withTimeout<T>(seconds: number | null | undefined, fn: TaskFn<T>): Promise<T> {
  const task = currentTask();
  if (!task) {
    // asyncio.timeout() needs a task; give it one.
    return await createTask(() => withTimeout(seconds, fn), "timeout");
  }
  let expiring = false;
  const cancelling = task.cancelling();
  let handle: Handle | null = null;
  if (seconds !== null && seconds !== undefined) {
    const onTimeout = () => {
      task.cancel();
      expiring = true;
      handle = null;
    };
    handle = seconds <= 0 ? callSoon(onTimeout) : callLater(seconds, onTimeout);
  }
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    (handle as Handle | null)?.cancel();
    if (expiring && task.uncancel() <= cancelling && e instanceof CancelledError) {
      throw new TimeoutError();
    }
    throw e;
  }
  (handle as Handle | null)?.cancel();
  if (expiring) task.uncancel();
  return result;
}

/**
 * asyncio.wait_for(aw, timeout). A function (a "coroutine") or a foreign
 * promise is awaited in the current task, a Task is awaited (and cancelled on
 * timeout). `timeout` null waits forever.
 */
export async function waitFor<T>(aw: Awaitable<T>, timeout: number | null | undefined): Promise<T> {
  if (timeout !== null && timeout !== undefined && timeout <= 0) {
    const future = ensureFuture(aw, "wait_for");
    if (future.done()) return future.result();
    await cancelAndWait(future);
    try {
      return future.result();
    } catch (e) {
      if (e instanceof CancelledError) throw new TimeoutError();
      throw e;
    }
  }
  return await withTimeout(timeout, () => awaitInline(aw));
}

/**
 * asyncio.timeout(seconds) as a scope: runs `fn` and cancels it on timeout,
 * raising TimeoutError.
 */
export function timeout<T>(seconds: number | null, fn: TaskFn<T>): Promise<T> {
  return withTimeout(seconds, fn);
}

/** tasks._GatheringFuture: cancelling it cancels the children. */
class GatheringFuture<T> extends Future<T> {
  readonly #children: Future<unknown>[];
  cancelRequested = false;

  constructor(children: Future<unknown>[]) {
    super();
    this.#children = children;
  }

  override cancel(message?: string): boolean {
    if (this.done()) return false;
    let cancelled = false;
    for (const child of this.#children) {
      if (child.cancel(message)) cancelled = true;
    }
    // Propagate the cancellation once the children are done.
    if (cancelled) this.cancelRequested = true;
    return cancelled;
  }
}

function gatherFuture(aws: Awaitable<unknown>[], returnExceptions: boolean): Future<unknown[]> {
  if (aws.length === 0) {
    const outer = new Future<unknown[]>();
    outer.setResult([]);
    return outer;
  }
  const children: Future<unknown>[] = [];
  const doneFutures: Future<unknown>[] = [];
  const seen = new Map<unknown, Future<unknown>>();
  let nfutures = 0;
  let nfinished = 0;
  let outer: GatheringFuture<unknown[]> | null = null;

  const onDone = (future: Future<unknown>) => {
    nfinished++;
    if (outer === null || outer.done()) return;
    if (!returnExceptions) {
      if (future.cancelled()) {
        outer.setException(future._makeCancelledError());
        return;
      }
      const error = future.exception();
      if (error !== undefined) {
        outer.setException(error);
        return;
      }
    }
    if (nfinished === nfutures) {
      const results = children.map((child) => {
        if (child.cancelled()) return child._makeCancelledError();
        const error = child.exception();
        return error !== undefined ? error : child.result();
      });
      if (outer.cancelRequested) outer.setException(future._makeCancelledError());
      else outer.setResult(results);
    }
  };

  for (const aw of aws) {
    let future = seen.get(aw);
    if (!future) {
      future = ensureFuture(aw);
      nfutures++;
      seen.set(aw, future);
      if (future.done()) doneFutures.push(future);
      else future.addDoneCallback(onDone);
    }
    children.push(future);
  }
  outer = new GatheringFuture<unknown[]>(children);
  for (const future of doneFutures) onDone(future);
  return outer;
}

/**
 * asyncio.gather(*aws). Functions run as child tasks; if the caller is
 * cancelled, all children are cancelled.
 */
export function gather<T extends readonly unknown[]>(
  ...aws: { [K in keyof T]: Awaitable<T[K]> }
): Promise<T> {
  return awaitFuture(
    gatherFuture(aws as Awaitable<unknown>[], false),
  ) as Promise<unknown> as Promise<T>;
}

/** asyncio.gather(*aws, return_exceptions=True) */
export function gatherSettled(...aws: Awaitable<unknown>[]): Promise<unknown[]> {
  return awaitFuture(gatherFuture(aws, true));
}

export const FIRST_COMPLETED = "FIRST_COMPLETED";
export const FIRST_EXCEPTION = "FIRST_EXCEPTION";
export const ALL_COMPLETED = "ALL_COMPLETED";
export type ReturnWhen = typeof FIRST_COMPLETED | typeof FIRST_EXCEPTION | typeof ALL_COMPLETED;

/**
 * asyncio.wait(tasks, timeout, return_when). Does not cancel anything on
 * timeout. Returns [done, pending].
 */
export async function wait<F extends Future<any>>(
  tasks: Iterable<F>,
  options: { timeout?: number | null; returnWhen?: ReturnWhen } = {},
): Promise<[Set<F>, Set<F>]> {
  const all = [...new Set(tasks)];
  const returnWhen = options.returnWhen ?? ALL_COMPLETED;
  if (all.length > 0) {
    const waiter = new Future<void>();
    let timeoutHandle: Handle | null = null;
    if (options.timeout !== undefined && options.timeout !== null) {
      timeoutHandle = callLater(options.timeout, () => {
        if (!waiter.done()) waiter.setResult(undefined);
      });
    }
    let counter = all.length;
    const onCompletion = (future: F) => {
      counter--;
      if (
        counter <= 0 ||
        returnWhen === FIRST_COMPLETED ||
        (returnWhen === FIRST_EXCEPTION && !future.cancelled() && future.exception() !== undefined)
      ) {
        timeoutHandle?.cancel();
        if (!waiter.done()) waiter.setResult(undefined);
      }
    };
    for (const future of all) future.addDoneCallback(onCompletion);
    try {
      await waiter;
    } finally {
      timeoutHandle?.cancel();
      for (const future of all) future.removeDoneCallback(onCompletion);
    }
  }
  const done = new Set<F>();
  const pending = new Set<F>();
  for (const future of all) (future.done() ? done : pending).add(future);
  return [done, pending];
}

/** asyncio.shield(aw): the caller can be cancelled without cancelling `aw`. */
export function shield<T>(aw: Awaitable<T>): Promise<T> {
  const inner = ensureFuture(aw);
  if (inner.done()) return awaitFuture(inner);
  const outer = new Future<T>();
  const onInnerDone = () => {
    if (outer.cancelled()) return;
    if (inner.cancelled()) {
      outer.cancel();
      return;
    }
    const error = inner.exception();
    if (error !== undefined) outer.setException(error);
    else outer.setResult(inner.result());
  };
  inner.addDoneCallback(onInnerDone);
  outer.addDoneCallback(() => {
    if (!inner.done()) inner.removeDoneCallback(onInnerDone);
  });
  return awaitFuture(outer);
}

/** Whether `value` is a Future or Task (asyncio.isfuture). */
export function isFuture(value: unknown): value is Future<unknown> {
  return value instanceof Future;
}
