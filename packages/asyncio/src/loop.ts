// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The ready queue: asyncio's event loop scheduling, for JavaScript.
//
// In asyncio a task runs until it genuinely suspends (awaits a future that is
// not done). Completing a future does not resume its waiters: their wakeups
// are queued with `loop.call_soon()` and run later, one after another, in FIFO
// order. So `await queue.get()` on a non-empty queue, `await queue.put()` on
// an unbounded one or awaiting a coroutine that never suspends all complete
// without letting any other task run.
//
// JavaScript resumes an awaiting function one microtask after its promise
// settles, so naive promise-based primitives interleave tasks at every
// `await`. Here, every wakeup (a future's done callbacks, a task's first step,
// `sleep(0)`, timers) is a `callSoon()` callback instead, and callbacks run
// one per macrotask: the microtask queue (the resumed task's run up to its next
// real suspension, plus anything it set off) drains completely before the
// next callback runs. Pending callbacks keep the process alive, like a running
// loop.
//
// The macrotask source is picked per runtime: a MessageChannel on Node
// (setImmediate there goes through a full libuv loop iteration per callback),
// setImmediate on Bun and Deno, a body read on Cloudflare Workers (its
// setImmediate and timers wait about a millisecond; MessageChannel messages
// are delivered without draining microtasks in between) and MessageChannel or
// setTimeout elsewhere.
//
// On Cloudflare Workers there is no ready queue: one isolate serves many
// requests and Durable Objects, and code runs in the I/O context of whatever
// event resumed it. A callback run from another context's turn would do that
// context's I/O (a Durable Object writing to its WebSocket from another
// object's turn fails), and a task it creates would stay there. So each
// callback gets a body read of its own, started in the context that scheduled
// it, and runs when that read settles. The reads of one context settle in the
// order they were started, so callbacks still run in FIFO order, one per turn.

import { AsyncLocalStorage } from "node:async_hooks";

/** @internal The task the code is running in (see task.ts). */
export const taskStorage = new AsyncLocalStorage<unknown>();

/** A callback scheduled with `callSoon()` / `callLater()` (asyncio.Handle). */
export class Handle {
  #callback: (() => void) | null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(callback: () => void) {
    this.#callback = callback;
  }

  /** Cancel the callback. Does nothing if it already ran. */
  cancel(): void {
    this.#callback = null;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  cancelled(): boolean {
    return this.#callback === null;
  }

  /** @internal */
  _setTimer(timer: ReturnType<typeof setTimeout>): void {
    this.#timer = timer;
  }

  /** @internal */
  _clearTimer(): void {
    this.#timer = undefined;
  }

  /** @internal */
  _run(): void {
    const callback = this.#callback;
    if (callback === null) return;
    this.#callback = null;
    callback();
  }
}

// FIFO of ready handles: an array consumed from `head`, compacted lazily.
let ready: Handle[] = [];
let head = 0;

type Trigger = { arm: () => void; idle: () => void };
let trigger: Trigger | undefined;
let armed = false;

/** Schedules one callback on its own, in the scheduling context (Workers), if set. */
let schedule: ((handle: Handle) => void) | null | undefined;

/**
 * Schedule `callback` to run on a later turn of the loop, after the code
 * running now (and every callback scheduled before it) has run up to its
 * next suspension (loop.call_soon). Runs with no current task.
 */
export function callSoon(callback: () => void): Handle {
  const handle = new Handle(callback);
  enqueue(handle);
  return handle;
}

/** Schedule `callback` after `delay` seconds (loop.call_later). */
export function callLater(delay: number, callback: () => void): Handle {
  const handle = new Handle(callback);
  // As in asyncio, a due timer only moves its callback to the ready queue.
  handle._setTimer(
    setTimeout(
      () => {
        handle._clearTimer();
        if (!handle.cancelled()) enqueue(handle);
      },
      Math.max(0, delay * 1000),
    ),
  );
  return handle;
}

function enqueue(handle: Handle): void {
  schedule ??= makeContextScheduler();
  if (schedule) {
    schedule(handle);
    return;
  }
  ready.push(handle);
  if (!armed) {
    armed = true;
    trigger ??= makeTrigger(runOne);
    trigger.arm();
  }
}

/** One loop turn: run the oldest ready callback, then let microtasks drain. */
function runOne(): void {
  armed = false;
  const handle = ready[head];
  if (handle === undefined) {
    trigger?.idle();
    return;
  }
  ready[head] = undefined as unknown as Handle;
  head++;
  if (head === ready.length) {
    ready = [];
    head = 0;
  } else if (head >= 1024 && head * 2 >= ready.length) {
    ready = ready.slice(head);
    head = 0;
  }
  if (head < ready.length) {
    armed = true;
    trigger!.arm();
  } else {
    trigger!.idle();
  }
  runHandle(handle);
}

function runHandle(handle: Handle): void {
  try {
    // Callbacks run outside any task, as in asyncio (current_task() is None).
    taskStorage.run(undefined, () => handle._run());
  } catch (e) {
    // asyncio logs callback errors and keeps the loop going; surface it the
    // way JavaScript reports an uncaught error, without stopping the queue.
    queueMicrotask(() => {
      throw e;
    });
  }
}

/**
 * On Cloudflare Workers, a scheduler that runs each callback in the I/O
 * context that scheduled it (see the top of this file); elsewhere null, and
 * callbacks share the ready queue.
 */
function makeContextScheduler(): ((handle: Handle) => void) | null {
  const g = globalThis as {
    navigator?: { userAgent?: string };
    Response?: new (body: string) => { arrayBuffer(): Promise<ArrayBuffer> };
  };
  if (g.navigator?.userAgent !== "Cloudflare-Workers" || typeof g.Response !== "function") {
    return null;
  }
  const Response = g.Response;
  // A body read settles from the runtime's event loop, after microtasks, in
  // the context that started it.
  return (handle) => void new Response("").arrayBuffer().then(() => runHandle(handle));
}

interface PortLike {
  onmessage: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  ref?: () => void;
  unref?: () => void;
}

function makeTrigger(run: () => void): Trigger {
  const g = globalThis as {
    Bun?: unknown;
    Deno?: unknown;
    process?: { versions?: { node?: string } };
    setImmediate?: (callback: () => void) => unknown;
    MessageChannel?: new () => { port1: PortLike; port2: PortLike };
  };
  const noop = () => {};

  const isNode = typeof g.process?.versions?.node === "string" && !g.Bun && !g.Deno;
  if (isNode && typeof g.MessageChannel === "function") {
    const { port1, port2 } = new g.MessageChannel();
    port1.onmessage = run;
    // Only pending callbacks keep the process alive.
    port1.unref?.();
    let referenced = false;
    return {
      arm: () => {
        if (!referenced) {
          referenced = true;
          port1.ref?.();
        }
        port2.postMessage(null);
      },
      idle: () => {
        if (referenced) {
          referenced = false;
          port1.unref?.();
        }
      },
    };
  }

  if (typeof g.setImmediate === "function") {
    const setImmediate = g.setImmediate;
    return { arm: () => void setImmediate(run), idle: noop };
  }

  if (typeof g.MessageChannel === "function") {
    const { port1, port2 } = new g.MessageChannel();
    port1.onmessage = run;
    return { arm: () => port2.postMessage(null), idle: noop };
  }

  return { arm: () => void setTimeout(run, 0), idle: noop };
}
