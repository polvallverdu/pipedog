// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import {
  abortable,
  CancelledError,
  createTask,
  currentTask,
  Event,
  gather,
  Lock,
  PriorityQueue,
  Queue,
  sleep,
  type Task,
  TimeoutError,
  wait,
  waitFor,
} from "../src/index.ts";

describe("Task", () => {
  test("does not start synchronously and returns its result", async () => {
    const order: string[] = [];
    const task = createTask(async () => {
      order.push("task");
      return 42;
    });
    order.push("caller");
    expect(await task).toBe(42);
    expect(order).toEqual(["caller", "task"]);
    expect(task.done()).toBe(true);
    expect(task.result()).toBe(42);
  });

  test("currentTask is tracked across awaits", async () => {
    let seen: unknown;
    const task = createTask(async () => {
      await sleep(0.001);
      // Don't return the task itself: Tasks are thenables and would adopt themselves.
      seen = currentTask();
    }, "named");
    await task;
    expect(seen).toBe(task);
    expect(task.getName()).toBe("named");
    expect(currentTask()).toBeUndefined();
  });

  test("cancel delivers CancelledError at the suspended await and runs finally", async () => {
    const events: string[] = [];
    const task = createTask(async () => {
      try {
        await sleep(10);
        events.push("not reached");
      } finally {
        events.push("finally");
      }
    });
    await sleep(0.01);
    task.cancel();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
    expect(task.cancelled()).toBe(true);
    expect(events).toEqual(["finally"]);
  });

  test("cancel before start never runs the body", async () => {
    let ran = false;
    const task = createTask(async () => {
      ran = true;
    });
    task.cancel();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBe(false);
  });

  test("a task may catch CancelledError and finish normally", async () => {
    const task = createTask(async () => {
      try {
        await sleep(10);
      } catch (e) {
        if (e instanceof CancelledError) return "caught";
        throw e;
      }
      return "no";
    });
    await sleep(0.005);
    task.cancel();
    expect(await task.promise).toBe("caught");
    expect(task.cancelled()).toBe(false);
  });

  test("cancellation is consumed once: awaits after catching it work", async () => {
    const task = createTask(async () => {
      try {
        await sleep(10);
      } catch {
        await sleep(0.001);
        return "cleaned up";
      }
    });
    await sleep(0.005);
    task.cancel();
    expect(await task.promise).toBe("cleaned up");
  });

  test("pending cancel is raised at the next checkpoint after a foreign await", async () => {
    let release!: () => void;
    const foreign = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    const task = createTask(async () => {
      await foreign; // not a cancellation point
      events.push("after foreign");
      await sleep(0); // checkpoint
      events.push("not reached");
    });
    await sleep(0.005);
    task.cancel();
    expect(task.signal.aborted).toBe(true);
    release();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
    expect(events).toEqual(["after foreign"]);
  });

  test("Queue.put is a cancellation point, so stale items are never pushed", async () => {
    const queue = new Queue<string>();
    let release!: () => void;
    const llm = new Promise<void>((r) => {
      release = r;
    });
    const task = createTask(async () => {
      await llm; // foreign await, e.g. an LLM stream chunk
      await queue.put("stale audio");
    });
    await sleep(0.002);
    task.cancel();
    release();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
    expect(queue.empty()).toBe(true);
  });

  test("abortable() turns a foreign await into a cancellation point", async () => {
    const task = createTask(async () => {
      await abortable(new Promise(() => {}));
    });
    await sleep(0.005);
    task.cancel();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("cancelling a task that awaits another task cancels both", async () => {
    const inner = createTask(() => sleep(10));
    const outer = createTask(async () => {
      await inner;
    });
    await sleep(0.005);
    outer.cancel();
    await expect(outer.promise).rejects.toBeInstanceOf(CancelledError);
    await expect(inner.promise).rejects.toBeInstanceOf(CancelledError);
  });

  // pipedog#96: `child.then(cb)` without awaiting made the caller a waiter on
  // `child`. The child's wakeup then cleared what the caller was really
  // blocked on, and cancelling the caller cancelled the child instead.
  test("then() on a task leaves the caller cancellable once the task is done", async () => {
    const caller = createTask(async () => {
      const child = createTask(() => sleep(0.01));
      child.then(() => {});
      await new Queue<number>().get();
    });
    await sleep(0.05);
    caller.cancel();
    await waitFor(
      caller.promise.catch(() => {}),
      0.5,
    );
    expect(caller.cancelled()).toBe(true);
  });

  test("then() on a pending task: cancelling the caller cancels the caller", async () => {
    let child!: Task<void>;
    const caller = createTask(async () => {
      child = createTask(() => new Event().wait());
      child.then(
        () => {},
        () => {},
      );
      // A foreign await: the cancellation is raised at the next checkpoint.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await sleep(10);
    });
    await sleep(0.005);
    caller.cancel();
    await waitFor(
      caller.promise.catch(() => {}),
      0.5,
    );
    expect(caller.cancelled()).toBe(true);
    expect(child.done()).toBe(false);
    child.cancel();
  });

  test("await Promise.all over tasks is still a cancellation point", async () => {
    const a = createTask(() => sleep(10));
    const b = createTask(() => sleep(10));
    const caller = createTask(async () => {
      await Promise.all([a, b]);
    });
    await sleep(0.005);
    caller.cancel();
    await expect(caller.promise).rejects.toBeInstanceOf(CancelledError);
    a.cancel();
  });

  test("exceptions are kept on the task", async () => {
    const task = createTask(async () => {
      throw new Error("boom");
    });
    await expect(task.promise).rejects.toThrow("boom");
    expect((task.exception() as Error).message).toBe("boom");
  });
});

describe("primitives", () => {
  test("Event wakes all waiters", async () => {
    const event = new Event();
    const results: number[] = [];
    const tasks = [1, 2].map((i) =>
      createTask(async () => {
        await event.wait();
        results.push(i);
      }),
    );
    await sleep(0.001);
    expect(results).toEqual([]);
    event.set();
    await gather(...tasks);
    expect(results.sort()).toEqual([1, 2]);
  });

  test("Queue is FIFO, blocks on get and supports join", async () => {
    const queue = new Queue<number>();
    const got: number[] = [];
    const consumer = createTask(async () => {
      for (;;) {
        got.push(await queue.get());
        queue.taskDone();
      }
    });
    await queue.put(1);
    await queue.put(2);
    await queue.put(3);
    await queue.join();
    expect(got).toEqual([1, 2, 3]);
    consumer.cancel();
    await expect(consumer.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("bounded Queue blocks put", async () => {
    const queue = new Queue<number>(1);
    await queue.put(1);
    let putDone = false;
    const producer = createTask(async () => {
      await queue.put(2);
      putDone = true;
    });
    await sleep(0.002);
    expect(putDone).toBe(false);
    expect(queue.getNowait()).toBe(1);
    await producer;
    expect(putDone).toBe(true);
  });

  test("PriorityQueue orders tuples like Python", async () => {
    const queue = new PriorityQueue<[number, number, string]>();
    queue.putNowait([20, 1, "data"]);
    queue.putNowait([10, 2, "system"]);
    queue.putNowait([1, 3, "start"]);
    queue.putNowait([10, 4, "system2"]);
    const out: string[] = [];
    while (!queue.empty()) out.push((await queue.get())[2]);
    expect(out).toEqual(["start", "system", "system2", "data"]);
  });

  test("a cancelled get does not swallow an item", async () => {
    const queue = new Queue<number>();
    const getter = createTask(() => queue.get());
    await sleep(0.001);
    getter.cancel();
    await expect(getter.promise).rejects.toBeInstanceOf(CancelledError);
    queue.putNowait(7);
    expect(await queue.get()).toBe(7);
  });

  test("waitFor raises TimeoutError and cancels the child", async () => {
    let finished = false;
    const child = async () => {
      try {
        await sleep(10);
      } finally {
        finished = true;
      }
    };
    await expect(waitFor(child, 0.01)).rejects.toBeInstanceOf(TimeoutError);
    expect(finished).toBe(true);
    expect(await waitFor(async () => 5, 1)).toBe(5);
  });

  test("gather returns results in order and cancels children when cancelled", async () => {
    expect(
      await gather(
        async () => 1,
        async () => "two",
      ),
    ).toEqual([1, "two"]);
    const child = createTask(() => sleep(10));
    const parent = createTask(() => gather(child));
    await sleep(0.002);
    parent.cancel();
    await expect(parent.promise).rejects.toBeInstanceOf(CancelledError);
    await expect(child.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("wait returns done and pending sets on timeout", async () => {
    const fast = createTask(() => sleep(0.001));
    const slow = createTask(() => sleep(10));
    const [done, pending] = await wait([fast, slow], { timeout: 0.02 });
    expect(done.has(fast)).toBe(true);
    expect(pending.has(slow)).toBe(true);
    slow.cancel();
  });

  test("Lock serializes critical sections", async () => {
    const lock = new Lock();
    const order: string[] = [];
    const run = (name: string) =>
      lock.run(async () => {
        order.push(`${name}:in`);
        await sleep(0.002);
        order.push(`${name}:out`);
      });
    await gather(
      () => run("a"),
      () => run("b"),
    );
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });
});
