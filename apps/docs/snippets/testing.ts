// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/concepts/frame-processors.mdx ("Testing a processor").
// Type-checked on every docs build.

// #region run-test
import { expect, test } from "bun:test";
import { type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";

class UpperCaseProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof TextFrame) {
      await this.pushFrame(new TextFrame({ text: frame.text.toUpperCase() }), direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

test("test_upper_case", async () => {
  const [down] = await runTest(new UpperCaseProcessor(), {
    framesToSend: [new TextFrame({ text: "hello" })],
    expectedDownFrames: [TextFrame],
  });
  expect((down[0] as TextFrame).text).toEqual("HELLO");
});
// #endregion run-test
