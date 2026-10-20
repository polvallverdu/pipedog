// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_registry.py

import { beforeEach, describe, expect, test } from "bun:test";

import { WorkerRegistry } from "../src/registry/index.ts";
import { WorkerReadyData } from "../src/registry/types.ts";

describe("TestTaskRegistry", () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry("runner_a");
  });

  test("test_register_local_task", async () => {
    // Local task is registered and appears in local_workers.
    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    const result = await registry.register(data);

    expect(result).toBe(true);
    expect(registry.localWorkers).toContain("greeter");
    expect(registry.remoteWorkers).not.toContain("greeter");
  });

  test("test_register_remote_task", async () => {
    // Remote task is registered and appears in remote_workers.
    const data = new WorkerReadyData({ workerName: "support", runner: "runner_b" });
    const result = await registry.register(data);

    expect(result).toBe(true);
    expect(registry.remoteWorkers).toContain("support");
    expect(registry.localWorkers).not.toContain("support");
  });

  test("test_duplicate_registration_returns_false", async () => {
    // Registering the same task twice returns False.
    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    const first = await registry.register(data);
    const second = await registry.register(data);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(registry.localWorkers.filter((n) => n === "greeter").length).toEqual(1);
  });

  test("test_get_local_task", async () => {
    // get() returns data for a local task.
    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    const result = registry.get("greeter");
    expect(result).toBe(data);
  });

  test("test_get_remote_task", async () => {
    // get() returns data for a remote task.
    const data = new WorkerReadyData({ workerName: "support", runner: "runner_b" });
    await registry.register(data);

    const result = registry.get("support");
    expect(result).toBe(data);
  });

  test("test_get_unknown_task_returns_none", async () => {
    // get() returns None for an unknown task.
    expect(registry.get("nonexistent")).toBeNull();
  });

  test("test_contains", async () => {
    // __contains__ works for registered and unregistered tasks.
    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    expect(registry.has("greeter")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
  });

  test("test_watch_fires_on_registration", async () => {
    // Watch handler fires when the watched task registers.
    const received: WorkerReadyData[] = [];

    const handler = async (taskData: WorkerReadyData) => {
      received.push(taskData);
    };

    await registry.watch("greeter", handler);

    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    expect(received.length).toEqual(1);
    expect(received[0]).toBe(data);
  });

  test("test_watch_is_idempotent_for_same_handler", async () => {
    // Re-watching with the same handler does not double-fire on registration.
    const received: WorkerReadyData[] = [];

    const handler = async (taskData: WorkerReadyData) => {
      received.push(taskData);
    };

    await registry.watch("greeter", handler);
    await registry.watch("greeter", handler); // duplicate, should be no-op

    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    expect(received.length).toEqual(1);
  });

  test("test_watch_does_not_fire_for_other_tasks", async () => {
    // Watch handler does not fire for a different task.
    const received: WorkerReadyData[] = [];

    const handler = async (taskData: WorkerReadyData) => {
      received.push(taskData);
    };

    await registry.watch("greeter", handler);

    const data = new WorkerReadyData({ workerName: "support", runner: "runner_a" });
    await registry.register(data);

    expect(received.length).toEqual(0);
  });

  test("test_watch_does_not_fire_on_duplicate", async () => {
    // Watch handler does not fire on duplicate registration.
    const received: WorkerReadyData[] = [];

    const handler = async (taskData: WorkerReadyData) => {
      received.push(taskData);
    };

    await registry.watch("greeter", handler);

    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);
    await registry.register(data);

    expect(received.length).toEqual(1);
  });

  test("test_multiple_watchers", async () => {
    // Multiple watch handlers fire for the same task.
    const receivedA: WorkerReadyData[] = [];
    const receivedB: WorkerReadyData[] = [];

    const handlerA = async (taskData: WorkerReadyData) => {
      receivedA.push(taskData);
    };

    const handlerB = async (taskData: WorkerReadyData) => {
      receivedB.push(taskData);
    };

    await registry.watch("greeter", handlerA);
    await registry.watch("greeter", handlerB);

    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    expect(receivedA.length).toEqual(1);
    expect(receivedB.length).toEqual(1);
  });

  test("test_watch_fires_immediately_if_already_registered", async () => {
    // Watch handler fires immediately when the task is already registered.
    const data = new WorkerReadyData({ workerName: "greeter", runner: "runner_a" });
    await registry.register(data);

    const received: WorkerReadyData[] = [];

    const handler = async (taskData: WorkerReadyData) => {
      received.push(taskData);
    };

    await registry.watch("greeter", handler);

    expect(received.length).toEqual(1);
    expect(received[0]).toBe(data);
  });

  test("test_runner_name_property", async () => {
    // runner_name returns the name passed at construction.
    expect(registry.runnerName).toEqual("runner_a");
  });

  test("test_multiple_remote_runners", async () => {
    // Tasks from multiple remote runners are tracked separately.
    const dataB = new WorkerReadyData({ workerName: "task_b", runner: "runner_b" });
    const dataC = new WorkerReadyData({ workerName: "task_c", runner: "runner_c" });
    await registry.register(dataB);
    await registry.register(dataC);

    const remote = registry.remoteWorkers;
    expect(remote).toContain("task_b");
    expect(remote).toContain("task_c");
    expect(remote.length).toEqual(2);
  });
});
