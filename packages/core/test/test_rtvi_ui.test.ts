// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_ui.py

/**
 * Smoke tests for the UI Worker Protocol wire format.
 *
 * The module under test is data only (constants, payload models, and
 * envelope classes), so the goal is to pin the shapes: any accidental
 * rename or type change to a wire-format field would break compatibility
 * with existing client code, and we want a test that fails loudly.
 */

import { describe, expect, test } from "bun:test";

import { RTVIUICommandFrame, RTVIUIEventFrame } from "../src/processors/frameworks/rtvi/frames.ts";
import {
  A11yNode,
  A11ySelection,
  A11ySnapshot,
  Click,
  Focus,
  Highlight,
  Navigate,
  ScrollTo,
  SelectText,
  SetInputValue,
  Toast,
  UICancelJobGroupData,
  UICancelJobGroupMessage,
  UICommandData,
  UICommandMessage,
  UIEventData,
  UIEventMessage,
  UIJobCompletedData,
  UIJobGroupCompletedData,
  UIJobGroupMessage,
  UIJobGroupStartedData,
  UIJobUpdateData,
  UISnapshotData,
  UISnapshotMessage,
} from "../src/processors/frameworks/rtvi/models.ts";

// Python `dict(model)` yields the model's fields by (snake_case) field name;
// for these flat payload models that is exactly `modelDump()`.

describe("TestEnvelopeMessages", () => {
  // Pin the on-the-wire envelope shapes for each first-class UI message.

  test("test_ui_event_envelope", () => {
    const msg = new UIEventMessage({
      id: "m1",
      data: new UIEventData({ event: "nav_click", payload: { view: "home" } }),
    });
    expect(msg.modelDump()).toEqual({
      label: "rtvi-ai",
      type: "ui-event",
      id: "m1",
      data: { event: "nav_click", payload: { view: "home" } },
    });
  });

  test("test_ui_command_envelope_no_id", () => {
    // Server-to-client push: no id field on the envelope (matches
    // ServerMessage / LLMFunctionCallMessage shape).
    const msg = new UICommandMessage({
      data: new UICommandData({ command: "toast", payload: { title: "Saved" } }),
    });
    expect(msg.modelDump()).toEqual({
      label: "rtvi-ai",
      type: "ui-command",
      data: { command: "toast", payload: { title: "Saved" } },
    });
  });

  test("test_ui_snapshot_envelope", () => {
    const msg = new UISnapshotMessage({
      id: "m2",
      data: new UISnapshotData({
        tree: new A11ySnapshot({
          root: new A11yNode({
            ref: "e1",
            role: "main",
            children: [new A11yNode({ ref: "e2", role: "button", name: "Save" })],
          }),
          capturedAt: 42,
          selection: new A11ySelection({ ref: "e2", text: "Save", startOffset: 0, endOffset: 4 }),
        }),
      }),
    });
    expect(msg.modelDump()).toEqual({
      label: "rtvi-ai",
      type: "ui-snapshot",
      id: "m2",
      data: {
        tree: {
          root: {
            ref: "e1",
            role: "main",
            name: null,
            value: null,
            state: null,
            level: null,
            colcount: null,
            rowcount: null,
            children: [
              {
                ref: "e2",
                role: "button",
                name: "Save",
                value: null,
                state: null,
                level: null,
                colcount: null,
                rowcount: null,
                children: null,
              },
            ],
          },
          captured_at: 42,
          selection: {
            ref: "e2",
            text: "Save",
            start_offset: 0,
            end_offset: 4,
          },
        },
      },
    });
  });

  test("test_ui_snapshot_allows_future_client_fields", () => {
    const msg = UISnapshotMessage.modelValidate({
      id: "m2",
      data: {
        tree: {
          root: {
            ref: "e1",
            role: "main",
            bounds: { x: 1, y: 2 },
            children: [
              {
                ref: "e2",
                role: "button",
                name: "Save",
                platform_state: { pressed: false },
              },
            ],
          },
          captured_at: 42,
          selection: {
            ref: "e2",
            text: "Save",
            direction: "forward",
          },
          viewport: { width: 1024, height: 768 },
        },
      },
    });

    const dumped = msg.modelDump() as any;
    const tree = dumped.data.tree;
    expect(tree.root.bounds).toEqual({ x: 1, y: 2 });
    expect(tree.root.children[0].platform_state).toEqual({ pressed: false });
    expect(tree.selection.direction).toEqual("forward");
    expect(tree.viewport).toEqual({ width: 1024, height: 768 });
  });

  test("test_ui_cancel_task_envelope", () => {
    const msg = new UICancelJobGroupMessage({
      id: "m3",
      data: new UICancelJobGroupData({ jobId: "t-99", reason: "user" }),
    });
    expect(msg.modelDump()).toEqual({
      label: "rtvi-ai",
      type: "ui-cancel-job-group",
      id: "m3",
      data: { job_id: "t-99", reason: "user" },
    });
  });

  test("test_ui_job_group_started", () => {
    const msg = new UIJobGroupMessage({
      data: new UIJobGroupStartedData({
        jobId: "t-1",
        workers: ["a", "b"],
        label: "Search",
        at: 42,
      }),
    });
    expect(msg.type).toEqual("ui-job-group");
    expect(msg.data.kind).toEqual("group_started");
    expect(msg.data.jobId).toEqual("t-1");
  });

  test("test_ui_job_update", () => {
    const msg = new UIJobGroupMessage({
      data: new UIJobUpdateData({ jobId: "t-1", workerName: "a", data: { progress: 0.5 }, at: 43 }),
    });
    expect(msg.data.kind).toEqual("job_update");
    expect((msg.data as UIJobUpdateData).workerName).toEqual("a");
  });

  test("test_ui_job_completed", () => {
    const msg = new UIJobGroupMessage({
      data: new UIJobCompletedData({
        jobId: "t-1",
        workerName: "a",
        status: "completed",
        response: { ok: true },
        at: 44,
      }),
    });
    expect(msg.data.kind).toEqual("job_completed");
    expect((msg.data as UIJobCompletedData).status).toEqual("completed");
  });

  test("test_ui_job_group_completed", () => {
    const msg = new UIJobGroupMessage({
      data: new UIJobGroupCompletedData({ jobId: "t-1", at: 45 }),
    });
    expect(msg.data.kind).toEqual("group_completed");
  });
});

describe("TestPayloadShapes", () => {
  // Pin the on-the-wire dict shape of each command payload.

  test("test_toast_required_only", () => {
    expect(new Toast({ title: "Saved" }).modelDump()).toEqual({
      title: "Saved",
      subtitle: null,
      description: null,
      image_url: null,
      duration_ms: null,
    });
  });

  test("test_navigate", () => {
    expect(new Navigate({ view: "home", params: { id: "42" } }).modelDump()).toEqual({
      view: "home",
      params: { id: "42" },
    });
  });

  test("test_scroll_to_with_ref", () => {
    expect(new ScrollTo({ ref: "e42", behavior: "smooth" }).modelDump()).toEqual({
      ref: "e42",
      target_id: null,
      behavior: "smooth",
    });
  });

  test("test_highlight_with_target_id", () => {
    expect(new Highlight({ targetId: "cta", durationMs: 2000 }).modelDump()).toEqual({
      ref: null,
      target_id: "cta",
      duration_ms: 2000,
    });
  });

  test("test_focus", () => {
    expect(new Focus({ ref: "e7" }).modelDump()).toEqual({ ref: "e7", target_id: null });
  });

  test("test_click", () => {
    expect(new Click({ ref: "e9" }).modelDump()).toEqual({ ref: "e9", target_id: null });
  });

  test("test_set_input_value_default_replace_true", () => {
    expect(new SetInputValue({ ref: "e3", value: "Marie Curie" }).modelDump()).toEqual({
      value: "Marie Curie",
      ref: "e3",
      target_id: null,
      replace: true,
    });
  });

  test("test_set_input_value_append", () => {
    const payload = new SetInputValue({ ref: "e3", value: "more", replace: false }).modelDump();
    expect(payload.replace).toBe(false);
  });

  test("test_select_text_full", () => {
    expect(new SelectText({ ref: "e15", startOffset: 4, endOffset: 12 }).modelDump()).toEqual({
      ref: "e15",
      target_id: null,
      start_offset: 4,
      end_offset: 12,
    });
  });

  test("test_select_text_whole_target_when_offsets_omitted", () => {
    const payload = new SelectText({ ref: "e15" }).modelDump();
    expect(payload.start_offset).toBeNull();
    expect(payload.end_offset).toBeNull();
  });
});

describe("TestFrames", () => {
  // Pin the frame API for named UI messages.

  test("test_ui_command_frame_names_command_and_payload", () => {
    const frame = new RTVIUICommandFrame({ command: "toast", payload: { title: "Saved" } });
    expect(frame.command).toEqual("toast");
    expect(frame.payload).toEqual({ title: "Saved" });
  });

  test("test_ui_event_frame_names_event_and_payload", () => {
    const frame = new RTVIUIEventFrame({
      msgId: "m1",
      event: "nav_click",
      payload: { view: "home" },
    });
    expect(frame.msgId).toEqual("m1");
    expect(frame.event).toEqual("nav_click");
    expect(frame.payload).toEqual({ view: "home" });
  });
});
