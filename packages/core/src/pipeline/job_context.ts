// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/job_context.py

/**
 * Worker group types for structured concurrent worker execution.
 *
 * Porting notes:
 * - `async with ctx:` becomes `await ctx.run(async (ctx) => { ... })`, or the
 *   explicit `await ctx.enter()` / `await ctx.exit(error)` pair.
 * - `async for event in ctx` is `for await (const event of ctx)`.
 * - The deprecated `resolve_job_params()` (and the per-argument job spelling
 *   it absorbs) is not ported.
 */

import { Event, Queue, shield, type Task } from "@pipecat-ts/asyncio";
import type { BaseWorker } from "../workers/base_worker.ts";

/** A job payload or response: structured JSON-like data. */
export type JobPayload = Record<string, unknown>;

export interface JobParamsOptions {
  name?: string | null;
  payload?: JobPayload | null;
  timeout?: number | null;
  label?: string | null;
  cancellable?: boolean;
}

/**
 * Configuration for a job sent to a single worker.
 *
 * - `name`: optional job name, routing the request to the matching
 *   `job({ name })` handler on the worker.
 * - `payload`: optional structured data describing the work.
 * - `timeout`: optional timeout in seconds, covering both the wait for the
 *   worker to become ready and the job itself.
 * - `label`: optional human-readable description of the work, e.g.
 *   `"Research: Radiohead"`. A `UIWorker` titles the client's progress card
 *   with it.
 * - `cancellable`: whether an external requester, such as the client UI, may
 *   ask for the job to be cancelled. Cancellation the worker initiates itself
 *   (shutdown, timeout, `cancelOnError`) proceeds either way.
 */
export class JobParams {
  name: string | null;
  payload: JobPayload | null;
  timeout: number | null;
  label: string | null;
  cancellable: boolean;

  constructor(options: JobParamsOptions = {}) {
    this.name = options.name ?? null;
    this.payload = options.payload ?? null;
    this.timeout = options.timeout ?? null;
    this.label = options.label ?? null;
    this.cancellable = options.cancellable ?? true;
  }
}

export interface JobGroupParamsOptions extends JobParamsOptions {
  cancelOnError?: boolean;
}

/**
 * Configuration for a job sent to several workers at once.
 *
 * Carries every `JobParams` field, which apply to the group as a whole, plus
 * how the group reacts to one of its workers failing.
 *
 * - `cancelOnError`: whether a worker responding with an error status cancels
 *   the rest of the group.
 */
export class JobGroupParams extends JobParams {
  cancelOnError: boolean;

  constructor(options: JobGroupParamsOptions = {}) {
    super(options);
    this.cancelOnError = options.cancelOnError ?? true;
  }
}

/**
 * Status of a completed worker.
 *
 * String values, so they compare naturally with plain strings and serialize
 * without extra handling.
 *
 * - `COMPLETED`: the worker finished successfully.
 * - `CANCELLED`: the worker was cancelled by the requester.
 * - `FAILED`: the worker failed due to a logical or business error.
 * - `ERROR`: the worker encountered an unexpected runtime error.
 */
export const JobStatus = {
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  ERROR: "error",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** Raised when a worker is cancelled due to a worker error or timeout. */
export class JobError extends Error {
  override name = "JobError";
}

/** Raised when a worker group is cancelled due to a worker error or timeout. */
export class JobGroupError extends Error {
  override name = "JobGroupError";
}

/**
 * Collected results from a completed job group.
 *
 * - `jobId`: the shared job identifier.
 * - `responses`: collected responses keyed by worker name.
 */
export class JobGroupResponse {
  jobId: string;
  responses: Record<string, JobPayload>;

  constructor(options: { jobId: string; responses: Record<string, JobPayload> }) {
    this.jobId = options.jobId;
    this.responses = options.responses;
  }
}

/**
 * An event received from a worker during a single-worker job.
 *
 * - `type`: the event type.
 * - `data`: optional event payload.
 */
export class JobEvent {
  static readonly UPDATE = "update";
  static readonly STREAM_START = "stream_start";
  static readonly STREAM_DATA = "stream_data";
  static readonly STREAM_END = "stream_end";

  type: string;
  data: JobPayload | null;

  constructor(options: { type: string; data?: JobPayload | null }) {
    this.type = options.type;
    this.data = options.data ?? null;
  }
}

/**
 * An event received from a worker during job group execution.
 *
 * - `type`: the event type.
 * - `workerName`: the name of the worker that sent the event.
 * - `data`: optional event payload.
 */
export class JobGroupEvent {
  static readonly UPDATE = "update";
  static readonly STREAM_START = "stream_start";
  static readonly STREAM_DATA = "stream_data";
  static readonly STREAM_END = "stream_end";

  type: string;
  workerName: string;
  data: JobPayload | null;

  constructor(options: { type: string; workerName: string; data?: JobPayload | null }) {
    this.type = options.type;
    this.workerName = options.workerName;
    this.data = options.data ?? null;
  }
}

export interface JobGroupOptions {
  jobId: string;
  workerNames: string[];
  responses?: Record<string, JobPayload>;
  timeoutTask?: Task<unknown> | null;
  cancelOnError?: boolean;
  label?: string | null;
  cancellable?: boolean;
  terminated?: Set<string>;
  eventQueue?: Queue<JobGroupEvent | null> | null;
}

/**
 * Tracks a group of workers launched together.
 *
 * - `jobId`: shared identifier for all workers in this group.
 * - `workerNames`: names of the workers in the group, in dispatch order.
 * - `responses`: collected responses keyed by worker name.
 * - `timeoutTask`: optional task that cancels the group on timeout.
 * - `cancelOnError`: whether to cancel the group if a worker errors.
 * - `label`: optional human-readable description of the work, from
 *   `JobGroupParams.label`.
 * - `cancellable`: whether an external requester may ask for the group to be
 *   cancelled, from `JobGroupParams.cancellable`.
 * - `terminated`: names of the workers that have reached a terminal state,
 *   whether by responding or by ending their stream.
 * - `eventQueue`: optional queue for streaming events to a `JobGroupContext`
 *   async iterator.
 */
export class JobGroup {
  jobId: string;
  workerNames: string[];
  responses: Record<string, JobPayload>;
  timeoutTask: Task<unknown> | null;
  cancelOnError: boolean;
  label: string | null;
  cancellable: boolean;
  terminated: Set<string>;
  eventQueue: Queue<JobGroupEvent | null> | null;
  protected _done = new Event();
  protected _error: string | null = null;

  constructor(options: JobGroupOptions) {
    this.jobId = options.jobId;
    this.workerNames = options.workerNames;
    this.responses = options.responses ?? {};
    this.timeoutTask = options.timeoutTask ?? null;
    this.cancelOnError = options.cancelOnError ?? true;
    this.label = options.label ?? null;
    this.cancellable = options.cancellable ?? true;
    this.terminated = options.terminated ?? new Set();
    this.eventQueue = options.eventQueue ?? null;
  }

  /** Whether the group has completed or failed. */
  get isDone(): boolean {
    return this._done.isSet();
  }

  /**
   * Wait for all workers in the group to respond.
   *
   * @throws JobGroupError If the group was cancelled due to error or timeout.
   */
  async wait(): Promise<void> {
    await this._done.wait();
    if (this._error) {
      throw new JobGroupError(this._error);
    }
  }

  /** Signal that all workers have responded. */
  complete(): void {
    this._done.set();
    if (this.eventQueue) {
      this.eventQueue.putNowait(null);
    }
  }

  /**
   * Signal that the group was cancelled.
   *
   * @param reason Human-readable reason for the failure.
   */
  fail(reason: string | null = null): void {
    this._error = reason;
    this._done.set();
    if (this.eventQueue) {
      this.eventQueue.putNowait(null);
    }
  }

  toString(): string {
    return `JobGroup(job_id=${this.jobId}, worker_names=${JSON.stringify(this.workerNames)})`;
  }
}

/**
 * Async context manager and iterator for structured job group execution.
 *
 * Sends job requests on enter, waits for all responses on exit. Supports
 * `for await` to receive intermediate events (updates and streaming data)
 * from workers while waiting for completion.
 *
 * On normal completion, results are available via `responses`. On worker
 * error (with `cancelOnError: true`) or timeout, throws `JobGroupError`. If
 * the block throws, remaining jobs are cancelled.
 *
 * @example
 * const tg = this.jobGroup(["w1", "w2"], { params: new JobGroupParams({ payload: data }) });
 * await tg.run(async (tg) => {
 *   for await (const event of tg) {
 *     console.log(`${event.workerName} [${event.type}]:`, event.data);
 *   }
 * });
 *
 * for (const [name, result] of Object.entries(tg.responses)) {
 *   console.log(name, result);
 * }
 */
export class JobGroupContext implements AsyncIterable<JobGroupEvent> {
  protected _worker: BaseWorker;
  protected _workerNames: readonly string[];
  protected _params: JobGroupParams;
  protected _group: JobGroup | null = null;

  /**
   * Initialize the JobGroupContext.
   *
   * @param worker The parent `BaseWorker` that owns this job group.
   * @param workerNames Names of the workers to send the job to.
   * @param options.params How to run the group. Defaults to `JobGroupParams` defaults.
   */
  constructor(
    worker: BaseWorker,
    workerNames: readonly string[],
    options: { params?: JobGroupParams | null } = {},
  ) {
    this._worker = worker;
    this._workerNames = workerNames;
    this._params = options.params ?? new JobGroupParams();
  }

  /** The shared job identifier for this group. */
  get jobId(): string {
    if (!this._group) {
      throw new Error("Job group has not been started");
    }
    return this._group.jobId;
  }

  /** Collected responses keyed by worker name. */
  get responses(): Record<string, JobPayload> {
    if (!this._group) {
      throw new Error("Job group has not been started");
    }
    return this._group.responses;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JobGroupEvent> {
    for (;;) {
      if (!this._group?.eventQueue) return;
      const event = await this._group.eventQueue.get();
      if (event === null) return;
      yield event;
    }
  }

  /** Send the job requests (`__aenter__`). */
  async enter(): Promise<this> {
    const group: JobGroup = await this._worker.createJobGroupAndRequestJob([...this._workerNames], {
      params: this._params,
    });
    group.eventQueue = new Queue();
    this._group = group;
    return this;
  }

  /**
   * Leave the block (`__aexit__`): cancel the remaining jobs if the block
   * threw, otherwise wait for every response.
   *
   * @param error What the block threw, if anything (`undefined` when it
   *   completed normally).
   */
  async exit(error?: unknown): Promise<void> {
    if (error !== undefined) {
      if (this._group && this._worker.jobGroups.has(this._group.jobId)) {
        // Shield the cleanup so it completes even if the surrounding worker
        // is being cancelled (e.g. tool interruption).
        const jobId = this._group.jobId;
        await shield(() =>
          this._worker.cancelJobGroup(jobId, { reason: "context exited with error" }),
        );
      }
      return;
    }

    if (this._group === null) throw new Error("Job group has not been started");
    await this._group.wait();
  }

  /**
   * Run `fn` inside the context, as `async with` does: enter, run the block,
   * then exit. An error thrown by the block cancels the group and is
   * re-thrown.
   */
  async run<R>(fn: (ctx: this) => Promise<R> | R): Promise<R> {
    await this.enter();
    let result: R;
    try {
      result = await fn(this);
    } catch (e) {
      await this.exit(e ?? new Error("context exited with error"));
      throw e;
    }
    await this.exit();
    return result;
  }
}

/**
 * Async context manager and iterator for a single-worker job.
 *
 * Sends a job request on enter, waits for the response on exit. Supports
 * `for await` to receive intermediate events (updates and streaming data)
 * from the worker while waiting for completion.
 *
 * On normal completion, the result is available via `response`. On worker
 * error or timeout, throws `JobError`. If the block throws, the job is
 * cancelled.
 *
 * @example
 * const t = this.job("worker", { params: new JobParams({ payload: data }) });
 * await t.run(async (t) => {
 *   for await (const event of t) {
 *     console.log(`[${event.type}]:`, event.data);
 *   }
 * });
 *
 * console.log(t.response);
 */
export class JobContext implements AsyncIterable<JobEvent> {
  protected _worker: BaseWorker;
  protected _workerName: string;
  protected _params: JobParams;
  protected _group: JobGroup | null = null;

  /**
   * Initialize the JobContext.
   *
   * @param worker The parent `BaseWorker` that owns this job.
   * @param workerName Name of the worker to send the job to.
   * @param options.params How to run the job. Defaults to `JobParams` defaults.
   */
  constructor(worker: BaseWorker, workerName: string, options: { params?: JobParams | null } = {}) {
    this._worker = worker;
    this._workerName = workerName;
    this._params = options.params ?? new JobParams();
  }

  /** The job identifier. */
  get jobId(): string {
    if (!this._group) {
      throw new Error("Job has not been started");
    }
    return this._group.jobId;
  }

  /** The worker's response payload. */
  get response(): JobPayload {
    if (!this._group) {
      throw new Error("Job has not been started");
    }
    return this._group.responses[this._workerName] ?? {};
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JobEvent> {
    for (;;) {
      if (!this._group?.eventQueue) return;
      const event = await this._group.eventQueue.get();
      if (event === null) return;
      yield new JobEvent({ type: event.type, data: event.data });
    }
  }

  /** Send the job request (`__aenter__`). */
  async enter(): Promise<this> {
    const group: JobGroup = await this._worker.createJobGroupAndRequestJob([this._workerName], {
      params: new JobGroupParams({ ...this._params }),
    });
    group.eventQueue = new Queue();
    this._group = group;
    return this;
  }

  /**
   * Leave the block (`__aexit__`): cancel the job if the block threw,
   * otherwise wait for the response.
   *
   * @param error What the block threw, if anything (`undefined` when it
   *   completed normally).
   * @throws JobError If the worker failed or timed out.
   */
  async exit(error?: unknown): Promise<void> {
    if (error !== undefined) {
      if (this._group && this._worker.jobGroups.has(this._group.jobId)) {
        // Shield the cleanup so it completes even if the surrounding worker
        // is being cancelled (e.g. tool interruption).
        const jobId = this._group.jobId;
        await shield(() =>
          this._worker.cancelJobGroup(jobId, { reason: "context exited with error" }),
        );
      }
      return;
    }

    if (this._group === null) throw new Error("Job has not been started");
    try {
      await this._group.wait();
    } catch (e) {
      if (e instanceof JobGroupError) {
        throw new JobError(e.message, { cause: e });
      }
      throw e;
    }
  }

  /**
   * Run `fn` inside the context, as `async with` does: enter, run the block,
   * then exit. An error thrown by the block cancels the job and is re-thrown.
   */
  async run<R>(fn: (ctx: this) => Promise<R> | R): Promise<R> {
    await this.enter();
    let result: R;
    try {
      result = await fn(this);
    } catch (e) {
      await this.exit(e ?? new Error("context exited with error"));
      throw e;
    }
    await this.exit();
    return result;
  }
}
