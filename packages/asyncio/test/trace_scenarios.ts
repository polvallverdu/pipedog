// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Interleavings pinned against CPython's asyncio. Every scenario here mirrors
// one in python/scenarios.py, line for line; python/traces.json holds what
// CPython 3.14 logged for it, and the TypeScript run must log the same.
// asyncio_traces.test.ts runs them under bun test, and compat/smoke.ts on
// every runtime. Regenerate the traces with:
//
//   python3 packages/asyncio/test/python/scenarios.py > packages/asyncio/test/python/traces.json
//   bunx biome format --write packages/asyncio/test/python/traces.json

import {
  CancelledError,
  createTask,
  currentTask,
  Event,
  FIRST_COMPLETED,
  Future,
  gather,
  gatherSettled,
  Lock,
  PriorityQueue,
  Queue,
  Semaphore,
  shield,
  sleep,
  type Task,
  TimeoutError,
  timeout,
  wait,
  waitFor,
} from "../src/index.ts";
import traces from "./python/traces.json" with { type: "json" };

export type Log = string[];
type Scenario = (log: Log) => Promise<void>;

/** The TypeScript twin of each scenario in python/scenarios.py. */
export const scenarios: Record<string, Scenario> = {};

async function noSuspend(log: Log, depth: number): Promise<string> {
  // A coroutine that never suspends: awaiting it does not yield.
  if (depth > 0) {
    log.push(`nested ${depth}`);
    return await noSuspend(log, depth - 1);
  }
  return "leaf";
}

const pyList = (items: string[]) => `[${items.map((s) => `'${s}'`).join(", ")}]`;

scenarios.queue_producer_consumer = async (log) => {
  const q = new Queue<number>();
  const consumer = async () => {
    for (let n = 0; n < 5; n++) {
      const item = await q.get();
      log.push(`got ${item}`);
    }
  };
  const t = createTask(consumer);
  for (let i = 0; i < 3; i++) {
    await q.put(i);
    log.push(`put ${i}`);
  }
  await sleep(0);
  log.push("producer after sleep(0)");
  for (let i = 3; i < 5; i++) {
    await q.put(i);
    log.push(`put ${i}`);
  }
  await t;
  log.push("done");
};

scenarios.bounded_queue = async (log) => {
  const q = new Queue<number>(1);
  const producer = async () => {
    for (let i = 0; i < 4; i++) {
      log.push(`putting ${i}`);
      await q.put(i);
      log.push(`put ${i}`);
    }
  };
  const consumer = async () => {
    for (let n = 0; n < 4; n++) {
      const item = await q.get();
      log.push(`got ${item}`);
    }
  };
  await gather(producer, consumer);
  log.push("done");
};

scenarios.event_set_while_running = async (log) => {
  const ev = new Event();
  const waiter = async (name: string) => {
    log.push(`${name} waiting`);
    await ev.wait();
    log.push(`${name} woke`);
  };
  const a = createTask(() => waiter("a"));
  const b = createTask(() => waiter("b"));
  await sleep(0);
  ev.set();
  log.push("set");
  log.push(await noSuspend(log, 2));
  await ev.wait();
  log.push("main wait on set event did not yield");
  await sleep(0);
  log.push("main after sleep(0)");
  await a;
  await b;
  log.push("done");
};

scenarios.gather_order = async (log) => {
  const child = async (name: string, yields: number) => {
    log.push(`${name} start`);
    for (let i = 0; i < yields; i++) {
      await sleep(0);
      log.push(`${name} step ${i}`);
    }
    return name;
  };
  const results = await gather(
    () => child("a", 2),
    () => child("b", 0),
    () => child("c", 1),
  );
  log.push(`results ${pyList(results)}`);
};

scenarios.task_creation_order = async (log) => {
  const child = async (name: string) => {
    log.push(`${name} start`);
    await sleep(0);
    log.push(`${name} end`);
    return name;
  };
  const tasks = [0, 1, 2].map((i) => createTask(() => child(`t${i}`)));
  log.push("created");
  log.push(await noSuspend(log, 1));
  log.push("main still running");
  await sleep(0);
  log.push("main after sleep(0)");
  log.push(`awaited ${await tasks[2]!}`);
  log.push(`t0 done ${tasks[0]!.done() ? "True" : "False"}`);
  await gather(...tasks);
  log.push("done");
};

scenarios.sleep0_pingpong = async (log) => {
  const player = async (name: string) => {
    for (let i = 0; i < 3; i++) {
      log.push(`${name} ${i}`);
      await sleep(0);
    }
  };
  await gather(
    () => player("ping"),
    () => player("pong"),
  );
};

scenarios.fast_paths_do_not_yield = async (log) => {
  const q = new Queue<string>();
  q.putNowait("x");
  const ev = new Event();
  ev.set();
  const lock = new Lock();
  const other = async () => {
    log.push("other ran");
  };
  const mainTask = async () => {
    log.push("main start");
    log.push(await noSuspend(log, 3));
    log.push(`get ${await q.get()}`);
    await q.put("y");
    log.push("put y");
    log.push(`get ${await q.get()}`);
    await ev.wait();
    log.push("event waited");
    await lock.acquire();
    log.push("lock acquired");
    lock.release();
    const done = new Future<string>();
    done.setResult("ready");
    log.push(`done future ${await done}`);
    log.push("main suspends");
    await sleep(0);
    log.push("main end");
  };
  const t1 = createTask(mainTask);
  const t2 = createTask(other);
  await gather(t1, t2);
};

scenarios.burst_through_two_queues = async (log) => {
  // The FrameProcessor shape: an input task moves items from the input
  // queue to the process queue; the process task looks behind each item.
  const inputQ = new Queue<number>();
  const processQ = new Queue<number>();
  const total = 4;
  const inputTask = async () => {
    for (let n = 0; n < total; n++) {
      const item = await inputQ.get();
      log.push(`input moves ${item}`);
      await processQ.put(item);
    }
  };
  const processTask = async () => {
    for (let n = 0; n < total; n++) {
      const item = await processQ.get();
      log.push(`process ${item} with ${processQ.qsize()} queued behind`);
    }
  };
  const tasks = [createTask(inputTask), createTask(processTask)];
  await sleep(0);
  for (let i = 0; i < 3; i++) await inputQ.put(i);
  log.push("burst queued");
  await sleep(0);
  await inputQ.put(3);
  log.push("straggler queued");
  await gather(...tasks);
};

scenarios.priority_queue_burst = async (log) => {
  const q = new PriorityQueue<[number, string]>();
  const consumer = async () => {
    for (let n = 0; n < 3; n++) {
      const [p, s] = await q.get();
      log.push(`got (${p}, '${s}')`);
    }
  };
  const t = createTask(consumer);
  await sleep(0);
  q.putNowait([3, "c"]);
  q.putNowait([1, "a"]);
  q.putNowait([2, "b"]);
  log.push("queued");
  await t;
};

scenarios.queue_item_taken_before_woken_getter_runs = async (log) => {
  const q = new Queue<string>();
  const getter = async () => {
    log.push("getter waiting");
    log.push(`getter got ${await q.get()}`);
  };
  const t = createTask(getter);
  await sleep(0);
  q.putNowait("first");
  log.push(`main took ${q.getNowait()}`);
  await sleep(0);
  log.push("main after sleep(0)");
  q.putNowait("second");
  await t;
};

scenarios.cancel_waiting_get = async (log) => {
  const q = new Queue<string>();
  const getter = async () => {
    try {
      await q.get();
    } catch (e) {
      if (e instanceof CancelledError) log.push("getter cancelled");
      throw e;
    } finally {
      log.push("getter finally");
    }
  };
  const t = createTask(getter);
  await sleep(0);
  log.push(`cancel ${t.cancel() ? "True" : "False"}`);
  log.push(`done right after cancel ${t.done() ? "True" : "False"}`);
  try {
    await t;
  } catch (e) {
    if (e instanceof CancelledError) log.push("awaiting raised CancelledError");
  }
  log.push(`cancelled ${t.cancelled() ? "True" : "False"}`);
};

scenarios.cancel_after_wakeup = async (log) => {
  const q = new Queue<string>();
  const getter = async (name: string) => {
    try {
      log.push(`${name} got ${await q.get()}`);
    } catch (e) {
      if (e instanceof CancelledError) log.push(`${name} cancelled`);
      throw e;
    }
  };
  const a = createTask(() => getter("a"));
  const b = createTask(() => getter("b"));
  await sleep(0);
  q.putNowait("item");
  // a is woken up but has not run yet: the cancellation wins, and a passes
  // the wakeup on to b.
  a.cancel();
  await gatherSettled(a, b);
  log.push(`a cancelled ${a.cancelled() ? "True" : "False"}, qsize ${q.qsize()}`);
};

scenarios.cancel_before_start = async (log) => {
  const child = async () => {
    log.push("child body ran");
  };
  const t = createTask(child);
  t.cancel();
  try {
    await t;
  } catch (e) {
    if (e instanceof CancelledError) log.push("cancelled before start");
  }
};

scenarios.cancel_parent_awaiting_child = async (log) => {
  const child = async () => {
    try {
      await sleep(10);
    } finally {
      log.push("child finally");
    }
  };
  const parent = async (c: Task<void>) => {
    try {
      await c;
    } catch (e) {
      if (e instanceof CancelledError) log.push("parent got CancelledError");
      throw e;
    }
  };
  const c = createTask(child);
  const p = createTask(() => parent(c));
  await sleep(0);
  p.cancel();
  log.push(`child cancelling ${c.cancelling()}`);
  await gatherSettled(p);
  log.push(
    `parent cancelled ${p.cancelled() ? "True" : "False"}, child cancelled ${c.cancelled() ? "True" : "False"}`,
  );
};

scenarios.child_swallows_cancel = async (log) => {
  const child = async () => {
    try {
      await sleep(10);
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      log.push("child swallows");
    }
    return "child result";
  };
  const parent = async (c: Task<string>) => {
    const result = await c;
    log.push(`parent got ${result}`);
    return result;
  };
  const c = createTask(child);
  const p = createTask(() => parent(c));
  await sleep(0);
  p.cancel();
  log.push(`parent result ${await p}, parent cancelling ${p.cancelling()}`);
};

scenarios.lock_fairness = async (log) => {
  const lock = new Lock();
  const worker = (name: string) =>
    lock.run(async () => {
      log.push(`${name} in`);
      await sleep(0);
      log.push(`${name} out`);
    });
  await gather(
    () => worker("a"),
    () => worker("b"),
    () => worker("c"),
  );
};

scenarios.semaphore_order = async (log) => {
  const sem = new Semaphore(2);
  const worker = (name: string) =>
    sem.run(async () => {
      log.push(`${name} in`);
      await sleep(0);
      log.push(`${name} out`);
    });
  await gather(...[..."abcd"].map((n) => () => worker(n)));
};

scenarios.wait_for_timeout = async (log) => {
  const slow = async () => {
    try {
      await sleep(10);
    } finally {
      log.push("slow finally");
    }
  };
  const fast = async () => {
    await sleep(0);
    return "fast";
  };
  try {
    await waitFor(slow, 0.01);
  } catch (e) {
    if (e instanceof TimeoutError) log.push(e.name);
  }
  log.push(`wait_for result ${await waitFor(fast, 1)}`);
  log.push(`cancelling ${currentTask()!.cancelling()}`);
  try {
    await waitFor(fast, 0);
  } catch (e) {
    if (e instanceof TimeoutError) log.push(`zero timeout ${e.name}`);
  }
};

scenarios.wait_first_completed = async (log) => {
  const child = async (name: string, yields: number) => {
    for (let i = 0; i < yields; i++) await sleep(0);
    log.push(`${name} finished`);
    return name;
  };
  const a = createTask(() => child("a", 3), "a");
  const b = createTask(() => child("b", 1), "b");
  const names = (s: Set<Task<string>>) => pyList([...s].map((t) => t.getName()).sort());
  let [done, pending] = await wait([a, b], { returnWhen: FIRST_COMPLETED });
  log.push(`done ${names(done)} pending ${names(pending)}`);
  [done, pending] = await wait([a, b]);
  log.push(`done ${names(done)} pending ${pending.size}`);
};

scenarios.done_callbacks_order = async (log) => {
  const child = async () => {
    log.push("child runs");
    return 1;
  };
  const t = createTask(child);
  t.addDoneCallback(() => log.push("callback 1"));
  const awaiter = async () => {
    await t;
    log.push("awaiter resumed");
  };
  const w = createTask(awaiter);
  await sleep(0);
  t.addDoneCallback(() => log.push("callback 2"));
  await w;
  t.addDoneCallback(() => log.push("callback 3 (added when done)"));
  log.push("main after awaiter");
  await sleep(0);
  log.push("main end");
};

scenarios.shield_inner_survives = async (log) => {
  const inner = async () => {
    await sleep(0);
    await sleep(0);
    log.push("inner finished");
    return "inner";
  };
  const innerTask = createTask(inner);
  const outer = async () => {
    try {
      await shield(innerTask);
    } catch (e) {
      if (e instanceof CancelledError) log.push("outer cancelled");
      throw e;
    }
  };
  const o = createTask(outer);
  await sleep(0);
  o.cancel();
  await gatherSettled(o);
  log.push(`inner done ${innerTask.done() ? "True" : "False"}`);
  log.push(`inner result ${await innerTask}`);
};

scenarios.gather_cancel = async (log) => {
  const child = async (name: string) => {
    try {
      await sleep(10);
    } catch (e) {
      if (e instanceof CancelledError) {
        log.push(`${name} cancelled`);
        await sleep(0);
        log.push(`${name} cleanup done`);
      }
      throw e;
    }
  };
  const parent = async () => {
    try {
      await gather(
        () => child("a"),
        () => child("b"),
      );
    } catch (e) {
      if (e instanceof CancelledError) log.push("parent got CancelledError");
      throw e;
    }
  };
  const p = createTask(parent);
  await sleep(0);
  await sleep(0);
  p.cancel();
  await gatherSettled(p);
  log.push(`parent cancelled ${p.cancelled() ? "True" : "False"}`);
};

scenarios.gather_exception = async (log) => {
  const bad = async () => {
    await sleep(0);
    throw new Error("boom");
  };
  const good = async () => {
    for (let i = 0; i < 3; i++) await sleep(0);
    log.push("good finished");
    return "good";
  };
  const g = createTask(good);
  try {
    await gather(bad, g);
  } catch (e) {
    log.push(`gather raised ${(e as Error).message}`);
  }
  log.push(`good done ${g.done() ? "True" : "False"}`);
  await g;
  const settled = await gatherSettled(bad, g);
  const repr = settled.map((r) => (r instanceof Error ? `ValueError('${r.message}')` : `'${r}'`));
  log.push(`gather settled [${repr.join(", ")}]`);
};

scenarios.event_cleared_before_waiter_runs = async (log) => {
  const ev = new Event();
  const waiter = async () => {
    log.push(`waiter got ${(await ev.wait()) ? "True" : "False"}`);
  };
  const t = createTask(waiter);
  await sleep(0);
  ev.set();
  ev.clear();
  await t;
  log.push(`is_set ${ev.isSet() ? "True" : "False"}`);
};

scenarios.timers_in_order = async (log) => {
  const sleeper = async (name: string, delay: number) => {
    await sleep(delay);
    log.push(`${name} woke`);
  };
  await gather(
    () => sleeper("late", 0.03),
    () => sleeper("early", 0.01),
    () => sleeper("zero", 0),
  );
};

scenarios.queue_join = async (log) => {
  const q = new Queue<number>();
  const worker = async () => {
    while (true) {
      const item = await q.get();
      log.push(`work ${item}`);
      await sleep(0);
      q.taskDone();
    }
  };
  const w = createTask(worker);
  for (let i = 0; i < 3; i++) q.putNowait(i);
  await q.join();
  log.push("joined");
  w.cancel();
  await gatherSettled(w);
  log.push(`worker cancelled ${w.cancelled() ? "True" : "False"}`);
};

scenarios.task_started_from_callback = async (log) => {
  const child = async (name: string) => {
    log.push(`${name} runs`);
  };
  const first = async () => {
    log.push("first runs");
  };
  const t = createTask(first);
  t.addDoneCallback(() => createTask(() => child("from callback")));
  createTask(() => child("sibling"));
  await t;
  log.push("main resumed");
  await sleep(0);
  await sleep(0);
  log.push("main end");
};

scenarios.timeout_scope = async (log) => {
  try {
    await timeout(0.01, async () => {
      try {
        await sleep(10);
      } catch (e) {
        if (e instanceof CancelledError) log.push("body cancelled");
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof TimeoutError) log.push("scope raised TimeoutError");
  }
  await timeout(1, async () => {
    await sleep(0);
    log.push("body finished in time");
  });
  log.push(`cancelling ${currentTask()!.cancelling()}`);
};

scenarios.wait_for_task_cancels_it = async (log) => {
  const child = async () => {
    try {
      await sleep(10);
    } catch (e) {
      if (e instanceof CancelledError) log.push("child cancelled");
      throw e;
    }
  };
  const t = createTask(child);
  try {
    await waitFor(t, 0.01);
  } catch (e) {
    if (e instanceof TimeoutError)
      log.push(`timed out, child cancelled ${t.cancelled() ? "True" : "False"}`);
  }
};

scenarios.lock_waiter_cancelled = async (log) => {
  const lock = new Lock();
  const worker = async (name: string) => {
    try {
      await lock.run(async () => {
        log.push(`${name} in`);
        await sleep(0);
        log.push(`${name} out`);
      });
    } catch (e) {
      if (e instanceof CancelledError) log.push(`${name} cancelled`);
      throw e;
    }
  };
  const a = createTask(() => worker("a"));
  const b = createTask(() => worker("b"));
  const c = createTask(() => worker("c"));
  await sleep(0);
  b.cancel();
  await gatherSettled(a, b, c);
  log.push(`locked ${lock.locked() ? "True" : "False"}`);
};

scenarios.bounded_putter_cancelled = async (log) => {
  const q = new Queue<string>(1);
  q.putNowait("full");
  const putter = async (name: string) => {
    try {
      await q.put(name);
      log.push(`${name} put`);
    } catch (e) {
      if (e instanceof CancelledError) log.push(`${name} cancelled`);
      throw e;
    }
  };
  const a = createTask(() => putter("a"));
  const b = createTask(() => putter("b"));
  await sleep(0);
  log.push(`got ${q.getNowait()}`);
  a.cancel();
  await gatherSettled(a, b);
  log.push(`queue holds ${q.getNowait()}`);
};

scenarios.cancelled_right_before_returning = async (log) => {
  const child = async () => {
    currentTask()!.cancel();
    log.push("child returns");
    return 1;
  };
  const t = createTask(child);
  try {
    await t;
  } catch (e) {
    if (e instanceof CancelledError) {
      log.push(`awaiting raised CancelledError, cancelled ${t.cancelled() ? "True" : "False"}`);
    }
  }
};

/** What CPython logged for each scenario. */
export const expectedTraces = traces as Record<string, string[]>;

/** Run a scenario as the main task (asyncio.run) and return its log. */
export async function runScenario(name: string): Promise<Log> {
  const log: Log = [];
  const run = scenarios[name];
  if (!run) throw new Error(`no scenario ${name}`);
  await createTask(() => run(log), "main");
  return log;
}
