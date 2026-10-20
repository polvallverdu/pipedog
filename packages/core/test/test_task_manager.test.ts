// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_task_manager.py

/** Unit tests for the asyncio TaskManager. */

import { describe, expect, test } from "bun:test";
import {
  CancelledError,
  createTask,
  currentTask,
  Event,
  gather,
  gatherSettled,
  sleep,
} from "@pipecat-ts/asyncio";
import { getRunningLoop, TaskManager } from "../src/utils/asyncio/task_manager.ts";

describe("TestTaskManagerCreateTask", () => {
  /** Tests for TaskManager.createTask() cancellation handling. */

  function createTaskManager(): TaskManager {
    return new TaskManager();
  }

  test("test_cancel_before_run_closes_coroutine", async () => {
    // A task cancelled before its coroutine starts must not leak it.
    //
    // In TS the "coroutine" is a function that only runs when the task steps
    // it; the analogue of upstream's CORO_CLOSED check is that the function
    // was never started (and so has nothing left un-awaited).
    const taskManager = createTaskManager();

    let started = false;
    const neverRuns = async () => {
      started = true;
      await sleep(0);
    };

    const task = taskManager.createTask(neverRuns, "never_runs");
    // Cancel before the event loop ever steps runCoroutine().
    task.cancel();
    await expect(Promise.resolve(task)).rejects.toBeInstanceOf(CancelledError);

    expect(started).toBe(false);
  });

  test("test_cancel_after_start_propagates_into_coroutine", async () => {
    // A started-then-cancelled task must still run the coroutine's cleanup.
    const taskManager = createTaskManager();
    const cleanupRan = new Event();

    const longHandler = async () => {
      try {
        await sleep(10);
      } catch (e) {
        if (e instanceof CancelledError) {
          cleanupRan.set();
        }
        throw e;
      }
    };

    const task = taskManager.createTask(longHandler, "long_handler");
    // Let the coroutine start and suspend at the sleep before cancelling.
    await sleep(0);
    await taskManager.cancelTask(task);

    expect(cleanupRan.isSet()).toBe(true);
  });

  test("test_normal_completion_returns_value", async () => {
    // A coroutine that runs to completion still returns its result.
    const taskManager = createTaskManager();

    const returnsValue = async () => 42;

    const task = taskManager.createTask(returnsValue, "returns_value");
    expect(await task).toEqual(42);
  });
});

describe("TestTaskManagerRegistry", () => {
  /** Tests for how TaskManager tracks concurrently-running tasks. */

  test("test_same_name_tasks_tracked_independently", async () => {
    // Concurrent tasks that share a name are each tracked separately.
    const taskManager = new TaskManager();

    const bothRunning = new Event();
    const release = new Event();
    let running = 0;

    const handler = async () => {
      running += 1;
      if (running === 2) {
        bothRunning.set();
      }
      await release.wait();
    };

    const task1 = taskManager.createTask(handler, "svc::_run_function_call");
    const task2 = taskManager.createTask(handler, "svc::_run_function_call");

    await bothRunning.wait();
    const current = taskManager.currentTasks();
    expect(current.length).toEqual(2);
    expect(current).toContain(task1);
    expect(current).toContain(task2);

    release.set();
    await gather(task1, task2);
    expect(taskManager.currentTasks().length).toEqual(0);
  });
});

describe("TestTaskManagerCancelTask", () => {
  /** Tests for TaskManager.cancelTask() cancellation handling. */

  function createTaskManager(): TaskManager {
    return new TaskManager({ loop: getRunningLoop() });
  }

  test("test_caller_cancellation_propagates", async () => {
    // cancelTask() must not swallow the caller's own cancellation.
    const taskManager = createTaskManager();

    const childStarted = new Event();
    const releaseChildCleanup = new Event();

    const slowDyingChild = async () => {
      childStarted.set();
      try {
        await new Event().wait();
      } finally {
        // Cleanup that outlives a single cancel — models a websocket
        // close handshake or a send blocked on a dead socket.
        await releaseChildCleanup.wait();
      }
    };

    const child = taskManager.createTask(slowDyingChild, "slow_dying_child");
    await childStarted.wait();

    let callerResumedAfterOwnCancel = false;

    const caller = async () => {
      await taskManager.cancelTask(child);
      callerResumedAfterOwnCancel = true;
    };

    const callerTask = createTask(caller);
    // Let the caller suspend at cancelTask's `await task`.
    await sleep(0.05);
    // Cancel the CALLER, not the child.
    callerTask.cancel();
    await sleep(0.05);

    try {
      // cancelTask swallowed the caller's own cancellation if this fails: the
      // caller completed normally after being cancelled.
      expect(callerTask.cancelled()).toBe(true);
      expect(callerResumedAfterOwnCancel).toBe(false);
    } finally {
      releaseChildCleanup.set();
      await gatherSettled(child, callerTask);
    }
  });

  test("test_child_cancellation_still_absorbed", async () => {
    // The child's own CancelledError is absorbed, not propagated.
    const taskManager = createTaskManager();

    const longHandler = async () => {
      await sleep(10);
    };

    const task = taskManager.createTask(longHandler, "long_handler");
    await sleep(0);
    // Must not raise even though awaiting `task` raises CancelledError.
    await taskManager.cancelTask(task);
    expect(task.cancelled()).toBe(true);
  });

  test("test_already_cancelled_caller_finishes_cleanup", async () => {
    // An already-cancelled caller still completes the rest of its cleanup.
    const taskManager = createTaskManager();
    const steps: string[] = [];

    const child = async () => {
      await new Event().wait();
    };

    const caller = async () => {
      const task = taskManager.createTask(child, "child");
      await sleep(0);
      try {
        await new Event().wait();
      } finally {
        await taskManager.cancelTask(task);
        steps.push("cancel_task returned");
        await sleep(0);
        steps.push("cleanup finished");
      }
    };

    const callerTask = createTask(caller);
    await sleep(0.05);
    callerTask.cancel();
    await gatherSettled(callerTask);

    expect(steps).toEqual(["cancel_task returned", "cleanup finished"]);
    expect(callerTask.cancelled()).toBe(true);
  });

  test("test_cancelling_the_running_task_is_ignored", async () => {
    // A task that asks to cancel itself carries on instead of dying.
    const taskManager = createTaskManager();
    const steps: string[] = [];

    const handler = async () => {
      steps.push("before");
      const task = currentTask();
      expect(task).toBeDefined();
      await taskManager.cancelTask(task!);
      steps.push("after");
    };

    const task = taskManager.createTask(handler, "self_canceller");
    await task;

    expect(steps).toEqual(["before", "after"]);
    expect(task.cancelled()).toBe(false);
  });
});
