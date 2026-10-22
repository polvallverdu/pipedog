// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Microbenchmark: the cost of one macrotask hop (a callback that runs after
// the microtask queue has drained) with each primitive a runtime offers.
// @pipedog/asyncio schedules every task wakeup on one, so this is the unit
// cost of moving a frame between tasks. Run it on every runtime with
// `bun tools/bench/perf/macrotask-run.ts`.

const N = globalThis.navigator?.userAgent === "Cloudflare-Workers" ? 2000 : 20_000;

type Arm = (run: () => void) => void;

const isWorkerd = globalThis.navigator?.userAgent === "Cloudflare-Workers";

async function now(): Promise<number> {
  if (isWorkerd) await new Promise((resolve) => setTimeout(resolve, 0));
  return performance.now();
}

/** µs per hop for a chain of N hops, each arming the next. */
async function chain(arm: Arm, n = N): Promise<number> {
  const t0 = await now();
  await new Promise<void>((resolve) => {
    let left = n;
    const step = () => {
      // A microtask the next hop must wait for, as a resumed task would queue.
      void Promise.resolve().then(() => {});
      if (--left === 0) resolve();
      else arm(step);
    };
    arm(step);
  });
  return (((await now()) - t0) / n) * 1000;
}

export default async function macrotask() {
  const g = globalThis as any;
  const out: Record<string, number> = {};
  const candidates: Record<string, Arm | undefined> = {};
  if (typeof g.MessageChannel === "function") {
    const { port1, port2 } = new g.MessageChannel();
    let cb: () => void = () => {};
    port1.onmessage = () => cb();
    candidates.messageChannel = (run) => {
      cb = run;
      port2.postMessage(null);
    };
  }
  if (typeof g.setImmediate === "function") candidates.setImmediate = (run) => g.setImmediate(run);
  candidates.setTimeout0 = (run) => setTimeout(run, 0);
  if (typeof g.Response === "function") {
    candidates.bodyRead = (run) => void new g.Response("").arrayBuffer().then(run);
    const empty = new Uint8Array(0);
    candidates.bodyReadBytes = (run) => void new g.Response(empty).arrayBuffer().then(run);
  }
  if (typeof g.scheduler?.wait === "function") {
    candidates.schedulerWait = (run) => void g.scheduler.wait(0).then(run);
  }
  for (const [name, arm] of Object.entries(candidates)) {
    if (!arm) continue;
    // setTimeout(0) is clamped to about 1 ms in most runtimes: fewer hops.
    const n = name === "setTimeout0" ? 50 : N;
    await chain(arm, n); // warm-up
    out[name] = await chain(arm, n);
  }
  return out;
}
