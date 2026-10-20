// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_idle_frame_processor.py

import { describe, expect, test } from "bun:test";

import { Event } from "@pipedog/asyncio";

import { TextFrame, TranscriptionFrame } from "../src/frames/frames.ts";
import { IdleFrameProcessor } from "../src/processors/idle_frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

/** Exposes the protected members the regression test pokes at, as upstream does. */
interface IdleInternals {
  _idleEvent: Event;
  _idleTaskHandler(): Promise<void>;
}

describe("TestIdleFrameProcessor", () => {
  test("test_basic_idle_detection", async () => {
    // Test that idle callback is triggered after timeout.
    const callbackCalled = new Event();

    const idleCallback = async (_processor: IdleFrameProcessor) => {
      callbackCalled.set();
    };

    const processor = new IdleFrameProcessor({ callback: idleCallback, timeout: 0.1 });

    await runTest(processor, {
      framesToSend: [new SleepFrame({ sleep: 0.2 })],
      expectedDownFrames: [],
    });

    expect(callbackCalled.isSet()).toBe(true);
  });

  test("test_activity_resets_timer", async () => {
    // Test that receiving frames resets the idle timer.
    const callbackCalled = new Event();

    const idleCallback = async (_processor: IdleFrameProcessor) => {
      callbackCalled.set();
    };

    const processor = new IdleFrameProcessor({ callback: idleCallback, timeout: 0.2 });

    await runTest(processor, {
      framesToSend: [
        new SleepFrame({ sleep: 0.1 }),
        new TextFrame({ text: "hello" }),
        new SleepFrame({ sleep: 0.1 }),
        new TextFrame({ text: "world" }),
        new SleepFrame({ sleep: 0.1 }),
      ],
      expectedDownFrames: [TextFrame, TextFrame],
    });

    expect(callbackCalled.isSet()).toBe(false);
  });

  test("test_signal_preserved_during_callback", async () => {
    // Regression: event set during callback must not be cleared.
    class _Sentinel extends Error {}

    const callback = async (proc: IdleFrameProcessor) => {
      (proc as unknown as IdleInternals)._idleEvent.set();
      throw new _Sentinel();
    };

    const processor = new IdleFrameProcessor({ callback, timeout: 0.01 });
    const internals = processor as unknown as IdleInternals;
    internals._idleEvent = new Event();

    await expect(internals._idleTaskHandler()).rejects.toThrow(_Sentinel);

    expect(internals._idleEvent.isSet()).toBe(true);
  });

  test("test_specific_frame_types", async () => {
    // Test that only monitored frame types reset the idle timer.
    const callbackCalled = new Event();

    const idleCallback = async (_processor: IdleFrameProcessor) => {
      callbackCalled.set();
    };

    const processor = new IdleFrameProcessor({
      callback: idleCallback,
      timeout: 0.15,
      types: [TranscriptionFrame],
    });

    await runTest(processor, {
      framesToSend: [
        new SleepFrame({ sleep: 0.1 }),
        new TextFrame({ text: "this should not reset" }),
        new SleepFrame({ sleep: 0.2 }),
      ],
      expectedDownFrames: [TextFrame],
    });

    expect(callbackCalled.isSet()).toBe(true);
  });
});
