// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/base_pipeline.py

/** Base pipeline implementation for frame processing. */

import { gather, monotonicNs, rethrowIfCancelled, type Task } from "@pipecat-ts/asyncio";
import { ProcessorSetUp } from "../observers/base_observer.ts";
import {
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";

export interface BasePipelineOptions extends FrameProcessorOptions {}

/** Base class for all pipeline implementations. */
export class BasePipeline extends FrameProcessor {
  /** Initialize the base pipeline. */
  constructor(options: BasePipelineOptions = {}) {
    super(options);
  }

  /**
   * Set up the given processors concurrently.
   *
   * A processor that fails to set up reports it as an error and leaves the
   * rest of the pipeline to carry on, the same way a failure while handling a
   * frame is reported. Every failure is reported, not just the first.
   *
   * The failure is permanent whatever caused it, since setting up is not
   * attempted again: the processor is left half-built for the rest of the
   * session, so it loses its usability and a switcher can move off it.
   *
   * Call it right after this pipeline's own setup, once it has released
   * itself with `_setupFinished()`. Each processor holds the StartFrame until
   * its own setup is done, so one slow processor doesn't block the ones ahead
   * of it. The processors are held before anything else runs, so the
   * StartFrame can't get past one whose setup() hasn't begun yet.
   *
   * @param processors The processors to set up.
   * @param setup Configuration for frame processor setup.
   */
  protected async _setupProcessors(
    processors: readonly FrameProcessor[],
    setup: FrameProcessorSetup,
  ): Promise<void> {
    const tasks = processors.map((p) => this._createSetupTask(p, setup));
    await gather(...tasks);
  }

  /** Hold the processor's StartFrame and set it up in a task of its own. */
  protected _createSetupTask(processor: FrameProcessor, setup: FrameProcessorSetup): Task<unknown> {
    processor._setupStarted();
    const task = this.createTask(
      () => this._setupProcessor(processor, setup),
      `${this}::setup::${processor}`,
    );
    task.addDoneCallback((task) => this._setupTaskDone(processor, task));
    return task;
  }

  /** Release the processor once it is set up, unless setting it up was cancelled. */
  protected _setupTaskDone(processor: FrameProcessor, task: Task<unknown>): void {
    if (!task.cancelled()) {
      processor._setupFinished();
    }
  }

  /** Set the processor up, reporting a failure as a permanent error. */
  protected async _setupProcessor(
    processor: FrameProcessor,
    setup: FrameProcessorSetup,
  ): Promise<void> {
    const startedAtNs = monotonicNs();
    try {
      await processor.setup(setup);
    } catch (e) {
      rethrowIfCancelled(e);
      await processor.pushError(`Error setting up processor: ${errorMessage(e)}`, {
        exception: e,
        forceTreatAsPermanent: true,
      });
    }
    if (setup.observer) {
      await setup.observer.onProcessorSetup(
        new ProcessorSetUp({
          processor,
          startedAtNs,
          finishedAtNs: monotonicNs(),
        }),
      );
    }
  }

  /**
   * Clean up the given processors concurrently.
   *
   * Tearing down is best effort: a processor that throws is logged and the
   * rest are still released. Cleaning up runs after a processor failed to set
   * up, or was abandoned part-way through being set up, so some of them are
   * released from a state they never finished reaching.
   *
   * @param processors The processors to clean up.
   */
  protected async _cleanupProcessors(processors: readonly FrameProcessor[]): Promise<void> {
    const cleanupProcessor = async (processor: FrameProcessor): Promise<void> => {
      try {
        await processor.cleanup();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error cleaning up ${processor}: ${errorMessage(e)}`);
      }
    };

    await gather(...processors.map((p) => () => cleanupProcessor(p)));
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
