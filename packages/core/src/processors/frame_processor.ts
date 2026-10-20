// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/frame_processor.py

/**
 * Frame processing pipeline infrastructure for Pipecat.
 *
 * Provides the core frame processing system that enables building
 * audio/video processing pipelines: frame processors, pipeline management,
 * and frame flow control mechanisms.
 */

import {
  Event,
  PriorityQueue,
  pythonCompare,
  rethrowIfCancelled,
  type Task,
  TimeoutError,
  waitFor,
} from "@pipecat-ts/asyncio";
import type { BaseClock } from "../clocks/base_clock.ts";
import {
  CancelFrame,
  ErrorFrame,
  type Frame,
  FrameProcessorPauseFrame,
  FrameProcessorPauseUrgentFrame,
  FrameProcessorResumeFrame,
  FrameProcessorResumeUrgentFrame,
  InterruptionFrame,
  renewFrameIdentity,
  StartFrame,
  SystemFrame,
  type TTSAudioRawFrame,
} from "../frames/frames.ts";
import type { LLMTokenUsage, MetricsData, STTUsage } from "../metrics/metrics.ts";
import { type BaseObserver, FrameProcessed, FramePushed } from "../observers/base_observer.ts";
import type { PipelineWorker } from "../pipeline/worker.ts";
import type { BaseTaskManager, EventLoop } from "../utils/asyncio/task_manager.ts";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";
import { ErrorCategory, classifyHttpException } from "../utils/errors.ts";
import { type FrameClass, FrameQueue } from "../utils/frame_queue.ts";
import { logger } from "../utils/logger.ts";
import type { TracingContext } from "../utils/tracing/tracing_context.ts";
import type { WorkerRunner } from "../workers/runner.ts";
import { FrameProcessorMetrics } from "./metrics/frame_processor_metrics.ts";

/**
 * Direction of frame flow in the processing pipeline.
 *
 * - DOWNSTREAM: frames flowing from input to output.
 * - UPSTREAM: frames flowing back from output to input.
 */
export const FrameDirection = {
  DOWNSTREAM: 1,
  UPSTREAM: 2,
} as const;
export type FrameDirection = (typeof FrameDirection)[keyof typeof FrameDirection];

export type FrameCallback = (
  processor: FrameProcessor,
  frame: Frame,
  direction: FrameDirection,
) => Promise<void>;

export interface FrameProcessorSetupOptions {
  clock: BaseClock;
  taskManager: BaseTaskManager;
  pipelineWorker: PipelineWorker | null;
  audioInSampleRate?: number;
  audioOutSampleRate?: number;
  enableMetrics?: boolean;
  enableTracing?: boolean;
  enableUsageMetrics?: boolean;
  observer?: BaseObserver | null;
  reportOnlyInitialTtfb?: boolean;
  tracingContext?: TracingContext | null;
}

/**
 * Configuration parameters for frame processor initialization.
 *
 * - `audioInSampleRate` / `audioOutSampleRate`: audio sample rates in Hz.
 * - `clock`: the clock instance for timing operations.
 * - `enableMetrics` / `enableTracing` / `enableUsageMetrics`: feature switches.
 * - `pipelineWorker`: the PipelineWorker running this pipeline, so processors
 *   can reach worker-scoped state (e.g. `this.pipelineWorker.appResources`).
 * - `observer`: optional observer for monitoring frame processing events.
 * - `taskManager`: the task manager for handling async operations.
 * - `tracingContext`: pipeline-scoped tracing context for span hierarchy.
 */
export class FrameProcessorSetup {
  clock: BaseClock;
  taskManager: BaseTaskManager;
  pipelineWorker: PipelineWorker | null;
  audioInSampleRate: number;
  audioOutSampleRate: number;
  enableMetrics: boolean;
  enableTracing: boolean;
  enableUsageMetrics: boolean;
  observer: BaseObserver | null;
  reportOnlyInitialTtfb: boolean;
  tracingContext: TracingContext | null;

  constructor(options: FrameProcessorSetupOptions) {
    this.clock = options.clock;
    this.taskManager = options.taskManager;
    this.pipelineWorker = options.pipelineWorker;
    this.audioInSampleRate = options.audioInSampleRate ?? 16000;
    this.audioOutSampleRate = options.audioOutSampleRate ?? 24000;
    this.enableMetrics = options.enableMetrics ?? false;
    this.enableTracing = options.enableTracing ?? false;
    this.enableUsageMetrics = options.enableUsageMetrics ?? false;
    this.observer = options.observer ?? null;
    this.reportOnlyInitialTtfb = options.reportOnlyInitialTtfb ?? false;
    this.tracingContext = options.tracingContext ?? null;
  }
}

type QueueItem = [Frame, FrameDirection, FrameCallback | null];
type PriorityItem = [number, number, QueueItem];

/**
 * A priority queue for the frames arriving at a frame processor.
 *
 * Frames are dequeued in three tiers: the StartFrame first, then
 * SystemFrame, then data and control frames. Frames of the same tier keep
 * their arrival order.
 */
export class FrameProcessorQueue {
  static readonly START_PRIORITY = 1;
  static readonly SYSTEM_PRIORITY = 10;
  static readonly DEFAULT_PRIORITY = 20;

  readonly #queue = new PriorityQueue<PriorityItem>(0, (a, b) =>
    pythonCompare([a[0], a[1]], [b[0], b[1]]),
  );
  // Counts every frame enqueued, which keeps frames of the same tier in
  // arrival order and stops the queue from ever having to compare frames.
  #counter = 0;

  /**
   * Put an item into the priority queue. The StartFrame outranks every other
   * frame and SystemFrame frames outrank data and control frames.
   */
  async put(item: QueueItem): Promise<void> {
    const [frame] = item;
    let priority: number;
    if (frame instanceof StartFrame) {
      priority = FrameProcessorQueue.START_PRIORITY;
    } else if (frame instanceof SystemFrame) {
      priority = FrameProcessorQueue.SYSTEM_PRIORITY;
    } else {
      priority = FrameProcessorQueue.DEFAULT_PRIORITY;
    }
    this.#counter += 1;
    await this.#queue.put([priority, this.#counter, item]);
  }

  /** Retrieve the next item from the queue, waiting until one is available. */
  async get(): Promise<QueueItem> {
    const [, , item] = await this.#queue.get();
    return item;
  }

  taskDone(): void {
    this.#queue.taskDone();
  }

  empty(): boolean {
    return this.#queue.empty();
  }

  qsize(): number {
    return this.#queue.qsize();
  }
}

/**
 * How long (seconds) a processor holds frames waiting for a readiness
 * condition before giving up and resuming. See `pauseProcessingAllFramesUntil()`.
 */
export const PAUSE_UNTIL_READY_TIMEOUT_SECS = 5.0;

/**
 * Timeout in seconds for cancelling the input frame processing task. Prevents
 * hanging if some code swallows cancellation.
 */
export const INPUT_TASK_CANCEL_TIMEOUT_SECS = 3;

export interface FrameProcessorOptions extends BaseObjectOptions {
  /** Process frames immediately instead of using internal queues. */
  enableDirectMode?: boolean;
  /** Optional metrics collector for this processor. */
  metrics?: FrameProcessorMetrics | null;
}

/**
 * Base class for all frame processors in the pipeline.
 *
 * Frame processors are the building blocks of Pipecat pipelines. They
 * receive frames, process them, and pass them to the next or previous
 * processor in the chain. Each processor guarantees frame ordering and
 * processes frames in its own task. System frames are processed in a
 * separate task which guarantees frame priority.
 *
 * Event handlers available:
 *
 * - on_before_process_frame: called before a frame is processed
 * - on_after_process_frame: called after a frame is processed
 * - on_before_push_frame: called before a frame is pushed
 * - on_after_push_frame: called after a frame is pushed
 * - on_error: called when an error is raised in the frame processing
 * - on_usable_changed: called with the new value of `isUsable` when the
 *   processor stops or starts being able to do its job
 *
 * @example
 * processor.eventHandler("on_usable_changed", async (processor, isUsable) => { ... });
 */
export class FrameProcessor extends BaseObject {
  protected _prev: FrameProcessor | null = null;
  protected _next: FrameProcessor | null = null;

  // Enable direct mode to skip queues and process frames right away.
  protected _enableDirectMode: boolean;

  // Processor setup
  protected _setup: FrameProcessorSetup | null = null;

  // Cancellation is done through CancelFrame (a system frame). This could
  // cause other events being triggered (e.g. closing a transport) which could
  // also cause other frames to be pushed from other tasks (e.g. EndFrame). So,
  // when we are cancelling we don't want anything else to be pushed.
  protected _cancelling = false;

  // Metrics
  protected _metrics: FrameProcessorMetrics;

  // Processors have an input priority queue which stores any type of frames
  // in order. System frames have higher priority than any other frames, so
  // they will be returned first from the queue.
  //
  // If a system frame is obtained it will be processed immediately; any other
  // type of frame (data and control) will be put in a separate queue for
  // later processing. This guarantees that each frame processor will always
  // process system frames before any other frame in the queue.

  // The input task handles all types of frames. It processes system frames
  // right away and queues non-system frames for later processing.
  #shouldBlockSystemFrames = false;
  readonly #inputQueue = new FrameProcessorQueue();
  #inputEvent: Event | null = null;
  #inputFrameTask: Task<unknown> | null = null;
  // Watches the readiness condition passed to
  // pauseProcessingAllFramesUntil() and lifts the pause it took.
  #pauseWatcherTask: Task<unknown> | null = null;
  // Clear while a pipeline is setting this processor up. The StartFrame is
  // held until it is set, so a processor never starts before its own setup is
  // done, while the ones ahead of it in the pipeline can.
  readonly #setupDone = new Event();
  #startReceived = false;

  // The process task processes non-system frames. Non-system frames will be
  // processed as soon as they are received by the processing task (default)
  // or they will block if `pauseProcessingFrames()` is called. To resume
  // processing frames we need to call `resumeProcessingFrames()` which will
  // wake up the event.
  #shouldBlockFrames = false;
  readonly #processQueue = new FrameQueue<QueueItem>((item) => item[0]);
  #processEvent: Event | null = null;
  #processFrameTask: Task<unknown> | null = null;
  #processCurrentFrame: Frame | null = null;

  // Whether this processor can still do its job. Flipped by the errors it
  // reports, so it is already up to date by the time an error travels.
  protected _isUsable = true;

  constructor(options: FrameProcessorOptions = {}) {
    super(options);
    this._enableDirectMode = options.enableDirectMode ?? false;
    this.#setupDone.set();

    this._metrics = options.metrics ?? new FrameProcessorMetrics();
    this._metrics.setProcessorName(this.name);

    // Frame processor events.
    this._registerEventHandler("on_before_process_frame", true);
    this._registerEventHandler("on_after_process_frame", true);
    this._registerEventHandler("on_before_push_frame", true);
    this._registerEventHandler("on_after_push_frame", true);
    this._registerEventHandler("on_error", true);
    this._registerEventHandler("on_usable_changed");
  }

  /**
   * Whether this processor can still do its job.
   *
   * A processor stays usable through failures it might recover from, and
   * becomes unusable once its work can no longer succeed: a provider has
   * rejected its API key, model or voice, or it has failed enough times to
   * stop trying. Services stop accepting work and stop reconnecting once this
   * is false.
   *
   * Errors set this as they are reported, so an error handler reading
   * `frame.processor.isUsable` sees the verdict that came with the error.
   */
  get isUsable(): boolean {
    return this._isUsable;
  }

  /**
   * Set whether this processor can be given work. Call this to bring back a
   * processor that became unusable, once whatever stopped it working has been
   * dealt with.
   */
  async setUsable(isUsable: boolean): Promise<void> {
    if (isUsable === this._isUsable) return;

    this._isUsable = isUsable;
    logger.debug(`${this}: ${isUsable ? "usable" : "no longer usable"}`);
    await this._callEventHandler("on_usable_changed", isUsable);
  }

  /**
   * The sub-processors contained within this processor. Only compound
   * processors (e.g. pipelines and parallel pipelines) have sub-processors.
   */
  get processors(): FrameProcessor[] {
    return [];
  }

  /**
   * The entry processors for this processor: the first processors in a
   * compound processor. Non-compound processors return an empty list.
   */
  get entryProcessors(): FrameProcessor[] {
    return [];
  }

  /** The next processor, or null. */
  get next(): FrameProcessor | null {
    return this._next;
  }

  /** The previous processor, or null. */
  get previous(): FrameProcessor | null {
    return this._prev;
  }

  /** The configuration this processor was set up with. */
  get processorSetup(): FrameProcessorSetup {
    if (!this._setup) {
      throw new Error(`${this} is still not set up.`);
    }
    return this._setup;
  }

  /** Whether metrics collection is enabled. */
  get metricsEnabled(): boolean {
    return Boolean(this._setup?.enableMetrics);
  }

  /** Whether usage metrics collection is enabled. */
  get usageMetricsEnabled(): boolean {
    return Boolean(this._setup?.enableUsageMetrics);
  }

  /** Whether only the initial TTFB should be reported. */
  get reportOnlyInitialTtfb(): boolean {
    return Boolean(this._setup?.reportOnlyInitialTtfb);
  }

  /**
   * The PipelineWorker this processor is running in. Gives access to
   * worker-scoped state, e.g. `this.pipelineWorker.appResources`.
   */
  get pipelineWorker(): PipelineWorker {
    return this.processorSetup.pipelineWorker as PipelineWorker;
  }

  /**
   * The WorkerRunner hosting this processor's worker. Use it to reach another
   * worker by name, e.g. `this.workerRunner.getWorker("ui-jobs")`.
   */
  get workerRunner(): WorkerRunner {
    return this.pipelineWorker.workerRunner;
  }

  /** Processors that can generate metrics, including nested ones. */
  processorsWithMetrics(): FrameProcessor[] {
    return [];
  }

  /** Whether this processor can generate metrics. */
  canGenerateMetrics(): boolean {
    return false;
  }

  /** Set core metrics data for this processor. */
  setCoreMetricsData(data: MetricsData): void {
    this._metrics.setCoreMetricsData(data);
  }

  /** Start time-to-first-byte metrics collection. */
  async startTtfbMetrics(options: { startTime?: number | null } = {}): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      await this._metrics.startTtfbMetrics({
        startTime: options.startTime ?? null,
        reportOnlyInitialTtfb: this.reportOnlyInitialTtfb,
      });
    }
  }

  /** Abandon the current time-to-first-byte measurement without reporting it. */
  async cancelTtfbMetrics(): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      await this._metrics.cancelTtfbMetrics();
    }
  }

  /** Stop time-to-first-byte metrics collection and push results. */
  async stopTtfbMetrics(options: { endTime?: number | null } = {}): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      const frame = await this._metrics.stopTtfbMetrics({ endTime: options.endTime ?? null });
      if (frame) await this.pushFrame(frame);
    }
  }

  /**
   * Scan a TTS audio frame for the first audible sample and push TTFA.
   * Call for every audio frame until a measurement is produced.
   */
  async processTtfaMetrics(frame: TTSAudioRawFrame): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      const metricsFrame = await this._metrics.processTtfaMetrics({
        audio: frame.audio,
        sampleRate: frame.sampleRate,
        numChannels: frame.numChannels,
      });
      if (metricsFrame) await this.pushFrame(metricsFrame);
    }
  }

  /** Stop time-to-first-answer-token metrics collection and push results. */
  async stopTtfatMetrics(options: { endTime?: number | null } = {}): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      const frame = await this._metrics.stopTtfatMetrics({ endTime: options.endTime ?? null });
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Start processing metrics collection. */
  async startProcessingMetrics(options: { startTime?: number | null } = {}): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      await this._metrics.startProcessingMetrics({ startTime: options.startTime ?? null });
    }
  }

  /** Stop processing metrics collection and push results. */
  async stopProcessingMetrics(options: { endTime?: number | null } = {}): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      const frame = await this._metrics.stopProcessingMetrics({ endTime: options.endTime ?? null });
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Start LLM usage metrics collection. */
  async startLlmUsageMetrics(tokens: LLMTokenUsage): Promise<void> {
    if (this.canGenerateMetrics() && this.usageMetricsEnabled) {
      const frame = await this._metrics.startLlmUsageMetrics(tokens);
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Start STT usage metrics collection. */
  async startSttUsageMetrics(usage: STTUsage): Promise<void> {
    if (this.canGenerateMetrics() && this.usageMetricsEnabled) {
      const frame = await this._metrics.startSttUsageMetrics(usage);
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Start TTS usage metrics collection. */
  async startTtsUsageMetrics(text: string): Promise<void> {
    if (this.canGenerateMetrics() && this.usageMetricsEnabled) {
      const frame = await this._metrics.startTtsUsageMetrics(text);
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Start text aggregation time metrics collection. */
  async startTextAggregationMetrics(): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      await this._metrics.startTextAggregationMetrics();
    }
  }

  /** Stop text aggregation time metrics collection and push results. */
  async stopTextAggregationMetrics(): Promise<void> {
    if (this.canGenerateMetrics() && this.metricsEnabled) {
      const frame = await this._metrics.stopTextAggregationMetrics();
      if (frame) await this.pushFrame(frame);
    }
  }

  /** Stop all active metrics collection. */
  async stopAllMetrics(): Promise<void> {
    await this.stopTtfbMetrics();
    await this.stopProcessingMetrics();
    await this.stopTextAggregationMetrics();
  }

  /**
   * Set up the processor with required components.
   *
   * This is where a processor connects and does its other slow start-up
   * work. A pipeline sets its processors up concurrently, so a resource
   * shared with another processor needs guarding (see `utils/shared`).
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);
    this._setup = setup;

    if (this._metrics) {
      await this._metrics.setup(this.taskManager);
    }
  }

  /** Hold the StartFrame until `_setupFinished` is called. Called by the pipeline before setup. */
  _setupStarted(): void {
    this.#setupDone.clear();
  }

  /** Let this processor start, once its own setup() has returned. */
  _setupFinished(): void {
    this.#setupDone.set();
    this.#maybeCreateInputTask();
  }

  /**
   * Release this processor's resources at teardown.
   *
   * This base implementation cancels only the processor's internal
   * input/process tasks; tasks created via `createTask` are released by an
   * override. Runs concurrently with every other processor's cleanup.
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this.#cancelPauseWatcher();
    await this.#cancelInputTask();
    await this.#cancelProcessTask();
    if (this._metrics) {
      await this._metrics.cleanup();
    }
  }

  /** Link this processor to the next processor in the pipeline. */
  link(processor: FrameProcessor): void {
    this._next = processor;
    processor._prev = this;
    logger.debug(`Linking ${this} -> ${this._next}`);
  }

  /** The clock used by this processor. */
  getClock(): BaseClock {
    return this.processorSetup.clock;
  }

  /** The event loop used by this processor. */
  getEventLoop(): EventLoop {
    return this.taskManager.getEventLoop();
  }

  /** Queue a frame for processing. */
  async queueFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
    callback: FrameCallback | null = null,
  ): Promise<void> {
    // If we are cancelling we don't want to process any other frame.
    if (this._cancelling) return;

    if (this._enableDirectMode) {
      if (frame instanceof StartFrame) {
        await this.#setupDone.wait();
      }
      await this.#processFrame(frame, direction, callback);
      return;
    }

    await this.#inputQueue.put([frame, direction, callback]);

    // Nothing drains the queue until the StartFrame arrives and this
    // processor is set up, so a processor never acts on a frame before it has
    // been started. Frames pushed before that simply wait, and the StartFrame
    // is dequeued ahead of them.
    if (frame instanceof StartFrame) {
      this.#startReceived = true;
      this.#maybeCreateInputTask();
    }
  }

  /** Pause processing of queued frames. */
  async pauseProcessingFrames(): Promise<void> {
    logger.trace(`${this}: pausing frame processing`);
    this.#shouldBlockFrames = true;
    this.#processEvent?.clear();
  }

  /** Pause processing of queued system frames. */
  async pauseProcessingSystemFrames(): Promise<void> {
    logger.trace(`${this}: pausing system frame processing`);
    this.#shouldBlockSystemFrames = true;
    this.#inputEvent?.clear();
  }

  /** Resume processing of queued frames. */
  async resumeProcessingFrames(): Promise<void> {
    logger.trace(`${this}: resuming frame processing`);
    this.#processEvent?.set();
  }

  /** Resume processing of queued system frames. */
  async resumeProcessingSystemFrames(): Promise<void> {
    logger.trace(`${this}: resuming system frame processing`);
    this.#inputEvent?.set();
  }

  /**
   * Hold frames arriving at this processor until `ready` resolves.
   *
   * Useful for a processor that cannot act on frames until some condition
   * holds, such as one that establishes a connection in the background.
   * Frames wait in the processor's queues and are delivered in order once
   * the condition resolves, so nothing is lost.
   *
   * The frame being processed when this is called is unaffected: the pause
   * takes hold from the next frame onwards.
   *
   * Both queues are held, so the pause is always lifted: when `ready`
   * resolves, when `timeout` (seconds) elapses, or at teardown.
   *
   * @param ready Awaited to learn when frames can be acted on, e.g. `() => someEvent.wait()`.
   */
  async pauseProcessingAllFramesUntil(
    ready: () => Promise<unknown>,
    options: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? PAUSE_UNTIL_READY_TIMEOUT_SECS;
    if (this._enableDirectMode) {
      logger.warning(`${this}: cannot hold frames, this processor runs in direct mode`);
      return;
    }

    await this.#cancelPauseWatcher();
    await this.pauseProcessingSystemFrames();
    await this.pauseProcessingFrames();
    this.#pauseWatcherTask = this.createTask(
      () => this.#pauseWatcherHandler(ready, timeout),
      `${this}::pause_watcher`,
    );
  }

  /** Lift the pause taken by pauseProcessingAllFramesUntil(). */
  async #pauseWatcherHandler(ready: () => Promise<unknown>, timeout: number): Promise<void> {
    try {
      await waitFor(ready, timeout);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      logger.warning(
        `${this}: still not ready after ${timeout}s, resuming frame processing anyway`,
      );
    }
    await this.#resumeProcessingAllFrames();
  }

  /** Stop watching, and lift the pause the watcher was going to lift. */
  async #cancelPauseWatcher(): Promise<void> {
    if (!this.#pauseWatcherTask) return;

    const task = this.#pauseWatcherTask;
    this.#pauseWatcherTask = null;
    await this.cancelTask(task);
    await this.#resumeProcessingAllFrames();
  }

  /** Resume both queues held by pauseProcessingAllFramesUntil(). */
  async #resumeProcessingAllFrames(): Promise<void> {
    await this.resumeProcessingSystemFrames();
    await this.resumeProcessingFrames();
  }

  /**
   * Process a frame. Subclasses override this and call
   * `await super.processFrame(frame, direction)` first.
   */
  async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    const observer = this._setup?.observer;
    if (observer) {
      const data = new FrameProcessed({
        processor: this,
        frame,
        direction,
        timestamp: this.getClock().getTime(),
      });
      await observer.onProcessFrame(data);
    }

    if (frame instanceof StartFrame) {
      await this.#start(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._startInterruption();
      await this.stopAllMetrics();
    } else if (frame instanceof CancelFrame) {
      await this.#cancel(frame);
    } else if (
      frame instanceof FrameProcessorPauseFrame ||
      frame instanceof FrameProcessorPauseUrgentFrame
    ) {
      await this.#pause(frame);
    } else if (
      frame instanceof FrameProcessorResumeFrame ||
      frame instanceof FrameProcessorResumeUrgentFrame
    ) {
      await this.#resume(frame);
    }
  }

  /**
   * Classify an exception this processor knows the shape of. Override for
   * providers that signal failures through SDK-specific errors rather than an
   * HTTP status code. Return null to fall back to `classifyHttpException`.
   */
  protected _classifyError(_exception: unknown): ErrorCategory | null {
    return null;
  }

  /**
   * Create and push an ErrorFrame upstream, with context about which
   * processor generated the error.
   *
   * @param errorMsg Descriptive message explaining the error condition.
   * @param options.exception The error that caused it, if available.
   * @param options.category Why the error occurred, when the caller knows.
   *   Leave unset to work it out from the exception, or pass
   *   `ErrorCategory.UNKNOWN` for an error whose cause can't be attributed.
   * @param options.forceTreatAsPermanent Treat this error as one that will
   *   keep recurring, leaving the processor unable to do any more work. The
   *   pipeline worker then applies its ProcessorUnusablePolicy.
   *
   * @example
   * // An error this processor can recover from
   * await this.pushError("Failed to process audio chunk, skipping");
   *
   * // An error that leaves this processor unable to do any more work
   * try {
   *   someCriticalOperation();
   * } catch (e) {
   *   await this.pushError("Critical operation failed", { exception: e, forceTreatAsPermanent: true });
   * }
   */
  async pushError(
    errorMsg: string,
    options: {
      exception?: unknown;
      category?: ErrorCategory | null;
      forceTreatAsPermanent?: boolean;
    } = {},
  ): Promise<void> {
    const errorFrame = new ErrorFrame({
      error: errorMsg,
      exception: options.exception ?? null,
      processor: this,
      category: options.category ?? null,
    });
    await this.pushErrorFrame(errorFrame, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  }

  /**
   * Push an error frame upstream.
   *
   * @param options.forceTreatAsPermanent See `pushError`.
   */
  async pushErrorFrame(
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> {
    if (!error.processor) {
      error.processor = this;
    }
    // Anything still unset by now is going to stay that way, so settle it here
    // and let handlers read a category off every error they receive.
    if (error.category === null && error.exception) {
      error.category =
        this._classifyError(error.exception) ?? classifyHttpException(error.exception);
    }
    if (error.category === null) {
      error.category = ErrorCategory.UNKNOWN;
    }

    // Before anything sees the error, so that handlers reading
    // `frame.processor.isUsable` get the verdict that came with it.
    if (options.forceTreatAsPermanent || error.category.isPermanent) {
      await this.setUsable(false);
    }

    await this._callEventHandler("on_error", error);

    if (error.exception) {
      logger.error(`${error.processor} exception: ${error.error}`, error.exception);
    } else {
      logger.error(`${error.processor} error: ${error.error}`);
    }
    await this.pushFrame(error, FrameDirection.UPSTREAM);
  }

  /** Push a frame to the next (downstream) or previous (upstream) processor. */
  async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this._callEventHandler("on_before_push_frame", frame);

    await this.#internalPushFrame(frame, direction);

    await this._callEventHandler("on_after_push_frame", frame);
  }

  /** Broadcast an InterruptionFrame both upstream and downstream. */
  async broadcastInterruption(): Promise<void> {
    logger.debug(`${this}: broadcasting interruption`);
    this.#resetProcessTask();
    await this.stopAllMetrics();
    await this.broadcastFrame(InterruptionFrame);
  }

  /**
   * Broadcast a frame of the specified class upstream and downstream.
   *
   * Creates two instances of the given frame class from the provided options
   * (without deep-copying them) and pushes them upstream and downstream.
   */
  async broadcastFrame<O>(frameCls: new (options: O) => Frame, options?: O): Promise<void> {
    const downstreamFrame = new frameCls(options as O);
    const upstreamFrame = new frameCls(options as O);
    downstreamFrame.broadcastSiblingId = upstreamFrame.id;
    upstreamFrame.broadcastSiblingId = downstreamFrame.id;
    await this.pushFrame(downstreamFrame);
    await this.pushFrame(upstreamFrame, FrameDirection.UPSTREAM);
  }

  /**
   * Broadcast a frame instance upstream and downstream.
   *
   * Creates two new frames shallow-copying all fields from the original
   * frame except `id` and `name`, which get fresh values. Prefer
   * `broadcastFrame()` when you are the creator of the frame.
   */
  async broadcastFrameInstance(frame: Frame): Promise<void> {
    const copy = (): Frame => {
      const clone = Object.assign(Object.create(Object.getPrototypeOf(frame)), frame) as Frame;
      renewFrameIdentity(clone);
      return clone;
    };
    const downstreamFrame = copy();
    const upstreamFrame = copy();
    downstreamFrame.broadcastSiblingId = upstreamFrame.id;
    upstreamFrame.broadcastSiblingId = downstreamFrame.id;
    await this.pushFrame(downstreamFrame);
    await this.pushFrame(upstreamFrame, FrameDirection.UPSTREAM);
  }

  async #start(_frame: StartFrame): Promise<void> {
    this.#createProcessTask();
  }

  async #cancel(_frame: CancelFrame): Promise<void> {
    this._cancelling = true;
    await this.#cancelProcessTask();
  }

  async #pause(frame: FrameProcessorPauseFrame | FrameProcessorPauseUrgentFrame): Promise<void> {
    if (frame.processor.name === this.name) {
      await this.pauseProcessingFrames();
    }
  }

  async #resume(frame: FrameProcessorResumeFrame | FrameProcessorResumeUrgentFrame): Promise<void> {
    if (frame.processor.name === this.name) {
      await this.resumeProcessingFrames();
    }
  }

  //
  // Handle interruptions
  //

  /** Start handling an interruption by cancelling current tasks. */
  protected async _startInterruption(): Promise<void> {
    try {
      const current = this.#processCurrentFrame;
      const currentIsUninterruptible = current !== null && !current.interruptible;
      if (currentIsUninterruptible) {
        // The frame currently being processed is uninterruptible, so we must
        // not cancel it. Just flush interruptible frames from the queue; any
        // uninterruptible ones will be kept and processed after the current
        // frame finishes.
        this.#resetProcessQueue();
      } else {
        // Cancel and re-create the process task. Uninterruptible queued frames
        // are safe here because #createProcessTask resets the process queue,
        // which always preserves them.
        await this.#cancelProcessTask();
        this.#createProcessTask();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Uncaught exception handling _start_interruption: ${errorMessage(e)}`, {
        exception: e,
        // A broad catch: this may not have come from this processor at all,
        // so its cause can't be attributed.
        category: ErrorCategory.UNKNOWN,
      });
    }
  }

  async #internalPushFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    const observer = this._setup?.observer;
    try {
      const timestamp = this._setup ? this.getClock().getTime() : 0;
      if (direction === FrameDirection.DOWNSTREAM && this._next) {
        logger.trace(`Pushing ${frame} downstream from ${this} to ${this._next}`);
        if (observer) {
          const data = new FramePushed({
            source: this,
            destination: this._next,
            frame,
            direction,
            timestamp,
          });
          await observer.onPushFrame(data);
        }
        await this._next.queueFrame(frame, direction);
      } else if (direction === FrameDirection.UPSTREAM && this._prev) {
        logger.trace(`Pushing ${frame} upstream from ${this} to ${this._prev}`);
        if (observer) {
          const data = new FramePushed({
            source: this,
            destination: this._prev,
            frame,
            direction,
            timestamp,
          });
          await observer.onPushFrame(data);
        }
        await this._prev.queueFrame(frame, direction);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      // Observers and the downstream processor run inside this block, so the
      // cause of an unexpected failure can't be attributed.
      await this.pushError(`Uncaught exception: ${errorMessage(e)}`, {
        exception: e,
        category: ErrorCategory.UNKNOWN,
      });
    }
  }

  /** Create the input task once the StartFrame is here and setup is done. */
  #maybeCreateInputTask(): void {
    if (!this.#startReceived || !this.#setupDone.isSet()) return;
    if (!this._taskManager) {
      // Setting up was cut short before FrameProcessor.setup() ran, so there
      // is no task manager to start processing frames with.
      logger.error(
        `${this}: can't start, setup ended before FrameProcessor.setup() was ` +
          "called (call super.setup() before anything that can block)",
      );
      return;
    }
    this.#createInputTask();
  }

  #createInputTask(): void {
    if (this._enableDirectMode) return;

    if (!this.#inputFrameTask) {
      this.#inputEvent = new Event();
      this.#inputFrameTask = this.createTask(
        () => this.#inputFrameTaskHandler(),
        "__input_frame_task_handler",
      );
    }
  }

  async #cancelInputTask(): Promise<void> {
    if (this.#inputFrameTask) {
      // Apply a timeout as a safeguard: if some code swallows cancellation,
      // the task would otherwise never be cancelled.
      await this.cancelTask(this.#inputFrameTask, INPUT_TASK_CANCEL_TIMEOUT_SECS);
      this.#inputFrameTask = null;
    }
  }

  #createProcessTask(): void {
    if (this._enableDirectMode) return;

    if (!this.#processFrameTask) {
      this.#resetProcessTask();
      this.#processFrameTask = this.createTask(
        () => this.#processFrameTaskHandler(),
        "__process_frame_task_handler",
      );
    }
  }

  #resetProcessTask(): void {
    if (this._enableDirectMode) return;

    this.#shouldBlockFrames = false;
    this.#processEvent = new Event();
    this.#resetProcessQueue();
  }

  #resetProcessQueue(): void {
    this.#processQueue.reset();
  }

  /** Whether a frame of the given type is waiting in the processing queue. */
  hasQueuedFrame(frameType: FrameClass): boolean {
    return this.#processQueue.hasFrame(frameType);
  }

  async #cancelProcessTask(): Promise<void> {
    if (this.#processFrameTask) {
      await this.cancelTask(this.#processFrameTask);
      this.#processFrameTask = null;
    }
  }

  async #processFrame(
    frame: Frame,
    direction: FrameDirection,
    callback: FrameCallback | null,
  ): Promise<void> {
    try {
      await this._callEventHandler("on_before_process_frame", frame);

      // Process the frame.
      await this.processFrame(frame, direction);
      // If this frame has an associated callback, call it now.
      if (callback) {
        await callback(this, frame, direction);
      }

      await this._callEventHandler("on_after_process_frame", frame);
    } catch (e) {
      rethrowIfCancelled(e);
      // The frame callback runs inside this block, so the cause of an
      // unexpected failure can't be attributed.
      await this.pushError(`Error processing frame: ${errorMessage(e)}`, {
        exception: e,
        category: ErrorCategory.UNKNOWN,
      });
    }
  }

  /**
   * Handle frames from the input queue. Only processes system frames; other
   * frames are queued for the process task.
   */
  async #inputFrameTaskHandler(): Promise<void> {
    for (;;) {
      const [frame, direction, callback] = await this.#inputQueue.get();

      if (this.#shouldBlockSystemFrames && this.#inputEvent) {
        logger.trace(`${this}: system frame processing paused`);
        await this.#inputEvent.wait();
        this.#inputEvent.clear();
        this.#shouldBlockSystemFrames = false;
        logger.trace(`${this}: system frame processing resumed`);
      }

      if (frame instanceof SystemFrame) {
        await this.#processFrame(frame, direction, callback);
      } else {
        await this.#processQueue.put([frame, direction, callback]);
      }

      this.#inputQueue.taskDone();
    }
  }

  /** Handle non-system frames from the process queue. */
  async #processFrameTaskHandler(): Promise<void> {
    for (;;) {
      this.#processCurrentFrame = null;

      const [frame, direction, callback] = await this.#processQueue.get();

      this.#processCurrentFrame = frame;

      if (this.#shouldBlockFrames && this.#processEvent) {
        logger.trace(`${this}: frame processing paused`);
        await this.#processEvent.wait();
        this.#processEvent.clear();
        this.#shouldBlockFrames = false;
        logger.trace(`${this}: frame processing resumed`);
      }

      await this.#processFrame(frame, direction, callback);

      this.#processQueue.taskDone();
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
