// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ui_job_lifecycle.py

/**
 * Tests for the UIWorker user-job-group lifecycle.
 *
 * Covers:
 * - `UIWorker.onBusMessage` forwarding of worker job updates/responses
 *   for registered user job groups as `BusUIJob*` carriers.
 * - The reserved `__cancel_job_group` client event routing to
 *   `cancelJobGroup`.
 * - Job groups dispatched by a `UIWorker` publishing `group_started` /
 *   `group_completed` envelopes and (de)registering the group on the worker.
 *
 * Porting notes:
 * - `UIJobGroupContext`, `UIWorker.ui_job_group`/`start_ui_job_group` and
 *   `BaseUIWorker` are deprecated upstream and not ported, so the tests that
 *   exercise them are skipped.
 */

import { describe, expect, mock, test } from "bun:test";

import { createTask, sleep } from "@pipecat-ts/asyncio";

import {
  BusJobResponseMessage,
  BusJobUpdateMessage,
  type BusMessage,
} from "../src/bus/messages.ts";
import {
  BusUIEventMessage,
  BusUIJobCompletedMessage,
  BusUIJobGroupCompletedMessage,
  BusUIJobGroupStartedMessage,
  BusUIJobUpdateMessage,
  UI_CANCEL_JOB_GROUP_EVENT_NAME,
} from "../src/bus/ui/messages.ts";
import { type Frame, LLMMessagesAppendFrame } from "../src/frames/frames.ts";
import { JobGroup, JobGroupParams, JobStatus } from "../src/pipeline/job_context.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import type { LLMService } from "../src/services/llm_service.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { UIWorker } from "../src/workers/ui/index.ts";

/**
 * Minimal stand-in for `unittest.mock.MagicMock`: every attribute access
 * returns a callable mock, and calling it returns another such mock.
 */
function magicMock(): any {
  const cache = new Map<PropertyKey, unknown>();
  const fn = mock((..._args: unknown[]) => magicMock());
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "<MagicMock>";
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (!cache.has(prop)) {
        cache.set(prop, magicMock());
      }
      return cache.get(prop);
    },
  });
}

/** The worker with its protected members and test spies reachable. */
type AnyWorker = UIWorker & Record<string, any>;

/** An `AsyncMock()` stand-in. */
function asyncMock() {
  return mock(async (..._args: unknown[]): Promise<void> => {});
}

/** The first argument of every awaited `sendBusMessage` call. */
function sent(worker: AnyWorker): BusMessage[] {
  return (worker.sendBusMessage as ReturnType<typeof asyncMock>).mock.calls.map(
    (c) => c[0] as BusMessage,
  );
}

/**
 * A UIWorker with a task manager and a `queueFrame` spy.
 *
 * Suitable for testing forwarding logic by directly invoking `onBusMessage`
 * and asserting on captured `sendBusMessage` calls.
 */
async function _makeSoloWorker(): Promise<AnyWorker> {
  const worker = new UIWorker({ name: "ui", llm: magicMock() as LLMService }) as AnyWorker;
  const tm = new TaskManager();
  worker._taskManager = tm;

  const recorded: Frame[] = [];

  const _record = async (
    frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> => {
    recorded.push(frame);
  };

  worker.queueFrame = _record;
  worker._recorded = recorded;
  return worker;
}

/** Put a live job group on the worker, as dispatch would. */
function _register(
  worker: AnyWorker,
  options: {
    jobId: string;
    workerNames: string[];
    label?: string | null;
    cancellable?: boolean;
  },
): JobGroup {
  const group = new JobGroup({
    jobId: options.jobId,
    workerNames: [...options.workerNames],
    label: options.label ?? null,
    cancellable: options.cancellable ?? true,
  });
  worker._jobGroups.set(options.jobId, group);
  return group;
}

describe("TestUIWorkerForwarding", () => {
  test("test_unregistered_job_update_is_not_forwarded", async () => {
    const worker = await _makeSoloWorker();
    worker.sendBusMessage = asyncMock();

    await worker.onBusMessage(
      new BusJobUpdateMessage({
        source: "worker",
        target: worker.name,
        jobId: "t-unknown",
        update: { x: 1 },
      }),
    );

    const forwarded = sent(worker).filter((m) => m instanceof BusUIJobUpdateMessage);
    expect(forwarded).toEqual([]);
  });

  test("test_registered_job_update_is_forwarded", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["worker"], label: "hello", cancellable: true });
    worker.sendBusMessage = asyncMock();

    await worker.onBusMessage(
      new BusJobUpdateMessage({
        source: "worker",
        target: worker.name,
        jobId: "t1",
        update: { kind: "tool_call", tool: "WebSearch" },
      }),
    );

    const forwarded = sent(worker).filter(
      (m): m is BusUIJobUpdateMessage => m instanceof BusUIJobUpdateMessage,
    );
    expect(forwarded.length).toEqual(1);
    expect(forwarded[0]!.jobId).toEqual("t1");
    expect(forwarded[0]!.workerName).toEqual("worker");
    expect(forwarded[0]!.data).toEqual({ kind: "tool_call", tool: "WebSearch" });
  });

  test("test_registered_job_response_is_forwarded", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["worker"], label: null, cancellable: true });
    worker.sendBusMessage = asyncMock();

    await worker.onBusMessage(
      new BusJobResponseMessage({
        source: "worker",
        target: worker.name,
        jobId: "t1",
        status: JobStatus.COMPLETED,
        response: { answer: 42 },
      }),
    );

    const forwarded = sent(worker).filter(
      (m): m is BusUIJobCompletedMessage => m instanceof BusUIJobCompletedMessage,
    );
    expect(forwarded.length).toEqual(1);
    expect(forwarded[0]!.jobId).toEqual("t1");
    expect(forwarded[0]!.workerName).toEqual("worker");
    expect(forwarded[0]!.status).toEqual("completed");
    expect(forwarded[0]!.response).toEqual({ answer: 42 });
  });

  test("test_response_status_serializes_for_cancelled_and_error", async () => {
    const worker = await _makeSoloWorker();
    // Two workers, so the group stays live across both responses
    // (source "w" responds twice here, and "other" never does).
    _register(worker, { jobId: "t1", workerNames: ["w", "other"] });
    worker.sendBusMessage = asyncMock();

    await worker.onBusMessage(
      new BusJobResponseMessage({
        source: "w",
        target: worker.name,
        jobId: "t1",
        status: JobStatus.CANCELLED,
      }),
    );
    await worker.onBusMessage(
      new BusJobResponseMessage({
        source: "w",
        target: worker.name,
        jobId: "t1",
        status: JobStatus.ERROR,
      }),
    );

    const statuses = sent(worker)
      .filter((m): m is BusUIJobCompletedMessage => m instanceof BusUIJobCompletedMessage)
      .map((m) => m.status);
    // The error cancels the group, so "other", which never reached a
    // terminal state of its own, is reported cancelled.
    expect(statuses).toEqual(["cancelled", "error", "cancelled"]);
  });
});

/** Messages that arrive for a group that is already gone. */
describe("TestLateMessagesAfterTeardown", () => {
  // Skipped: these run on the deprecated `BaseUIWorker` (deprecated since
  // 1.12.0), which is not ported.
  test.skip("test_late_cancelled_response_is_not_forwarded", () => {});

  // Skipped: runs on the deprecated `BaseUIWorker`, which is not ported.
  test.skip("test_late_update_is_not_forwarded", () => {});
});

describe("TestCancelJobEvent", () => {
  test("test_cancel_event_routes_to_cancel_job_group", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["w"], label: null, cancellable: true });
    worker.cancelJobGroup = asyncMock();

    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: { job_id: "t1", reason: "user clicked cancel" },
      }),
    );

    expect(worker.cancelJobGroup).toHaveBeenCalledTimes(1);
    expect(worker.cancelJobGroup).toHaveBeenCalledWith("t1", { reason: "user clicked cancel" });
  });

  test("test_cancel_event_default_reason_when_omitted", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["w"], label: null, cancellable: true });
    worker.cancelJobGroup = asyncMock();

    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: { job_id: "t1" },
      }),
    );

    expect(worker.cancelJobGroup).toHaveBeenCalledTimes(1);
    const args = (worker.cancelJobGroup as ReturnType<typeof asyncMock>).mock.calls[0]!;
    expect((args[1] as { reason: string }).reason).toEqual("cancelled by user");
  });

  test("test_non_cancellable_group_is_ignored", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["w"], label: null, cancellable: false });
    worker.cancelJobGroup = asyncMock();

    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: { job_id: "t1" },
      }),
    );

    expect(worker.cancelJobGroup).not.toHaveBeenCalled();
  });

  test("test_unknown_job_id_is_ignored", async () => {
    const worker = await _makeSoloWorker();
    worker.cancelJobGroup = asyncMock();

    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: { job_id: "nope" },
      }),
    );

    expect(worker.cancelJobGroup).not.toHaveBeenCalled();
  });

  test("test_missing_or_bad_payload_is_ignored", async () => {
    const worker = await _makeSoloWorker();
    worker.cancelJobGroup = asyncMock();

    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: null,
      }),
    );
    await worker.onBusMessage(
      new BusUIEventMessage({
        source: "bridge",
        target: worker.name,
        eventName: UI_CANCEL_JOB_GROUP_EVENT_NAME,
        payload: { job_id: 42 },
      }),
    );

    expect(worker.cancelJobGroup).not.toHaveBeenCalled();
  });
});

describe("TestForwardingDoesNotInjectLLMContext", () => {
  test("test_job_update_forwarding_does_not_queue_append_frames", async () => {
    const worker = await _makeSoloWorker();
    _register(worker, { jobId: "t1", workerNames: ["w"], label: null, cancellable: true });

    await worker.onBusMessage(
      new BusJobUpdateMessage({ source: "w", target: worker.name, jobId: "t1", update: { x: 1 } }),
    );

    const appends = (worker._recorded as Frame[]).filter(
      (f) => f instanceof LLMMessagesAppendFrame,
    );
    expect(appends).toEqual([]);
  });
});

/**
 * Stub the transport under `createJobGroupAndRequestJob`.
 *
 * Patches the ready-wait, the request send, and group creation (for a
 * deterministic `jobId`) while leaving the real `createJobGroupAndRequestJob`
 * -- and therefore the UI registration and `group_started` emission -- in
 * place. Each worker "responds" on the next loop tick through the real
 * `_trackJobGroupResponse` path, so teardown (including `group_completed`
 * emission) is the production code too.
 */
function _stubJobGroup(worker: AnyWorker, jobId = "t1"): void {
  const _ready = async (_names: string[]) => {
    return async () => {};
  };

  const _send = async (
    _workerName: string,
    _jid: string,
    _options: { jobName?: string | null; payload?: unknown } = {},
  ): Promise<void> => {};

  const _fakeCreate = (names: string[], options: { params?: JobGroupParams } = {}): JobGroup => {
    const params = options.params ?? new JobGroupParams();
    const group = new JobGroup({
      jobId,
      workerNames: [...names],
      cancelOnError: params.cancelOnError,
      label: params.label,
      cancellable: params.cancellable,
    });
    worker._jobGroups.set(jobId, group);

    const _finish = async (): Promise<void> => {
      // Yield so JobGroupContext.enter() can set eventQueue first.
      await sleep(0);
      // Each worker "responds" through the real bus-message path, so
      // response recording, group teardown, and envelope forwarding all run
      // production code.
      for (const n of names) {
        await worker.onBusMessage(
          new BusJobResponseMessage({
            source: n,
            target: worker.name,
            jobId,
            status: JobStatus.COMPLETED,
            response: {},
          }),
        );
      }
    };

    createTask(() => _finish());
    return group;
  };

  worker._waitWorkersReady = _ready;
  worker._sendJobRequest = _send;
  worker._createJobGroup = _fakeCreate;
}

describe("TestUIJobGroupContext", () => {
  // Skipped: `UIJobGroupContext` is deprecated upstream (since 1.8.0) and not ported.
  test.skip("test_label_and_cancellable_read_the_group_params", () => {});

  // Skipped: `UIWorker.ui_job_group` / `start_ui_job_group` are deprecated
  // upstream (since 1.8.0) and not ported.
  test.skip("test_the_deprecated_wrappers_pass_on_their_arguments", () => {});

  test("test_context_publishes_started_and_completed", async () => {
    const worker = await _makeSoloWorker();
    worker.sendBusMessage = asyncMock();
    _stubJobGroup(worker);

    await worker
      .jobGroup("w1", { params: new JobGroupParams({ label: "My research" }) })
      .run(async (tg) => {
        expect(tg.jobId).toEqual("t1");
        expect(worker._jobGroups.has("t1")).toBe(true);
      });

    expect(worker._jobGroups.has("t1")).toBe(false);

    const kinds = sent(worker).map((m) => m.constructor.name);
    expect(kinds).toEqual([
      "BusUIJobGroupStartedMessage",
      "BusUIJobCompletedMessage",
      "BusUIJobGroupCompletedMessage",
    ]);

    const started = sent(worker)[0] as BusUIJobGroupStartedMessage;
    expect(started).toBeInstanceOf(BusUIJobGroupStartedMessage);
    expect(started.jobId).toEqual("t1");
    expect(started.workers).toEqual(["w1"]);
    expect(started.label).toEqual("My research");
    expect(started.cancellable).toBe(true);

    const completed = sent(worker)[2] as BusUIJobGroupCompletedMessage;
    expect(completed).toBeInstanceOf(BusUIJobGroupCompletedMessage);
    expect(completed.jobId).toEqual("t1");
  });

  test("test_non_cancellable_group_sets_flag_in_started_message", async () => {
    const worker = await _makeSoloWorker();
    worker.sendBusMessage = asyncMock();
    _stubJobGroup(worker);

    await worker
      .jobGroup("w1", { params: new JobGroupParams({ cancellable: false }) })
      .run(async () => {});

    const started = sent(worker)[0] as BusUIJobGroupStartedMessage;
    expect(started.cancellable).toBe(false);
  });

  test("test_unregisters_on_exit", async () => {
    const worker = await _makeSoloWorker();
    worker.sendBusMessage = asyncMock();
    _stubJobGroup(worker);

    const tg = worker.jobGroup("w1");
    await tg.run(async () => {});

    expect(worker._jobGroups.has(tg.jobId)).toBe(false);
  });

  test("test_request_job_group_returns_id_and_publishes", async () => {
    const worker = await _makeSoloWorker();
    worker.sendBusMessage = asyncMock();
    _stubJobGroup(worker);

    const jobId = await worker.requestJobGroup("w1", {
      params: new JobGroupParams({ label: "Background work" }),
    });
    expect(jobId).toEqual("t1");

    const started = sent(worker)[0] as BusUIJobGroupStartedMessage;
    expect(started).toBeInstanceOf(BusUIJobGroupStartedMessage);
    expect(started.label).toEqual("Background work");

    // The background runner drains the group and publishes completion.
    let published = false;
    for (let i = 0; i < 50; i++) {
      await sleep(0);
      if (sent(worker).some((m) => m instanceof BusUIJobGroupCompletedMessage)) {
        published = true;
        break;
      }
    }
    if (!published) {
      throw new Error("group_completed envelope was not published");
    }

    expect(worker._jobGroups.has("t1")).toBe(false);
  });
});

/** The deprecated BaseUIWorker warns and still dispatches client-visible job groups. */
describe("TestBaseUIWorkerJobGroups", () => {
  // Skipped: every test here exercises the deprecated `BaseUIWorker`
  // (deprecated since 1.12.0, removed in 2.0.0), which is not ported. The
  // same behaviors are covered on `UIWorker` above.
  test.skip("test_constructing_one_warns", () => {});
  test.skip("test_context_publishes_started_and_completed", () => {});
  test.skip("test_registered_update_and_response_are_forwarded", () => {});
  test.skip("test_cancel_event_routes_to_cancel_job_group", () => {});
  test.skip("test_non_cancellable_group_ignores_cancel_event", () => {});
  test.skip("test_single_job_with_ui_publishes_envelopes", () => {});
  test.skip("test_error_response_forwards_worker_envelope_before_group_completes", () => {});
  test.skip("test_cancel_synthesizes_cancelled_envelopes_for_unreported_workers", () => {});
  test.skip("test_stream_end_completion_completes_group", () => {});
  test.skip("test_request_job_group_returns_id_and_publishes", () => {});
});
