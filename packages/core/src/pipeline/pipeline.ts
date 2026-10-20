// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/pipeline.py

/**
 * Pipeline implementation for connecting and managing frame processors.
 *
 * Provides the main Pipeline class that connects frame processors in sequence
 * and manages frame flow between them, along with helper classes for pipeline
 * source and sink operations.
 */

import type { Frame } from "../frames/frames.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { BasePipeline } from "./base_pipeline.ts";

/** Function receiving the frames that leave a pipeline at one of its ends. */
export type PushFrameFn = (frame: Frame, direction: FrameDirection) => Promise<void>;

/**
 * Source processor that forwards frames to an upstream handler.
 *
 * Acts as the entry point for a pipeline, forwarding downstream frames to the
 * next processor and upstream frames to a provided upstream handler function.
 */
export class PipelineSource extends FrameProcessor {
  protected _upstreamPushFrame: PushFrameFn;

  /**
   * Initialize the pipeline source.
   *
   * @param upstreamPushFrame Async function to handle upstream frames.
   * @param options Additional options passed to the parent class.
   */
  constructor(upstreamPushFrame: PushFrameFn, options: FrameProcessorOptions = {}) {
    super({ ...options, enableDirectMode: true });
    this._upstreamPushFrame = upstreamPushFrame;
  }

  /**
   * Process frames and route them based on direction.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    switch (direction) {
      case FrameDirection.UPSTREAM:
        await this._upstreamPushFrame(frame, direction);
        break;
      case FrameDirection.DOWNSTREAM:
        await this.pushFrame(frame, direction);
        break;
    }
  }
}

/**
 * Sink processor that forwards frames to a downstream handler.
 *
 * Acts as the exit point for a pipeline, forwarding upstream frames to the
 * previous processor and downstream frames to a provided downstream handler
 * function.
 */
export class PipelineSink extends FrameProcessor {
  protected _downstreamPushFrame: PushFrameFn;

  /**
   * Initialize the pipeline sink.
   *
   * @param downstreamPushFrame Async function to handle downstream frames.
   * @param options Additional options passed to the parent class.
   */
  constructor(downstreamPushFrame: PushFrameFn, options: FrameProcessorOptions = {}) {
    super({ ...options, enableDirectMode: true });
    this._downstreamPushFrame = downstreamPushFrame;
  }

  /**
   * Process frames and route them based on direction.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    switch (direction) {
      case FrameDirection.UPSTREAM:
        await this.pushFrame(frame, direction);
        break;
      case FrameDirection.DOWNSTREAM:
        await this._downstreamPushFrame(frame, direction);
        break;
    }
  }
}

export interface PipelineOptions {
  /** An optional pipeline source processor. */
  source?: FrameProcessor | null;
  /** An optional pipeline sink processor. */
  sink?: FrameProcessor | null;
}

/**
 * Main pipeline implementation that connects frame processors in sequence.
 *
 * Creates a linear chain of frame processors with automatic source and sink
 * processors for external frame handling. Manages processor lifecycle and
 * provides metrics collection from contained processors.
 */
export class Pipeline extends BasePipeline {
  protected _source: FrameProcessor;
  protected _sink: FrameProcessor;
  protected _processors: FrameProcessor[];

  /**
   * Initialize the pipeline with a list of processors.
   *
   * @param processors Sequence of frame processors to connect in sequence.
   * @param options.source An optional pipeline source processor.
   * @param options.sink An optional pipeline sink processor.
   */
  constructor(processors: readonly FrameProcessor[], options: PipelineOptions = {}) {
    super({ enableDirectMode: true });

    // Add a source and a sink queue so we can forward frames upstream and
    // downstream outside of the pipeline.
    this._source =
      options.source ||
      new PipelineSource((frame, direction) => this.pushFrame(frame, direction), {
        name: `${this}::Source`,
      });
    this._sink =
      options.sink ||
      new PipelineSink((frame, direction) => this.pushFrame(frame, direction), {
        name: `${this}::Sink`,
      });
    this._processors = [this._source, ...processors, this._sink];

    this._linkProcessors();
  }

  //
  // Frame processor
  //

  /**
   * The list of sub-processors contained within this processor.
   *
   * Only compound processors (e.g. pipelines and parallel pipelines) have
   * sub-processors. Non-compound processors return an empty list.
   */
  override get processors(): FrameProcessor[] {
    return this._processors;
  }

  /**
   * The list of entry processors for this processor.
   *
   * Entry processors are the first processors in a compound processor (e.g.
   * pipelines, parallel pipelines). Note that pipelines can also be an entry
   * processor as pipelines are processors themselves. Non-compound processors
   * simply return an empty list.
   */
  override get entryProcessors(): FrameProcessor[] {
    return [this._source];
  }

  /**
   * Processors that can generate metrics.
   *
   * Recursively collects all processors that support metrics generation,
   * including those from nested pipelines.
   */
  override processorsWithMetrics(): FrameProcessor[] {
    const services: FrameProcessor[] = [];
    for (const p of this.processors) {
      if (p.canGenerateMetrics()) {
        services.push(p);
      }
      services.push(...p.processorsWithMetrics());
    }
    return services;
  }

  /**
   * Set up the pipeline and all contained processors.
   *
   * @param setup Configuration for frame processor setup.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // This pipeline is set up, so let the StartFrame in: each processor holds
    // it until its own setup is done.
    this._setupFinished();
    await this._setupProcessors(this._processors, setup);
  }

  /** Clean up the pipeline and all contained processors. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cleanupProcessors(this._processors);
  }

  /**
   * Process frames by routing them through the pipeline.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (direction === FrameDirection.DOWNSTREAM) {
      await this._source.queueFrame(frame, FrameDirection.DOWNSTREAM);
    } else if (direction === FrameDirection.UPSTREAM) {
      await this._sink.queueFrame(frame, FrameDirection.UPSTREAM);
    }
  }

  /** Link all processors in sequence and set their parent. */
  protected _linkProcessors(): void {
    let prev = this._processors[0] as FrameProcessor;
    for (const curr of this._processors.slice(1)) {
      prev.link(curr);
      prev = curr;
    }
  }
}
