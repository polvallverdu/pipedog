// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_job_group.py

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CancelledError, createTask, Event, sleep, waitFor } from "@pipedog/asyncio";
import {
  AsyncQueueBus,
  BusDataMessage,
  BusJobCancelMessage,
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusJobResponseUrgentMessage,
  type BusMessage,
} from "../src/bus/index.ts";
import {
  JobError,
  JobEvent,
  JobGroup,
  JobGroupError,
  JobGroupEvent,
  JobGroupParams,
  JobParams,
  type JobPayload,
  JobStatus,
} from "../src/pipeline/job_context.ts";
import { WorkerRegistry } from "../src/registry/index.ts";
import { WorkerReadyData } from "../src/registry/types.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { BaseWorker } from "../src/workers/base_worker.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

class StubTask extends BaseWorker {
  constructor(name: string) {
    super({ name });
  }
}

/** Worker that automatically responds to job requests via the bus. */
class JobWorkerTask extends BaseWorker {
  protected _autoResponse: JobPayload | null;
  protected _autoStatus: JobStatus;

  constructor(name: string, options: { response?: JobPayload | null; status?: JobStatus } = {}) {
    super({ name });
    this._autoResponse = options.response ?? null;
    this._autoStatus = options.status ?? JobStatus.COMPLETED;
  }

  override async onJobRequest(message: BusJobRequestMessage): Promise<void> {
    await super.onJobRequest(message);
    await this.sendJobResponse(message.jobId, this._autoResponse, { status: this._autoStatus });
  }
}

/** Worker that responds urgently to job requests. */
class UrgentJobWorkerTask extends BaseWorker {
  protected _autoResponse: JobPayload | null;
  protected _autoStatus: JobStatus;

  constructor(name: string, options: { response?: JobPayload | null; status?: JobStatus } = {}) {
    super({ name });
    this._autoResponse = options.response ?? null;
    this._autoStatus = options.status ?? JobStatus.COMPLETED;
  }

  override async onJobRequest(message: BusJobRequestMessage): Promise<void> {
    await super.onJobRequest(message);
    await this.sendJobResponse(message.jobId, this._autoResponse, {
      status: this._autoStatus,
      urgent: true,
    });
  }
}

/** Worker that sends updates before responding. */
class UpdatingWorkerTask extends BaseWorker {
  protected _updates: JobPayload[];
  protected _autoResponse: JobPayload | null;

  constructor(name: string, options: { updates: JobPayload[]; response?: JobPayload | null }) {
    super({ name });
    this._updates = options.updates;
    this._autoResponse = options.response ?? null;
  }

  override async onJobRequest(message: BusJobRequestMessage): Promise<void> {
    await super.onJobRequest(message);
    for (const update of this._updates) {
      await this.sendJobUpdate(message.jobId, update);
    }
    await this.sendJobResponse(message.jobId, this._autoResponse);
  }
}

/** Worker that streams data before responding. */
class StreamingWorkerTask extends BaseWorker {
  protected _chunks: JobPayload[];
  protected _autoResponse: JobPayload | null;

  constructor(name: string, options: { chunks: JobPayload[]; response?: JobPayload | null }) {
    super({ name });
    this._chunks = options.chunks;
    this._autoResponse = options.response ?? null;
  }

  override async onJobRequest(message: BusJobRequestMessage): Promise<void> {
    await super.onJobRequest(message);
    await this.sendJobStreamStart(message.jobId, { content_type: "text" });
    for (const chunk of this._chunks) {
      await this.sendJobStreamData(message.jobId, chunk);
    }
    await this.sendJobStreamEnd(message.jobId, this._autoResponse);
  }
}

/** Worker that blocks during job execution until cancelled. */
class SlowWorkerTask extends BaseWorker {
  started = new Event();
  wasCancelled = false;

  constructor(name: string) {
    super({ name });
  }

  override async onJobRequest(message: BusJobRequestMessage): Promise<void> {
    await super.onJobRequest(message);
    this.started.set();
    try {
      // Block until cancelled
      await new Event().wait();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      this.wasCancelled = true;
    }
  }
}

async function createTestEnv(): Promise<[AsyncQueueBus, TaskManager, WorkerRegistry]> {
  const bus = new AsyncQueueBus();
  const tm = new TaskManager();
  await bus.setup(tm);
  await bus.start();
  const registry = new WorkerRegistry("test-runner");
  return [bus, tm, registry];
}

/** Subscribe a task to the bus and register it as ready. */
async function setupTask(
  bus: AsyncQueueBus,
  registry: WorkerRegistry,
  task: BaseWorker,
): Promise<void> {
  await task.attach({
    registry,
    bus,
    workerRunner: new WorkerRunner({ bus, handleSigint: false }),
  });
  await task.setup(bus.taskManager);
  await bus.subscribe(task);
  await registry.register(new WorkerReadyData({ workerName: task.name, runner: "test-runner" }));
}

function captureBus(bus: AsyncQueueBus): BusMessage[] {
  const sent: BusMessage[] = [];
  const originalSend = bus.send.bind(bus);

  bus.send = async (message: BusMessage) => {
    sent.push(message);
    await originalSend(message);
  };
  return sent;
}

/** Run `fn` and return what it threw (Python's `with self.assertRaises(E) as ctx`). */
async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("TestJobGroupContext", () => {
  let bus: AsyncQueueBus;
  let registry: WorkerRegistry;

  beforeEach(async () => {
    [bus, , registry] = await createTestEnv();
  });

  afterEach(async () => {
    await bus.stop();
  });

  test("test_job_group_collects_responses", async () => {
    // job_group() context manager collects all responses.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const w1 = new JobWorkerTask("w1", { response: { a: 1 } });
    const w2 = new JobWorkerTask("w2", { response: { b: 2 } });
    await setupTask(bus, registry, w1);
    await setupTask(bus, registry, w2);

    const tg = parent.jobGroup("w1", "w2", {
      params: new JobGroupParams({ payload: { work: true } }),
    });
    await tg.run(async () => {});

    expect(tg.responses).toEqual({ w1: { a: 1 }, w2: { b: 2 } });
  });

  test("test_job_group_sends_request", async () => {
    // job_group() sends BusJobRequestMessage to each task.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const w1 = new JobWorkerTask("w1", { response: { ok: true } });
    await setupTask(bus, registry, w1);

    await parent
      .jobGroup("w1", { params: new JobGroupParams({ payload: { data: 1 } }) })
      .run(async () => {});

    const requestMsgs = sent.filter((m) => m instanceof BusJobRequestMessage);
    expect(requestMsgs.length).toEqual(1);
    expect(requestMsgs[0]!.payload).toEqual({ data: 1 });
  });

  test("test_job_group_raises_on_cancel", async () => {
    // job_group() raises JobGroupError when group is cancelled.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    // StubTask doesn't auto-respond, so we can cancel manually
    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    const err = await catchError(() =>
      parent.jobGroup("worker").run(async (tg) => {
        createTask(() => parent.cancelJobGroup(tg.jobId, { reason: "manual cancel" }));
      }),
    );
    expect(err).toBeInstanceOf(JobGroupError);

    // Let the event loop schedule handler tasks spawned by the bus
    await sleep(0);
    expect(String(err)).toContain("manual cancel");
  });

  test("test_job_group_raises_on_timeout", async () => {
    // job_group() raises JobGroupError on timeout.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    // StubTask doesn't auto-respond, so timeout fires
    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    const err = await catchError(() =>
      parent
        .jobGroup("worker", { params: new JobGroupParams({ timeout: 0.05 }) })
        .run(async () => {}),
    );
    expect(err).toBeInstanceOf(JobGroupError);

    expect(String(err)).toContain("timeout");
  });

  test("test_job_group_raises_on_ready_timeout", async () => {
    // job_group() raises JobGroupError when tasks aren't ready in time.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    // "ghost" is never registered, so the ready-wait times out
    const err = await catchError(() =>
      parent
        .jobGroup("ghost", { params: new JobGroupParams({ timeout: 0.05 }) })
        .run(async () => {}),
    );
    expect(err).toBeInstanceOf(JobGroupError);

    expect(String(err)).toContain("not ready");
  });

  test("test_job_group_cancels_on_block_exception", async () => {
    // job_group() cancels remaining jobs when the block raises.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    const err = await catchError(() =>
      parent.jobGroup("worker").run(async () => {
        throw new RangeError("something went wrong");
      }),
    );
    expect(err).toBeInstanceOf(RangeError);

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.reason).toEqual("context exited with error");
  });

  test("test_job_group_raises_on_worker_error", async () => {
    // job_group() raises JobGroupError when a worker errors with cancel_on_error.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", {
      response: { error: "failed" },
      status: JobStatus.ERROR,
    });
    await setupTask(bus, registry, worker);

    const tg = parent.jobGroup("worker");
    const err = await catchError(() => tg.run(async () => {}));
    expect(err).toBeInstanceOf(JobGroupError);

    // Error response is tracked in partial responses
    expect(tg.responses).toEqual({ worker: { error: "failed" } });
  });

  test("test_job_group_on_job_error_fires", async () => {
    // on_job_error fires when a worker errors with cancel_on_error.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", {
      response: { error: "boom" },
      status: JobStatus.ERROR,
    });
    await setupTask(bus, registry, worker);

    const errors: BusJobResponseMessage[] = [];

    parent.eventHandler("on_job_error", async (_task, message: BusJobResponseMessage) => {
      errors.push(message);
    });

    const err = await catchError(() => parent.jobGroup("worker").run(async () => {}));
    expect(err).toBeInstanceOf(JobGroupError);

    expect(errors.length).toEqual(1);
    expect(errors[0]!.source).toEqual("worker");
    expect(errors[0]!.response).toEqual({ error: "boom" });
    expect(errors[0]!.status).toEqual(JobStatus.ERROR);
  });

  test("test_job_group_partial_responses_on_error", async () => {
    // Partial responses from successful workers are available after error.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    // w1 responds successfully, w2 responds with error.
    // Order depends on bus dispatch, but both are registered.
    const w1 = new JobWorkerTask("w1", { response: { ok: true } });
    const w2 = new JobWorkerTask("w2", { response: { error: "fail" }, status: JobStatus.ERROR });
    await setupTask(bus, registry, w1);
    await setupTask(bus, registry, w2);

    const tg = parent.jobGroup("w1", "w2");
    const err = await catchError(() => tg.run(async () => {}));
    expect(err).toBeInstanceOf(JobGroupError);

    // w2's error response should be in partial responses
    expect(tg.responses).toHaveProperty("w2");
    expect(tg.responses.w2).toEqual({ error: "fail" });
  });

  test("test_job_group_job_id_available", async () => {
    // job_id is available inside the async with block.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", { response: {} });
    await setupTask(bus, registry, worker);

    let capturedJobId: string | null = null;

    const tg = parent.jobGroup("worker");
    await tg.run(async (tg) => {
      capturedJobId = tg.jobId;
    });

    expect(capturedJobId).not.toBeNull();
    expect(capturedJobId as string | null).toEqual(tg.jobId);
  });

  test("test_job_group_on_job_completed_still_fires", async () => {
    // on_job_completed callback still fires when using job_group().
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("w1", { response: { ok: true } });
    await setupTask(bus, registry, worker);

    const completed: { responses: Record<string, JobPayload> }[] = [];

    parent.eventHandler("on_job_completed", async (_task, result) => {
      completed.push(result);
    });

    await parent.jobGroup("w1").run(async () => {});

    expect(completed.length).toEqual(1);
    expect(completed[0]!.responses).toEqual({ w1: { ok: true } });
  });

  test("test_job_group_iterates_updates", async () => {
    // async for yields update events from workers.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new UpdatingWorkerTask("worker", {
      updates: [{ progress: 25 }, { progress: 75 }],
      response: { result: "done" },
    });
    await setupTask(bus, registry, worker);

    const events: JobGroupEvent[] = [];
    const tg = parent.jobGroup("worker", {
      params: new JobGroupParams({ payload: { work: true } }),
    });
    await tg.run(async (tg) => {
      for await (const event of tg) {
        events.push(event);
      }
    });

    expect(events.length).toEqual(2);
    expect(events[0]!.type).toEqual(JobGroupEvent.UPDATE);
    expect(events[0]!.workerName).toEqual("worker");
    expect(events[0]!.data).toEqual({ progress: 25 });
    expect(events[1]!.data).toEqual({ progress: 75 });
    expect(tg.responses).toEqual({ worker: { result: "done" } });
  });

  test("test_job_group_iterates_stream_events", async () => {
    // async for yields stream_start, stream_data, and stream_end events.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StreamingWorkerTask("worker", {
      chunks: [{ text: "hello " }, { text: "world" }],
      response: { final: true },
    });
    await setupTask(bus, registry, worker);

    const events: JobGroupEvent[] = [];
    await parent.jobGroup("worker").run(async (tg) => {
      for await (const event of tg) {
        events.push(event);
      }
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      JobGroupEvent.STREAM_START,
      JobGroupEvent.STREAM_DATA,
      JobGroupEvent.STREAM_DATA,
      JobGroupEvent.STREAM_END,
    ]);
    expect(events[0]!.data).toEqual({ content_type: "text" });
    expect(events[1]!.data).toEqual({ text: "hello " });
    expect(events[2]!.data).toEqual({ text: "world" });
    expect(events[3]!.data).toEqual({ final: true });
  });

  test("test_job_group_iterates_mixed_events", async () => {
    // async for yields events from multiple workers interleaved.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const w1 = new UpdatingWorkerTask("w1", {
      updates: [{ status: "working" }],
      response: { a: 1 },
    });
    const w2 = new JobWorkerTask("w2", { response: { b: 2 } });
    await setupTask(bus, registry, w1);
    await setupTask(bus, registry, w2);

    const events: JobGroupEvent[] = [];
    const tg = parent.jobGroup("w1", "w2");
    await tg.run(async (tg) => {
      for await (const event of tg) {
        events.push(event);
      }
    });

    expect(events.length).toEqual(1);
    expect(events[0]!.type).toEqual(JobGroupEvent.UPDATE);
    expect(events[0]!.workerName).toEqual("w1");
    expect(tg.responses).toEqual({ w1: { a: 1 }, w2: { b: 2 } });
  });

  test("test_job_group_no_iteration_still_works", async () => {
    // job_group() works without iterating (pass body).
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new UpdatingWorkerTask("worker", {
      updates: [{ progress: 50 }],
      response: { ok: true },
    });
    await setupTask(bus, registry, worker);

    const tg = parent.jobGroup("worker");
    await tg.run(async () => {});

    expect(tg.responses).toEqual({ worker: { ok: true } });
  });

  test("test_urgent_job_response_collected", async () => {
    // Urgent job responses are collected like normal responses.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new UrgentJobWorkerTask("worker", { response: { urgent: true } });
    await setupTask(bus, registry, worker);

    const tg = parent.jobGroup("worker");
    await tg.run(async () => {});

    expect(tg.responses).toEqual({ worker: { urgent: true } });
  });

  test("test_urgent_job_response_triggers_on_job_error", async () => {
    // Urgent error response triggers on_job_error and cancels group.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new UrgentJobWorkerTask("worker", {
      response: { error: "critical" },
      status: JobStatus.ERROR,
    });
    await setupTask(bus, registry, worker);

    const errors: BusJobResponseMessage[] = [];

    parent.eventHandler("on_job_error", async (_task, message: BusJobResponseMessage) => {
      errors.push(message);
    });

    const err = await catchError(() => parent.jobGroup("worker").run(async () => {}));
    expect(err).toBeInstanceOf(JobGroupError);

    expect(errors.length).toEqual(1);
    expect(errors[0]!.response).toEqual({ error: "critical" });
  });

  // DIVERGENCE: upstream sends the data messages while the bus is already
  // running and relies on asyncio not switching tasks during
  // `await bus.send(...)` (AsyncQueueBus.publish never suspends), so nothing
  // is dispatched until the bus is restarted. In JavaScript every `await`
  // drains the microtask queue, so the running router/data tasks deliver
  // `data_0` before the urgent message is even queued. The bus priority
  // ordering itself is covered by test_bus.test.ts
  // (test_task_cancel_is_system_priority), which queues before `start()`.
  test.skip("test_urgent_response_has_system_priority", async () => {
    // Urgent job response is delivered before normal data messages.

    // Queue data messages first, then an urgent response
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const received: BusMessage[] = [];

    parent.eventHandler("on_bus_message", async (_task, message: BusMessage) => {
      received.push(message);
    });

    // Send data messages before starting dispatch
    for (let i = 0; i < 3; i++) {
      await bus.send(new BusDataMessage({ source: `data_${i}` }));
    }
    await bus.send(
      new BusJobResponseUrgentMessage({
        source: "worker",
        target: "parent",
        jobId: "t1",
        status: JobStatus.COMPLETED,
      }),
    );

    // Start dispatch — urgent should arrive first
    // bus is already started in setUp; restart by stopping and starting
    await bus.stop();
    await bus.start();
    await sleep(0.1);
    await bus.stop();

    // First message should be the urgent response
    expect(received[0]).toBeInstanceOf(BusJobResponseUrgentMessage);
  });
});

describe("TestRequestCancelJobGroup", () => {
  // External cancellation requests, which `cancellable` governs.

  async function _worker(): Promise<BaseWorker> {
    const [bus, , registry] = await createTestEnv();
    const parent = new BaseWorker({ name: "parent" });
    await setupTask(bus, registry, parent);
    return parent;
  }

  test("test_cancels_a_cancellable_group", async () => {
    const parent = await _worker();
    parent.jobGroups.set(
      "j1",
      new JobGroup({ jobId: "j1", workerNames: ["w1"], cancellable: true }),
    );

    expect(await parent.requestCancelJobGroup("j1", { reason: "user" })).toBe(true);
    expect(parent.jobGroups.has("j1")).toBe(false);
  });

  test("test_refuses_a_non_cancellable_group", async () => {
    const parent = await _worker();
    parent.jobGroups.set(
      "j1",
      new JobGroup({ jobId: "j1", workerNames: ["w1"], cancellable: false }),
    );

    expect(await parent.requestCancelJobGroup("j1")).toBe(false);
    expect(parent.jobGroups.has("j1")).toBe(true);
  });

  test("test_refuses_an_unknown_group", async () => {
    const parent = await _worker();

    expect(await parent.requestCancelJobGroup("nope")).toBe(false);
  });

  test("test_worker_initiated_cancel_ignores_cancellable", async () => {
    // Shutdown, timeout and cancel_on_error go straight to cancel_job_group.
    const parent = await _worker();
    parent.jobGroups.set(
      "j1",
      new JobGroup({ jobId: "j1", workerNames: ["w1"], cancellable: false }),
    );

    await parent.cancelJobGroup("j1", { reason: "timeout" });

    expect(parent.jobGroups.has("j1")).toBe(false);
  });
});

describe("TestJobContext", () => {
  let bus: AsyncQueueBus;
  let registry: WorkerRegistry;

  beforeEach(async () => {
    [bus, , registry] = await createTestEnv();
  });

  afterEach(async () => {
    await bus.stop();
  });

  test("test_job_collects_response", async () => {
    // job() context manager collects the worker's response.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", { response: { result: 42 } });
    await setupTask(bus, registry, worker);

    const t = parent.job("worker", { params: new JobParams({ payload: { x: 1 } }) });
    await t.run(async () => {});

    expect(t.response).toEqual({ result: 42 });
  });

  test("test_job_sends_request", async () => {
    // job() sends a BusJobRequestMessage to the task.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", { response: { ok: true } });
    await setupTask(bus, registry, worker);

    await parent.job("worker").run(async () => {});

    const requestMsgs = sent.filter((m) => m instanceof BusJobRequestMessage);
    expect(requestMsgs.length).toEqual(1);
    expect(requestMsgs[0]!.target).toEqual("worker");
    expect(requestMsgs[0]!.source).toEqual("parent");
  });

  test("test_job_iterates_events", async () => {
    // job() yields intermediate events via async for.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new UpdatingWorkerTask("worker", {
      updates: [{ progress: 50 }],
      response: { done: true },
    });
    await setupTask(bus, registry, worker);

    const events: JobEvent[] = [];
    const t = parent.job("worker");
    await t.run(async (t) => {
      for await (const event of t) {
        events.push(event);
      }
    });

    expect(events.length).toEqual(1);
    expect(events[0]!.type).toEqual(JobEvent.UPDATE);
    expect(events[0]).toBeInstanceOf(JobEvent);
    expect(t.response).toEqual({ done: true });
  });

  test("test_job_streams_data", async () => {
    // job() yields stream events from a streaming worker.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StreamingWorkerTask("worker", {
      chunks: [{ text: "hello" }, { text: "world" }],
      response: { ok: true },
    });
    await setupTask(bus, registry, worker);

    const events: JobEvent[] = [];
    const t = parent.job("worker");
    await t.run(async (t) => {
      for await (const event of t) {
        events.push(event);
      }
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      JobEvent.STREAM_START,
      JobEvent.STREAM_DATA,
      JobEvent.STREAM_DATA,
      JobEvent.STREAM_END,
    ]);
    expect(t.response).toEqual({ ok: true });
  });

  test("test_job_cancels_on_exception", async () => {
    // job() cancels the job if the block raises.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    const err = await catchError(() =>
      parent.job("worker").run(async () => {
        throw new RangeError("something went wrong");
      }),
    );
    expect(err).toBeInstanceOf(RangeError);

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.reason).toEqual("context exited with error");
  });

  test("test_job_raises_on_worker_error", async () => {
    // job() raises JobError when the worker errors.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", {
      response: { error: "boom" },
      status: JobStatus.ERROR,
    });
    await setupTask(bus, registry, worker);

    const err = await catchError(() => parent.job("worker").run(async () => {}));
    expect(err).toBeInstanceOf(JobError);
  });

  test("test_job_exposes_job_id", async () => {
    // job() exposes the job_id inside the context.
    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new JobWorkerTask("worker", { response: { ok: true } });
    await setupTask(bus, registry, worker);

    await parent.job("worker").run(async (t) => {
      expect(typeof t.jobId).toBe("string");
      expect(t.jobId.length > 0).toBe(true);
    });
  });

  test("test_job_group_cancels_on_cancelled_error", async () => {
    // job_group() cancels workers when CancelledError is raised (e.g. tool interruption).
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    async function runJobGroup(): Promise<void> {
      await parent.jobGroup("worker").run(async () => {
        // Simulate tool cancellation while waiting
        throw new CancelledError();
      });
    }

    const task = createTask(() => runJobGroup());
    const err = await catchError(async () => {
      await task;
    });
    expect(err).toBeInstanceOf(CancelledError);

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.reason).toEqual("context exited with error");
    // Job group should be cleaned up
    expect(parent.jobGroups.size).toEqual(0);
  });

  test("test_job_cancels_on_cancelled_error", async () => {
    // job() cancels the worker when CancelledError is raised (e.g. tool interruption).
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new StubTask("worker");
    await setupTask(bus, registry, worker);

    async function runJob(): Promise<void> {
      await parent.job("worker").run(async () => {
        throw new CancelledError();
      });
    }

    const task = createTask(() => runJob());
    const err = await catchError(async () => {
      await task;
    });
    expect(err).toBeInstanceOf(CancelledError);

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.reason).toEqual("context exited with error");
    expect(parent.jobGroups.size).toEqual(0);
  });

  test("test_fire_and_forget_jobs_cancelled_manually", async () => {
    // User cancels fire-and-forget jobs in a CancelledError handler.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const w1 = new StubTask("w1");
    const w2 = new StubTask("w2");
    await setupTask(bus, registry, w1);
    await setupTask(bus, registry, w2);

    // Simulate what a user would do in on_function_calls_cancelled:
    // track job IDs and cancel only the ones started here
    const jobIds: string[] = [];
    try {
      jobIds.push(
        await parent.requestJob("w1", { params: new JobParams({ payload: { job: 1 } }) }),
      );
      jobIds.push(
        await parent.requestJob("w2", { params: new JobParams({ payload: { job: 2 } }) }),
      );
      expect(parent.jobGroups.size).toEqual(2);
      throw new CancelledError();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      for (const jid of jobIds) {
        await parent.cancelJobGroup(jid, { reason: "tool cancelled" });
      }
    }

    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(2);
    const cancelledTargets = new Set(cancelMsgs.map((m) => m.target));
    expect(cancelledTargets).toEqual(new Set(["w1", "w2"]));
    for (const m of cancelMsgs) {
      expect(m.reason).toEqual("tool cancelled");
    }
    expect(parent.jobGroups.size).toEqual(0);
  });

  test("test_cancel_interrupts_running_handler", async () => {
    // Cancelling a job interrupts a handler that is currently executing.
    const sent = captureBus(bus);

    const parent = new StubTask("parent");
    await setupTask(bus, registry, parent);

    const worker = new SlowWorkerTask("worker");
    await setupTask(bus, registry, worker);

    const jobId = await parent.requestJob("worker", {
      params: new JobParams({ payload: { job: 1 } }),
    });

    // Wait for the worker to start executing
    await waitFor(() => worker.started.wait(), 2.0);

    // Cancel while the handler is blocked
    await parent.cancelJobGroup(jobId, { reason: "no longer needed" });

    // Give the event loop time to process the cancellation
    await sleep(0.1);

    // The handler should have been cancelled
    expect(worker.wasCancelled).toBe(true);

    // A cancel message should have been sent
    const cancelMsgs = sent.filter((m) => m instanceof BusJobCancelMessage);
    expect(cancelMsgs.length).toEqual(1);
    expect(cancelMsgs[0]!.reason).toEqual("no longer needed");

    // A CANCELLED response should have been sent back
    const responseMsgs = sent.filter((m) => m instanceof BusJobResponseMessage);
    expect(responseMsgs.length).toEqual(1);
    expect(responseMsgs[0]!.status).toEqual(JobStatus.CANCELLED);
  });
});
