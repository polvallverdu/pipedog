// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/startup_timing_observer.py

/**
 * Observer for tracking pipeline startup timing.
 *
 * This module provides an observer that measures how long each processor
 * takes during pipeline startup (i.e. setup() and `StartFrame`). It works by
 * tracking `setup()` time and when the `StartFrame` arrives at a processor
 * (`onProcessFrame`) versus when it leaves (`onPushFrame`), giving the exact
 * `start()` duration for each processor in the pipeline.
 *
 * It also measures transport timing — the time from before `setup()` to the
 * first `BotConnectedFrame` (SFU transports only) and `ClientConnectedFrame` —
 * via a separate `on_transport_timing_report` event.
 *
 * @example
 * const observer = new StartupTimingObserver();
 *
 * observer.eventHandler("on_startup_timing_report", async (observer, report) => {
 *   for (const t of report.processorTimings) {
 *     console.log(`${t.processorName}: ${t.durationSecs.toFixed(3)}s`);
 *   }
 * });
 *
 * observer.eventHandler("on_transport_timing_report", async (observer, report) => {
 *   if (report.botConnectedSecs !== null) {
 *     console.log(`Bot connected in ${report.botConnectedSecs.toFixed(3)}s`);
 *   }
 *   console.log(`Client connected in ${report.clientConnectedSecs?.toFixed(3)}s`);
 * });
 *
 * const worker = new PipelineWorker(pipeline, { observers: [observer] });
 */

import { monotonicNs, time } from "@pipedog/asyncio";
import { BotConnectedFrame, ClientConnectedFrame, StartFrame } from "../frames/frames.ts";
import { BasePipeline } from "../pipeline/base_pipeline.ts";
import { PipelineSource } from "../pipeline/pipeline.ts";
import type { FrameProcessor } from "../processors/frame_processor.ts";
import type { BaseTaskManager } from "../utils/asyncio/task_manager.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  type FrameProcessed,
  type FramePushed,
  type ProcessorSetUp,
} from "./base_observer.ts";

export type FrameProcessorClass = abstract new (...args: any[]) => FrameProcessor;

// Internal pipeline types excluded from tracking by default.
const INTERNAL_TYPES: readonly FrameProcessorClass[] = [PipelineSource, BasePipeline];

/** Captured once when the first StartFrame arrives at a processor. */
interface StartFrameInfo {
  frameId: number;
  arrivalNs: number;
  wallClock: number;
}

/** Internal record of when a StartFrame arrived at a processor. */
interface ArrivalInfo {
  processor: FrameProcessor;
  arrivalTsNs: number;
}

export interface ProcessorStartupTimingOptions {
  /** The name of the processor. */
  processorName: string;
  /** Offset in seconds from the StartFrame to when this processor's start() began. */
  startOffsetSecs: number;
  /** What the processor cost to get ready, in seconds: its setup() and start() together. */
  durationSecs: number;
  /** How long the processor's setup() took, in seconds. */
  setupDurationSecs: number;
  /** How long the processor spent on the StartFrame, in seconds. */
  startDurationSecs?: number;
}

/**
 * Startup timing for a single processor.
 *
 * - `processorName`: the name of the processor.
 * - `startOffsetSecs`: offset in seconds from the StartFrame to when this
 *   processor's start() began.
 * - `durationSecs`: what the processor cost to get ready, in seconds: its
 *   setup() and its start() together.
 * - `setupDurationSecs`: how long the processor's setup() took, in seconds.
 *   Processors are set up concurrently, so this overlaps every other
 *   processor's and only the longest of them holds up the pipeline.
 * - `startDurationSecs`: how long the processor spent on the StartFrame, in
 *   seconds. The frame reaches processors one after another, so this adds to
 *   what every other processor spent rather than overlapping it.
 */
export class ProcessorStartupTiming {
  processorName: string;
  startOffsetSecs: number;
  durationSecs: number;
  setupDurationSecs: number;
  startDurationSecs: number;

  constructor(options: ProcessorStartupTimingOptions) {
    this.processorName = options.processorName;
    this.startOffsetSecs = options.startOffsetSecs;
    this.durationSecs = options.durationSecs;
    this.setupDurationSecs = options.setupDurationSecs;
    this.startDurationSecs = options.startDurationSecs ?? 0.0;
  }
}

export interface StartupTimingReportOptions {
  /** Unix timestamp when the pipeline began setting up. */
  startTime: number;
  /** Wall-clock time from the pipeline starting to set up until it had started. */
  totalDurationSecs: number;
  /** How long getting every processor ready took, in seconds. */
  setupPhaseSecs?: number;
  /** How long the StartFrame took to travel the pipeline, in seconds. */
  startPhaseSecs?: number;
  /** Per-processor timing data, in pipeline order. */
  processorTimings?: ProcessorStartupTiming[];
}

/**
 * Report of startup timings for all measured processors.
 *
 * - `startTime`: Unix timestamp when the pipeline began setting up.
 * - `totalDurationSecs`: wall-clock time from the pipeline starting to set up
 *   until it had started, which is `setupPhaseSecs` and `startPhaseSecs` back
 *   to back.
 * - `setupPhaseSecs`: how long getting every processor ready took, in
 *   seconds. Setting up runs concurrently, so the longest single processor
 *   decides this rather than their sum.
 * - `startPhaseSecs`: how long the StartFrame took to travel the pipeline, in
 *   seconds. It reaches processors one after another, so what each spends on
 *   it adds up.
 * - `processorTimings`: per-processor timing data, in pipeline order.
 */
export class StartupTimingReport {
  startTime: number;
  totalDurationSecs: number;
  setupPhaseSecs: number;
  startPhaseSecs: number;
  processorTimings: ProcessorStartupTiming[];

  constructor(options: StartupTimingReportOptions) {
    this.startTime = options.startTime;
    this.totalDurationSecs = options.totalDurationSecs;
    this.setupPhaseSecs = options.setupPhaseSecs ?? 0.0;
    this.startPhaseSecs = options.startPhaseSecs ?? 0.0;
    this.processorTimings = options.processorTimings ?? [];
  }
}

export interface TransportTimingReportOptions {
  /** Unix timestamp when the pipeline began setting up. */
  startTime: number;
  /** Seconds until the first BotConnectedFrame (only set for SFU transports). */
  botConnectedSecs?: number | null;
  /** Seconds until the first ClientConnectedFrame. */
  clientConnectedSecs?: number | null;
}

/**
 * Time from pipeline start to transport connection milestones.
 *
 * - `startTime`: Unix timestamp when the pipeline began setting up.
 * - `botConnectedSecs`: seconds from the pipeline starting to set up until
 *   the first BotConnectedFrame (only set for SFU transports).
 * - `clientConnectedSecs`: seconds from the pipeline starting to set up until
 *   the first ClientConnectedFrame.
 */
export class TransportTimingReport {
  startTime: number;
  botConnectedSecs: number | null;
  clientConnectedSecs: number | null;

  constructor(options: TransportTimingReportOptions) {
    this.startTime = options.startTime;
    this.botConnectedSecs = options.botConnectedSecs ?? null;
    this.clientConnectedSecs = options.clientConnectedSecs ?? null;
  }
}

export interface StartupTimingObserverOptions extends BaseObserverOptions {
  /**
   * Optional processor types to measure. If null, all non-internal processors
   * are measured.
   */
  processorTypes?: readonly FrameProcessorClass[] | null;
}

/**
 * Observer that measures processor startup times during pipeline initialization.
 *
 * Tracks what each processor costs to get ready: its `setup()` and its
 * `start()` together, the latter measured from the `StartFrame` arriving at
 * the processor to it being pushed downstream. This captures WebSocket
 * connections, API authentication, model loading, and other initialization
 * work, most of which happens while the processor is being set up.
 *
 * Also measures transport timing, the time from the pipeline starting to set
 * up until each connection milestone. A transport connects while it is set
 * up, so these can be reached before the `StartFrame` is pushed:
 *
 * - `botConnectedSecs`: when the bot joins the transport room (SFU
 *   transports only, triggered by `BotConnectedFrame`).
 * - `clientConnectedSecs`: when a remote participant connects (triggered by
 *   `ClientConnectedFrame`).
 *
 * By default, internal pipeline processors (`PipelineSource`, `Pipeline`) are
 * excluded from the report. Pass `processorTypes` to measure only specific
 * types.
 *
 * Event handlers available:
 *
 * - on_startup_timing_report: called once after startup completes with the
 *   full timing report.
 * - on_transport_timing_report: called once when the first client connects
 *   with a TransportTimingReport containing clientConnectedSecs and
 *   botConnectedSecs (if available).
 *
 * @example
 * const observer = new StartupTimingObserver({ processorTypes: [STTService, TTSService] });
 *
 * observer.eventHandler("on_startup_timing_report", async (observer, report) => {
 *   for (const t of report.processorTimings) {
 *     logger.info(`${t.processorName}: ${t.durationSecs.toFixed(3)}s`);
 *   }
 * });
 */
export class StartupTimingObserver extends BaseObserver {
  protected _processorTypes: readonly FrameProcessorClass[] | null;

  // Map processor ID -> arrival info.
  protected _arrivals = new Map<number, ArrivalInfo>();

  // Collected timings in pipeline order.
  protected _timings: ProcessorStartupTiming[] = [];

  // Captured once when the first StartFrame arrives.
  protected _startFrame: StartFrameInfo | null = null;

  // When the pipeline began setting up, i.e. before any processor connected,
  // and how long each processor's setup() took.
  protected _setupStartedNs = 0;
  protected _setupWallClock = 0.0;
  protected _setupFinishedNs = 0;
  protected _setupDurations = new Map<number, number>();

  // Whether we've already emitted the startup timing report.
  protected _startupTimingReported = false;

  // Whether we've already measured transport timing.
  protected _transportTimingReported = false;

  // Bot connected timing (stored for inclusion in the transport report).
  protected _botConnectedSecs: number | null = null;

  /** Initialize the startup timing observer. */
  constructor(options: StartupTimingObserverOptions = {}) {
    super(options);
    this._processorTypes = options.processorTypes ?? null;

    this._registerEventHandler("on_startup_timing_report");
    this._registerEventHandler("on_transport_timing_report");
  }

  /**
   * Start the clock, before any processor has been set up.
   *
   * Processors connect while they are being set up, so startup begins here
   * rather than at the StartFrame.
   *
   * @param taskManager The task manager to run tasks on.
   */
  override async setup(taskManager: BaseTaskManager | unknown): Promise<void> {
    await super.setup(taskManager);
    this._setupStartedNs = monotonicNs();
    this._setupWallClock = time();
  }

  /**
   * Record how long a processor's setup() took.
   *
   * @param data The processor setup event data.
   */
  override async onProcessorSetup(data: ProcessorSetUp): Promise<void> {
    if (this._startupTimingReported) {
      return;
    }

    // Setting up runs concurrently, so the last processor to finish is what
    // ends the phase. Filtered-out processors still hold it open, so they
    // count here.
    this._setupFinishedNs = Math.max(this._setupFinishedNs, data.finishedAtNs);

    if (!this._shouldTrack(data.processor)) {
      return;
    }

    this._setupDurations.set(data.processor.id, (data.finishedAtNs - data.startedAtNs) / 1e9);
  }

  /**
   * Check if a processor should be tracked for timing.
   *
   * @param processor The processor to check.
   * @returns True if the processor matches the filter or no filter is set.
   */
  protected _shouldTrack(processor: FrameProcessor): boolean {
    if (this._processorTypes !== null) {
      return this._processorTypes.some((t) => processor instanceof t);
    }
    // Default: exclude internal pipeline plumbing.
    return !INTERNAL_TYPES.some((t) => processor instanceof t);
  }

  /**
   * Emit the startup timing report when the pipeline has fully started.
   *
   * Called by the `PipelineWorker` after the `StartFrame` has been processed
   * by all processors, including nested `ParallelPipeline` branches.
   */
  override async onPipelineStarted(): Promise<void> {
    if (this._timings.length > 0) {
      await this._emitReport();
    }
  }

  /**
   * Record when a StartFrame arrives at a processor.
   *
   * @param data The frame processing event data.
   */
  override async onProcessFrame(data: FrameProcessed): Promise<void> {
    if (this._startupTimingReported) {
      return;
    }

    if (!(data.frame instanceof StartFrame)) {
      return;
    }

    // Lock onto the first StartFrame.
    if (this._startFrame === null) {
      this._startFrame = {
        frameId: data.frame.id,
        arrivalNs: data.timestamp,
        wallClock: time(),
      };
    } else if (data.frame.id !== this._startFrame.frameId) {
      return;
    }

    if (this._shouldTrack(data.processor)) {
      this._arrivals.set(data.processor.id, {
        processor: data.processor,
        arrivalTsNs: data.timestamp,
      });
    }
  }

  /**
   * Record when a StartFrame leaves a processor and compute the delta.
   *
   * Also handles `BotConnectedFrame` and `ClientConnectedFrame` to measure
   * transport timing.
   *
   * @param data The frame push event data.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.frame instanceof BotConnectedFrame) {
      this._handleBotConnected(data);
      return;
    }

    if (data.frame instanceof ClientConnectedFrame) {
      await this._handleClientConnected(data);
      return;
    }

    if (this._startupTimingReported) {
      return;
    }

    if (!(data.frame instanceof StartFrame)) {
      return;
    }

    if (this._startFrame !== null && data.frame.id !== this._startFrame.frameId) {
      return;
    }

    const arrival = this._arrivals.get(data.source.id);
    this._arrivals.delete(data.source.id);
    if (arrival === undefined || this._startFrame === null) {
      return;
    }

    const durationNs = data.timestamp - arrival.arrivalTsNs;
    const durationSecs = durationNs / 1e9;
    const startOffsetSecs = (arrival.arrivalTsNs - this._startFrame.arrivalNs) / 1e9;

    const setupDurationSecs = this._setupDurations.get(arrival.processor.id) ?? 0.0;

    this._timings.push(
      new ProcessorStartupTiming({
        processorName: arrival.processor.name,
        startOffsetSecs,
        // What the processor cost overall: it connects while being set up,
        // and start() is whatever is left to do once it has.
        durationSecs: setupDurationSecs + durationSecs,
        setupDurationSecs,
        startDurationSecs: durationSecs,
      }),
    );
  }

  /** Record bot connected timing on first BotConnectedFrame. */
  protected _handleBotConnected(data: FramePushed): void {
    if (this._botConnectedSecs !== null) {
      return;
    }

    this._botConnectedSecs = data.timestamp / 1e9;
  }

  /** Emit transport timing report on first ClientConnectedFrame. */
  protected async _handleClientConnected(data: FramePushed): Promise<void> {
    if (this._transportTimingReported) {
      return;
    }

    this._transportTimingReported = true;
    const clientConnectedSecs = data.timestamp / 1e9;
    const report = new TransportTimingReport({
      // Both offsets are elapsed pipeline-clock time, which starts before this
      // observer does, so the wall clock they are offsets from comes from the
      // same clock rather than from a second reading of its own.
      startTime: time() - clientConnectedSecs,
      botConnectedSecs: this._botConnectedSecs,
      clientConnectedSecs,
    });
    await this._callEventHandler("on_transport_timing_report", report);
  }

  /** Build and emit the startup timing report. */
  protected async _emitReport(): Promise<void> {
    if (this._startupTimingReported) {
      return;
    }
    this._startupTimingReported = true;

    // Processors are set up concurrently, so what they cost does not add up
    // to wall-clock time. Report the span instead.
    const total = (monotonicNs() - this._setupStartedNs) / 1e9;

    // Getting ready ends with the last processor to finish connecting. What
    // follows is the StartFrame travelling the pipeline.
    const setupPhaseEndNs = this._setupFinishedNs;
    let setupPhaseSecs = Math.max(0, setupPhaseEndNs - this._setupStartedNs) / 1e9;
    setupPhaseSecs = Math.min(setupPhaseSecs, total);

    const report = new StartupTimingReport({
      startTime: this._setupWallClock,
      totalDurationSecs: total,
      setupPhaseSecs,
      startPhaseSecs: total - setupPhaseSecs,
      processorTimings: this._timings,
    });

    await this._callEventHandler("on_startup_timing_report", report);
  }
}
