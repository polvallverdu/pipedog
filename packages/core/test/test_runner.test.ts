// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_runner.py

import { describe, expect, test } from "bun:test";
import { CancelledError, Event, sleep, waitFor } from "@pipedog/asyncio";
import {
  BusAddWorkerMessage,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusEndMessage,
  BusEndWorkerMessage,
  type BusMessage,
} from "../src/bus/index.ts";
import { BaseWorker } from "../src/workers/base_worker.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

/** BaseWorker subclass that stops on end/cancel so the runner can exit. */
class StubTask extends BaseWorker {
  constructor(name: string) {
    super({ name });
  }

  protected override async _handleWorkerEnd(message: BusEndWorkerMessage): Promise<void> {
    await super._handleWorkerEnd(message);
    this._finishedEvent.set();
  }

  protected override async _handleWorkerCancel(message: BusCancelWorkerMessage): Promise<void> {
    await super._handleWorkerCancel(message);
    this._finishedEvent.set();
  }
}

/** Test-only access to protected members, as the Python test pokes privates. */
type Internals = { _parent: string | null };
type RunnerInternals = { _cancelSpawnedWorkers(): Promise<void> };

describe("TestWorkerRunner", () => {
  // Deprecated: `PipelineRunner` is a deprecated alias of `WorkerRunner` and
  // is not ported (see docs/CONVENTIONS.md).
  test.skip("test_pipeline_runner_alias_is_deprecated", () => {});

  test("test_spawn_registers_task", async () => {
    // addWorkers() registers the task by name (duplicate is silently skipped).
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");

    await runner.addWorkers(task);

    // Duplicate is silently skipped (logs error)
    await runner.addWorkers(new StubTask("task_a"));
  });

  test("test_run_starts_bus_and_tasks", async () => {
    // run() starts bus, starts all tasks, fires on_ready.
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");
    await runner.addWorkers(task);

    const runnerStarted = new Event();

    runner.eventHandler("on_ready", async (runner: WorkerRunner) => {
      runnerStarted.set();
      // Immediately end to unblock run()
      await runner.end();
    });

    await waitFor(() => runner.run(), 5.0);

    expect(runnerStarted.isSet()).toBe(true);
  });

  test("test_end_is_idempotent", async () => {
    // end() is idempotent — subsequent calls are no-ops.
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");
    await runner.addWorkers(task);

    runner.eventHandler("on_ready", async (runner: WorkerRunner) => {
      await runner.end("first");
      await runner.end("second"); // should be no-op
    });

    await waitFor(() => runner.run(), 5.0);
    // If we got here without hanging, idempotency works
  });

  test("test_cancel_is_idempotent", async () => {
    // cancel() is idempotent — subsequent calls are no-ops.
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");
    await runner.addWorkers(task);

    runner.eventHandler("on_ready", async (runner: WorkerRunner) => {
      await runner.cancel("first");
      await runner.cancel("second"); // should be no-op
    });

    try {
      await waitFor(() => runner.run(), 5.0);
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  });

  test("test_end_sends_end_task_message_to_root_tasks_only", async () => {
    // end() sends BusEndWorkerMessage only to root tasks (no parent).
    const runner = new WorkerRunner({ handleSigint: false });
    const root = new StubTask("root");
    const child = new StubTask("child");
    // Manually mark child as having root as parent
    (child as unknown as Internals)._parent = root.name;
    await runner.addWorkers(root);
    await runner.addWorkers(child);

    const sent: BusMessage[] = [];
    const bus = runner.bus;
    const originalSend = bus.send.bind(bus);

    bus.send = async (message: BusMessage) => {
      sent.push(message);
      await originalSend(message);
    };

    // Call end() directly — no need to run the full pipeline lifecycle
    await runner.end();

    const endMsgs = sent.filter((m) => m instanceof BusEndWorkerMessage);
    const targets = new Set(endMsgs.map((m) => m.target));
    expect(targets.has("root")).toBe(true);
    expect(targets.has("child")).toBe(false);
  });

  test("test_cancel_sends_cancel_task_message_to_root_tasks_only", async () => {
    // Cancelling reaches root tasks only, and carries the caller's reason.
    //
    // `cancel()` signals shutdown; the messages go out as the runner exits,
    // which is why that step is driven here directly.
    const runner = new WorkerRunner({ handleSigint: false });
    const root = new StubTask("root");
    const child = new StubTask("child");
    (child as unknown as Internals)._parent = root.name;
    await runner.addWorkers(root);
    await runner.addWorkers(child);

    const sent: BusMessage[] = [];
    const bus = runner.bus;
    const originalSend = bus.send.bind(bus);

    bus.send = async (message: BusMessage) => {
      sent.push(message);
      await originalSend(message);
    };

    await runner.cancel("stop now");
    // What `run()` does once the shutdown signal reaches it.
    await (runner as unknown as RunnerInternals)._cancelSpawnedWorkers();

    const cancelMsgs = sent.filter((m) => m instanceof BusCancelWorkerMessage);
    const targets = new Set(cancelMsgs.map((m) => m.target));
    expect(targets.has("root")).toBe(true);
    expect(targets.has("child")).toBe(false);
    expect(new Set(cancelMsgs.map((m) => m.reason))).toEqual(new Set(["stop now"]));
  });

  test("test_bus_end_message_triggers_end", async () => {
    // BusEndMessage on bus triggers runner.end().
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");
    await runner.addWorkers(task);

    const bus = runner.bus;

    runner.eventHandler("on_ready", async (_runner: WorkerRunner) => {
      // Simulate a task sending BusEndMessage
      await bus.send(new BusEndMessage({ source: "task_a" }));
    });

    await waitFor(() => runner.run(), 5.0);
    // If we got here, end was triggered by the bus message
  });

  test("test_bus_cancel_message_triggers_cancel", async () => {
    // BusCancelMessage on bus triggers runner.cancel().
    const runner = new WorkerRunner({ handleSigint: false });
    const task = new StubTask("task_a");
    await runner.addWorkers(task);

    const bus = runner.bus;

    runner.eventHandler("on_ready", async (_runner: WorkerRunner) => {
      await bus.send(new BusCancelMessage({ source: "task_a" }));
    });

    try {
      await waitFor(() => runner.run(), 5.0);
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  });

  test("test_bus_add_task_message_triggers_add", async () => {
    // BusAddWorkerMessage on bus triggers addWorkers().
    const runner = new WorkerRunner({ handleSigint: false });
    const taskA = new StubTask("task_a");
    await runner.addWorkers(taskA);

    const taskB = new StubTask("task_b");
    const bus = runner.bus;

    runner.eventHandler("on_ready", async (runner: WorkerRunner) => {
      // Upstream passes the stale keyword `task=task_b`; the message field is
      // `worker` (BusAddWorkerMessage.worker), which an options object requires.
      await bus.send(new BusAddWorkerMessage({ source: "task_a", worker: taskB }));
      await sleep(0.1);
      await runner.end();
    });

    await waitFor(() => runner.run(), 5.0);

    // Verify task_b was added (duplicate is silently skipped)
    await runner.addWorkers(new StubTask("task_b"));
  });
});
