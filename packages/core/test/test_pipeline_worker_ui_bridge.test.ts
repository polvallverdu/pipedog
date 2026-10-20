// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pipeline_worker_ui_bridge.py

/**
 * Tests for the native RTVI⇄bus UI bridge built into PipelineWorker.
 *
 * Inbound: typed RTVI UI messages from the client (fired via the RTVI
 * processor's `on_ui_message` event) are republished onto the bus as a
 * broadcast `BusUIEventMessage`. Outbound: `BusUICommandMessage` and
 * the four `BusUIJob*` lifecycle carriers are translated into the
 * matching RTVI frames and queued downstream. The bridge is active only
 * when RTVI is enabled.
 */

import { describe, expect, test } from "bun:test";
import { gather } from "@pipedog/asyncio";
import { BusTTSSpeakMessage } from "../src/bus/index.ts";
import {
  BusUICommandMessage,
  BusUIEventMessage,
  BusUIJobCompletedMessage,
  BusUIJobGroupCompletedMessage,
  BusUIJobGroupStartedMessage,
  BusUIJobUpdateMessage,
  UI_CANCEL_JOB_GROUP_EVENT_NAME,
  UI_SNAPSHOT_EVENT_NAME,
} from "../src/bus/ui/messages.ts";
import { type Frame, TTSSpeakFrame } from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { PipelineWorker, type PipelineWorkerOptions } from "../src/pipeline/worker.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import {
  RTVIUICommandFrame,
  RTVIUIJobGroupFrame,
} from "../src/processors/frameworks/rtvi/frames.ts";
import {
  A11yNode,
  A11ySnapshot,
  UICancelJobGroupData,
  UICancelJobGroupMessage,
  UIEventData,
  UIEventMessage,
  UISnapshotData,
  UISnapshotMessage,
} from "../src/processors/frameworks/rtvi/models.ts";

/** Test access to protected state, as the Python test reads `_rtvi`. */
const internals = (o: unknown): any => o;

/** A PipelineWorker with bus + frame spies installed. */
function _makeRoot({
  enableRtvi = true,
}: {
  enableRtvi?: boolean;
} = {}): [PipelineWorker, unknown[], Frame[]] {
  const worker = new PipelineWorker(new Pipeline([new IdentityFilter()]), {
    name: "root",
    enableRtvi,
    cancelOnIdleTimeout: false,
  });
  const sent: unknown[] = [];
  const frames: Frame[] = [];

  const _recordBus = async (message: unknown): Promise<void> => {
    sent.push(message);
  };

  const _recordFrame = async (
    frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> => {
    frames.push(frame);
  };

  internals(worker).sendBusMessage = _recordBus;
  internals(worker).queueFrame = _recordFrame;
  return [worker, sent, frames];
}

/** Fire the RTVI processor's `on_ui_message` event and drain it. */
async function _fireUiMessage(worker: PipelineWorker, message: unknown): Promise<void> {
  const rtvi = internals(worker.rtvi);
  await rtvi._callEventHandler("on_ui_message", message);
  const tasks = [...rtvi._eventTasks].map(([_name, t]: [string, unknown]) => t);
  if (tasks.length > 0) {
    await gather(...tasks);
  }
}

describe("TestUIBridgeInbound", () => {
  test("test_republishes_ui_event_as_broadcast_bus_message", async () => {
    const [worker, sent] = _makeRoot();

    await _fireUiMessage(
      worker,
      new UIEventMessage({
        id: "m1",
        data: new UIEventData({ event: "nav_click", payload: { view: "home" } }),
      }),
    );

    const events = sent.filter((m) => m instanceof BusUIEventMessage) as BusUIEventMessage[];
    expect(events.length).toEqual(1);
    expect(events[0]!.source).toEqual("root");
    expect(events[0]!.target).toBeNull();
    expect(events[0]!.eventName).toEqual("nav_click");
    expect(events[0]!.payload).toEqual({ view: "home" });
  });

  test("test_snapshot_message_routes_to_internal_event_name", async () => {
    const [worker, sent] = _makeRoot();
    const tree = new A11ySnapshot({
      root: new A11yNode({ ref: "root", role: "document" }),
      capturedAt: 1,
    });

    await _fireUiMessage(
      worker,
      new UISnapshotMessage({ id: "m2", data: new UISnapshotData({ tree }) }),
    );

    const events = sent.filter((m) => m instanceof BusUIEventMessage) as BusUIEventMessage[];
    expect(events[0]!.eventName).toEqual(UI_SNAPSHOT_EVENT_NAME);
    expect(events[0]!.payload).toEqual(tree.modelDump({ excludeNone: true }));
  });

  test("test_cancel_task_message_routes_to_internal_event_name", async () => {
    const [worker, sent] = _makeRoot();

    await _fireUiMessage(
      worker,
      new UICancelJobGroupMessage({
        id: "m3",
        data: new UICancelJobGroupData({ jobId: "t-1", reason: "user" }),
      }),
    );

    const events = sent.filter((m) => m instanceof BusUIEventMessage) as BusUIEventMessage[];
    expect(events[0]!.eventName).toEqual(UI_CANCEL_JOB_GROUP_EVENT_NAME);
    expect(events[0]!.payload).toEqual({ job_id: "t-1", reason: "user" });
  });

  test("test_missing_payload_becomes_none", async () => {
    const [worker, sent] = _makeRoot();

    await _fireUiMessage(
      worker,
      new UIEventMessage({ id: "m1", data: new UIEventData({ event: "hello" }) }),
    );

    const events = sent.filter((m) => m instanceof BusUIEventMessage) as BusUIEventMessage[];
    expect(events[0]!.eventName).toEqual("hello");
    expect(events[0]!.payload).toBeNull();
  });

  test("test_unknown_message_type_is_ignored", async () => {
    const [worker, sent] = _makeRoot();

    await _fireUiMessage(worker, {});

    expect(sent.filter((m) => m instanceof BusUIEventMessage)).toEqual([]);
  });
});

describe("TestUIBridgeOutbound", () => {
  test("test_command_becomes_rtvi_ui_command_frame", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusUICommandMessage({
        source: "ui",
        target: null,
        commandName: "toast",
        payload: { t: "Hi" },
      }),
    );

    const uiFrames = frames.filter((f) => f instanceof RTVIUICommandFrame) as RTVIUICommandFrame[];
    expect(uiFrames.length).toEqual(1);
    expect(uiFrames[0]!.command).toEqual("toast");
    expect(uiFrames[0]!.payload).toEqual({ t: "Hi" });
  });

  test("test_group_started_envelope", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusUIJobGroupStartedMessage({
        source: "ui",
        target: null,
        jobId: "t1",
        workers: ["w1", "w2"],
        label: "Doing stuff",
        cancellable: true,
        at: 1700,
      }),
    );

    const frame = frames.find((f) => f instanceof RTVIUIJobGroupFrame) as RTVIUIJobGroupFrame;
    const data = frame.data as any;
    expect(data.kind).toEqual("group_started");
    expect(data.jobId).toEqual("t1");
    expect(data.workers).toEqual(["w1", "w2"]);
    expect(data.label).toEqual("Doing stuff");
    expect(data.cancellable).toBe(true);
    expect(data.at).toEqual(1700);
  });

  test("test_job_update_envelope", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusUIJobUpdateMessage({
        source: "ui",
        target: null,
        jobId: "t1",
        workerName: "w1",
        data: { kind: "tool_call", tool: "WebSearch" },
        at: 1701,
      }),
    );

    const frame = frames.find((f) => f instanceof RTVIUIJobGroupFrame) as RTVIUIJobGroupFrame;
    const data = frame.data as any;
    expect(data.kind).toEqual("job_update");
    expect(data.jobId).toEqual("t1");
    expect(data.workerName).toEqual("w1");
    expect(data.data).toEqual({ kind: "tool_call", tool: "WebSearch" });
    expect(data.at).toEqual(1701);
  });

  test("test_job_completed_envelope", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusUIJobCompletedMessage({
        source: "ui",
        target: null,
        jobId: "t1",
        workerName: "w1",
        status: "completed",
        response: { answer: 42 },
        at: 1702,
      }),
    );

    const frame = frames.find((f) => f instanceof RTVIUIJobGroupFrame) as RTVIUIJobGroupFrame;
    const data = frame.data as any;
    expect(data.kind).toEqual("job_completed");
    expect(data.jobId).toEqual("t1");
    expect(data.workerName).toEqual("w1");
    expect(data.status).toEqual("completed");
    expect(data.response).toEqual({ answer: 42 });
    expect(data.at).toEqual(1702);
  });

  test("test_group_completed_envelope", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusUIJobGroupCompletedMessage({ source: "ui", target: null, jobId: "t1", at: 1703 }),
    );

    const frame = frames.find((f) => f instanceof RTVIUIJobGroupFrame) as RTVIUIJobGroupFrame;
    const data = frame.data as any;
    expect(data.kind).toEqual("group_completed");
    expect(data.jobId).toEqual("t1");
    expect(data.at).toEqual(1703);
  });

  test("test_non_ui_bus_message_queues_no_frame", async () => {
    const [worker, , frames] = _makeRoot();

    // A plain BusUIEventMessage (inbound carrier) is not an outbound
    // command/job-group, so the outbound translation must ignore it.
    await worker.onBusMessage(
      new BusUIEventMessage({ source: "x", target: null, eventName: "e", payload: {} }),
    );

    expect(
      frames.filter((f) => f instanceof RTVIUICommandFrame || f instanceof RTVIUIJobGroupFrame),
    ).toEqual([]);
  });

  test("test_worker_without_rtvi_does_not_translate", async () => {
    const [worker, , frames] = _makeRoot({ enableRtvi: false });
    expect(internals(worker)._rtvi).toBeNull();

    await worker.onBusMessage(
      new BusUICommandMessage({ source: "ui", target: null, commandName: "toast", payload: {} }),
    );

    expect(frames).toEqual([]);
  });
});

describe("TestUISpeakBridge", () => {
  test("test_speak_message_becomes_tts_speak_frame", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusTTSSpeakMessage({ source: "ui", target: "root", text: "hello there" }),
    );

    const speak = frames.filter((f) => f instanceof TTSSpeakFrame) as TTSSpeakFrame[];
    expect(speak.length).toEqual(1);
    expect(speak[0]!.text).toEqual("hello there");
  });

  test("test_speak_message_works_without_rtvi", async () => {
    // TTS does not require RTVI; the speak branch must run regardless.
    const [worker, , frames] = _makeRoot({ enableRtvi: false });
    expect(internals(worker)._rtvi).toBeNull();

    await worker.onBusMessage(
      new BusTTSSpeakMessage({ source: "ui", target: "root", text: "hello there" }),
    );

    const speak = frames.filter((f) => f instanceof TTSSpeakFrame) as TTSSpeakFrame[];
    expect(speak.length).toEqual(1);
    expect(speak[0]!.text).toEqual("hello there");
  });

  test("test_speak_message_for_other_target_is_ignored", async () => {
    const [worker, , frames] = _makeRoot();

    await worker.onBusMessage(
      new BusTTSSpeakMessage({ source: "ui", target: "someone-else", text: "hello" }),
    );

    expect(frames.filter((f) => f instanceof TTSSpeakFrame)).toEqual([]);
  });
});

/** RTVI is on by default for the worker that owns the client, and off for a bridged one. */
describe("TestRTVIDefault", () => {
  const _worker = (options: PipelineWorkerOptions = {}): PipelineWorker =>
    new PipelineWorker(new Pipeline([new IdentityFilter()]), {
      name: "w",
      cancelOnIdleTimeout: false,
      ...options,
    });

  test("test_an_unbridged_worker_has_rtvi", () => {
    expect(internals(_worker())._rtvi).not.toBeNull();
  });

  test("test_a_bridged_worker_has_no_rtvi", () => {
    expect(internals(_worker({ bridged: [] }))._rtvi).toBeNull();
  });

  test("test_an_explicit_choice_wins", () => {
    expect(internals(_worker({ bridged: [], enableRtvi: true }))._rtvi).not.toBeNull();
    expect(internals(_worker({ enableRtvi: false }))._rtvi).toBeNull();
  });
});
