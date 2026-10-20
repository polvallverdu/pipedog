// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/pipelines-and-workers.mdx. Type-checked on every docs build.

import {
  CancelWorkerFrame,
  EndFrame,
  EndWorkerFrame,
  type ErrorFrame,
  type Frame,
  InterruptionWorkerFrame,
  TextFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { ParallelPipeline } from "@pipedog/core/pipeline/parallel_pipeline";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import {
  PipelineParams,
  PipelineWorker,
  ProcessorUnusablePolicy,
} from "@pipedog/core/pipeline/worker";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { WorkerRunner } from "@pipedog/core/workers/runner";

class Passthrough extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}
const [a, b, c, d] = [new Passthrough(), new Passthrough(), new Passthrough(), new Passthrough()];

// #region pipeline
const pipeline = new Pipeline([a, b, c]);
// #endregion pipeline

// #region parallel
// Every branch receives every frame; their output is merged downstream.
const parallel = new Pipeline([a, new ParallelPipeline([b], [c]), d]);
// #endregion parallel
void parallel;

// #region worker
const worker = new PipelineWorker(pipeline, {
  params: new PipelineParams({
    audioInSampleRate: 16000,
    audioOutSampleRate: 24000,
    enableMetrics: true,
    enableUsageMetrics: true,
  }),
  idleTimeoutSecs: 300, // seconds, as upstream
  cancelOnIdleTimeout: true,
  processorUnusablePolicy: ProcessorUnusablePolicy.CONTINUE,
  enableRtvi: false,
});
// #endregion worker

// #region worker-events
worker.eventHandler("on_pipeline_started", async (_worker: PipelineWorker, _frame: Frame) => {
  console.log("pipeline started");
});

worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
  // StopFrame, EndFrame or CancelFrame: inspect it to tell the cases apart.
  console.log(`pipeline finished: ${frame}`);
});

worker.eventHandler("on_pipeline_error", async (_worker: PipelineWorker, frame: ErrorFrame) => {
  if (frame.processor && !frame.processor.isUsable) {
    await worker.cancel({ reason: `${frame.processor} is no longer usable` });
  }
});

worker.eventHandler("on_idle_timeout", async (_worker: PipelineWorker) => {
  console.log("nobody said anything for a while");
});
// #endregion worker-events

export async function queueing(): Promise<void> {
  // #region queue-frames
  // Executed in order: speak first, then end the pipeline once that is flushed.
  await worker.queueFrames([
    new TTSSpeakFrame({ text: "Goodbye!" }),
    new EndFrame({ reason: "user said goodbye" }),
  ]);

  // Interrupt whatever the bot is doing.
  await worker.queueFrame(new InterruptionWorkerFrame());

  // Push from the end of the pipeline, towards the start.
  await worker.queueFrame(new TextFrame({ text: "upstream" }), FrameDirection.UPSTREAM);
  // #endregion queue-frames

  // #region ending
  await worker.stopWhenDone(); // queue an EndFrame behind everything already queued
  await worker.end({ reason: "done" }); // request a graceful end, draining first
  await worker.cancel({ reason: "shutting down" }); // stop now, dropping queued frames
  // #endregion ending
}

// #region end-from-inside
/** Ends the conversation when it sees a "goodbye" TextFrame. */
export class GoodbyeDetector extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);

    if (frame instanceof TextFrame && frame.text.toLowerCase().includes("goodbye")) {
      await this.pushFrame(new TTSSpeakFrame({ text: "Have a nice day!" }));
      // Downstream (the default), so the goodbye is flushed before the pipeline ends.
      await this.pushFrame(new EndWorkerFrame(), FrameDirection.DOWNSTREAM);
    } else if (frame instanceof TextFrame && frame.text === "abort") {
      // Ends right away, abandoning queued frames.
      await this.pushFrame(new CancelWorkerFrame());
    }
  }
}
// #endregion end-from-inside

// #region runner
const runner = new WorkerRunner({
  handleSigint: true, // the default: Ctrl-C cancels the runner (Bun, Node, Deno)
});
await runner.addWorkers(worker);
await runner.run(); // returns once every root worker has finished
// #endregion runner
