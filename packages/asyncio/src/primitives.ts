// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// asyncio synchronization primitives and helpers. Every wait here is a
// cancellation point (see task.ts). Durations are in seconds, as in Python.

import {
  CancelledError,
  createTask,
  currentTask,
  suspend,
  Task,
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

/** asyncio.sleep(seconds). `sleep(0)` yields to other tasks. */
export function sleep(seconds: number): Promise<void> {
  return suspend<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds * 1000));
    return () => clearTimeout(timer);
  });
}

/** asyncio.Event */
export class Event {
  #set = false;
  #waiters = new Set<() => void>();

  isSet(): boolean {
    return this.#set;
  }

  set(): void {
    if (this.#set) return;
    this.#set = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }

  clear(): void {
    this.#set = false;
  }

  wait(): Promise<true> {
    if (this.#set) {
      try {
        currentTask()?.checkpoint();
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(true);
    }
    return suspend<true>((resolve) => {
      const waiter = () => resolve(true);
      this.#waiters.add(waiter);
      return () => this.#waiters.delete(waiter);
    });
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
 * asyncio.Queue. Subclasses override `_init/_put/_get/_size/_items` to change
 * ordering, as Python's PriorityQueue and LifoQueue do.
 */
export class Queue<T> {
  readonly maxsize: number;
  #getters: { resolve: (item: T) => void; reject: (e: unknown) => void }[] = [];
  #putters: (() => void)[] = [];
  #unfinished = 0;
  #finished = new Event();
  #shutdown = false;

  constructor(maxsize = 0) {
    this.maxsize = maxsize;
    this._init();
    this.#finished.set();
  }

  // Storage hooks.
  protected _items: T[] = [];
  protected _init(): void {
    this._items = [];
  }
  protected _put(item: T): void {
    this._items.push(item);
  }
  protected _get(): T {
    return this._items.shift() as T;
  }
  protected _size(): number {
    return this._items.length;
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
      await suspend<void>((resolve) => {
        this.#putters.push(resolve);
        return () => {
          const i = this.#putters.indexOf(resolve);
          if (i >= 0) this.#putters.splice(i, 1);
        };
      });
    }
    this.putNowait(item);
  }

  putNowait(item: T): void {
    if (this.#shutdown) throw new QueueShutDown();
    if (this.full()) throw new QueueFull();
    this._put(item);
    this.#unfinished++;
    this.#finished.clear();
    this.#wakeGetter();
  }

  async get(): Promise<T> {
    if (!this.empty() && this.#getters.length === 0) {
      currentTask()?.checkpoint();
      return this.getNowait();
    }
    if (this.#shutdown && this.empty()) throw new QueueShutDown();
    return suspend<T>((resolve, reject) => {
      const getter = { resolve, reject };
      this.#getters.push(getter);
      // Item may already be available if getters were queued before us.
      this.#wakeGetter();
      return () => {
        const i = this.#getters.indexOf(getter);
        if (i >= 0) this.#getters.splice(i, 1);
      };
    });
  }

  getNowait(): T {
    if (this.empty()) {
      if (this.#shutdown) throw new QueueShutDown();
      throw new QueueEmpty();
    }
    const item = this._get();
    this.#wakePutter();
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
    for (const getter of this.#getters.splice(0)) getter.reject(new QueueShutDown());
    for (const putter of this.#putters.splice(0)) putter();
  }

  #wakeGetter(): void {
    while (this.#getters.length > 0 && !this.empty()) {
      const getter = this.#getters.shift()!;
      const item = this._get();
      getter.resolve(item);
      this.#wakePutter();
    }
  }

  #wakePutter(): void {
    const putter = this.#putters.shift();
    putter?.();
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
  #waiters: (() => void)[] = [];

  locked(): boolean {
    return this.#locked;
  }

  async acquire(): Promise<true> {
    if (!this.#locked && this.#waiters.length === 0) {
      this.#locked = true;
      return true;
    }
    await suspend<void>((resolve) => {
      this.#waiters.push(resolve);
      return () => {
        const i = this.#waiters.indexOf(resolve);
        if (i >= 0) this.#waiters.splice(i, 1);
      };
    });
    this.#locked = true;
    return true;
  }

  release(): void {
    if (!this.#locked) throw new Error("Lock is not acquired.");
    this.#locked = false;
    const next = this.#waiters.shift();
    if (next) {
      // Hand over directly so no one can barge in.
      this.#locked = true;
      next();
      // `acquire` sets locked again after resuming; keep it consistent.
    }
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
  #waiters: (() => void)[] = [];

  constructor(value = 1) {
    this.#value = value;
  }

  locked(): boolean {
    return this.#value === 0;
  }

  async acquire(): Promise<true> {
    if (this.#value > 0 && this.#waiters.length === 0) {
      this.#value--;
      return true;
    }
    await suspend<void>((resolve) => {
      this.#waiters.push(resolve);
      return () => {
        const i = this.#waiters.indexOf(resolve);
        if (i >= 0) this.#waiters.splice(i, 1);
      };
    });
    return true;
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#value++;
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

export type Awaitable<T> = TaskFn<T> | Task<T> | PromiseLike<T>;

function toTask<T>(aw: Awaitable<T>, name?: string): Task<T> {
  if (aw instanceof Task) return aw;
  if (typeof aw === "function") return createTask(aw as TaskFn<T>, name);
  return createTask(() => aw as PromiseLike<T> as Promise<T>, name);
}

/**
 * asyncio.wait_for(aw, timeout). Pass a function (a "coroutine") so it can
 * run as a child task that is cancelled on timeout. `timeout` null waits forever.
 */
export async function waitFor<T>(aw: Awaitable<T>, timeout: number | null | undefined): Promise<T> {
  const child = toTask(aw, "wait_for");
  if (timeout === null || timeout === undefined) return await child;

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.cancel();
    },
    Math.max(0, timeout * 1000),
  );
  try {
    return await child;
  } catch (e) {
    if (timedOut && e instanceof CancelledError && !(currentTask()?.cancelling() ?? 0)) {
      throw new TimeoutError();
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * asyncio.gather(*aws). Functions run as child tasks; if the caller is
 * cancelled, all children are cancelled.
 */
export async function gather<T extends readonly unknown[]>(
  ...aws: { [K in keyof T]: Awaitable<T[K]> }
): Promise<T> {
  const tasks = aws.map((aw) => toTask(aw as Awaitable<unknown>));
  return (await suspend<unknown[]>(
    (resolve, reject) => {
      Promise.all(tasks.map((t) => t.promise)).then(resolve, reject);
      return () => {};
    },
    () => {
      for (const t of tasks) t.cancel();
    },
  )) as unknown as T;
}

/** asyncio.gather(*aws, return_exceptions=True) */
export async function gatherSettled(...aws: Awaitable<unknown>[]): Promise<unknown[]> {
  const tasks = aws.map((aw) => toTask(aw));
  return await suspend<unknown[]>(
    (resolve) => {
      Promise.allSettled(tasks.map((t) => t.promise)).then((results) =>
        resolve(results.map((r) => (r.status === "fulfilled" ? r.value : r.reason))),
      );
      return () => {};
    },
    () => {
      for (const t of tasks) t.cancel();
    },
  );
}

export const FIRST_COMPLETED = "FIRST_COMPLETED";
export const FIRST_EXCEPTION = "FIRST_EXCEPTION";
export const ALL_COMPLETED = "ALL_COMPLETED";
export type ReturnWhen = typeof FIRST_COMPLETED | typeof FIRST_EXCEPTION | typeof ALL_COMPLETED;

/**
 * asyncio.wait(tasks, timeout, return_when). Does not cancel anything on
 * timeout. Returns [done, pending].
 */
export function wait<T>(
  tasks: Iterable<Task<T>>,
  options: { timeout?: number | null; returnWhen?: ReturnWhen } = {},
): Promise<[Set<Task<T>>, Set<Task<T>>]> {
  const all = [...tasks];
  const returnWhen = options.returnWhen ?? ALL_COMPLETED;
  const result = (): [Set<Task<T>>, Set<Task<T>>] => [
    new Set(all.filter((t) => t.done())),
    new Set(all.filter((t) => !t.done())),
  ];
  return suspend((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const done = all.filter((t) => t.done());
      const finished =
        done.length === all.length ||
        (returnWhen === FIRST_COMPLETED && done.length > 0) ||
        (returnWhen === FIRST_EXCEPTION &&
          done.some((t) => !t.cancelled() && t.exception() !== undefined));
      if (finished) {
        if (timer) clearTimeout(timer);
        resolve(result());
      }
    };
    for (const t of all) t.addDoneCallback(check);
    if (options.timeout !== undefined && options.timeout !== null) {
      timer = setTimeout(() => resolve(result()), options.timeout * 1000);
    }
    check();
    return () => {
      if (timer) clearTimeout(timer);
      for (const t of all) t.removeDoneCallback(check);
    };
  });
}

/**
 * asyncio.timeout(seconds) as a scope: runs `fn` and cancels it on timeout,
 * raising TimeoutError.
 */
export function timeout<T>(seconds: number | null, fn: TaskFn<T>): Promise<T> {
  return waitFor(fn, seconds);
}

/** asyncio.shield(aw): the caller can be cancelled without cancelling `aw`. */
export function shield<T>(aw: Awaitable<T>): Promise<T> {
  const task = toTask(aw);
  return suspend<T>((resolve, reject) => {
    task.promise.then(resolve, reject);
    return () => {};
  });
}
