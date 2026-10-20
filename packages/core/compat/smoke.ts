// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: imports the core pipeline modules and
// runs a one-processor pipeline end to end with runTest().

import { type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import { WorkerRunner } from "@pipedog/core/workers/runner";

class PassThrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`core smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  // Constructing the building blocks must not need any runtime-specific API.
  const pipeline = new Pipeline([new PassThrough()]);
  const worker = new PipelineWorker(pipeline, { params: new PipelineParams() });
  check(worker instanceof PipelineWorker, "PipelineWorker");
  check(new WorkerRunner() instanceof WorkerRunner, "WorkerRunner");

  // And a frame must make it through a running pipeline.
  const [down] = await runTest(new PassThrough(), {
    framesToSend: [new TextFrame({ text: "hello" })],
    expectedDownFrames: [TextFrame],
  });
  const text = down[0];
  check(text instanceof TextFrame && text.text === "hello", "TextFrame did not pass through");
}
