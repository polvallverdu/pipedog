// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/messages.py

/**
 * Bus message types for inter-worker communication.
 *
 * Defines the message hierarchy used by the `WorkerBus` for pub/sub messaging
 * between workers and the runner.
 */

import type { Frame } from "../frames/frames.ts";
import type { JobStatus } from "../pipeline/job_context.ts";
import type { FrameDirection } from "../processors/frame_processor.ts";
import type { WorkerRegistryEntry } from "../registry/types.ts";
import { type Ctor, defineMixin } from "../utils/mixin.ts";
import { objCount, objId } from "../utils/utils.ts";
import type { BaseWorker } from "../workers/base_worker.ts";

// ---------------------------------------------------------------------------
// Base types and mixins
// ---------------------------------------------------------------------------

export interface BusMessageOptions {
  /** Name of the worker or component that sent this message. */
  source: string;
  /** Name of the intended recipient worker, or null for broadcast. */
  target?: string | null;
}

/**
 * Base class for messages carried by the `WorkerBus`.
 *
 * Bus messages are independent of pipeline `Frame`s — if a worker needs to
 * ship a frame between pipelines it wraps it in a `BusFrameMessage`.
 * Subclasses choose delivery priority by extending `BusDataMessage` (normal
 * priority, FIFO) or `BusSystemMessage` (high priority, delivered ahead of
 * queued data messages).
 *
 * - `id`: unique identifier for the message instance.
 * - `name`: human-readable name combining class name and instance count.
 * - `source`: name of the worker or component that sent this message.
 * - `target`: name of the intended recipient worker, or null for broadcast.
 */
export class BusMessage {
  id: number = objId();
  name: string = `${this.constructor.name}#${objCount(this)}`;
  source: string;
  target: string | null;

  constructor(options: BusMessageOptions) {
    this.source = options.source;
    this.target = options.target ?? null;
  }

  toString(): string {
    return `${this.name} (source=${this.source}, target=${this.target})`;
  }
}

/** Mixin: message stays on the local bus, never forwarded to remote buses. */
// biome-ignore lint/suspicious/noEmptyInterface: marker mixin with no members.
export interface BusLocalMessage {}

export const BusLocalMessage = defineMixin<
  BusLocalMessage,
  <B extends Ctor>(base: B) => B & Ctor<BusLocalMessage>
>("BusLocalMessage", <B extends Ctor>(Base: B) => {
  abstract class BusLocalMessageMixin extends Base implements BusLocalMessage {}
  return BusLocalMessageMixin;
});

/**
 * Normal-priority bus message.
 *
 * Delivered in FIFO order on the subscriber's data queue.
 */
export class BusDataMessage extends BusMessage {}

/**
 * High-priority bus message.
 *
 * Delivered ahead of any queued `BusDataMessage` on the subscriber's priority
 * queue.
 */
export class BusSystemMessage extends BusMessage {}

// ---------------------------------------------------------------------------
// Frame transport
// ---------------------------------------------------------------------------

export interface BusFrameMessageOptions extends BusMessageOptions {
  /** The Pipecat frame to transport. */
  frame: Frame;
  /** Direction the frame should travel in the recipient's pipeline. */
  direction: FrameDirection;
  /** Optional bridge name for routing in multi-bridge setups. */
  bridge?: string | null;
}

/** Wraps a Pipecat `Frame` for transport over the bus. */
export class BusFrameMessage extends BusDataMessage {
  frame: Frame;
  direction: FrameDirection;
  bridge: string | null;

  constructor(options: BusFrameMessageOptions) {
    super(options);
    this.frame = options.frame;
    this.direction = options.direction;
    this.bridge = options.bridge ?? null;
  }

  override toString(): string {
    return `${this.name}(frame: ${this.frame}, direction: ${this.direction}, bridge: ${this.bridge})`;
  }
}

// ---------------------------------------------------------------------------
// Pipeline commands
// ---------------------------------------------------------------------------

export interface BusTTSSpeakMessageOptions extends BusMessageOptions {
  /** The text to be spoken. */
  text: string;
  /**
   * Whether the spoken text should also be appended to the conversation
   * context (forwarded to `TTSSpeakFrame`). Defaults to true, matching
   * `TTSSpeakFrame.appendToContext`.
   */
  appendToContext?: boolean;
}

/**
 * Asks a `PipelineWorker` to speak the given text via its TTS service.
 *
 * On receipt, the worker queues a `TTSSpeakFrame` into its pipeline.
 * Pipelines without a TTS service let the frame flow through harmlessly.
 */
export class BusTTSSpeakMessage extends BusDataMessage {
  text: string;
  appendToContext: boolean;

  constructor(options: BusTTSSpeakMessageOptions) {
    super(options);
    this.text = options.text;
    this.appendToContext = options.appendToContext ?? true;
  }
}

export interface BusFlushProgressMessageOptions extends BusMessageOptions {
  /** The id of the probe being reported on. */
  flushId: number;
}

/**
 * Reports that a flush probe from another worker is still making progress.
 *
 * A probe that crosses into another pipeline is answered there, so the worker
 * waiting on it cannot see whether anything is happening. The pipeline
 * holding the probe says so, and the wait stays alive for as long as it keeps
 * saying it.
 */
export class BusFlushProgressMessage extends BusDataMessage {
  flushId: number;

  constructor(options: BusFlushProgressMessageOptions) {
    super(options);
    this.flushId = options.flushId;
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export interface BusActivateWorkerMessageOptions extends BusMessageOptions {
  /** Optional activation arguments forwarded to `onActivated`. */
  args?: Record<string, unknown> | null;
}

/** Tells a targeted worker to become active and start processing. */
export class BusActivateWorkerMessage extends BusDataMessage {
  args: Record<string, unknown> | null;

  constructor(options: BusActivateWorkerMessageOptions) {
    super(options);
    this.args = options.args ?? null;
  }
}

/** Tells a targeted worker to become inactive and stop processing. */
export class BusDeactivateWorkerMessage extends BusDataMessage {}

export interface BusReasonMessageOptions extends BusMessageOptions {
  /** Optional human-readable reason. */
  reason?: string | null;
}
export type BusEndMessageOptions = BusReasonMessageOptions;
export type BusEndWorkerMessageOptions = BusReasonMessageOptions;
export type BusCancelMessageOptions = BusReasonMessageOptions;
export type BusCancelWorkerMessageOptions = BusReasonMessageOptions;

/**
 * Request a graceful end of the session.
 *
 * Sent by a worker to the runner, which responds by sending
 * `BusEndWorkerMessage` to each worker.
 */
export class BusEndMessage extends BusDataMessage {
  /** Optional human-readable reason for ending. */
  reason: string | null;

  constructor(options: BusEndMessageOptions) {
    super(options);
    this.reason = options.reason ?? null;
  }
}

/**
 * Tells a targeted worker to end its pipeline gracefully.
 *
 * Sent by the runner to individual workers during shutdown.
 */
export class BusEndWorkerMessage extends BusDataMessage {
  /** Optional human-readable reason for ending. */
  reason: string | null;

  constructor(options: BusEndWorkerMessageOptions) {
    super(options);
    this.reason = options.reason ?? null;
  }
}

/**
 * Request a hard cancel of the session.
 *
 * Sent by a worker to the runner, which responds by sending
 * `BusCancelWorkerMessage` to each worker.
 */
export class BusCancelMessage extends BusSystemMessage {
  /** Optional human-readable reason for the cancellation. */
  reason: string | null;

  constructor(options: BusCancelMessageOptions) {
    super(options);
    this.reason = options.reason ?? null;
  }
}

/**
 * Tells a targeted worker to cancel its pipeline.
 *
 * Sent by the runner to individual workers during cancellation.
 */
export class BusCancelWorkerMessage extends BusSystemMessage {
  /** Optional human-readable reason for the cancellation. */
  reason: string | null;

  constructor(options: BusCancelWorkerMessageOptions) {
    super(options);
    this.reason = options.reason ?? null;
  }
}

// ---------------------------------------------------------------------------
// Worker registry and errors
// ---------------------------------------------------------------------------

export interface BusAddWorkerMessageOptions extends BusMessageOptions {
  /** The worker instance to add. */
  worker: BaseWorker;
}

/**
 * Request to add a worker to the local runner.
 *
 * Local-only: carries an in-memory worker reference that cannot be
 * serialized over the network.
 */
export class BusAddWorkerMessage extends BusLocalMessage(BusSystemMessage) {
  worker: BaseWorker;

  constructor(options: BusAddWorkerMessageOptions) {
    super(options);
    this.worker = options.worker;
  }
}

export interface BusWorkerRegistryMessageOptions extends BusMessageOptions {
  /** Name of the runner that owns these workers. */
  runner: string;
  /** List of worker entries with their state. */
  workers: WorkerRegistryEntry[];
}

/**
 * Snapshot of workers managed by a runner.
 *
 * Sent by the runner on startup and when new runners connect, so that remote
 * runners can discover each other's workers.
 */
export class BusWorkerRegistryMessage extends BusSystemMessage {
  runner: string;
  workers: WorkerRegistryEntry[];

  constructor(options: BusWorkerRegistryMessageOptions) {
    super(options);
    this.runner = options.runner;
    this.workers = options.workers;
  }
}

export interface BusWorkerReadyMessageOptions extends BusMessageOptions {
  /** Name of the runner managing this worker. */
  runner: string;
  /** Name of the parent worker, or null for root workers. */
  parent?: string | null;
  /** Whether the worker started active. */
  active?: boolean;
  /** Whether the worker is bridged (receives pipeline frames from the bus). */
  bridged?: boolean;
  /** Unix timestamp (seconds) when the worker became ready. */
  startedAt?: number | null;
}

/**
 * Announces that a worker is ready.
 *
 * Sent when any worker (root or child) becomes ready. Carries the worker's
 * parent name so observers can reconstruct the full hierarchy.
 */
export class BusWorkerReadyMessage extends BusDataMessage {
  runner: string;
  parent: string | null;
  active: boolean;
  bridged: boolean;
  startedAt: number | null;

  constructor(options: BusWorkerReadyMessageOptions) {
    super(options);
    this.runner = options.runner;
    this.parent = options.parent ?? null;
    this.active = options.active ?? false;
    this.bridged = options.bridged ?? false;
    this.startedAt = options.startedAt ?? null;
  }
}

export interface BusWorkerErrorMessageOptions extends BusMessageOptions {
  /** Description of the error. */
  error: string;
}

/**
 * Reports an error from a root worker.
 *
 * Sent over the network so remote workers can react. For child worker errors,
 * see `BusWorkerLocalErrorMessage`.
 */
export class BusWorkerErrorMessage extends BusSystemMessage {
  error: string;

  constructor(options: BusWorkerErrorMessageOptions) {
    super(options);
    this.error = options.error;
  }
}

export type BusWorkerLocalErrorMessageOptions = BusWorkerErrorMessageOptions;

/**
 * Reports an error from a child worker to its parent.
 *
 * Local-only: never crosses the network. The parent receives it via
 * `onWorkerFailed()`.
 */
export class BusWorkerLocalErrorMessage extends BusLocalMessage(BusSystemMessage) {
  error: string;

  constructor(options: BusWorkerLocalErrorMessageOptions) {
    super(options);
    this.error = options.error;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface BusJobRequestMessageOptions extends BusMessageOptions {
  /** Unique identifier for this job. */
  jobId: string;
  /** Optional job name for routing to named `@job` handlers. */
  jobName?: string | null;
  /** Optional structured data describing the work. */
  payload?: Record<string, unknown> | null;
}

/** Requests a worker worker to start work. */
export class BusJobRequestMessage extends BusDataMessage {
  jobId: string;
  jobName: string | null;
  payload: Record<string, unknown> | null;

  constructor(options: BusJobRequestMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.jobName = options.jobName ?? null;
    this.payload = options.payload ?? null;
  }
}

export interface BusJobResponseMessageOptions extends BusMessageOptions {
  /** The job identifier. */
  jobId: string;
  /** Completion status. */
  status: JobStatus;
  /** Optional result data. */
  response?: Record<string, unknown> | null;
}

/** Response from a worker worker when its job completes. */
export class BusJobResponseMessage extends BusDataMessage {
  jobId: string;
  status: JobStatus;
  response: Record<string, unknown> | null;

  constructor(options: BusJobResponseMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.status = options.status;
    this.response = options.response ?? null;
  }
}

export type BusJobResponseUrgentMessageOptions = BusJobResponseMessageOptions;

/**
 * High-priority job response.
 *
 * Same semantics as `BusJobResponseMessage` but delivered with system
 * priority, preempting queued data messages.
 */
export class BusJobResponseUrgentMessage extends BusSystemMessage {
  jobId: string;
  status: JobStatus;
  response: Record<string, unknown> | null;

  constructor(options: BusJobResponseUrgentMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.status = options.status;
    this.response = options.response ?? null;
  }
}

export interface BusJobUpdateMessageOptions extends BusMessageOptions {
  /** The job identifier. */
  jobId: string;
  /** Optional progress data. */
  update?: Record<string, unknown> | null;
}

/** Progress update from a worker worker. */
export class BusJobUpdateMessage extends BusDataMessage {
  jobId: string;
  update: Record<string, unknown> | null;

  constructor(options: BusJobUpdateMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.update = options.update ?? null;
  }
}

export type BusJobUpdateUrgentMessageOptions = BusJobUpdateMessageOptions;

/**
 * High-priority job progress update.
 *
 * Same semantics as `BusJobUpdateMessage` but delivered with system priority,
 * preempting queued data messages.
 */
export class BusJobUpdateUrgentMessage extends BusSystemMessage {
  jobId: string;
  update: Record<string, unknown> | null;

  constructor(options: BusJobUpdateUrgentMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.update = options.update ?? null;
  }
}

export interface BusJobUpdateRequestMessageOptions extends BusMessageOptions {
  /** The job identifier. */
  jobId: string;
}

/** Request a progress update from a worker worker. */
export class BusJobUpdateRequestMessage extends BusDataMessage {
  jobId: string;

  constructor(options: BusJobUpdateRequestMessageOptions) {
    super(options);
    this.jobId = options.jobId;
  }
}

export interface BusJobCancelMessageOptions extends BusMessageOptions {
  /** The job identifier. */
  jobId: string;
  /** Optional human-readable reason for cancellation. */
  reason?: string | null;
}

/** Cancel a running job. */
export class BusJobCancelMessage extends BusSystemMessage {
  jobId: string;
  reason: string | null;

  constructor(options: BusJobCancelMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.reason = options.reason ?? null;
  }
}

// ---------------------------------------------------------------------------
// Job streaming
// ---------------------------------------------------------------------------

export interface BusJobStreamMessageOptions extends BusMessageOptions {
  /** The job identifier. */
  jobId: string;
  /** Optional payload (metadata, chunk data or final metadata). */
  data?: Record<string, unknown> | null;
}
export type BusJobStreamStartMessageOptions = BusJobStreamMessageOptions;
export type BusJobStreamDataMessageOptions = BusJobStreamMessageOptions;
export type BusJobStreamEndMessageOptions = BusJobStreamMessageOptions;

/** Signals the start of a streaming job response. */
export class BusJobStreamStartMessage extends BusDataMessage {
  jobId: string;
  /** Optional metadata (e.g. content type). */
  data: Record<string, unknown> | null;

  constructor(options: BusJobStreamStartMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.data = options.data ?? null;
  }
}

/** A chunk of streaming job data. */
export class BusJobStreamDataMessage extends BusDataMessage {
  jobId: string;
  /** The chunk payload. */
  data: Record<string, unknown> | null;

  constructor(options: BusJobStreamDataMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.data = options.data ?? null;
  }
}

/** Signals the end of a streaming job response. */
export class BusJobStreamEndMessage extends BusDataMessage {
  jobId: string;
  /** Optional final metadata. */
  data: Record<string, unknown> | null;

  constructor(options: BusJobStreamEndMessageOptions) {
    super(options);
    this.jobId = options.jobId;
    this.data = options.data ?? null;
  }
}
