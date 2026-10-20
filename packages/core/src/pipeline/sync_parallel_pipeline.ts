// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/sync_parallel_pipeline.py

/**
 * Synchronized parallel pipeline that holds output until all branches finish.
 *
 * A SyncParallelPipeline fans each inbound frame out to multiple parallel
 * pipelines and waits for every pipeline to finish processing before releasing
 * any of the resulting output frames. This ensures that all frames produced in
 * response to a single input frame are emitted together.
 *
 * System frames (except EndFrame) are exempt from this synchronization — they
 * pass straight through without waiting, since they are expected to race
 * ahead of regular data frames.
 */

import { gather, Queue } from "@pipedog/asyncio";
import { ControlFrame, EndFrame, type Frame, StartFrame, SystemFrame } from "../frames/frames.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { logger } from "../utils/logger.ts";
import { BasePipeline } from "./base_pipeline.ts";
import { Pipeline } from "./pipeline.ts";

/**
 * Controls the order in which synchronized frames are pushed downstream.
 *
 * When multiple parallel pipelines produce output for the same input frame,
 * this setting determines the order in which those output frames are pushed.
 *
 * - ARRIVAL: frames are pushed in the order they arrive from any pipeline.
 *   This is the default and matches the behavior of prior versions.
 * - PIPELINE: frames are pushed in pipeline definition order — all frames from
 *   the first pipeline are pushed, then all frames from the second pipeline,
 *   and so on. Useful when the relative ordering between pipelines matters
 *   (e.g. ensuring image frames precede audio frames).
 */
export const FrameOrder = {
  ARRIVAL: "arrival",
  PIPELINE: "pipeline",
} as const;
export type FrameOrder = (typeof FrameOrder)[keyof typeof FrameOrder];

/**
 * Sentinel frame used to detect when a parallel pipeline has finished processing.
 *
 * After sending a real frame into a parallel pipeline, a SyncFrame is sent
 * behind it. When the SyncFrame emerges from the pipeline's output, we know
 * all output frames for the preceding input have been produced.
 */
export class SyncFrame extends ControlFrame {}

/**
 * Bookend processor placed at the start of each parallel pipeline.
 *
 * Forwards downstream frames into the pipeline and captures upstream frames
 * into a queue so the parent SyncParallelPipeline can release them later.
 */
export class SyncParallelPipelineSource extends FrameProcessor {
  protected _upQueue: Queue<Frame>;

  /**
   * Initialize the sync parallel pipeline source.
   *
   * @param upstreamQueue Queue for collecting upstream frames from the pipeline.
   */
  constructor(upstreamQueue: Queue<Frame>) {
    super({ enableDirectMode: true });
    this._upQueue = upstreamQueue;
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
        await this._upQueue.put(frame);
        break;
      case FrameDirection.DOWNSTREAM:
        await this.pushFrame(frame, direction);
        break;
    }
  }
}

/**
 * Bookend processor placed at the end of each parallel pipeline.
 *
 * Captures downstream output frames into a queue so the parent
 * SyncParallelPipeline can release them later, and forwards upstream frames
 * back through the pipeline.
 */
export class SyncParallelPipelineSink extends FrameProcessor {
  protected _downQueue: Queue<Frame>;

  /**
   * Initialize the sync parallel pipeline sink.
   *
   * @param downstreamQueue Queue for collecting downstream frames from the pipeline.
   */
  constructor(downstreamQueue: Queue<Frame>) {
    super({ enableDirectMode: true });
    this._downQueue = downstreamQueue;
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
        await this._downQueue.put(frame);
        break;
    }
  }
}

/** A bookend processor and the queue its pipeline's output lands in. */
interface Bookend {
  processor: FrameProcessor;
  queue: Queue<Frame>;
}

export interface SyncParallelPipelineOptions {
  /**
   * Controls the order in which synchronized output frames are pushed.
   * `FrameOrder.ARRIVAL` (default) pushes frames in the order they arrive.
   * `FrameOrder.PIPELINE` pushes all frames from the first pipeline before the
   * second, and so on.
   */
  frameOrder?: FrameOrder;
}

/**
 * Fans each input frame to parallel pipelines then holds output until every
 * pipeline finishes.
 *
 * For each inbound frame the pipeline:
 *
 * 1. Sends the frame into every parallel pipeline.
 * 2. Sends a `SyncFrame` sentinel behind it in each pipeline.
 * 3. Waits until every pipeline has produced its `SyncFrame`, meaning all
 *    output for that input is ready.
 * 4. Releases the collected output frames (deduplicating by frame id, since
 *    the same frame may emerge from more than one branch).
 *
 * System frames (except `EndFrame`) bypass this mechanism entirely — they are
 * forwarded through each pipeline and pushed immediately, since system frames
 * are expected to race ahead of regular data frames.
 *
 * By default, output frames are pushed in the order they arrive from any
 * pipeline (`FrameOrder.ARRIVAL`). Set `frameOrder: FrameOrder.PIPELINE` to
 * push frames in pipeline definition order instead — all output from the
 * first pipeline, then the second, and so on.
 *
 * @example
 * new SyncParallelPipeline([imageGen], [tts], { frameOrder: FrameOrder.PIPELINE });
 */
export class SyncParallelPipeline extends BasePipeline {
  protected _frameOrder: FrameOrder;
  protected _sinks: Bookend[] = [];
  protected _sources: Bookend[] = [];
  protected _pipelines: Pipeline[] = [];

  protected _upQueue = new Queue<Frame>();
  protected _downQueue = new Queue<Frame>();

  /**
   * Initialize the synchronous parallel pipeline.
   *
   * @param args Variable number of processor lists, each representing a
   *   parallel pipeline path, optionally followed by an options object.
   * @throws Error If no arguments are provided.
   * @throws TypeError If any argument is not a list of processors.
   */
  constructor(...args: [...FrameProcessor[][], SyncParallelPipelineOptions] | FrameProcessor[][]) {
    super();

    let options: SyncParallelPipelineOptions = {};
    let lists: unknown[] = args;
    const last = args[args.length - 1];
    if (last !== undefined && !Array.isArray(last)) {
      options = last as SyncParallelPipelineOptions;
      lists = args.slice(0, -1);
    }
    this._frameOrder = options.frameOrder ?? FrameOrder.ARRIVAL;

    if (lists.length === 0) {
      throw new Error("SyncParallelPipeline needs at least one argument");
    }

    logger.debug(`Creating ${this} pipelines`);
    for (const processors of lists) {
      if (!Array.isArray(processors)) {
        throw new TypeError(`SyncParallelPipeline argument ${processors} is not a list`);
      }

      // We add a source at the beginning of the pipeline and a sink at the end.
      const upQueue = new Queue<Frame>();
      const downQueue = new Queue<Frame>();
      const source = new SyncParallelPipelineSource(upQueue);
      const sink = new SyncParallelPipelineSink(downQueue);

      // Keep track of sources and sinks. We also keep the output queue of the
      // source and the sinks so we can use it later.
      this._sources.push({ processor: source, queue: downQueue });
      this._sinks.push({ processor: sink, queue: upQueue });

      // Create pipeline
      const pipeline = new Pipeline(processors as FrameProcessor[], { source, sink });
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
    return this._sources.map((s) => s.processor);
  }

  /**
   * Collect processors that can generate metrics from all parallel pipelines.
   *
   * @returns Frame processors that support metrics collection from all parallel paths.
   */
  override processorsWithMetrics(): FrameProcessor[] {
    return this._pipelines.flatMap((p) => p.processorsWithMetrics());
  }

  /**
   * Set up the parallel pipeline and all contained processors.
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

  /** Clean up the parallel pipeline and all contained processors. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cleanupProcessors(this._pipelines);
  }

  /**
   * Send a frame through all parallel pipelines and release output once all finish.
   *
   * System frames (except EndFrame) skip synchronization and pass straight
   * through. All other frames are fanned out to every pipeline, and output is
   * held until every pipeline signals completion (via SyncFrame).
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame && direction === FrameDirection.DOWNSTREAM) {
      await this._startPipelines(frame);
      return;
    }

    // SystemFrames are simply passed through all internal pipelines without
    // draining queued output. This avoids the race condition where a
    // SystemFrame's waitForSync steals frames from a concurrent
    // non-SystemFrame's waitForSync.
    if (frame instanceof SystemFrame) {
      if (direction === FrameDirection.UPSTREAM) {
        for (const s of this._sinks) {
          await s.processor.processFrame(frame, direction);
        }
      } else if (direction === FrameDirection.DOWNSTREAM) {
        for (const s of this._sources) {
          await s.processor.processFrame(frame, direction);
        }
      }
      await this.pushFrame(frame, direction);
      return;
    }

    const usePipelineOrder = this._frameOrder === FrameOrder.PIPELINE;

    // The last processor of each pipeline needs to be synchronous otherwise
    // this element won't work. Since we know it should be synchronous we push
    // a SyncFrame. Since frames are ordered we know this frame will be pushed
    // after the synchronous processor has pushed its data allowing us to
    // synchronize all the internal pipelines by waiting for the SyncFrame in
    // all of them.
    //
    // In ARRIVAL mode, output frames are put onto a shared mainQueue as they
    // arrive. In PIPELINE mode, they are accumulated in a per-pipeline list
    // and returned so the caller can drain them in definition order.
    const waitForSync = async (
      obj: Bookend,
      mainQueue: Queue<Frame>,
      frame: Frame,
      direction: FrameDirection,
    ): Promise<Frame[]> => {
      const processor = obj.processor;
      const queue = obj.queue;
      const outputFrames: Frame[] = [];

      await processor.processFrame(frame, direction);

      if (frame instanceof EndFrame) {
        let newFrame = await queue.get();
        if (newFrame instanceof EndFrame) {
          if (usePipelineOrder) {
            outputFrames.push(newFrame);
          } else {
            await mainQueue.put(newFrame);
          }
        } else {
          while (!(newFrame instanceof EndFrame)) {
            if (usePipelineOrder) {
              outputFrames.push(newFrame);
            } else {
              await mainQueue.put(newFrame);
            }
            queue.taskDone();
            newFrame = await queue.get();
          }
        }
      } else {
        await processor.processFrame(new SyncFrame(), direction);
        let newFrame = await queue.get();
        while (!(newFrame instanceof SyncFrame)) {
          if (usePipelineOrder) {
            outputFrames.push(newFrame);
          } else {
            await mainQueue.put(newFrame);
          }
          queue.taskDone();
          newFrame = await queue.get();
        }
      }

      return outputFrames;
    };

    let framesPerPipeline: Frame[][] = [];
    if (direction === FrameDirection.UPSTREAM) {
      // If we get an upstream frame we process it in each sink.
      framesPerPipeline = (await gather(
        ...this._sinks.map((s) => () => waitForSync(s, this._upQueue, frame, direction)),
      )) as Frame[][];
    } else if (direction === FrameDirection.DOWNSTREAM) {
      // If we get a downstream frame we process it in each source.
      framesPerPipeline = (await gather(
        ...this._sources.map((s) => () => waitForSync(s, this._downQueue, frame, direction)),
      )) as Frame[][];
    }

    if (usePipelineOrder) {
      // Push frames in pipeline definition order, deduplicating by id.
      const seenIds = new Set<number>();
      for (const pipelineFrames of framesPerPipeline) {
        for (const f of pipelineFrames) {
          if (!seenIds.has(f.id)) {
            await this.pushFrame(f, direction);
            seenIds.add(f.id);
          }
        }
      }
    } else {
      // ARRIVAL mode: drain the shared queues in the order frames arrived.
      let seenIds = new Set<number>();
      while (!this._upQueue.empty()) {
        const f = await this._upQueue.get();
        if (!seenIds.has(f.id)) {
          await this.pushFrame(f, FrameDirection.UPSTREAM);
          seenIds.add(f.id);
        }
        this._upQueue.taskDone();
      }

      seenIds = new Set<number>();
      while (!this._downQueue.empty()) {
        const f = await this._downQueue.get();
        if (!seenIds.has(f.id)) {
          await this.pushFrame(f, FrameDirection.DOWNSTREAM);
          seenIds.add(f.id);
        }
        this._downQueue.taskDone();
      }
    }
  }

  /** Start every pipeline, then pass the StartFrame on once it is through all of them. */
  protected async _startPipelines(frame: StartFrame): Promise<void> {
    await gather(
      ...this._pipelines.map(
        (pipeline, i) => () =>
          this._startPipeline(pipeline, (this._sources[i] as Bookend).queue, frame),
      ),
    );
    await this.pushFrame(frame);
  }

  /** Push the StartFrame into a pipeline and wait for it to come out of the pipeline's sink. */
  protected async _startPipeline(
    pipeline: Pipeline,
    queue: Queue<Frame>,
    frame: StartFrame,
  ): Promise<void> {
    // Into the pipeline rather than straight to its source, so the pipeline
    // and each of its processors hold it until they are set up.
    await pipeline.queueFrame(frame);
    await queue.get();
  }
}
