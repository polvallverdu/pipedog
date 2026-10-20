// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_filters.py

import { describe, test } from "bun:test";

import {
  EndFrame,
  type Frame,
  TextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { FrameFilter } from "../src/processors/filters/frame_filter.ts";
import { FunctionFilter } from "../src/processors/filters/function_filter.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import { runTest } from "../src/tests/utils.ts";

describe("TestIdentifyFilter", () => {
  test("test_identity", async () => {
    const filter = new IdentityFilter();
    const framesToSend = [new UserStartedSpeakingFrame(), new UserStoppedSpeakingFrame()];
    const expectedDownFrames = [UserStartedSpeakingFrame, UserStoppedSpeakingFrame];
    await runTest(filter, { framesToSend, expectedDownFrames });
  });
});

describe("TestFrameFilter", () => {
  test("test_text_frame", async () => {
    const filter = new FrameFilter({ types: [TextFrame] });
    const framesToSend = [new TextFrame({ text: "Hello Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(filter, { framesToSend, expectedDownFrames });
  });

  test("test_end_frame", async () => {
    const filter = new FrameFilter({ types: [EndFrame] });
    const framesToSend = [new EndFrame()];
    const expectedDownFrames = [EndFrame];
    await runTest(filter, { framesToSend, expectedDownFrames, sendEndFrame: false });
  });

  test("test_system_frame", async () => {
    const filter = new FrameFilter({ types: [] });
    const framesToSend = [new UserStartedSpeakingFrame()];
    const expectedDownFrames = [UserStartedSpeakingFrame];
    await runTest(filter, { framesToSend, expectedDownFrames });
  });
});

/** Pushes a TextFrame upstream when it receives a system frame. */
class UpstreamPusher extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
    if (frame instanceof UserStartedSpeakingFrame) {
      await this.pushFrame(new TextFrame({ text: "upstream" }), FrameDirection.UPSTREAM);
    }
  }
}

describe("TestFunctionFilter", () => {
  test("test_passthrough", async () => {
    const passthrough = async (_frame: Frame) => true;

    const filter = new FunctionFilter({ filter: passthrough });
    const framesToSend = [new TextFrame({ text: "Hello Pipecat!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(filter, { framesToSend, expectedDownFrames });
  });

  test("test_no_passthrough", async () => {
    const noPassthrough = async (_frame: Frame) => false;

    const filter = new FunctionFilter({ filter: noPassthrough });
    const framesToSend = [new TextFrame({ text: "Hello Pipecat!" })];
    const expectedDownFrames: (typeof Frame)[] = [];
    await runTest(filter, { framesToSend, expectedDownFrames });
  });

  test("test_no_direction_filters_both_directions", async () => {
    // When direction is None, frames in both directions are filtered.
    const blockText = async (frame: Frame) => !(frame instanceof TextFrame);

    // direction=None: filter applies in both directions. The downstream
    // TextFrame is blocked and the upstream TextFrame pushed by
    // UpstreamPusher is also blocked.
    const filter = new FunctionFilter({ filter: blockText, direction: null });
    const pipeline = new Pipeline([filter, new UpstreamPusher()]);
    const framesToSend = [new TextFrame({ text: "Hello!" }), new UserStartedSpeakingFrame()];
    const expectedDownFrames = [UserStartedSpeakingFrame];
    const expectedUpFrames: (typeof Frame)[] = [];
    await runTest(pipeline, { framesToSend, expectedDownFrames, expectedUpFrames });
  });

  test("test_downstream_direction_passes_upstream", async () => {
    // When direction is DOWNSTREAM, upstream frames pass through unfiltered.
    const blockText = async (frame: Frame) => !(frame instanceof TextFrame);

    // direction=DOWNSTREAM: filter only applies downstream, so the
    // upstream TextFrame pushed by UpstreamPusher passes through.
    const filter = new FunctionFilter({ filter: blockText });
    const pipeline = new Pipeline([filter, new UpstreamPusher()]);
    const framesToSend = [new UserStartedSpeakingFrame()];
    const expectedDownFrames = [UserStartedSpeakingFrame];
    const expectedUpFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames, expectedUpFrames });
  });

  // DIVERGENCE: upstream expects the UserStartedSpeakingFrame (a SystemFrame)
  // to overtake the earlier TextFrame. That relies on asyncio scheduling: the
  // non-blocking Queue.put calls in run_test's push_frames never yield, so both
  // frames are queued before the worker's push task runs, and each processor's
  // input task then handles the system frame before its process task forwards
  // the TextFrame. In JS every await yields to already-woken tasks (microtasks),
  // so the TextFrame starts traversing the pipeline before the system frame is
  // queued and arrives first ([TextFrame, UserStartedSpeakingFrame]). Fixing it
  // needs asyncio-style "call_soon" scheduling in @pipecat-ts/asyncio, not a
  // change in FunctionFilter.
  test.skip("test_upstream_direction_passes_downstream", async () => {
    // When direction is UPSTREAM, downstream frames pass through unfiltered.
    const blockText = async (frame: Frame) => !(frame instanceof TextFrame);

    // direction=UPSTREAM: filter only applies upstream, so the
    // downstream TextFrame passes through but the upstream TextFrame
    // pushed by UpstreamPusher is blocked.
    const filter = new FunctionFilter({ filter: blockText, direction: FrameDirection.UPSTREAM });
    const pipeline = new Pipeline([filter, new UpstreamPusher()]);
    const framesToSend = [new TextFrame({ text: "Hello!" }), new UserStartedSpeakingFrame()];
    const expectedDownFrames = [UserStartedSpeakingFrame, TextFrame];
    const expectedUpFrames: (typeof Frame)[] = [];
    await runTest(pipeline, { framesToSend, expectedDownFrames, expectedUpFrames });
  });
});

describe("TestWakeCheckFilter", () => {
  // WakeCheckFilter is deprecated upstream (since 0.0.106, removed in 2.0.0;
  // use WakePhraseUserTurnStartStrategy) and is therefore not ported.
  test.skip("test_no_wake_word", () => {});

  // WakeCheckFilter is deprecated upstream and is therefore not ported.
  test.skip("test_wake_word", () => {});
});
