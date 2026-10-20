// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_frames_interruptible.py

/** The interruptible flag on frames: its defaults and how a frame overrides them. */

import { describe, expect, test } from "bun:test";
import { DataFrame, EndFrame, FunctionCallResultFrame, TextFrame } from "../src/frames/frames.ts";

describe("TestInterruptibleFlag", () => {
  test("test_defaults_follow_the_class", () => {
    expect(new TextFrame({ text: "hi" }).interruptible).toBe(true);
    expect(new EndFrame().interruptible).toBe(false);
    expect(
      new FunctionCallResultFrame({
        functionName: "f",
        toolCallId: "1",
        arguments: {},
        result: {},
      }).interruptible,
    ).toBe(false);
  });

  test("test_a_frame_may_be_set_either_way", () => {
    const frame = new TextFrame({ text: "hi" });
    frame.interruptible = false;
    expect(frame.interruptible).toBe(false);
    const end = new EndFrame();
    end.interruptible = true;
    expect(end.interruptible).toBe(true);
  });

  test("test_a_class_declares_its_default_through_the_field", () => {
    class Sticky extends DataFrame {
      override interruptible = false;
    }

    expect(new Sticky().interruptible).toBe(false);
  });

  // Deprecated upstream API (`UninterruptibleFrame` marker, deprecated since
  // 1.11.0) is not ported; see docs/CONVENTIONS.md.
  test.skip("test_the_marker_still_works_and_warns", () => {});
});
