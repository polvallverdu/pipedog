// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/parallel_pipeline.py

/**
 * Parallel pipeline implementation for concurrent frame processing.
 *
 * This module provides a parallel pipeline that processes frames through
 * multiple sub-pipelines concurrently, with coordination for system frames and
 * proper handling of pipeline lifecycle events.
 */

import { CancelFrame, EndFrame, type Frame, StartFrame } from "../frames/frames.ts";
import type {
  FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import { BasePipeline } from "./base_pipeline.ts";
import { Pipeline, PipelineSink, PipelineSource } from "./pipeline.ts";

/**
 * Pipeline that processes frames through multiple sub-pipelines concurrently.
 *
 * Creates multiple parallel processing branches from the provided processor
 * lists, coordinating frame flow and ensuring proper synchronization of
 * lifecycle events like EndFrames. Each branch runs independently while system
 * frames are handled specially to maintain pipeline coordination.
 */
export class ParallelPipeline extends BasePipeline {
  protected _pipelines: Pipeline[] = [];

  protected _seenIds = new Set<number>();
  protected _frameCounter = new Map<number, number>();
  protected _synchronizing = false;
  protected _bufferedFrames: [Frame, FrameDirection][] = [];

  /**
   * Initialize the parallel pipeline with processor lists.
   *
   * @param args Variable number of processor lists, each becoming a parallel branch.
   * @throws Error If no processor lists are provided.
   * @throws TypeError If any argument is not a list of processors.
   */
  constructor(...args: FrameProcessor[][]) {
    // We don't set it to direct mode because we use frame pausing and that
    // requires queues.
    super();

    if (args.length === 0) {
      throw new Error("ParallelPipeline needs at least one argument");
    }

    logger.debug(`Creating ${this} pipelines`);

    for (const processors of args) {
      if (!Array.isArray(processors)) {
        throw new TypeError(`ParallelPipeline argument ${processors} is not a list`);
      }

      const numPipelines = this._pipelines.length;

      // We add a source before the pipeline and a sink after so we control
      // the frames that are pushed upstream and downstream.
      const source = new PipelineSource(
        (frame, direction) => this._parallelPushFrame(frame, direction),
        { name: `${this}::Source${numPipelines}` },
      );
      const sink = new PipelineSink(
        (frame, direction) => this._pipelineSinkPushFrame(frame, direction),
        { name: `${this}::Sink${numPipelines}` },
      );

      // Create pipeline
      const pipeline = new Pipeline(processors, { source, sink });
      this._pipelines.push(pipeline);
    }

    logger.debug(`Finished creating ${this} pipelines`);
  }

  //
  // Frame processor
  //

  /**
   * The list of sub-processors contained within this processor.
   *
   * Only compound processors (e.g. pipelines and parallel pipelines) have
   * sub-processors. Non-compound processors will return an empty list.
   */
  override get processors(): FrameProcessor[] {
    return this._pipelines;
  }

  /**
   * The list of entry processors for this processor.
   *
   * Entry processors are the first processors in a compound processor (e.g.
   * pipelines, parallel pipelines). Note that pipelines can also be an entry
   * processor as pipelines are processors themselves. Non-compound processors
   * will simply return an empty list.
   */
  override get entryProcessors(): FrameProcessor[] {
    return this._pipelines;
  }

  /**
   * Collect processors that can generate metrics from all parallel branches.
   *
   * @returns Frame processors that support metrics collection from all branches.
   */
  override processorsWithMetrics(): FrameProcessor[] {
    return this._pipelines.flatMap((p) => p.processorsWithMetrics());
  }

  /**
   * Set up the parallel pipeline and all its branches.
   *
   * @param setup Configuration for frame processor setup.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // This pipeline is set up, so let the StartFrame in: each branch holds it
    // until its own setup is done.
    this._setupFinished();
    await this._setupProcessors(this._pipelines, setup);
  }

  /** Clean up the parallel pipeline and all its branches. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cleanupProcessors(this._pipelines);
  }

  /**
   * Process frames through all parallel branches with lifecycle coordination.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Parallel pipeline synchronized frames.
    //
    // - StartFrame: If a fast branch completes first, processors in other
    //   branches that haven't received StartFrame yet could receive other
    //   frames before it, causing errors.
    //
    // - EndFrame: If EndFrame escapes from a fast branch, downstream
    //   processors (e.g. output transport) begin shutting down while other
    //   branches still have frames to flush, causing lost output.
    //
    // - CancelFrame: PipelineWorker waits for CancelFrame to reach the
    //   pipeline sink. If it escapes from a fast branch while slower branches
    //   are still running, the task considers cancellation complete
    //   prematurely.
    if (isSynchronizedFrame(frame)) {
      this._frameCounter.set(frame.id, this._pipelines.length);
      this._synchronizing = true;
      await this.pauseProcessingSystemFrames();
      await this.pauseProcessingFrames();
    }

    // Process frames in each of the sub-pipelines.
    for (const p of this._pipelines) {
      await p.queueFrame(frame, direction);
    }
  }

  /**
   * Push frames while avoiding duplicates using frame ID tracking.
   *
   * During lifecycle frame synchronization, non-lifecycle frames are buffered
   * to prevent them from escaping the parallel pipeline before all branches
   * have finished processing the lifecycle frame.
   */
  protected async _parallelPushFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (!this._seenIds.has(frame.id)) {
      this._seenIds.add(frame.id);
      if (this._synchronizing) {
        this._bufferedFrames.push([frame, direction]);
      } else {
        await this.pushFrame(frame, direction);
      }
    }
  }

  protected async _pipelineSinkPushFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    // Parallel pipeline synchronized frames.
    if (isSynchronizedFrame(frame)) {
      // Decrement counter.
      let frameCounter = this._frameCounter.get(frame.id) ?? 0;
      if (frameCounter > 0) {
        frameCounter -= 1;
        this._frameCounter.set(frame.id, frameCounter);
      }

      // Only push the frame when all pipelines have processed it.
      if (frameCounter === 0) {
        this._synchronizing = false;
        // StartFrame should always go before any other frame.
        if (frame instanceof StartFrame) {
          await this._parallelPushFrame(frame, direction);
          await this._flushBufferedFrames();
        } else {
          await this._flushBufferedFrames();
          await this._parallelPushFrame(frame, direction);
        }
        await this.resumeProcessingSystemFrames();
        await this.resumeProcessingFrames();
      }
    } else {
      await this._parallelPushFrame(frame, direction);
    }
  }

  /** Flush frames that were buffered during lifecycle frame synchronization. */
  protected async _flushBufferedFrames(): Promise<void> {
    while (this._bufferedFrames.length > 0) {
      const [frame, direction] = this._bufferedFrames.shift() as [Frame, FrameDirection];
      await this.pushFrame(frame, direction);
    }
  }
}

function isSynchronizedFrame(frame: Frame): boolean {
  return frame instanceof StartFrame || frame instanceof EndFrame || frame instanceof CancelFrame;
}
