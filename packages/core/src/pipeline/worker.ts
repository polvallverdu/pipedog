// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/worker.py

/**
 * Pipeline worker implementation for managing frame processing pipelines.
 *
 * Provides the main PipelineWorker class that orchestrates pipeline
 * execution, frame routing, lifecycle management, and monitoring capabilities
 * including heartbeats, idle detection, and observer integration.
 *
 * Porting notes: the deprecated `PipelineTask` and `PipelineTaskParams`
 * aliases, the `toolResources` option, the `ErrorFrame.fatal` branch, the
 * deprecated `StartFrame` configuration fields and the legacy
 * `setup_pipeline_task` setup hook name are not ported.
 */

import {
  CancelledError,
  Event,
  monotonic,
  Queue,
  shield,
  sleep,
  type Task,
  TimeoutError,
  wait,
  waitFor,
} from "@pipedog/asyncio";
import { _BusEdgeProcessor } from "../bus/bridge_processor.ts";
import {
  BusCancelWorkerMessage,
  type BusEndWorkerMessage,
  BusFlushProgressMessage,
  BusFrameMessage,
  type BusMessage,
  BusTTSSpeakMessage,
} from "../bus/index.ts";
import {
  BusUICommandMessage,
  BusUIDataMessage,
  BusUIEventMessage,
  BusUIJobCompletedMessage,
  BusUIJobGroupCompletedMessage,
  BusUIJobGroupStartedMessage,
  BusUIJobUpdateMessage,
  UI_CANCEL_JOB_GROUP_EVENT_NAME,
  UI_SNAPSHOT_EVENT_NAME,
} from "../bus/ui/messages.ts";
import type { BaseClock } from "../clocks/base_clock.ts";
import { SystemClock } from "../clocks/system_clock.ts";
import type { ExpressionPolicy } from "../expressive/policy.ts";
import {
  BotSpeakingFrame,
  CancelFrame,
  CancelWorkerFrame,
  EndFrame,
  EndWorkerFrame,
  ErrorFrame,
  type Frame,
  HeartbeatFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  InterruptionWorkerFrame,
  MetricsFrame,
  PipelineFlushFrame,
  StartFrame,
  StopFrame,
  StopWorkerFrame,
  TranscriptionFrame,
  TTSSpeakFrame,
  UserSpeakingFrame,
  UserStartedSpeakingFrame,
} from "../frames/frames.ts";
import { type MetricsData, ProcessingMetricsData, TTFBMetricsData } from "../metrics/metrics.ts";
import { BaseObserver, type FramePushed } from "../observers/base_observer.ts";
import { TurnTrackingObserver } from "../observers/turn_tracking_observer.ts";
import { UserBotLatencyObserver } from "../observers/user_bot_latency_observer.ts";
import {
  FrameDirection,
  type FrameProcessor,
  FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import { RTVIUICommandFrame, RTVIUIJobGroupFrame } from "../processors/frameworks/rtvi/frames.ts";
import {
  RTVIObserver,
  type RTVIObserverParams,
  RTVIProcessor,
} from "../processors/frameworks/rtvi/index.ts";
import * as RTVI from "../processors/frameworks/rtvi/models.ts";
import { BaseInputTransport } from "../transports/base_input.ts";
import { BaseOutputTransport } from "../transports/base_output.ts";
import type { BaseTaskManager } from "../utils/asyncio/task_manager.ts";
import type { FrameClass } from "../utils/frame_queue.ts";
import { logger } from "../utils/logger.ts";
import { runSetupHook } from "../utils/startup.ts";
import {
  isTracingAvailable,
  loadOpenTelemetry,
  type OtelAttributeValue,
} from "../utils/tracing/setup.ts";
import { TracingContext } from "../utils/tracing/tracing_context.ts";
import { TurnTraceObserver } from "../utils/tracing/turn_trace_observer.ts";
import {
  BaseWorker,
  type WorkerActivationArgs,
  type WorkerParams,
} from "../workers/base_worker.ts";
import type { BasePipeline } from "./base_pipeline.ts";
import { BotCapabilities } from "./capabilities.ts";
import { Pipeline, PipelineSink, PipelineSource } from "./pipeline.ts";
import { WorkerObserver } from "./worker_observer.ts";

export const HEARTBEAT_SECS = 1.0;
export const HEARTBEAT_MONITOR_SECS = 10.0;

/** How often a pipeline answering someone else's flush says it is still working. */
export const FLUSH_PROGRESS_PERIOD_SECS = 1.0;

export const IDLE_TIMEOUT_SECS = 300;

export const CANCEL_TIMEOUT_SECS = 20.0;

export const SETUP_TIMEOUT_SECS = 20.0;

export const START_TIMEOUT_SECS = 20.0;

type AnyClass<T> = abstract new (...args: any[]) => T;

export interface IdleFrameObserverOptions {
  /** The event to set if the idle timeout frames are being pushed. */
  idleEvent: Event;
  /** The frames that should set the event when received. */
  idleTimeoutFrames: readonly FrameClass[];
}

/**
 * Idle timeout observer.
 *
 * Waits for specific frames being generated in the pipeline. If the frames
 * are generated the given event is set. If the event is not set it means the
 * pipeline is probably idle.
 */
export class IdleFrameObserver extends BaseObserver {
  protected _idleEvent: Event;
  protected _idleTimeoutFrames: readonly FrameClass[];

  /**
   * Initialize the observer.
   *
   * @param options.idleEvent The event to set if the idle timeout frames are being pushed.
   * @param options.idleTimeoutFrames The frames that should set the event when received.
   */
  constructor(options: IdleFrameObserverOptions) {
    super({ observeEveryPush: false });
    this._idleEvent = options.idleEvent;
    this._idleTimeoutFrames = options.idleTimeoutFrames;
  }

  /**
   * Callback executed when a frame is pushed in the pipeline.
   *
   * @param data The frame push event data.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (
      data.frame instanceof StartFrame ||
      this._idleTimeoutFrames.some((cls) => data.frame instanceof cls)
    ) {
      this._idleEvent.set();
    }
  }
}

/**
 * What a pipeline worker does when a processor can no longer do its job.
 *
 * An unusable processor keeps failing for as long as the pipeline keeps using
 * it, so the pipeline has to decide whether it is still worth running. A
 * processor becomes unusable through a permanent error category or through
 * `FrameProcessor.pushError` with `forceTreatAsPermanent: true`.
 *
 * - `CONTINUE`: report the error and keep running. The application can decide
 *   what to do, for example by failing over to another provider.
 * - `END`: end the pipeline gracefully, letting queued frames drain first.
 * - `CANCEL`: cancel the pipeline immediately, abandoning queued frames.
 */
export const ProcessorUnusablePolicy = {
  CONTINUE: "continue",
  END: "end",
  CANCEL: "cancel",
} as const;
export type ProcessorUnusablePolicy =
  (typeof ProcessorUnusablePolicy)[keyof typeof ProcessorUnusablePolicy];

export interface PipelineParamsOptions {
  audioInSampleRate?: number;
  audioOutSampleRate?: number;
  enableExpressiveConversation?: boolean;
  expressionPolicy?: ExpressionPolicy | null;
  enableHeartbeats?: boolean;
  enableMetrics?: boolean;
  enableUsageMetrics?: boolean;
  heartbeatsPeriodSecs?: number;
  heartbeatsMonitorSecs?: number;
  reportOnlyInitialTtfb?: boolean;
  sendInitialEmptyMetrics?: boolean;
  startMetadata?: Record<string, unknown>;
}

/**
 * Configuration parameters for pipeline execution.
 *
 * These parameters are usually passed to all frame processors through
 * FrameProcessorSetup. For other generic pipeline worker parameters use
 * PipelineWorker constructor options instead.
 *
 * - `audioInSampleRate`: input audio sample rate in Hz.
 * - `audioOutSampleRate`: output audio sample rate in Hz.
 * - `enableExpressiveConversation`: whether the agent takes part in an
 *   expressive conversation (alpha). TTS services then read the expression
 *   tags an LLM writes into its reply instead of speaking them.
 * - `expressionPolicy`: which expression tags the LLMs are offered and when to
 *   use them, with expressive conversation on. Defaults to null, which offers
 *   every tag the TTS service performs, with no guidance. Part of expressive
 *   conversation (alpha).
 * - `enableHeartbeats`: whether to enable heartbeat monitoring.
 * - `enableMetrics`: whether to enable metrics collection.
 * - `enableUsageMetrics`: whether to enable usage metrics.
 * - `heartbeatsPeriodSecs`: period between heartbeats in seconds.
 * - `heartbeatsMonitorSecs`: timeout (in seconds) before warning about missed
 *   heartbeats. Defaults to 10 seconds.
 * - `reportOnlyInitialTtfb`: whether to report only initial time to first byte.
 * - `sendInitialEmptyMetrics`: whether to send initial empty metrics.
 * - `startMetadata`: additional metadata for pipeline start.
 */
export class PipelineParams {
  audioInSampleRate: number;
  audioOutSampleRate: number;
  enableExpressiveConversation: boolean;
  expressionPolicy: ExpressionPolicy | null;
  enableHeartbeats: boolean;
  enableMetrics: boolean;
  enableUsageMetrics: boolean;
  heartbeatsPeriodSecs: number;
  heartbeatsMonitorSecs: number;
  reportOnlyInitialTtfb: boolean;
  sendInitialEmptyMetrics: boolean;
  startMetadata: Record<string, unknown>;

  constructor(options: PipelineParamsOptions = {}) {
    this.audioInSampleRate = options.audioInSampleRate ?? 16000;
    this.audioOutSampleRate = options.audioOutSampleRate ?? 24000;
    this.enableExpressiveConversation = options.enableExpressiveConversation ?? false;
    this.expressionPolicy = options.expressionPolicy ?? null;
    this.enableHeartbeats = options.enableHeartbeats ?? false;
    this.enableMetrics = options.enableMetrics ?? false;
    this.enableUsageMetrics = options.enableUsageMetrics ?? false;
    this.heartbeatsPeriodSecs = options.heartbeatsPeriodSecs ?? HEARTBEAT_SECS;
    this.heartbeatsMonitorSecs = options.heartbeatsMonitorSecs ?? HEARTBEAT_MONITOR_SECS;
    this.reportOnlyInitialTtfb = options.reportOnlyInitialTtfb ?? false;
    this.sendInitialEmptyMetrics = options.sendInitialEmptyMetrics ?? true;
    this.startMetadata = options.startMetadata ?? {};
  }
}

export interface PipelineWorkerOptions {
  /** Whether the worker starts active. Forwarded to `BaseWorker`. */
  active?: boolean;
  /**
   * Optional attributes to propagate as OpenTelemetry conversation span
   * attributes.
   */
  additionalSpanAttributes?: Record<string, OtelAttributeValue> | null;
  /**
   * Optional application-defined bag of anything your application code may
   * want to share across this session (DB handles, HTTP clients, etc.),
   * passed by reference. Pipecat passes it through untouched and exposes it
   * on the worker itself as `worker.appResources` and passes it to tool
   * handlers as `FunctionCallParams.appResources`. The framework never copies
   * or clears this object; the caller retains their handle and can read any
   * mutations after the worker finishes.
   */
  appResources?: unknown;
  /**
   * Bridge configuration. `null` means the pipeline is not bridged. An empty
   * array `[]` wraps the pipeline with bus edge processors that accept frames
   * from all bridges. An array of names like `["voice"]` accepts only frames
   * from those bridges. The bus comes from `attach()` (called by the runner).
   */
  bridged?: readonly string[] | null;
  /**
   * Whether reaching the idle timeout should cancel the pipeline worker. When
   * false, the idle event still fires `on_idle_timeout` but the worker is
   * left alone (and `cancelRunnerOnIdleTimeout` is ignored too: opting out of
   * local cancellation also opts out of the runner-wide cancel).
   */
  cancelOnIdleTimeout?: boolean;
  /**
   * When `cancelOnIdleTimeout` is also true, whether reaching the idle
   * timeout should also cancel the entire `WorkerRunner`. The worker is
   * always cancelled first; when this is true the worker also emits a
   * `BusCancelMessage` so the runner broadcasts cancellation to every other
   * root worker. Defaults to true so a multi-worker bot's helpers shut down
   * with the main pipeline; set to false for a sidecar `PipelineWorker` that
   * should self-cancel on idle without bringing down its peers.
   */
  cancelRunnerOnIdleTimeout?: boolean;
  /** Timeout (in seconds) to wait for cancellation to happen cleanly. */
  cancelTimeoutSecs?: number;
  /**
   * What the bot does, for fields the pipeline can't show. Its known fields
   * replace the ones derived from the pipeline's transports and parameters.
   * See `capabilities`.
   */
  capabilities?: BotCapabilities | null;
  /**
   * Whether to warn about tasks left running when the worker finishes. Only
   * applies when the worker owns its task manager; otherwise the runner
   * reports dangling tasks.
   */
  checkDanglingTasks?: boolean;
  /** Clock implementation for timing operations. */
  clock?: BaseClock | null;
  /** Optional custom ID for the conversation. */
  conversationId?: string | null;
  /** Whether to enable tracing. */
  enableTracing?: boolean;
  /** Whether to enable turn tracking. */
  enableTurnTracking?: boolean;
  /**
   * Whether this worker answers a flush probe, bouncing it at the sink and
   * completing it at the source. Defaults to whether the pipeline is
   * unbridged, so a worker wired into someone else's topology leaves the
   * probe to travel on and be completed by the pipeline that owns the
   * transport. A bridged worker with no such peer never completes a flush and
   * every `flushPipeline` call waits out its timeout.
   */
  handleFlushFrame?: boolean | null;
  /**
   * Whether to automatically add RTVI support to the pipeline. `null`, the
   * default, adds it unless the pipeline is bridged: a bridged worker has no
   * client of its own, and its RTVI would report every frame a second time as
   * it crosses the bridge.
   */
  enableRtvi?: boolean | null;
  /**
   * When `bridged` is set, extra frame types that should not cross the bus
   * (lifecycle frames are always excluded).
   */
  excludeFrames?: readonly FrameClass[] | null;
  /**
   * The frames that should trigger an idle timeout if not received within
   * `idleTimeoutSecs`. The default pairs the VAD-only `UserSpeakingFrame` with
   * the turn and transcription frames a provider-driven pipeline reports
   * instead.
   */
  idleTimeoutFrames?: readonly FrameClass[];
  /**
   * Timeout (in seconds) to consider pipeline idle, or null. If a pipeline is
   * idle the pipeline worker will be cancelled automatically.
   */
  idleTimeoutSecs?: number | null;
  /** Optional worker name (used for worker-style addressing on the bus). */
  name?: string | null;
  /** Observers for monitoring pipeline execution. */
  observers?: BaseObserver[] | null;
  /**
   * What to do when a processor reports an error that leaves it unable to do
   * its job, such as a service whose API key was rejected. Defaults to
   * `ProcessorUnusablePolicy.CONTINUE`, leaving the decision to
   * `on_pipeline_error` handlers.
   */
  processorUnusablePolicy?: ProcessorUnusablePolicy;
  /** Configuration parameters for the pipeline. */
  params?: PipelineParams | null;
  /** The RTVI processor to add if RTVI is enabled. */
  rtviProcessor?: RTVIProcessor | null;
  /** The RTVI observer parameters to use if RTVI is enabled. */
  rtviObserverParams?: RTVIObserverParams | null;
  /**
   * Timeout (in seconds) to wait for every processor to be set up. Processors
   * connect while they are set up, so one that blocks connecting never lets
   * the pipeline start, and the worker is torn down instead of waiting
   * forever. The `StartFrame` is pushed while processors are still being set
   * up, and each processor holds it only until its own setup is done, so
   * processors ahead of a slow one start without it.
   */
  setupTimeoutSecs?: number;
  /**
   * Timeout (in seconds) to wait for the `StartFrame` to reach the end of the
   * pipeline, counted from when every processor is set up. A processor that
   * blocks while handling it never lets the pipeline start, so the worker is
   * torn down instead of waiting forever.
   */
  startTimeoutSecs?: number;
  /** Optional task manager for handling tasks. */
  taskManager?: BaseTaskManager | null;
}

/**
 * Manages the execution of a pipeline, handling frame processing and worker
 * lifecycle.
 *
 * Orchestrates pipeline execution with comprehensive monitoring, event
 * handling, and lifecycle management. Provides event handlers for various
 * pipeline states and frame types, idle detection, heartbeat monitoring, and
 * observer integration.
 *
 * Event handlers available:
 *
 * - on_frame_reached_upstream: called when upstream frames reach the source
 * - on_frame_reached_downstream: called when downstream frames reach the sink
 * - on_heartbeat_timeout: called when a heartbeat frame is not received within
 *   the monitor timeout. Fires repeatedly every `heartbeatsMonitorSecs` for as
 *   long as the stall persists.
 * - on_idle_timeout: called when pipeline is idle beyond timeout threshold
 * - on_pipeline_started: called when pipeline starts with StartFrame
 * - on_pipeline_finished: called after the pipeline has reached any terminal
 *   state. This includes:
 *     - StopFrame: pipeline was stopped (processors keep connections open)
 *     - EndFrame: pipeline ended normally
 *     - CancelFrame: pipeline was cancelled
 *
 *   Use this event for cleanup, logging, or post-processing tasks. Users can
 *   inspect the frame if they need to handle specific cases.
 * - on_pipeline_timeout: called when a frame the worker was waiting on never
 *   reached the end of the pipeline, meaning a processor is blocked. Inspect
 *   the frame to tell the cases apart:
 *     - StartFrame: the pipeline never started and is being torn down
 *     - CancelFrame: the pipeline was cancelled but did not drain
 *
 *   There is no EndFrame case: ending flushes whatever is queued, so the
 *   worker waits for it however long that takes.
 * - on_pipeline_error: called when an error occurs with ErrorFrame. Handler
 *   can read `frame.processor.isUsable` to distinguish between errors that
 *   end a processor's usability from those that don't.
 * - on_setup_timeout: called when setting the pipeline up times out.
 *
 * @example
 * worker.eventHandler("on_frame_reached_upstream", async (worker, frame) => { ... });
 * worker.eventHandler("on_heartbeat_timeout", async (worker) => { ... });
 * worker.eventHandler("on_idle_timeout", async (worker) => { ... });
 * worker.eventHandler("on_pipeline_started", async (worker, frame) => { ... });
 * worker.eventHandler("on_pipeline_finished", async (worker, frame) => { ... });
 * worker.eventHandler("on_pipeline_timeout", async (worker, frame) => { ... });
 * worker.eventHandler("on_pipeline_error", async (worker, frame) => { ... });
 * worker.eventHandler("on_setup_timeout", async (worker) => { ... });
 */
export class PipelineWorker extends BaseWorker {
  protected _bridged: readonly string[] | null;
  protected _handleFlushFrame: boolean;
  protected _params: PipelineParams;
  protected _capabilitiesOverride: BotCapabilities;
  protected _additionalSpanAttributes: Record<string, OtelAttributeValue>;
  protected _cancelOnIdleTimeout: boolean;
  protected _cancelRunnerOnIdleTimeout: boolean;
  protected _cancelTimeoutSecs: number;
  // Frames that have reached the sink. A flush watches this to tell a
  // pipeline that is still working from one that is stuck.
  protected _framesReachingSink = 0;
  // Probes from other workers that this pipeline is answering, by flush id,
  // and the progress reported back for our own.
  protected _foreignProbes = new Map<number, string>();
  protected _flushProgress = new Map<number, number>();
  // Python starts this at 0.0 against a `time.monotonic()` that counts from
  // boot; ours counts from process start, so -Infinity keeps the first report
  // from being held back.
  protected _flushProgressSent = Number.NEGATIVE_INFINITY;
  protected _setupTimeoutSecs: number;
  protected _startTimeoutSecs: number;
  protected _clock: BaseClock;
  protected _conversationId: string | null;
  protected _enableTracing: boolean;
  /** `enableTracing` as given; `_enableTracing` also needs OpenTelemetry. */
  protected _tracingRequested: boolean;
  protected _enableTurnTracking: boolean;
  protected _idleTimeoutSecs: number | null;
  protected _appResources: unknown;
  protected _processorUnusablePolicy: ProcessorUnusablePolicy;
  // Processors the policy has already been applied for, so a service that
  // keeps failing is acted on once instead of on every frame it can't handle.
  protected _unusableProcessors = new Set<FrameProcessor>();
  protected _turnTrackingObserver: TurnTrackingObserver | null = null;
  protected _userBotLatencyObserver: UserBotLatencyObserver | null = null;
  protected _turnTraceObserver: TurnTraceObserver | null = null;
  protected _tracingContext: TracingContext | null = null;

  protected _finished = false;
  protected _cancelled = false;

  // This queue is the queue used to push frames to the pipeline.
  protected _pushQueue = new Queue<Frame>();
  protected _processPushTask: Task<unknown> | null = null;
  protected _pipelineSetupTask: Task<unknown> | null = null;
  protected _pipelineStartTask: Task<boolean | undefined> | null = null;
  protected _setupWatchTask: Task<unknown> | null = null;

  // This is the heartbeat queue. When a heartbeat frame is received in the
  // down queue we add it to the heartbeat queue for processing.
  protected _heartbeatQueue = new Queue<HeartbeatFrame>();
  protected _heartbeatPushTask: Task<unknown> | null = null;
  protected _heartbeatMonitorTask: Task<unknown> | null = null;

  // RTVI support
  protected _rtvi: RTVIProcessor | null = null;

  // This is the idle event. When selected frames are pushed from any
  // processor we consider the pipeline is not idle. We use an observer which
  // will be listening any part of the pipeline.
  protected _idleEvent = new Event();
  protected _idleMonitorTask: Task<unknown> | null = null;

  // This event is used to indicate the StartFrame has been received at the
  // end of the pipeline.
  protected _pipelineStartEvent = new Event();

  // This event is used to indicate a finalize frame (e.g. EndFrame,
  // StopFrame) has been received at the end of the pipeline.
  protected _pipelineEndEvent = new Event();

  protected _source: PipelineSource;
  protected _sink: PipelineSink;
  protected _pipeline: Pipeline;
  protected _observer: WorkerObserver;

  // These events can be used to check which frames make it to the source or
  // sink processors. Instead of calling the event handlers for every frame
  // the user needs to specify which events they are interested in. This is
  // mainly for efficiency reason because each event handler creates a task
  // and most likely you only care about one or two frame types.
  protected _reachedUpstreamTypes = new Set<FrameClass>();
  protected _reachedDownstreamTypes = new Set<FrameClass>();

  /**
   * Initialize the PipelineWorker.
   *
   * @param pipeline The pipeline to execute.
   * @param options See `PipelineWorkerOptions`.
   */
  constructor(pipeline: BasePipeline, options: PipelineWorkerOptions = {}) {
    super({
      name: options.name ?? null,
      active: options.active ?? true,
      taskManager: options.taskManager ?? null,
      checkDanglingTasks: options.checkDanglingTasks ?? true,
    });
    const bridged = options.bridged ?? null;
    this._bridged = bridged;
    this._handleFlushFrame =
      options.handleFlushFrame !== null && options.handleFlushFrame !== undefined
        ? options.handleFlushFrame
        : bridged === null;
    this._params = options.params ?? new PipelineParams();
    if (this._params.expressionPolicy !== null && !this._params.enableExpressiveConversation) {
      logger.warning(
        `${this}: expressionPolicy has no effect without enableExpressiveConversation=true`,
      );
    }
    this._capabilitiesOverride = options.capabilities ?? new BotCapabilities();
    this._additionalSpanAttributes = options.additionalSpanAttributes ?? {};
    this._cancelOnIdleTimeout = options.cancelOnIdleTimeout ?? true;
    this._cancelRunnerOnIdleTimeout = options.cancelRunnerOnIdleTimeout ?? true;
    this._cancelTimeoutSecs = options.cancelTimeoutSecs ?? CANCEL_TIMEOUT_SECS;
    this._setupTimeoutSecs = options.setupTimeoutSecs ?? SETUP_TIMEOUT_SECS;
    this._startTimeoutSecs = options.startTimeoutSecs ?? START_TIMEOUT_SECS;
    this._clock = options.clock ?? new SystemClock();
    this._conversationId = options.conversationId ?? null;
    this._tracingRequested = options.enableTracing ?? false;
    // Rechecked in _setup() (after awaiting core's asynchronous import of
    // OpenTelemetry), so building the worker early never disables tracing.
    this._enableTracing = this._tracingRequested && isTracingAvailable();
    this._enableTurnTracking = options.enableTurnTracking ?? true;
    this._idleTimeoutSecs =
      options.idleTimeoutSecs === undefined ? IDLE_TIMEOUT_SECS : options.idleTimeoutSecs;
    this._appResources = options.appResources ?? null;
    this._processorUnusablePolicy =
      options.processorUnusablePolicy ?? ProcessorUnusablePolicy.CONTINUE;
    const idleTimeoutFrames = options.idleTimeoutFrames ?? [
      BotSpeakingFrame,
      InterimTranscriptionFrame,
      TranscriptionFrame,
      UserSpeakingFrame,
      UserStartedSpeakingFrame,
    ];

    // Like upstream (`observers or []`), observers are added to the caller's
    // list, unless it is empty (falsy in Python), in which case a new one is used.
    const observers = options.observers && options.observers.length > 0 ? options.observers : [];
    if (this._enableTurnTracking) {
      this._turnTrackingObserver = new TurnTrackingObserver();
      observers.push(this._turnTrackingObserver);
    }
    if (this._enableTracing) {
      observers.push(...this._createTracingObservers());
    }

    // RTVI support
    const enableRtvi = options.enableRtvi ?? bridged === null;
    let prependRtvi = false;
    const externalRtvi = firstOf(this._iterProcessors(pipeline, [RTVIProcessor]));
    const externalObserverFound = observers.some((o) => o instanceof RTVIObserver);

    if (externalRtvi && !externalObserverFound) {
      logger.error(
        `${this}: RTVIProcessor found in pipeline but no RTVIObserver in observers. ` +
          "Make sure to add both.",
      );
    } else if (!externalRtvi && externalObserverFound) {
      logger.error(
        `${this}: RTVIObserver found in observers but no RTVIProcessor in pipeline. ` +
          "Make sure to add both.",
      );
    } else if (externalRtvi && externalObserverFound) {
      logger.warning(
        `${this}: RTVIProcessor and RTVIObserver found, skipping default ones. ` +
          "They are both added by default, no need to add them yourself.",
      );
      this._rtvi = externalRtvi;
    } else if (enableRtvi) {
      this._rtvi = options.rtviProcessor ?? new RTVIProcessor();
      observers.push(this._rtvi.createRtviObserver({ params: options.rtviObserverParams ?? null }));
      prependRtvi = true;
    }

    if (this._rtvi) {
      // Automatically call RTVIProcessor.setBotReady()
      this.rtvi.eventHandler("on_client_ready", async (rtvi: RTVIProcessor) => {
        await rtvi.setBotReady();
      });

      // Republish inbound client UI messages onto the bus so UIWorker
      // subscribers can dispatch them.
      this.rtvi.eventHandler("on_ui_message", async (_rtvi: RTVIProcessor, message: unknown) => {
        await this._republishUiMessageOnBus(message);
      });
    }

    if (this._idleTimeoutSecs) {
      const idleFrameObserver = new IdleFrameObserver({
        idleEvent: this._idleEvent,
        idleTimeoutFrames,
      });
      observers.push(idleFrameObserver);
    }

    // When bridged, wrap the user pipeline with bus edge processors so frames
    // tee onto the bus at the source/sink and incoming bus frames are
    // injected back into the local pipeline. The edges read the worker's bus
    // lazily, so the bus only needs to be set (via `attach()`) before `run()`
    // is called.
    let userPipeline: FrameProcessor = pipeline;
    if (bridged !== null) {
      const edgeSource = new _BusEdgeProcessor({
        worker: this,
        direction: FrameDirection.UPSTREAM,
        excludeFrames: options.excludeFrames ?? null,
        name: `${this}::EdgeSource`,
      });
      const edgeSink = new _BusEdgeProcessor({
        worker: this,
        direction: FrameDirection.DOWNSTREAM,
        excludeFrames: options.excludeFrames ?? null,
        name: `${this}::EdgeSink`,
      });
      userPipeline = new Pipeline([edgeSource, pipeline, edgeSink]);
    }

    // This is the final pipeline. It is composed of a source processor,
    // followed by the user pipeline, and ending with a sink processor. The
    // source allows us to receive and react to upstream frames, and the sink
    // allows us to receive and react to downstream frames.
    this._source = new PipelineSource(
      (frame, direction) => this._sourcePushFrame(frame, direction),
      {
        name: `${this}::Source`,
      },
    );
    this._sink = new PipelineSink((frame, direction) => this._sinkPushFrame(frame, direction), {
      name: `${this}::Sink`,
    });
    // Only prepend the RTVIProcessor if we created it ourselves. When the
    // user already placed it inside their pipeline we must not insert it
    // again or it will appear twice in the frame chain.
    const processors: FrameProcessor[] =
      prependRtvi && this._rtvi ? [this._rtvi, userPipeline] : [userPipeline];
    this._pipeline = new Pipeline(processors, { source: this._source, sink: this._sink });

    // The worker observer acts as a proxy to the provided observers. This
    // way, we only need to pass a single observer (using the
    // FrameProcessorSetup) which then just acts as a proxy.
    this._observer = new WorkerObserver({ observers });

    this._registerEventHandler("on_frame_reached_upstream");
    this._registerEventHandler("on_frame_reached_downstream");
    this._registerEventHandler("on_heartbeat_timeout");
    this._registerEventHandler("on_idle_timeout");
    this._registerEventHandler("on_pipeline_started");
    this._registerEventHandler("on_pipeline_finished");
    this._registerEventHandler("on_pipeline_timeout");
    this._registerEventHandler("on_setup_timeout");
    this._registerEventHandler("on_pipeline_error");

    // Bridge pipeline lifecycle to the BaseWorker lifecycle so the bus
    // registry sees this worker as ready/finished.
    this.eventHandler("on_pipeline_started", async (_task: unknown, _frame: Frame) => {
      await this.start();
    });

    this.eventHandler("on_pipeline_finished", async (_task: unknown, _frame: Frame) => {
      await this.stop();
    });
  }

  /** The pipeline parameters for this worker. */
  get params(): PipelineParams {
    return this._params;
  }

  /**
   * What the bot does in this session.
   *
   * Derived from the media the pipeline's transports send and receive and
   * from `PipelineParams.enableMetrics`, with the `capabilities` passed to the
   * constructor applied on top. A field no transport reports is `null`
   * (unknown). RTVI sends this to the client in `bot-ready`.
   */
  get capabilities(): BotCapabilities {
    let derived = new BotCapabilities({ metrics: this._params.enableMetrics });
    for (const processor of this._iterProcessors<BaseInputTransport | BaseOutputTransport>(
      this._pipeline,
      [BaseInputTransport, BaseOutputTransport],
    )) {
      derived = derived.combine(processor.capabilities);
    }
    return derived.override(this._capabilitiesOverride);
  }

  /** Whether this pipeline is bridged onto the bus. */
  override get bridged(): boolean {
    return this._bridged !== null;
  }

  /**
   * The application-defined resources passed to this worker.
   *
   * This is the same object passed to the constructor as `appResources`. Tool
   * handlers can also access it via `FunctionCallParams.appResources`. The
   * framework returns the original reference; mutations are visible to all
   * callers. `null` if none were passed.
   */
  get appResources(): unknown {
    return this._appResources;
  }

  /**
   * The full pipeline managed by this pipeline worker. This also includes any
   * internal processors added by the pipeline worker.
   */
  get pipeline(): BasePipeline {
    return this._pipeline;
  }

  /**
   * Create the pipeline-scoped tracing context and the latency and turn trace
   * observers (with turn tracking enabled), and return the observers to add.
   */
  protected _createTracingObservers(): BaseObserver[] {
    if (!this._turnTrackingObserver) {
      return [];
    }
    // Create pipeline-scoped tracing context
    this._tracingContext = new TracingContext();
    // Create latency observer for tracing
    this._userBotLatencyObserver = new UserBotLatencyObserver();
    // Create turn trace observer with latency tracking
    this._turnTraceObserver = new TurnTraceObserver({
      turnTracker: this._turnTrackingObserver,
      latencyTracker: this._userBotLatencyObserver,
      conversationId: this._conversationId,
      additionalSpanAttributes: this._additionalSpanAttributes,
      tracingContext: this._tracingContext,
    });
    return [this._userBotLatencyObserver, this._turnTraceObserver];
  }

  /** The turn tracking observer if enabled, or null. */
  get turnTrackingObserver(): TurnTrackingObserver | null {
    return this._turnTrackingObserver;
  }

  /** The turn trace observer if enabled, or null. */
  get turnTraceObserver(): TurnTraceObserver | null {
    return this._turnTraceObserver;
  }

  /** The RTVI processor added to the pipeline when RTVI is enabled. */
  get rtvi(): RTVIProcessor {
    if (!this._rtvi) {
      throw new Error(`${this} RTVI is not enabled.`);
    }
    return this._rtvi;
  }

  /** Frame types that trigger the on_frame_reached_upstream event. */
  get reachedUpstreamTypes(): FrameClass[] {
    return [...this._reachedUpstreamTypes];
  }

  /** Frame types that trigger the on_frame_reached_downstream event. */
  get reachedDownstreamTypes(): FrameClass[] {
    return [...this._reachedDownstreamTypes];
  }

  /**
   * Add an observer to monitor pipeline execution.
   *
   * @param observer The observer to add to the pipeline monitoring.
   */
  addObserver(observer: BaseObserver): void {
    this._observer.addObserver(observer);
  }

  /**
   * Remove an observer from pipeline monitoring.
   *
   * @param observer The observer to remove from pipeline monitoring.
   */
  async removeObserver(observer: BaseObserver): Promise<void> {
    await this._observer.removeObserver(observer);
  }

  /**
   * Set which frame types trigger the on_frame_reached_upstream event.
   *
   * @param types Frame types to monitor for upstream events.
   */
  setReachedUpstreamFilter(types: readonly FrameClass[]): void {
    this._reachedUpstreamTypes = new Set(types);
  }

  /**
   * Set which frame types trigger the on_frame_reached_downstream event.
   *
   * @param types Frame types to monitor for downstream events.
   */
  setReachedDownstreamFilter(types: readonly FrameClass[]): void {
    this._reachedDownstreamTypes = new Set(types);
  }

  /**
   * Add frame types to trigger the on_frame_reached_upstream event.
   *
   * @param types Frame types to add to upstream monitoring.
   */
  addReachedUpstreamFilter(types: readonly FrameClass[]): void {
    for (const t of types) this._reachedUpstreamTypes.add(t);
  }

  /**
   * Add frame types to trigger the on_frame_reached_downstream event.
   *
   * @param types Frame types to add to downstream monitoring.
   */
  addReachedDownstreamFilter(types: readonly FrameClass[]): void {
    for (const t of types) this._reachedDownstreamTypes.add(t);
  }

  /**
   * Check if the pipeline worker has finished execution.
   *
   * This indicates whether the worker has finished, meaning all processors
   * have stopped.
   *
   * @returns True if all processors have stopped and the worker is complete.
   */
  hasFinished(): boolean {
    return this._finished;
  }

  /**
   * Schedule the pipeline to stop after processing all queued frames.
   *
   * Sends an EndFrame to gracefully terminate the pipeline once all current
   * processing is complete.
   */
  async stopWhenDone(): Promise<void> {
    logger.debug(`Task ${this} scheduled to stop when done`);
    await this.queueFrame(new EndFrame());
  }

  /**
   * Request a graceful end of the session, draining the pipeline first.
   *
   * Whatever this worker has already pushed reaches the end of the pipeline
   * before the session goes away, rather than being cut off wherever it
   * happened to be.
   *
   * @param options.reason Optional human-readable reason for ending.
   */
  override async end(options: { reason?: string | null } = {}): Promise<void> {
    await this._drainPipeline();
    await super.end({ reason: options.reason ?? null });
  }

  /**
   * Activate a worker by name, draining this pipeline when handing over.
   *
   * Deactivating this worker before its pipeline drains would let the target
   * start producing while this worker's output is still in flight, and both
   * would arrive interleaved. A worker that stays active is handing nothing
   * over, so it doesn't wait: the first activation of a session would
   * otherwise wait on the very worker it is about to wake.
   *
   * @param workerName The name of the worker to activate.
   * @param options.args Optional `WorkerActivationArgs` forwarded to the
   *   target worker's `onActivated`.
   * @param options.deactivateSelf Whether to deactivate this worker before
   *   activating the target. Deactivating this worker drains its pipeline
   *   first; staying active does not. A worker that stays active and wants to
   *   drain anyway can call `flushPipeline` before this.
   */
  override async activateWorker(
    workerName: string,
    options: { args?: WorkerActivationArgs | null; deactivateSelf?: boolean } = {},
  ): Promise<void> {
    const deactivateSelf = options.deactivateSelf ?? false;
    if (deactivateSelf) {
      await this._drainPipeline();
    }
    await super.activateWorker(workerName, { args: options.args ?? null, deactivateSelf });
  }

  /**
   * Wait for in-flight frames to be processed, if any can be.
   *
   * A pipeline that is not running has no one left to bounce the flush probe
   * back, so waiting on it would only spend the flush timeout.
   * `_processPushTask` is created with the worker's tasks and cleared once
   * they are torn down, so it stands for whether there is a pipeline to
   * drain.
   */
  protected async _drainPipeline(): Promise<void> {
    if (this._processPushTask === null || this.hasFinished()) {
      return;
    }
    if (!(await this.flushPipeline())) {
      logger.warning(
        `${this}: proceeding without draining; whatever is still in flight will be cut off`,
      );
    }
  }

  /**
   * Request the running pipeline to cancel.
   *
   * @param options.reason Optional reason to indicate why the pipeline is being cancelled.
   */
  override async cancel(options: { reason?: string | null } = {}): Promise<void> {
    if (!this._finished) {
      await this._cancel({ reason: options.reason ?? null });
    }
  }

  /**
   * Start and manage the pipeline execution until completion or cancellation.
   *
   * @param params Configuration parameters for pipeline execution.
   */
  override async run(params: WorkerParams): Promise<void> {
    if (this.hasFinished()) {
      return;
    }

    try {
      // Set the worker up and start setting processors up. Processors are set
      // up in the background, see _watchPipelineSetup().
      if (!(await this._setupWithinTimeout(params))) {
        // Nothing was pushed into the pipeline, so there is nothing to drain:
        // release whatever was set up and give up.
        await this._cleanup(true);
        return;
      }

      // Create the worker's tasks and wait for the push task, which feeds
      // frames to the very beginning of our pipeline (i.e. to our controlled
      // source processor).
      await this._createTasks();

      try {
        // Wait for pipeline to finish.
        await this._waitForPipelineFinished();
      } catch (e) {
        if (!(e instanceof CancelledError)) throw e;
        logger.debug(`Pipeline worker ${this} got cancelled from outside...`);
        // We have been cancelled from outside, let's just cancel everything.
        await this._cancel();
        // Wait again for pipeline to finish. This time we have really
        // cancelled, so it should really finish.
        await this._waitForPipelineFinished();
        // Re-throw in case there's more cleanup to do.
        throw e;
      }
    } finally {
      // We can reach this point for different reasons:
      //
      // 1. The pipeline worker has finished (try case).
      // 2. By a task cancellation (catch case).
      logger.debug(`Pipeline worker ${this} is finishing...`);
      await this._cancelTasks();
      this._printDanglingTasks();
      await this._cancelChildren();
      this._finished = true;
      logger.debug(`Pipeline worker ${this} has finished`);
    }
  }

  /**
   * Queue a single frame to be pushed through the pipeline.
   *
   * Downstream frames are pushed from the beginning of the pipeline. Upstream
   * frames are pushed from the end of the pipeline.
   *
   * @param frame The frame to be processed.
   * @param direction The direction to push the frame. Defaults to downstream.
   */
  async queueFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (direction === FrameDirection.DOWNSTREAM) {
      await this._pushQueue.put(frame);
    } else {
      await this._sink.queueFrame(frame, direction);
    }
  }

  /**
   * Queue multiple frames to be pushed through the pipeline.
   *
   * Downstream frames are pushed from the beginning of the pipeline. Upstream
   * frames are pushed from the end of the pipeline.
   *
   * @param frames An iterable or async iterable of frames to be processed.
   * @param direction The direction to push the frames. Defaults to downstream.
   */
  async queueFrames(
    frames: Iterable<Frame> | AsyncIterable<Frame>,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (Symbol.asyncIterator in frames) {
      for await (const frame of frames) {
        await this.queueFrame(frame, direction);
      }
    } else if (Symbol.iterator in frames) {
      for (const frame of frames) {
        await this.queueFrame(frame, direction);
      }
    }
  }

  /**
   * Flush all in-flight frames from the pipeline and wait for it to drain.
   *
   * Pushes a `PipelineFlushFrame` downstream to the sink, then a new probe
   * back up to the source and a third down to the sink again, and waits for
   * that last one to arrive. By then every frame queued ahead of the flush has
   * been processed, along with anything a processor started by pushing
   * upstream. The first probe goes on the worker's push queue, behind whatever
   * is already waiting there, and bypasses any `queueFrame` override (e.g.
   * tool-call deferral).
   *
   * @param timeout Seconds of no progress before giving up. Progress is a
   *   frame reaching this worker's sink, or a report from the pipeline
   *   answering the probe when it crossed into another worker. A pipeline
   *   still working keeps the wait alive, however long it takes; one that is
   *   stuck, or that nobody will answer, gives up after this much quiet. On
   *   giving up a warning is logged and `false` is returned rather than
   *   blocking forever.
   * @returns True if the pipeline drained, false if it went quiet first.
   */
  async flushPipeline(timeout = 5.0): Promise<boolean> {
    const event = new Event();
    const probe = new PipelineFlushFrame({ event, origin: this.name });

    logger.debug(`${this}: pushing flush probe downstream`);

    this._flushProgress.set(probe.flushId, 0);
    try {
      await this._pushQueue.put(probe);
      for (;;) {
        const frames = this._framesReachingSink;
        const reports = this._flushProgress.get(probe.flushId);
        try {
          await waitFor(() => event.wait(), timeout);
          return true;
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          const reported = this._flushProgress.get(probe.flushId) !== reports;
          if (this._framesReachingSink === frames && !reported) {
            logger.warning(`${this}: pipeline flush gave up after ${timeout}s of no progress`);
            return false;
          }
          if (reported) {
            logger.debug(`${this}: flush still in flight, whoever has it is working`);
          }
        }
      }
    } finally {
      this._flushProgress.delete(probe.flushId);
    }
  }

  /**
   * Report progress on a probe from another worker while we hold it.
   *
   * Called by whoever brings the probe into this pipeline, since only they
   * know it is really coming in: every worker on the bus sees it, but most of
   * them have nowhere to put it.
   *
   * @param frame The flush probe entering this pipeline.
   */
  trackFlushProbe(frame: PipelineFlushFrame): void {
    if (this._handleFlushFrame && frame.origin && frame.origin !== this.name) {
      this._foreignProbes.set(frame.flushId, frame.origin);
    }
  }

  /**
   * Handle outbound bus messages: TTS playback and RTVI UI translation.
   *
   * Runs the base lifecycle/job dispatch first. A `BusTTSSpeakMessage`
   * targeted at this worker is queued as a `TTSSpeakFrame` (pipelines without
   * a TTS service let it flow through). When this worker owns the RTVI
   * processor, UI carriers produced by a `UIWorker` (`BusUIDataMessage`
   * subclasses) are translated into RTVI frames by `_handleUiBusMessage`;
   * other workers skip the translation.
   */
  override async onBusMessage(message: BusMessage): Promise<void> {
    await super.onBusMessage(message);

    // `BaseWorker.onBusMessage` already drops targeted messages for other
    // workers, but it returns early before reaching here -- re-apply the
    // filter before queueing pipeline frames.
    if (message.target && message.target !== this.name) {
      return;
    }

    if (message instanceof BusFrameMessage) {
      await this._queueBridgedFrame(message);
    } else if (message instanceof BusFlushProgressMessage) {
      const progress = this._flushProgress.get(message.flushId);
      if (progress !== undefined) {
        this._flushProgress.set(message.flushId, progress + 1);
      }
    } else if (message instanceof BusTTSSpeakMessage) {
      await this.queueFrame(
        new TTSSpeakFrame({ text: message.text, appendToContext: message.appendToContext }),
      );
    } else if (this._rtvi && message instanceof BusUIDataMessage) {
      await this._handleUiBusMessage(message);
    }
  }

  /**
   * Queue a frame that reached this worker over the bus.
   *
   * Queued rather than pushed from the edge that captured the outbound
   * direction, so bus inbound serialises with the frames this worker queues
   * itself (e.g. those a flow framework enqueues from `setNode`).
   *
   * @param message The frame carrier to inject.
   */
  protected async _queueBridgedFrame(message: BusFrameMessage): Promise<void> {
    if (this._bridged === null) {
      return;
    }
    if (message.source === this.name) {
      return;
    }
    if (this._bridged.length > 0 && !this._bridged.includes(message.bridge as string)) {
      return;
    }
    await this.queueFrame(message.frame, message.direction);
  }

  /**
   * Translate a UI carrier into the matching RTVI frame and queue it.
   *
   * Called only when this worker owns the RTVI processor. The `RTVIObserver`
   * later wraps the queued frame into a typed `ui-command` / `ui-job-group`
   * envelope for the client. Inbound carriers (e.g. `BusUIEventMessage`)
   * match no branch and are ignored.
   */
  protected async _handleUiBusMessage(message: BusUIDataMessage): Promise<void> {
    let frame: Frame | null = null;
    if (message instanceof BusUICommandMessage) {
      frame = new RTVIUICommandFrame({
        command: message.commandName,
        payload: message.payload,
      });
    } else if (message instanceof BusUIJobGroupStartedMessage) {
      frame = new RTVIUIJobGroupFrame({
        data: new RTVI.UIJobGroupStartedData({
          jobId: message.jobId,
          workers: [...(message.workers ?? [])],
          label: message.label,
          cancellable: message.cancellable,
          at: message.at,
        }),
      });
    } else if (message instanceof BusUIJobUpdateMessage) {
      frame = new RTVIUIJobGroupFrame({
        data: new RTVI.UIJobUpdateData({
          jobId: message.jobId,
          workerName: message.workerName,
          data: message.data,
          at: message.at,
        }),
      });
    } else if (message instanceof BusUIJobCompletedMessage) {
      frame = new RTVIUIJobGroupFrame({
        data: new RTVI.UIJobCompletedData({
          jobId: message.jobId,
          workerName: message.workerName,
          status: message.status,
          response: message.response,
          at: message.at,
        }),
      });
    } else if (message instanceof BusUIJobGroupCompletedMessage) {
      frame = new RTVIUIJobGroupFrame({
        data: new RTVI.UIJobGroupCompletedData({
          jobId: message.jobId,
          at: message.at,
        }),
      });
    }

    if (frame !== null) {
      await this.queueFrame(frame);
    }
  }

  /**
   * Republish an inbound client UI message onto the bus.
   *
   * Translates a typed RTVI UI message from the client (`UIEventMessage`,
   * `UISnapshotMessage`, or `UICancelJobGroupMessage`) into a single
   * `BusUIEventMessage` carrier so `UIWorker` subscribers can dispatch it.
   * This is the inbound counterpart of `onBusMessage`. Unrecognized message
   * types are ignored.
   */
  protected async _republishUiMessageOnBus(message: unknown): Promise<void> {
    let eventName: string;
    let payload: unknown;
    if (message instanceof RTVI.UIEventMessage) {
      eventName = message.data.event;
      payload = message.data.payload;
    } else if (message instanceof RTVI.UISnapshotMessage) {
      eventName = UI_SNAPSHOT_EVENT_NAME;
      payload = message.data.tree.modelDump({ excludeNone: true });
    } else if (message instanceof RTVI.UICancelJobGroupMessage) {
      eventName = UI_CANCEL_JOB_GROUP_EVENT_NAME;
      payload = {
        job_id: message.data.jobId,
        reason: message.data.reason,
      };
    } else {
      return;
    }
    await this.sendBusMessage(
      new BusUIEventMessage({
        source: this.name,
        target: null,
        eventName,
        payload,
      }),
    );
  }

  /** Stop processors still setting up; they keep holding the StartFrame. */
  protected async _cancelPipelineSetup(): Promise<void> {
    if (this._pipelineSetupTask && !this._pipelineSetupTask.done()) {
      await this.cancelTask(this._pipelineSetupTask);
    }
  }

  /** Stop waiting for the pipeline to start, so it is only cleaned up. */
  protected async _cancelPipelineStart(): Promise<void> {
    if (this._pipelineStartTask && !this._pipelineStartTask.done()) {
      await this.cancelTask(this._pipelineStartTask);
    }
  }

  /**
   * Internal cancellation logic for the pipeline worker.
   *
   * @param options.reason Optional reason to indicate why the pipeline is being cancelled.
   */
  protected async _cancel(options: { reason?: string | null } = {}): Promise<void> {
    if (!this._cancelled) {
      logger.debug(`Cancelling pipeline worker ${this}`);
      this._cancelled = true;
      // Only pushed into a started pipeline: if the StartFrame hasn't reached
      // the end, cancelling the start task below means the pipeline is only
      // cleaned up and this CancelFrame is never pushed.
      await this.queueFrame(new CancelFrame({ reason: options.reason ?? null }));
      // Only request them: a processor's setup() may be what is cancelling,
      // and awaiting the setup task from inside it never returns.
      if (this._pipelineSetupTask && !this._pipelineSetupTask.done()) {
        this._pipelineSetupTask.cancel();
      }
      if (this._pipelineStartTask && !this._pipelineStartTask.done()) {
        this._pipelineStartTask.cancel();
      }
    }
  }

  /** Create and start all pipeline processing tasks. */
  protected async _createTasks(): Promise<void> {
    this._processPushTask = this.createTask(() => this._processPushQueue(), "_process_push_queue");
    this._setupWatchTask = this.createTask(
      () => this._watchPipelineSetup(),
      "_watch_pipeline_setup",
    );
  }

  /**
   * Give up on a pipeline whose processors don't finish setting up.
   *
   * Setting up is cancelled, so the processors still being set up keep
   * holding the StartFrame: the pipeline never starts and is only cleaned up,
   * as when setting the worker up times out.
   */
  protected async _watchPipelineSetup(): Promise<void> {
    const setupTask = this._pipelineSetupTask;
    if (!setupTask) {
      return;
    }
    try {
      await waitFor(() => shield(setupTask), this._setupTimeoutSecs);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      logger.error(
        `${this}: timeout setting the pipeline up ` +
          "(a processor blocked while connecting?), stopping the pipeline.",
      );
      await this._callEventHandler("on_setup_timeout");
      // Not _cancel(), which does nothing if the worker was cancelled before
      // setting up began.
      await this._cancelPipelineSetup();
      await this._cancelPipelineStart();
    }
  }

  /** Start heartbeat tasks if heartbeats are enabled and not already running. */
  protected _maybeStartHeartbeatTasks(): void {
    if (this._params.enableHeartbeats && this._heartbeatPushTask === null) {
      this._heartbeatPushTask = this.createTask(
        () => this._heartbeatPushHandler(),
        "_heartbeat_push_handler",
      );
      this._heartbeatMonitorTask = this.createTask(
        () => this._heartbeatMonitorHandler(),
        "_heartbeat_monitor_handler",
      );
    }
  }

  /** Start the idle monitoring task if an idle timeout is configured. */
  protected _maybeStartIdleTask(): void {
    if (this._idleTimeoutSecs) {
      this._idleMonitorTask = this.createTask(
        () => this._idleMonitorHandler(),
        "_idle_monitor_handler",
      );
    }
  }

  /** Cancel all running pipeline tasks. */
  protected async _cancelTasks(): Promise<void> {
    await this._cancelPipelineSetup();
    await this._cancelPipelineStart();
    if (this._setupWatchTask) {
      await this.cancelTask(this._setupWatchTask);
      this._setupWatchTask = null;
    }
    if (this._processPushTask) {
      await this.cancelTask(this._processPushTask);
      this._processPushTask = null;
    }

    await this._maybeCancelHeartbeatTasks();
    await this._maybeCancelIdleTask();
  }

  /** Cancel heartbeat tasks if they are running. */
  protected async _maybeCancelHeartbeatTasks(): Promise<void> {
    if (!this._params.enableHeartbeats) {
      return;
    }

    if (this._heartbeatPushTask) {
      await this.cancelTask(this._heartbeatPushTask);
      this._heartbeatPushTask = null;
    }

    if (this._heartbeatMonitorTask) {
      await this.cancelTask(this._heartbeatMonitorTask);
      this._heartbeatMonitorTask = null;
    }
  }

  /** Cancel the idle monitoring task if it is running. */
  protected async _maybeCancelIdleTask(): Promise<void> {
    if (this._idleMonitorTask) {
      await this.cancelTask(this._idleMonitorTask);
      this._idleMonitorTask = null;
    }
  }

  /** Create an initial metrics frame with zero values for all processors. */
  protected _initialMetricsFrame(): MetricsFrame {
    const processors = this._pipeline.processorsWithMetrics();
    const data: MetricsData[] = [];
    for (const p of processors) {
      data.push(new TTFBMetricsData({ processor: p.name, value: 0.0 }));
      data.push(new ProcessingMetricsData({ processor: p.name, value: 0.0 }));
    }
    return new MetricsFrame({ data });
  }

  /**
   * Push the StartFrame and wait for the pipeline to start.
   *
   * Pushing it waits too, while the pipeline is still held, so cancelling
   * this task gives up on both.
   *
   * @returns Whether the pipeline started; see `_waitForPipelineStart`.
   */
  protected async _startPipeline(): Promise<boolean> {
    // Processors read the pipeline configuration from FrameProcessorSetup.
    const frame = new StartFrame();
    frame.metadata = this._createStartMetadata();
    await this._pipeline.queueFrame(frame);
    return await this._waitForPipelineStart(frame);
  }

  /**
   * Wait for the start task, and return whether it started the pipeline (a
   * cancelled one didn't).
   */
  protected async _waitForStartTask(): Promise<boolean> {
    const startTask = this._pipelineStartTask;
    if (!startTask) {
      return false;
    }
    await wait([startTask]);
    if (startTask.cancelled()) {
      return false;
    }
    return Boolean(startTask.result());
  }

  /**
   * Wait for the specified start frame to reach the end of the pipeline.
   *
   * @returns Whether the pipeline started. A pipeline that doesn't start
   *   within `startTimeoutSecs` is torn down, since nothing pushed into it
   *   afterwards would be processed.
   */
  protected async _waitForPipelineStart(frame: Frame): Promise<boolean> {
    logger.debug(`${this}: Starting. Waiting for ${frame} to reach the end of the pipeline...`);
    // Setting up has its own timeout, so the start timeout only counts from
    // the moment every processor is set up.
    if (this._pipelineSetupTask) {
      await wait([this._pipelineSetupTask]);
    }
    try {
      await waitFor(() => this._pipelineStartEvent.wait(), this._startTimeoutSecs);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      logger.error(
        `${this}: timeout waiting for ${frame} to reach the end of the pipeline ` +
          "(being blocked somewhere?), stopping the pipeline.",
      );
      await this._callEventHandler("on_pipeline_timeout", frame);
      return false;
    }
    this._pipelineStartEvent.clear();
    logger.debug(`${this}: ${frame} reached the end of the pipeline, pipeline is now ready.`);
    return true;
  }

  /** Wait for the specified frame to reach the end of the pipeline. */
  protected async _waitForPipelineEnd(frame: Frame): Promise<void> {
    const waitForCancel = async (): Promise<void> => {
      try {
        await waitFor(() => this._pipelineEndEvent.wait(), this._cancelTimeoutSecs);
        logger.debug(`${this}: ${frame} reached the end of the pipeline.`);
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        logger.warning(
          `${this}: timeout waiting for ${frame} to reach the end of the pipeline (being blocked somewhere?).`,
        );
        await this._callEventHandler("on_pipeline_timeout", frame);
      } finally {
        await this._callEventHandler("on_pipeline_finished", frame);
      }
    };

    logger.debug(`${this}: Closing. Waiting for ${frame} to reach the end of the pipeline...`);

    if (frame instanceof CancelFrame) {
      await waitForCancel();
    } else {
      // Ending flushes what is queued, so cutting the wait short would drop
      // the audio the EndFrame exists to play out. A processor that could
      // hold it up watches for that itself.
      await this._pipelineEndEvent.wait();
      logger.debug(`${this}: ${frame} reached the end of the pipeline, pipeline is closing.`);
    }

    this._pipelineEndEvent.clear();

    // We are really done. Setting `_finishedEvent` makes `BaseWorker.wait()`
    // resolve for callers awaiting this worker.
    this._finishedEvent.set();
  }

  protected async _waitForPipelineFinished(): Promise<void> {
    await this._finishedEvent.wait();
    // Make sure we wait for the push task to complete.
    if (this._processPushTask) {
      await this._processPushTask;
      this._processPushTask = null;
    }
  }

  /**
   * Set up the pipeline worker, bounded by a timeout.
   *
   * Processors are only started being set up here; their setup is bounded
   * separately by `_watchPipelineSetup`.
   *
   * @returns Whether the worker was set up. Setup files and observers that
   *   block never let the pipeline start, so setting up is abandoned once
   *   `setupTimeoutSecs` elapses.
   */
  protected async _setupWithinTimeout(params: WorkerParams): Promise<boolean> {
    try {
      await waitFor(() => this._setup(params), this._setupTimeoutSecs);
      return true;
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      logger.error(
        `${this}: timeout setting the pipeline up ` +
          "(a processor blocked while connecting?), stopping the pipeline.",
      );
      await this._callEventHandler("on_setup_timeout");
      return false;
    }
  }

  /** Set up the pipeline worker and all processors. */
  protected async _setup(params: WorkerParams): Promise<void> {
    // Processors connect while they are set up and push frames as they do, so
    // the clock runs from here rather than from the StartFrame, which would
    // leave those frames timestamped zero.
    this._clock.start();

    await super.setup(this._taskManager ?? params.taskManager);

    // Do any additional pipeline worker setup externally.
    await this._loadSetupFiles();

    // Core imports OpenTelemetry asynchronously: a worker built before that
    // import finished (e.g. at module top level) turns tracing on here,
    // before the observers start and the processors get `enableTracing`.
    if (this._tracingRequested && !this._enableTracing && (await loadOpenTelemetry())) {
      this._enableTracing = true;
      for (const observer of this._createTracingObservers()) {
        this._observer.addObserver(observer);
      }
    }

    // Start worker observer.
    await this._observer.setup(this.taskManager);

    // Setup processors
    const setup = new FrameProcessorSetup({
      audioInSampleRate: this._params.audioInSampleRate,
      audioOutSampleRate: this._params.audioOutSampleRate,
      clock: this._clock,
      enableExpressiveConversation: this._params.enableExpressiveConversation,
      enableMetrics: this._params.enableMetrics,
      enableTracing: this._enableTracing,
      enableUsageMetrics: this._params.enableUsageMetrics,
      expressionPolicy: this._params.expressionPolicy,
      observer: this._observer,
      pipelineWorker: this,
      reportOnlyInitialTtfb: this._params.reportOnlyInitialTtfb,
      taskManager: this.taskManager,
      tracingContext: this._tracingContext,
    });
    this._pipeline._setupStarted();
    const setupTask = this.createTask(() => this._pipeline.setup(setup), "setup");
    this._pipelineSetupTask = setupTask;
    // The StartFrame is pushed right away and each processor holds it until
    // its own setup is done (see BasePipeline._setupProcessors()).
    setupTask.addDoneCallback((task: Task<unknown>) => this._pipelineSetupDone(task));
    // Created together, so a cancel always finds both: with the setup
    // cancelled but no start task to cancel, the start would wait forever on
    // a pipeline that is never released.
    this._pipelineStartTask = this.createTask(() => this._startPipeline(), "_start_pipeline");
  }

  /**
   * Release the pipeline once it is set up, unless setting up was abandoned.
   *
   * A cancelled setup (timed out, or the worker was cancelled) keeps the
   * StartFrame held, so the pipeline never starts and is only cleaned up.
   */
  protected _pipelineSetupDone(task: Task<unknown>): void {
    if (!task.cancelled()) {
      this._pipeline._setupFinished();
    }
  }

  /** Clean up the pipeline worker and processors. */
  protected async _cleanup(cleanupPipeline: boolean): Promise<void> {
    // Cleanup base object.
    await this.cleanup();

    // Cleanup observers.
    await this._observer.cleanup();

    // End conversation tracing if it's active - this will also close any
    // active turn span
    if (this._enableTracing && this._turnTraceObserver) {
      this._turnTraceObserver.endConversationTracing();
    }

    // Cleanup pipeline processors.
    if (cleanupPipeline) {
      await this._pipeline.cleanup();
    }

    // Nothing left to answer a probe we are still holding.
    this._foreignProbes.clear();
  }

  /**
   * Cancel the children once this worker's pipeline is over.
   *
   * A pipeline that ends on its own (an `EndFrame` it queued itself, an idle
   * timeout, a permanent error) is never told to end over the bus, so nothing
   * has passed the end on to its children. A child that has already finished
   * takes no notice.
   */
  protected async _cancelChildren(): Promise<void> {
    for (const child of this._children) {
      await this.sendBusMessage(
        new BusCancelWorkerMessage({
          source: this.name,
          target: child.name,
          reason: `${this.name} finished`,
        }),
      );
    }
  }

  /**
   * End the pipeline after propagating end to children.
   *
   * Drives shutdown through the pipeline (`EndFrame`) so `_finishedEvent`
   * fires once the frame drains through the sink, rather than calling
   * `stop()` directly.
   */
  protected override async _handleWorkerEnd(message: BusEndWorkerMessage): Promise<void> {
    logger.debug(`Worker '${this}': received end`);
    await this._propagateEndToChildren(message);
    await this.queueFrame(new EndFrame({ reason: message.reason }));
  }

  /**
   * Cancel the pipeline after propagating cancel to children.
   *
   * Drives shutdown through the pipeline (`CancelFrame`) so `_finishedEvent`
   * fires once the frame drains, rather than calling `stop()` directly.
   *
   * Children are told whatever state this worker is in: one that cancelled
   * itself earlier, on an idle timeout or a permanent error, still has to
   * pass the runner's cancel on.
   */
  protected override async _handleWorkerCancel(message: BusCancelWorkerMessage): Promise<void> {
    logger.debug(`Worker '${this}': received cancel`);
    await this._propagateCancelToChildren(message);
    await this.cancel({ reason: message.reason });
  }

  /**
   * Process frames from the push queue and send them through the pipeline.
   *
   * Once the start task has started the pipeline, it pushes the frames queued
   * by the user. It runs until the worker is cancelled or stopped (e.g. with
   * an EndFrame).
   */
  protected async _processPushQueue(): Promise<void> {
    // No other frame goes in before the pipeline has started; one that
    // hasn't started is only cleaned up.
    let running = await this._waitForStartTask();

    if (running) {
      this._maybeStartIdleTask();
    }

    if (running && this._params.enableMetrics && this._params.sendInitialEmptyMetrics) {
      await this._pipeline.queueFrame(this._initialMetricsFrame());
    }

    // A pipeline that never started can't process anything we push into it,
    // so skip straight to cleanup.
    let cleanupPipeline = true;
    while (running) {
      const frame = await this._pushQueue.get();
      await this._pipeline.queueFrame(frame);
      const isLast =
        frame instanceof CancelFrame || frame instanceof EndFrame || frame instanceof StopFrame;
      if (isLast) {
        await this._waitForPipelineEnd(frame);
      }
      running = !isLast;
      cleanupPipeline = !(frame instanceof StopFrame);
      this._pushQueue.taskDone();
    }
    await this._cleanup(cleanupPipeline);
  }

  /**
   * Move a flush probe along its trip, settling it once it is done.
   *
   * The probe travels down to the sink, back up to the source, then down
   * again, and only the second arrival at the sink settles it. The extra leg
   * is what makes the probe wait for work a processor starts by pushing
   * upstream: an `LLMContextFrame` pushed up after a function call result,
   * say, whose response only comes back down afterwards. A probe that stopped
   * at the source would return while that response was still being
   * generated, or still being synthesized. Each leg is pushed as a new probe
   * with the same `flushId`.
   *
   * @param frame The probe, carrying the event its initiator awaits.
   * @param atSink Whether the probe has arrived at the sink or the source.
   */
  protected async _advanceFlushProbe(frame: PipelineFlushFrame, atSink: boolean): Promise<void> {
    if (!atSink) {
      logger.debug(`${this}: flush probe reached source — sending it down again`);
      const probe = new PipelineFlushFrame({
        event: frame.event,
        origin: frame.origin,
        flushId: frame.flushId,
        returning: true,
      });
      await this._source.pushFrame(probe, FrameDirection.DOWNSTREAM);
    } else if (!frame.returning) {
      logger.debug(`${this}: flush probe reached sink — bouncing upstream`);
      const probe = new PipelineFlushFrame({
        event: frame.event,
        origin: frame.origin,
        flushId: frame.flushId,
      });
      await this._sink.pushFrame(probe, FrameDirection.UPSTREAM);
    } else {
      logger.debug(`${this}: flush probe reached sink again — pipeline drained`);
      this._foreignProbes.delete(frame.flushId);
      if (frame.event) {
        frame.event.set();
      }
    }
  }

  /**
   * Tell whoever is waiting on a probe we hold that we are still working.
   *
   * Their own sink sees nothing while we drain, so without this they can only
   * conclude the pipeline has gone quiet. Sent no more than once a second: it
   * says the flush is alive, not how much is left.
   */
  protected async _reportFlushProgress(): Promise<void> {
    const now = monotonic();
    if (now - this._flushProgressSent < FLUSH_PROGRESS_PERIOD_SECS) {
      return;
    }
    this._flushProgressSent = now;
    // Over a snapshot: sending suspends on a network bus, and a probe arriving
    // meanwhile would change the map under the loop.
    for (const [flushId, origin] of [...this._foreignProbes.entries()]) {
      await this.bus.send(
        new BusFlushProgressMessage({ source: this.name, target: origin, flushId }),
      );
    }
  }

  /**
   * Process frames coming upstream from the pipeline.
   *
   * These frames might indicate, for example, that we want the pipeline to be
   * stopped (e.g. EndWorkerFrame) in which case we would send an EndFrame
   * down the pipeline.
   */
  protected async _sourcePushFrame(frame: Frame, _direction: FrameDirection): Promise<void> {
    if (isInstanceOfAny(frame, this._reachedUpstreamTypes)) {
      await this._callEventHandler("on_frame_reached_upstream", frame);
    }

    if (frame instanceof EndWorkerFrame) {
      // Tell the worker we should end nicely.
      logger.debug(`${this}: received end worker frame upstream ${frame}`);
      await this.queueFrame(new EndFrame({ reason: frame.reason }));
    } else if (frame instanceof CancelWorkerFrame) {
      // Tell the worker we should end right away.
      logger.debug(`${this}: received cancel worker frame upstream ${frame}`);
      await this.queueFrame(new CancelFrame({ reason: frame.reason }));
    } else if (frame instanceof StopWorkerFrame) {
      // Tell the worker we should stop nicely.
      logger.debug(`${this}: received stop worker frame upstream ${frame}`);
      await this.queueFrame(new StopFrame());
    } else if (frame instanceof InterruptionWorkerFrame) {
      // Tell the worker we should interrupt the pipeline. Note that we are
      // bypassing the push queue and directly queue into the pipeline. This
      // is in case the push task is blocked waiting for a pipeline-ending
      // frame to finish traversing the pipeline.
      logger.debug(`${this}: received interruption worker frame upstream ${frame}`);
      await this._pipeline.queueFrame(new InterruptionFrame());
    } else if (frame instanceof ErrorFrame) {
      await this._callEventHandler("on_pipeline_error", frame);
      if (frame.processor && !frame.processor.isUsable) {
        await this._handleUnusableProcessor(frame.processor);
      } else {
        logger.warning(`${this}: Something went wrong: ${frame}`);
      }
    } else if (frame instanceof PipelineFlushFrame && this._handleFlushFrame) {
      await this._advanceFlushProbe(frame, false);
    }
  }

  /**
   * Apply the unusable-processor policy, once per processor.
   *
   * A processor that can no longer do its job keeps failing for as long as
   * the pipeline keeps using it, so the policy is applied to the first error
   * that says so and not to the ones that follow.
   *
   * @param processor The processor that can no longer do its job.
   */
  protected async _handleUnusableProcessor(processor: FrameProcessor): Promise<void> {
    if (this._unusableProcessors.has(processor)) {
      return;
    }
    this._unusableProcessors.add(processor);

    logger.error(`${this}: ${processor} can no longer do its job`);

    if (this._processorUnusablePolicy === ProcessorUnusablePolicy.END) {
      await this.stopWhenDone();
    } else if (this._processorUnusablePolicy === ProcessorUnusablePolicy.CANCEL) {
      await this._cancel({ reason: `${processor} can no longer do its job` });
    }
  }

  /**
   * Process frames coming downstream from the pipeline.
   *
   * Processes frames coming downstream from the pipeline. For example,
   * heartbeat frames or an EndFrame which would indicate all processors have
   * handled the EndFrame and therefore we can exit the worker cleanly.
   */
  protected async _sinkPushFrame(frame: Frame, _direction: FrameDirection): Promise<void> {
    if (isInstanceOfAny(frame, this._reachedDownstreamTypes)) {
      await this._callEventHandler("on_frame_reached_downstream", frame);
    }

    // Heartbeats don't count: they arrive whether or not the pipeline is
    // doing anything, so counting them would make it always look busy.
    if (!(frame instanceof HeartbeatFrame)) {
      this._framesReachingSink += 1;
      if (this._foreignProbes.size > 0) {
        await this._reportFlushProgress();
      }
    }

    if (frame instanceof StartFrame) {
      await this._callEventHandler("on_pipeline_started", frame);
      await this._observer.onPipelineStarted();

      // Start heartbeat tasks now that StartFrame has been processed by all
      // processors in the pipeline
      this._maybeStartHeartbeatTasks();

      this._pipelineStartEvent.set();
    } else if (frame instanceof EndFrame) {
      await this._callEventHandler("on_pipeline_finished", frame);
      this._pipelineEndEvent.set();
    } else if (frame instanceof StopFrame) {
      await this._callEventHandler("on_pipeline_finished", frame);
      this._pipelineEndEvent.set();
    } else if (frame instanceof CancelFrame) {
      this._pipelineEndEvent.set();
    } else if (frame instanceof HeartbeatFrame) {
      await this._heartbeatQueue.put(frame);
    } else if (frame instanceof EndWorkerFrame) {
      logger.debug(`${this}: received end worker frame downstream ${frame}`);
      await this.queueFrame(new EndWorkerFrame({ reason: frame.reason }), FrameDirection.UPSTREAM);
    } else if (frame instanceof StopWorkerFrame) {
      logger.debug(`${this}: received stop worker frame downstream ${frame}`);
      await this.queueFrame(new StopWorkerFrame(), FrameDirection.UPSTREAM);
    } else if (frame instanceof CancelWorkerFrame) {
      logger.debug(`${this}: received cancel worker frame downstream ${frame}`);
      await this.queueFrame(
        new CancelWorkerFrame({ reason: frame.reason }),
        FrameDirection.UPSTREAM,
      );
    } else if (frame instanceof InterruptionWorkerFrame) {
      logger.debug(`${this}: received interruption worker frame downstream ${frame}`);
      await this.queueFrame(new InterruptionWorkerFrame(), FrameDirection.UPSTREAM);
    } else if (frame instanceof PipelineFlushFrame && this._handleFlushFrame) {
      await this._advanceFlushProbe(frame, true);
    }
  }

  /** Push heartbeat frames at regular intervals. */
  protected async _heartbeatPushHandler(): Promise<void> {
    for (;;) {
      // Don't use `queueFrame()` because if an EndFrame is queued the worker
      // will just stop waiting for the pipeline to finish not allowing more
      // frames to be pushed.
      await this._pipeline.queueFrame(new HeartbeatFrame({ timestamp: this._clock.getTime() }));
      await sleep(this._params.heartbeatsPeriodSecs);
    }
  }

  /**
   * Monitor heartbeat frames for processing time and timeout detection.
   *
   * Logs the time each heartbeat takes to traverse the pipeline. If no
   * heartbeat arrives within `heartbeatsMonitorSecs`, logs a warning and
   * fires `on_heartbeat_timeout`. The event fires repeatedly every
   * `heartbeatsMonitorSecs` for as long as the stall persists.
   */
  protected async _heartbeatMonitorHandler(): Promise<void> {
    const waitTime = this._params.heartbeatsMonitorSecs;
    for (;;) {
      try {
        const frame = await waitFor(() => this._heartbeatQueue.get(), waitTime);
        const processTime = (this._clock.getTime() - frame.timestamp) / 1_000_000_000;
        logger.trace(`${this}: heartbeat frame processed in ${processTime} seconds`);
        this._heartbeatQueue.taskDone();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        logger.warning(`${this}: heartbeat frame not received for more than ${waitTime} seconds`);
        await this._callEventHandler("on_heartbeat_timeout");
      }
    }
  }

  /**
   * Monitor pipeline activity and detect idle conditions.
   *
   * Tracks frame activity and triggers idle timeout events when the pipeline
   * hasn't received relevant frames within the timeout period.
   *
   * Note: Heartbeats are excluded from idle detection.
   */
  protected async _idleMonitorHandler(): Promise<void> {
    let running = true;
    while (running) {
      try {
        await waitFor(() => this._idleEvent.wait(), this._idleTimeoutSecs);
        this._idleEvent.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        running = await this._idleTimeoutDetected();
      }
    }
  }

  /**
   * Handle idle timeout detection and optional cancellation.
   *
   * @returns Whether the pipeline worker should continue running.
   */
  protected async _idleTimeoutDetected(): Promise<boolean> {
    // If we are cancelling, just exit the task.
    if (this._cancelled) {
      return false;
    }

    logger.warning("Idle timeout detected.");
    await this._callEventHandler("on_idle_timeout");
    if (!this._cancelOnIdleTimeout) {
      return true;
    }

    logger.warning("Idle pipeline detected, cancelling pipeline worker...");
    await this.cancel({ reason: "idle timeout" });
    if (this._cancelRunnerOnIdleTimeout) {
      logger.warning("...and cancelling the runner.");
      // `BaseWorker.cancel` sends `BusCancelMessage` on the bus so the runner
      // broadcasts cancellation to every other root worker too. This
      // worker's pipeline is already cancelling from the call above.
      await BaseWorker.prototype.cancel.call(this, { reason: "idle timeout" });
    }
    return false;
  }

  /**
   * Run `setupPipelineWorker` from each file in `PIPECAT_SETUP_FILES`.
   *
   * A setup file may define `setupPipelineWorker(worker)` to attach event
   * handlers, observers, or other per-worker wiring.
   */
  protected async _loadSetupFiles(): Promise<void> {
    await runSetupHook({
      target: this,
      functionName: "setup_pipeline_worker",
    });
  }

  /** Build and return start metadata including user-provided values. */
  protected _createStartMetadata(): Record<string, unknown> {
    const startMetadata: Record<string, unknown> = {};

    // Update with user provided metadata.
    Object.assign(startMetadata, this._params.startMetadata);

    return startMetadata;
  }

  /** Recursively yield the processors of the given type(s) in the pipeline. */
  protected *_iterProcessors<T>(
    processor: FrameProcessor,
    processorTypes: readonly AnyClass<T>[],
  ): Generator<T> {
    if (processorTypes.some((cls) => processor instanceof cls)) {
      yield processor as T;
    }
    for (const p of processor.processors) {
      yield* this._iterProcessors(p, processorTypes);
    }
  }
}

function firstOf<T>(iterable: Iterable<T>): T | null {
  for (const item of iterable) return item;
  return null;
}

function isInstanceOfAny(frame: Frame, types: Iterable<FrameClass>): boolean {
  for (const cls of types) {
    if (frame instanceof cls) return true;
  }
  return false;
}
