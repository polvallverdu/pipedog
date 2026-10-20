// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_processor_unusable_policy.py

import { describe, expect, test } from "bun:test";
import { waitFor } from "@pipecat-ts/asyncio";
import { CancelFrame, EndFrame, ErrorFrame, type Frame, TextFrame } from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { PipelineWorker, ProcessorUnusablePolicy } from "../src/pipeline/worker.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../src/processors/frame_processor.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import { WorkerParams } from "../src/workers/base_worker.ts";

const RUN_TIMEOUT_SECS = 10;

/** Test access to PipelineWorker's protected state, as the Python test reads it. */
const internals = (w: PipelineWorker): any => w;

interface ErroringProcessorOptions extends FrameProcessorOptions {
  category?: ErrorCategory;
}

/** Processor that reports an error every time it sees a `TextFrame`. */
class ErroringProcessor extends FrameProcessor {
  protected _category: ErrorCategory;

  constructor(options: ErroringProcessorOptions = {}) {
    super(options);
    this._category = options.category ?? ErrorCategory.AUTHENTICATION;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      await this.pushErrorFrame(
        new ErrorFrame({ error: "service failed", category: this._category }),
      );
    }

    // Forward everything, so lifecycle frames reach the sink and every
    // processor in the pipeline gets a chance to report its own error.
    await this.pushFrame(frame, direction);
  }
}

/** Processor whose failure keeps recurring, whatever its category says. */
class PermanentlyFailingProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      await this.pushError("service failed for good", {
        category: ErrorCategory.SERVER,
        forceTreatAsPermanent: true,
      });
    }

    await this.pushFrame(frame, direction);
  }
}

/**
 * Collect the errors that cost their processor its usefulness.
 *
 * This is how application code tells the two kinds of error apart, with no
 * dedicated event of its own.
 */
function collectUnusable(worker: PipelineWorker): ErrorFrame[] {
  const unusable: ErrorFrame[] = [];

  worker.eventHandler("on_pipeline_error", async (_worker: PipelineWorker, frame: ErrorFrame) => {
    if (frame.processor && !frame.processor.isUsable) {
      unusable.push(frame);
    }
  });

  return unusable;
}

/** Run a one-processor pipeline, returning its errors and terminal frames. */
async function runWorker(
  processor: FrameProcessor,
  policy: ProcessorUnusablePolicy,
  frames: Frame[],
): Promise<[ErrorFrame[], Frame[]]> {
  const worker = new PipelineWorker(new Pipeline([processor]), {
    processorUnusablePolicy: policy,
  });

  const unusable = collectUnusable(worker);
  const finished: Frame[] = [];

  worker.eventHandler("on_pipeline_finished", async (_worker: PipelineWorker, frame: Frame) => {
    finished.push(frame);
  });

  await worker.queueFrames(frames);

  await waitFor(
    () => worker.run(new WorkerParams({ taskManager: new TaskManager() })),
    RUN_TIMEOUT_SECS,
  );

  return [unusable, finished];
}

describe("TestProcessorUnusablePolicy", () => {
  test("test_continue_keeps_the_pipeline_running", async () => {
    const [unusable, finished] = await runWorker(
      new ErroringProcessor(),
      ProcessorUnusablePolicy.CONTINUE,
      [new TextFrame({ text: "hello" }), new EndFrame()],
    );

    expect(unusable.length).toEqual(1);
    expect(unusable[0]!.category).toBe(ErrorCategory.AUTHENTICATION);
    // The pipeline ran until the EndFrame we queued, not because of the error.
    expect(finished.some((frame) => frame instanceof EndFrame)).toBe(true);
  });

  test("test_end_stops_the_pipeline", async () => {
    const [unusable, finished] = await runWorker(
      new ErroringProcessor(),
      ProcessorUnusablePolicy.END,
      [new TextFrame({ text: "hello" })],
    );

    expect(unusable.length).toEqual(1);
    expect(finished.some((frame) => frame instanceof EndFrame)).toBe(true);
  });

  test("test_cancel_stops_the_pipeline", async () => {
    const [unusable, finished] = await runWorker(
      new ErroringProcessor(),
      ProcessorUnusablePolicy.CANCEL,
      [new TextFrame({ text: "hello" })],
    );

    expect(unusable.length).toEqual(1);
    expect(finished.some((frame) => frame instanceof CancelFrame)).toBe(true);
  });

  test("test_default_policy_is_continue", async () => {
    const worker = new PipelineWorker(new Pipeline([]));
    expect(internals(worker)._processorUnusablePolicy).toEqual(ProcessorUnusablePolicy.CONTINUE);
  });
});

describe("TestErrorsThePipelineActsOn", () => {
  test("test_a_processor_is_acted_on_once", async () => {
    const processor = new ErroringProcessor();
    const worker = new PipelineWorker(new Pipeline([processor]), {
      processorUnusablePolicy: ProcessorUnusablePolicy.CONTINUE,
    });
    collectUnusable(worker);

    await worker.queueFrames([
      new TextFrame({ text: "one" }),
      new TextFrame({ text: "two" }),
      new TextFrame({ text: "three" }),
      new EndFrame(),
    ]);

    await waitFor(
      () => worker.run(new WorkerParams({ taskManager: new TaskManager() })),
      RUN_TIMEOUT_SECS,
    );

    // Every error is reported, but the policy is applied to the first.
    const unusableProcessors: Set<FrameProcessor> = internals(worker)._unusableProcessors;
    expect(unusableProcessors.size).toEqual(1);
    expect(unusableProcessors.has(processor)).toBe(true);
  });

  test("test_each_processor_is_acted_on_separately", async () => {
    const first = new ErroringProcessor({ name: "first" });
    const second = new ErroringProcessor({ name: "second" });
    const worker = new PipelineWorker(new Pipeline([first, second]), {
      processorUnusablePolicy: ProcessorUnusablePolicy.CONTINUE,
    });

    // The TextFrame reaches both processors, so both report an error.
    await worker.queueFrames([new TextFrame({ text: "hello" }), new EndFrame()]);

    await waitFor(
      () => worker.run(new WorkerParams({ taskManager: new TaskManager() })),
      RUN_TIMEOUT_SECS,
    );

    const unusableProcessors: Set<FrameProcessor> = internals(worker)._unusableProcessors;
    expect(unusableProcessors.size).toEqual(2);
    expect(unusableProcessors.has(first)).toBe(true);
    expect(unusableProcessors.has(second)).toBe(true);
  });

  test("test_transient_errors_leave_the_pipeline_running", async () => {
    const [unusable, finished] = await runWorker(
      new ErroringProcessor({ category: ErrorCategory.SERVER }),
      ProcessorUnusablePolicy.END,
      [new TextFrame({ text: "hello" }), new EndFrame()],
    );

    expect(unusable).toEqual([]);
    expect(finished.some((frame) => frame instanceof EndFrame)).toBe(true);
  });

  test("test_unclassified_errors_leave_the_pipeline_running", async () => {
    const [unusable] = await runWorker(
      new ErroringProcessor({ category: ErrorCategory.UNKNOWN }),
      ProcessorUnusablePolicy.END,
      [new TextFrame({ text: "hello" }), new EndFrame()],
    );

    expect(unusable).toEqual([]);
  });

  test("test_permanent_errors_are_acted_on_whatever_the_category", async () => {
    const [unusable, finished] = await runWorker(
      new PermanentlyFailingProcessor(),
      ProcessorUnusablePolicy.CANCEL,
      [new TextFrame({ text: "hello" })],
    );

    expect(unusable.length).toEqual(1);
    expect(finished.some((frame) => frame instanceof CancelFrame)).toBe(true);
  });
});

// The deprecated `fatal` flag (`ErrorFrame(fatal=)`, `FatalErrorFrame`,
// `push_error(fatal=)`) is not ported, so these tests only exercise
// deprecated behavior and are skipped.
describe("TestDeprecatedFatalFlag", () => {
  test.skip("test_error_frame_warns_when_fatal", () => {
    // Deprecated: `ErrorFrame.fatal` is not ported.
  });

  test.skip("test_error_frame_stays_quiet_without_fatal", () => {
    // Deprecated: only checks the `ErrorFrame.fatal` deprecation warning, which is not ported.
  });

  test.skip("test_fatal_error_frame_warns_about_itself_only", () => {
    // Deprecated: `FatalErrorFrame` is not ported.
  });

  test.skip("test_push_error_warns_when_fatal_and_still_cancels", () => {
    // Deprecated: `push_error(fatal=True)` is not ported.
  });

  test.skip("test_push_error_stays_quiet_when_permanent", () => {
    // Deprecated: only checks that no `fatal` deprecation warning is raised; warnings not ported.
  });
});
