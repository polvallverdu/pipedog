// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The Quickstart from the docs (content/docs/quickstart.mdx). It is
// type-checked by `bun run snippets:check` on every docs build, and can be run
// with `bun snippets/quickstart.ts`.

// #region bot
import { EndFrame, type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { WorkerRunner } from "@pipedog/core/workers/runner";

/** Upper-cases every TextFrame and passes every other frame through. */
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

/** Prints the text frames that reach it. */
class PrintProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      console.log(`${this.name}: ${frame.text}`);
    }
    await this.pushFrame(frame, direction);
  }
}

const pipeline = new Pipeline([new UpperCaseProcessor(), new PrintProcessor()]);
const worker = new PipelineWorker(pipeline, { enableRtvi: false });

worker.eventHandler("on_pipeline_started", async () => {
  await worker.queueFrames([
    new TextFrame({ text: "hello" }),
    new TextFrame({ text: "from pipedog" }),
    new EndFrame(),
  ]);
});

worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
  console.log(`pipeline finished with ${frame.name}`);
});

const runner = new WorkerRunner({ handleSigint: false });
await runner.addWorkers(worker);
await runner.run();
// #endregion bot
