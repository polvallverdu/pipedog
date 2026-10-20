// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/ui/messages.py

/**
 * Bus carriers for the UI Worker protocol.
 *
 * These classes are the on-the-bus shape that a UI worker (see `workers/ui`)
 * and the client-facing worker exchange. They are NOT the on-the-wire format
 * the client sees: the client-facing worker translates between the two, in
 * whichever format its own client speaks.
 *
 * For example, `PipelineWorker` with RTVI enabled republishes inbound client
 * messages onto the bus in `onUiMessage` and turns outbound carriers into
 * RTVI frames in `onBusMessage`; the wire types it produces live in
 * `processors/frameworks/rtvi/models` (`UIEventMessage`, `UICommandMessage`,
 * `UIJobGroupMessage`, ...).
 *
 * All carriers subclass `BusUIDataMessage`, which a client-facing worker
 * dispatches on to pick the outbound ones out of its bus traffic.
 *
 * - `BusUIEventMessage` and `BusUICommandMessage` carry client events and
 *   server commands respectively.
 * - `BusUIJobGroupStartedMessage`, `BusUIJobUpdateMessage`,
 *   `BusUIJobCompletedMessage`, and `BusUIJobGroupCompletedMessage` carry the
 *   four phases of a user-facing job group's lifecycle (see `UIWorker`).
 *
 * The carriers live in the `bus` layer (rather than alongside `UIWorker`)
 * because both `PipelineWorker` (in `pipeline`) and `UIWorker` (in
 * `workers`) reference them, and `pipeline` must not import from `workers`.
 */

import { BusDataMessage, type BusMessageOptions } from "../messages.ts";

/**
 * The `eventName` of the client's accessibility snapshot on the bus. A
 * client-facing worker republishes a `ui-snapshot` wire message as a
 * `BusUIEventMessage` with this name, and `UIWorker` keeps the payload as its
 * latest snapshot. The leading double underscore keeps app-defined
 * `@ui_event` names from colliding with it.
 */
export const UI_SNAPSHOT_EVENT_NAME = "__ui_snapshot";

/**
 * The `eventName` of the client's request to cancel a job group. A
 * client-facing worker republishes a `ui-cancel-job-group` wire message as a
 * `BusUIEventMessage` with this name, and the worker that dispatched the
 * group turns it into a cancel request.
 */
export const UI_CANCEL_JOB_GROUP_EVENT_NAME = "__cancel_job_group";

/**
 * Base for all UI Worker protocol bus carriers.
 *
 * A client-facing worker dispatches on this type to translate a worker's
 * outbound UI carriers into its client's wire format, so every UI bus message
 * below subclasses it.
 */
export class BusUIDataMessage extends BusDataMessage {}

export interface BusUIEventMessageOptions extends BusMessageOptions {
  /** App-defined event name. */
  eventName?: string;
  /** App-defined payload. Schemaless by design. */
  payload?: unknown;
}

/**
 * A UI event sent from the client to a server-side worker.
 *
 * Emitted by the client-facing worker when the client dispatches an event via
 * `PipecatClient.sendUIEvent(event, payload)`. `UIWorker` subclasses dispatch
 * these to `@ui_event(name)` handlers.
 */
export class BusUIEventMessage extends BusUIDataMessage {
  eventName: string;
  payload: unknown;

  constructor(options: BusUIEventMessageOptions) {
    super(options);
    this.eventName = options.eventName ?? "";
    this.payload = options.payload ?? null;
  }
}

export interface BusUICommandMessageOptions extends BusMessageOptions {
  /** App-defined command name. */
  commandName?: string;
  /** App-defined payload (already a plain object by the time it lands on the bus). */
  payload?: unknown;
}

/**
 * A UI command sent from a server-side worker to the client.
 *
 * Published by `UIWorker.sendCommand(name, payload)`. The client-facing
 * worker translates it into a command on its client's wire format; over RTVI
 * that is an `RTVIUICommandFrame({ command: commandName, payload })` pushed
 * through the pipeline.
 */
export class BusUICommandMessage extends BusUIDataMessage {
  commandName: string;
  payload: unknown;

  constructor(options: BusUICommandMessageOptions) {
    super(options);
    this.commandName = options.commandName ?? "";
    this.payload = options.payload ?? null;
  }
}

// ---------------------------------------------------------------------------
// UI job-group lifecycle
// ---------------------------------------------------------------------------

export interface BusUIJobGroupStartedMessageOptions extends BusMessageOptions {
  /** Shared job-group identifier for the group. */
  jobId?: string;
  /** Names of the workers the work was dispatched to. */
  workers?: string[] | null;
  /** Optional human-readable label for the group. */
  label?: string | null;
  /** Whether the client may request cancellation. */
  cancellable?: boolean;
  /** Epoch milliseconds when the group started. */
  at?: number;
}

/**
 * A user-facing job group has been dispatched.
 *
 * Published by a `UIWorker` as it dispatches the group. The client-facing
 * worker forwards it as a `ui-job-group` envelope with
 * `kind = "group_started"`.
 */
export class BusUIJobGroupStartedMessage extends BusUIDataMessage {
  jobId: string;
  workers: string[] | null;
  label: string | null;
  cancellable: boolean;
  at: number;

  constructor(options: BusUIJobGroupStartedMessageOptions) {
    super(options);
    this.jobId = options.jobId ?? "";
    this.workers = options.workers ?? null;
    this.label = options.label ?? null;
    this.cancellable = options.cancellable ?? true;
    this.at = options.at ?? 0;
  }
}

export interface BusUIJobUpdateMessageOptions extends BusMessageOptions {
  /** The shared job-group identifier. */
  jobId?: string;
  /** The worker that produced the update. */
  workerName?: string;
  /** The worker's update payload, forwarded verbatim. */
  data?: unknown;
  /** Epoch milliseconds when the update was emitted on the bus. */
  at?: number;
}

/**
 * Per-worker progress for a user-facing job group.
 *
 * Forwarded by a `UIWorker` whenever a worker of one of its job groups emits
 * a `BusJobUpdateMessage`. The client-facing worker forwards it as a
 * `ui-job-group` envelope with `kind = "job_update"`.
 */
export class BusUIJobUpdateMessage extends BusUIDataMessage {
  jobId: string;
  workerName: string;
  data: unknown;
  at: number;

  constructor(options: BusUIJobUpdateMessageOptions) {
    super(options);
    this.jobId = options.jobId ?? "";
    this.workerName = options.workerName ?? "";
    this.data = options.data ?? null;
    this.at = options.at ?? 0;
  }
}

export interface BusUIJobCompletedMessageOptions extends BusMessageOptions {
  /** The shared job-group identifier. */
  jobId?: string;
  /** The worker that produced the response. */
  workerName?: string;
  /** Completion status as a string (`JobStatus` value). */
  status?: string;
  /** The worker's response payload. */
  response?: unknown;
  /** Epoch milliseconds when the response was received. */
  at?: number;
}

/**
 * A worker in a user-facing job group has completed.
 *
 * Forwarded by a `UIWorker` when a worker of one of its job groups reaches a
 * terminal state. The client-facing worker forwards it as a `ui-job-group`
 * envelope with `kind = "job_completed"`.
 */
export class BusUIJobCompletedMessage extends BusUIDataMessage {
  jobId: string;
  workerName: string;
  status: string;
  response: unknown;
  at: number;

  constructor(options: BusUIJobCompletedMessageOptions) {
    super(options);
    this.jobId = options.jobId ?? "";
    this.workerName = options.workerName ?? "";
    this.status = options.status ?? "";
    this.response = options.response ?? null;
    this.at = options.at ?? 0;
  }
}

export interface BusUIJobGroupCompletedMessageOptions extends BusMessageOptions {
  /** The shared job-group identifier. */
  jobId?: string;
  /** Epoch milliseconds when the group completed. */
  at?: number;
}

/**
 * A user-facing job group has completed.
 *
 * Published by a `UIWorker` once every worker in the group has finished, or
 * the group was cancelled. The client-facing worker forwards it as a
 * `ui-job-group` envelope with `kind = "group_completed"`.
 */
export class BusUIJobGroupCompletedMessage extends BusUIDataMessage {
  jobId: string;
  at: number;

  constructor(options: BusUIJobGroupCompletedMessageOptions) {
    super(options);
    this.jobId = options.jobId ?? "";
    this.at = options.at ?? 0;
  }
}
