// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/base_worker.py

/**
 * Abstract base worker for the multi-worker framework.
 *
 * Provides the `BaseWorker` class that all workers inherit from, handling
 * worker lifecycle, parent-child relationships, and long-running job
 * coordination on the bus.
 *
 * Porting notes:
 * - The deprecated per-argument job spelling (`name=`, `payload=`,
 *   `timeout=`, `cancel_on_error=` on `request_job`, `job`,
 *   `request_job_group`, `job_group` and `create_job_group_and_request_job`)
 *   and `resolve_job_params` are not ported; pass `params` instead.
 * - Methods that take `*names` plus keyword arguments take the names as rest
 *   arguments and an optional trailing options object:
 *   `this.jobGroup("w1", "w2", { params })`, `this.addWorkers(a, b, { watch: false })`.
 */

import {
  CancelledError,
  currentTask,
  Event,
  gather,
  Lock,
  sleep,
  type Task,
  type TaskFn,
  TimeoutError,
  time,
  waitFor,
} from "@pipecat-ts/asyncio";
import type { WorkerBus } from "../bus/bus.ts";
import {
  BusActivateWorkerMessage,
  BusAddWorkerMessage,
  BusCancelMessage,
  BusCancelWorkerMessage,
  BusDeactivateWorkerMessage,
  BusEndMessage,
  BusEndWorkerMessage,
  BusFrameMessage,
  BusJobCancelMessage,
  BusJobRequestMessage,
  BusJobResponseMessage,
  BusJobResponseUrgentMessage,
  BusJobStreamDataMessage,
  BusJobStreamEndMessage,
  BusJobStreamStartMessage,
  BusJobUpdateMessage,
  BusJobUpdateRequestMessage,
  BusJobUpdateUrgentMessage,
  type BusMessage,
  BusWorkerErrorMessage,
  BusWorkerLocalErrorMessage,
  BusWorkerReadyMessage,
} from "../bus/messages.ts";
import { BusSubscriber } from "../bus/subscriber.ts";
import {
  JobContext,
  JobGroup,
  JobGroupContext,
  JobGroupError,
  JobGroupEvent,
  JobGroupParams,
  JobGroupResponse,
  JobParams,
  JobStatus,
} from "../pipeline/job_context.ts";
import { _collectJobHandlers } from "../pipeline/job_decorator.ts";
import { _collectWorkerReadyHandlers } from "../pipeline/worker_ready_decorator.ts";
import type { WorkerRegistry } from "../registry/registry.ts";
import { WorkerErrorData, WorkerReadyData } from "../registry/types.ts";
import type { BaseTaskManager } from "../utils/asyncio/task_manager.ts";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";
import { logger } from "../utils/logger.ts";
import type { WorkerRunner } from "./runner.ts";

type Dict = Record<string, unknown>;

type JobHandlerFn = (message: BusJobRequestMessage) => Promise<unknown> | unknown;

export interface WorkerParamsOptions {
  /** Task manager for handling asyncio tasks. */
  taskManager: BaseTaskManager;
}

/**
 * Configuration parameters for worker execution.
 *
 * - `taskManager`: Task manager for handling asyncio tasks.
 */
export class WorkerParams {
  taskManager: BaseTaskManager;

  constructor(options: WorkerParamsOptions) {
    this.taskManager = options.taskManager;
  }
}

export interface WorkerActivationArgsOptions {
  /** Optional structured data passed during activation. */
  metadata?: Dict | null;
}

/**
 * Base activation arguments for any worker.
 *
 * - `metadata`: Optional structured data passed during activation.
 *
 * Subclasses add fields (with defaults) and accept them in their options
 * object; `fromDict` and `toDict` work off the instance's own fields.
 */
export class WorkerActivationArgs {
  metadata: Dict | null;

  constructor(options: WorkerActivationArgsOptions = {}) {
    this.metadata = options.metadata ?? null;
  }

  /** Create from a dict, ignoring unknown keys. */
  static fromDict<T extends WorkerActivationArgs>(this: new (options?: Dict) => T, data: Dict): T {
    const fields = new Set(Object.keys(new this({})));
    return new this(Object.fromEntries(Object.entries(data).filter(([k]) => fields.has(k))));
  }

  /** Convert to a dict, excluding null values. */
  toDict(): Dict {
    return Object.fromEntries(
      Object.entries(this).filter(([, value]) => value !== null && value !== undefined),
    );
  }
}

/**
 * Messages an inactive worker still receives: the ones that change whether it
 * is active, and the ones that stop it. Gating these would leave it with no
 * way to be woken or shut down.
 */
const ALWAYS_DELIVERED = [
  BusActivateWorkerMessage,
  BusDeactivateWorkerMessage,
  BusEndWorkerMessage,
  BusCancelWorkerMessage,
] as const;

export interface BaseWorkerOptions extends BaseObjectOptions {
  /**
   * Unique name for this worker. If null, an auto-generated name is used
   * (useful for instances that don't participate in inter-worker
   * communication).
   */
  name?: string | null;
  /**
   * Whether the worker starts out accepting bus messages (see `active`).
   * Starting one inactive is for multi-worker setups where workers take
   * turns: it stays out of the way, doing nothing, until another worker or
   * the application activates it. Defaults to true.
   */
  active?: boolean;
  /**
   * Whether to warn about tasks left running when the worker finishes. Only
   * applies when the worker owns its task manager; a worker sharing the
   * runner's task manager leaves the report to the runner. Defaults to true.
   */
  checkDanglingTasks?: boolean;
  /** Optional task manager for handling asyncio tasks. */
  taskManager?: BaseTaskManager | null;
}

export interface AttachOptions {
  /** The shared worker registry. */
  registry: WorkerRegistry;
  /** The shared worker bus. */
  bus: WorkerBus;
  /** The runner hosting the worker, reachable afterwards as `workerRunner`. */
  workerRunner: WorkerRunner;
}

export interface AddWorkersOptions {
  /**
   * When true (the default), watch each newly added child so
   * `onWorkerReady` fires once it registers. Workers that were skipped
   * (already parented elsewhere) are not watched.
   */
  watch?: boolean;
}

export interface ActivateWorkerOptions {
  /** Optional `WorkerActivationArgs` forwarded to the target worker's `onActivated`. */
  args?: WorkerActivationArgs | null;
  /** Whether to deactivate this worker before activating the target. */
  deactivateSelf?: boolean;
}

export interface JobOptions {
  /** How to run the job. See `JobParams`. */
  params?: JobParams | null;
}

export interface JobGroupOptions {
  /** How to run the group. See `JobGroupParams`. */
  params?: JobGroupParams | null;
}

export interface SendJobResponseOptions {
  /** Completion status. Defaults to `JobStatus.COMPLETED`. */
  status?: JobStatus;
  /** When true, the response is delivered with system priority, preempting queued data messages. */
  urgent?: boolean;
}

export interface SendJobUpdateOptions {
  /** When true, the update is delivered with system priority, preempting queued data messages. */
  urgent?: boolean;
}

/** Split `(...names, options?)` rest arguments. */
function splitTrailingOptions<T, O extends object>(
  args: readonly (T | O)[],
  isItem: (value: unknown) => value is T,
): [T[], O] {
  const last = args[args.length - 1];
  if (args.length > 0 && !isItem(last) && typeof last === "object" && last !== null) {
    return [args.slice(0, -1) as T[], last as O];
  }
  return [args as T[], {} as O];
}

function checkWorkerNames(worker: BaseWorker, workerNames: readonly unknown[]): void {
  for (const workerName of workerNames) {
    if (typeof workerName !== "string") {
      const typeName =
        workerName === null
          ? "NoneType"
          : typeof workerName === "object"
            ? (workerName as object).constructor.name
            : typeof workerName;
      throw new TypeError(`${worker} Expected worker name as str, got ${typeName}`);
    }
  }
}

/**
 * Abstract base for workers in framework.
 *
 * A worker connects to a `WorkerBus`, registers itself in the shared
 * registry, accepts activation/deactivation, and exchanges job
 * requests/responses with other workers. Concrete subclasses
 * (e.g. `PipelineWorker`) provide the runtime that actually drives
 * the worker's work.
 *
 * Overridable lifecycle methods (always call `super`):
 *
 * - `onActivated(args)`: Called when this worker is activated.
 * - `onDeactivated()`: Called when this worker is deactivated.
 * - `onWorkerReady(data)`: Called when another worker is ready to receive
 *   messages. For local root workers, fires automatically. For children,
 *   fires only on the parent. For remote workers, fires only for workers
 *   watched via `watchWorkers()`.
 * - `onJobRequest(message)`: Called when a job request is received.
 * - `onJobResponse(message)`: Called when a worker sends a response.
 * - `onJobUpdate(message)`: Called when a worker sends a progress update.
 * - `onJobUpdateRequested(message)`: Called when the requester asks for a
 *   progress update.
 * - `onJobCompleted(result)`: Called when all workers in a job group have
 *   responded.
 * - `onJobError(message)`: Called when a worker errors and the group is
 *   cancelled (`cancelOnError`).
 * - `onJobStreamStart(message)`: Called when a worker begins streaming.
 * - `onJobStreamData(message)`: Called for each streaming chunk from a worker.
 * - `onJobStreamEnd(message)`: Called when a worker finishes streaming.
 * - `onJobCancelled(message)`: Called when this worker's job is cancelled by
 *   the requester.
 * - `onBusMessage(message)`: Called for bus messages after default lifecycle
 *   handling.
 *
 * Event handlers available:
 *
 * - on_activated: Worker was activated.
 * - on_deactivated: Worker was deactivated.
 * - on_worker_ready: Another worker is ready.
 * - on_worker_failed: A child worker reported an error.
 * - on_job_request: Received a job request.
 * - on_job_response: A worker sent a response.
 * - on_job_update: A worker sent a progress update.
 * - on_job_update_requested: Requester asked for a progress update.
 * - on_job_completed: All workers in a job group responded.
 * - on_job_error: A worker errored and the group was cancelled.
 * - on_job_stream_start: A worker started streaming.
 * - on_job_stream_data: A worker sent a streaming chunk.
 * - on_job_stream_end: A worker finished streaming.
 * - on_job_cancelled: This worker's job was cancelled.
 * - on_bus_message: A bus message was received.
 */
export class BaseWorker extends BusSubscriber(BaseObject) {
  // Only the owner of a task manager reports its dangling tasks. A worker
  // that's handed its own task manager owns it; one that falls back to the
  // runner's shared task manager does not (the runner reports instead).
  protected _checkDanglingTasks: boolean;
  protected _ownsTaskManager: boolean;

  // Runner-provided context. Populated by `attach()` before `run()` is
  // called. Accessing `this.bus` / `this.registry` before `attach()` throws.
  protected _bus: WorkerBus | null = null;
  protected _registry: WorkerRegistry | null = null;
  protected _workerRunner: WorkerRunner | null = null;

  // Activation. Pending activation is deferred until the worker starts, then
  // onActivated fires.
  protected _active: boolean;
  protected _pendingActivation: boolean;
  protected _activationArgs: Dict | null = null;

  // Worker lifecycle. Parent/children form a tree. Finished is set when the
  // worker stops.
  protected _parent: string | null = null;
  protected _children: BaseWorker[] = [];
  protected _startedAt: number | null = null;
  protected _finishedEvent = new Event();

  // Job coordination. Worker state tracks active job requests keyed by
  // jobId, supporting multiple jobs in flight (e.g. parallel job handlers).
  // Each running handler has a tracked task so it can be cancelled by system
  // messages. Requester state tracks job groups launched by this worker. Job
  // handlers are collected from `job()` decorated methods at init.
  protected _activeJobs = new Map<string, BusJobRequestMessage>();
  protected _jobHandlerTasks = new Map<string, Task<unknown>>();
  protected _jobGroups = new Map<string, JobGroup>();
  protected _jobHandlers: Map<string, JobHandlerFn>;
  protected _jobLocks = new Map<string, Lock>();

  // Worker-ready handlers collected from `workerReady()` decorated methods.
  protected _workerReadyHandlers: Map<string, (data: WorkerReadyData) => unknown>;

  // A stable handler for registry watches (the registry ignores a handler it
  // already holds, as Python's bound-method equality does).
  protected readonly _onWatchedWorkerReadyHandler = (data: WorkerReadyData) =>
    this._onWatchedWorkerReady(data);

  /** Initialize the BaseWorker. */
  constructor(options: BaseWorkerOptions = {}) {
    super(options);

    this._checkDanglingTasks = options.checkDanglingTasks ?? true;
    this._ownsTaskManager = options.taskManager !== undefined && options.taskManager !== null;

    this._active = options.active ?? true;
    this._pendingActivation = this._active;

    this._jobHandlers = _collectJobHandlers(this);
    this._workerReadyHandlers = _collectWorkerReadyHandlers(this);

    // Worker lifecycle events
    this._registerEventHandler("on_activated");
    this._registerEventHandler("on_deactivated");
    this._registerEventHandler("on_bus_message");
    this._registerEventHandler("on_job_request");
    this._registerEventHandler("on_job_response");
    this._registerEventHandler("on_job_update");
    this._registerEventHandler("on_job_update_requested");
    this._registerEventHandler("on_job_completed");
    this._registerEventHandler("on_job_error");
    this._registerEventHandler("on_job_stream_start");
    this._registerEventHandler("on_job_stream_data");
    this._registerEventHandler("on_job_stream_end");
    this._registerEventHandler("on_job_cancelled");

    // Other workers
    this._registerEventHandler("on_worker_ready");
    this._registerEventHandler("on_worker_failed");
  }

  /**
   * The bus this worker is attached to.
   *
   * @throws Error If accessed before `attach()` has been called.
   */
  get bus(): WorkerBus {
    if (this._bus === null) {
      throw new Error(`Worker '${this}': bus is not set; call attach() first.`);
    }
    return this._bus;
  }

  /**
   * Whether this worker is accepting bus messages.
   *
   * An active worker takes everything addressed to it. An inactive one takes
   * only activation, deactivation, end or cancel messages, so no job request,
   * frame or UI event reaches it and none of its `onBusMessage` handling runs.
   *
   * It matters mainly in multi-worker setups, where a worker is put out of
   * the way while the others carry on.
   *
   * Registry watches sit outside this: `workerReady` handlers fire from
   * `WorkerRegistry` whatever this returns, because they never travel over
   * the bus.
   */
  get active(): boolean {
    return this._active;
  }

  /** The arguments from the most recent activation, or null if inactive. */
  get activationArgs(): Dict | null {
    return this._activationArgs;
  }

  /** The name of the parent worker, or null if this is a root worker. */
  get parent(): string | null {
    return this._parent;
  }

  /**
   * The shared worker registry this worker is attached to.
   *
   * @throws Error If accessed before `attach()` has been called.
   */
  get registry(): WorkerRegistry {
    if (this._registry === null) {
      throw new Error(`Worker '${this}': registry is not set; call attach() first.`);
    }
    return this._registry;
  }

  /**
   * The runner this worker is attached to.
   *
   * Use it to reach another worker on the same runner by name, e.g.
   * `this.workerRunner.getWorker("ui-jobs")`.
   *
   * @throws Error If accessed before `attach()` has been called.
   */
  get workerRunner(): WorkerRunner {
    if (this._workerRunner === null) {
      throw new Error(`Worker '${this}': runner is not set; call attach() first.`);
    }
    return this._workerRunner;
  }

  /** Unix timestamp (seconds) when this worker became ready, or null if not yet started. */
  get startedAt(): number | null {
    return this._startedAt;
  }

  /**
   * Whether this worker is bridged onto the bus.
   *
   * Subclasses (e.g. `PipelineWorker`) override when they auto-wrap their
   * pipeline with bus edge processors.
   */
  get bridged(): boolean {
    return false;
  }

  /** The list of child workers added via `addWorkers()`. */
  get children(): BaseWorker[] {
    return this._children;
  }

  /** Active job requests this worker is currently working on, keyed by jobId. */
  get activeJobs(): Map<string, BusJobRequestMessage> {
    return this._activeJobs;
  }

  /** Active job groups launched by this worker, keyed by jobId. */
  get jobGroups(): Map<string, JobGroup> {
    return this._jobGroups;
  }

  /**
   * Attach the worker to a runner-provided registry and bus.
   *
   * Called by the runner (typically from `addWorkers()`) before the worker
   * is run. After this call, `registry` and `bus` return the provided
   * instances, and the worker is subscribed to the bus — so workers added
   * later are listening before any worker emits its first message.
   */
  async attach(options: AttachOptions): Promise<void> {
    this._registry = options.registry;
    this._bus = options.bus;
    this._workerRunner = options.workerRunner;
    await this._bus.subscribe(this);
  }

  /**
   * Clean up the worker and release resources.
   *
   * Cancels running jobs, unsubscribes from the bus, and signals that the
   * worker has stopped.
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this.stop();
  }

  /**
   * Run this worker until it finishes.
   *
   * The default implementation is for bus-only workers: it subscribes to the
   * bus, marks the worker as started, then waits until `stop()` (or
   * `_finishedEvent`) is signalled. Subclasses with their own runtime (e.g.
   * `PipelineWorker`) override this method.
   *
   * @param params Configuration parameters for worker execution.
   */
  async run(params: WorkerParams): Promise<void> {
    await super.setup(this._taskManager ?? params.taskManager);

    await this.start();
    try {
      await this._finishedEvent.wait();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    } finally {
      await this.stop();
      this._printDanglingTasks();
    }
  }

  /** Mark the worker as started, register, and activate if requested. */
  async start(): Promise<void> {
    this._startedAt = time();
    await this._registerReady();
    await this._maybeActivate();
    await this._watchDecoratedWorkers();
  }

  /**
   * Clean up and signal that this worker has stopped.
   *
   * Cancels all running job groups and reports any still-active job
   * requests back to their requesters as `CANCELLED`, so parents aren't left
   * waiting, and cancels the handlers still running for them, such as one
   * holding a long-lived job open.
   */
  async stop(): Promise<void> {
    for (const jobId of [...this._jobGroups.keys()]) {
      await this.cancelJobGroup(jobId, { reason: `worker '${this}' stopped` });
    }
    for (const jobId of [...this._activeJobs.keys()]) {
      await this.sendJobResponse(jobId, null, { status: JobStatus.CANCELLED });
    }

    // Cancel every handler still running, including any that may have
    // already responded (so are no longer in `_activeJobs`) but live on for
    // some reason.
    for (const task of [...this._jobHandlerTasks.values()]) {
      await this.cancelTask(task);
    }
    this._finishedEvent.set();
  }

  /**
   * Request a graceful end of the session.
   *
   * @param options.reason Optional human-readable reason for ending.
   */
  async end(options: { reason?: string | null } = {}): Promise<void> {
    await this.sendBusMessage(new BusEndMessage({ source: this.name, reason: options.reason }));
  }

  /**
   * Request an immediate cancellation of all workers.
   *
   * @param options.reason Optional human-readable reason. Propagated through
   *   the runner to every root worker's `BusCancelWorkerMessage`.
   */
  async cancel(options: { reason?: string | null } = {}): Promise<void> {
    await this.sendBusMessage(new BusCancelMessage({ source: this.name, reason: options.reason }));
  }

  /** Wait for this worker to finish. */
  async wait(): Promise<void> {
    await this._finishedEvent.wait();
  }

  /**
   * Called when this worker is activated.
   *
   * Override in subclasses to react to activation. Always call
   * `super.onActivated(args)`.
   *
   * @param args Optional arguments from the caller.
   */
  async onActivated(_args: Dict | null): Promise<void> {}

  /**
   * Called when this worker is deactivated.
   *
   * Override in subclasses to react to deactivation. Always call
   * `super.onDeactivated()`.
   */
  async onDeactivated(): Promise<void> {}

  /**
   * Called when another worker is ready to receive messages.
   *
   * For local root workers this fires automatically. For remote workers it
   * fires only for workers watched via `watchWorkers()`. For child workers
   * it fires only on the parent that created them.
   *
   * @param data Information about the ready worker.
   */
  async onWorkerReady(_data: WorkerReadyData): Promise<void> {}

  /**
   * Called when a child worker reports an error.
   *
   * @param data Information about the error.
   */
  async onWorkerFailed(_data: WorkerErrorData): Promise<void> {}

  /**
   * Take bus messages only while active.
   *
   * An inactive worker is handed only activation, deactivation, end or
   * cancel messages. Work addressed to it, and everything it would merely
   * observe, is dropped by the bus rather than reaching `onBusMessage`.
   *
   * Registry notifications are unaffected, since `workerReady` watches fire
   * from `WorkerRegistry` rather than travelling over the bus.
   *
   * @param message The bus message about to be delivered.
   * @returns Whether to deliver the message.
   */
  override acceptsBusMessage(message: BusMessage): boolean {
    return this._active || ALWAYS_DELIVERED.some((cls) => message instanceof cls);
  }

  /**
   * Called for every bus message after built-in lifecycle handling.
   *
   * Override to handle custom message types. Built-in message types
   * (activation, end, cancel, job) are already dispatched to their
   * respective hooks before this method is called.
   *
   * @param message The `BusMessage` to process.
   */
  override async onBusMessage(message: BusMessage): Promise<void> {
    // Frame messages are not handled by the base worker.
    if (message instanceof BusFrameMessage) {
      return;
    }

    // Ignore targeted messages for other workers
    if (message.target && message.target !== this.name) {
      return;
    }

    if (message instanceof BusWorkerErrorMessage || message instanceof BusWorkerLocalErrorMessage) {
      await this._handleWorkerError(message);
    } else if (message instanceof BusActivateWorkerMessage) {
      await this._handleWorkerActivate(message);
    } else if (message instanceof BusDeactivateWorkerMessage) {
      await this._handleWorkerDeactivate(message);
    } else if (message instanceof BusEndWorkerMessage) {
      await this._handleWorkerEnd(message);
    } else if (message instanceof BusCancelWorkerMessage) {
      await this._handleWorkerCancel(message);
    } else if (message instanceof BusJobRequestMessage) {
      await this._handleJobRequest(message);
    } else if (
      message instanceof BusJobResponseMessage ||
      message instanceof BusJobResponseUrgentMessage
    ) {
      await this._handleJobResponse(message);
    } else if (
      message instanceof BusJobUpdateMessage ||
      message instanceof BusJobUpdateUrgentMessage
    ) {
      await this._handleJobUpdate(message);
    } else if (message instanceof BusJobUpdateRequestMessage) {
      await this._handleJobUpdateRequest(message);
    } else if (message instanceof BusJobCancelMessage) {
      await this._handleJobCancel(message);
    } else if (message instanceof BusJobStreamStartMessage) {
      await this._handleJobStreamStart(message);
    } else if (message instanceof BusJobStreamDataMessage) {
      await this._handleJobStreamData(message);
    } else if (message instanceof BusJobStreamEndMessage) {
      await this._handleJobStreamEnd(message);
    }

    await this._callEventHandler("on_bus_message", message);
  }

  /**
   * Called when this worker receives a job request.
   *
   * Override to perform work. Use `sendJobUpdate()` to report progress and
   * `sendJobResponse()` to return results.
   */
  async onJobRequest(_message: BusJobRequestMessage): Promise<void> {}

  /**
   * Called when a worker sends a response.
   *
   * Override to process individual results as they arrive.
   */
  async onJobResponse(
    _message: BusJobResponseMessage | BusJobResponseUrgentMessage,
  ): Promise<void> {}

  /** Called when a worker sends a progress update. */
  async onJobUpdate(_message: BusJobUpdateMessage | BusJobUpdateUrgentMessage): Promise<void> {}

  /**
   * Called when the requester asks for a progress update.
   *
   * Override to send back a progress update via `sendJobUpdate()`.
   */
  async onJobUpdateRequested(_message: BusJobUpdateRequestMessage): Promise<void> {}

  /** Called when all workers in a job group have responded. */
  async onJobCompleted(_result: JobGroupResponse): Promise<void> {}

  /**
   * Called when a job group is cancelled due to a worker error.
   *
   * Fires when a worker responds with `ERROR` or `FAILED` status and
   * `cancelOnError` is set. The group is cancelled and `onJobCompleted`
   * will not fire. Partial responses from workers that completed before the
   * error are available in the job group's `responses`.
   */
  async onJobError(_message: BusJobResponseMessage | BusJobResponseUrgentMessage): Promise<void> {}

  /** Called when a worker begins streaming. */
  async onJobStreamStart(_message: BusJobStreamStartMessage): Promise<void> {}

  /** Called for each streaming chunk from a worker. */
  async onJobStreamData(_message: BusJobStreamDataMessage): Promise<void> {}

  /** Called when a worker finishes streaming. */
  async onJobStreamEnd(_message: BusJobStreamEndMessage): Promise<void> {}

  /**
   * Called when this worker's job is cancelled by the requester.
   *
   * Override to clean up resources or stop in-progress work.
   */
  async onJobCancelled(_message: BusJobCancelMessage): Promise<void> {}

  /**
   * Send a message on the bus.
   *
   * @param message The `BusMessage` to send.
   */
  async sendBusMessage(message: BusMessage): Promise<void> {
    if (this._bus) {
      await this._bus.send(message);
    }
  }

  /**
   * Report an error on the bus.
   *
   * Child workers send a local-only message to the parent. Root workers
   * broadcast over the network.
   *
   * @param error Description of the error.
   */
  async sendBusErrorMessage(error: string): Promise<void> {
    if (this._parent) {
      await this.sendBusMessage(new BusWorkerLocalErrorMessage({ source: this.name, error }));
    } else {
      await this.sendBusMessage(new BusWorkerErrorMessage({ source: this.name, error }));
    }
  }

  /**
   * Register one or more child workers under this parent.
   *
   * Each child's lifecycle (end, cancel) is automatically managed by this
   * parent worker. By default, the children are also watched so the parent
   * receives `onWorkerReady` when each one starts; pass `{ watch: false }`
   * as the last argument to opt out (you can still call `watchWorkers()`
   * later).
   *
   * @example
   * await this.addWorkers(researcher, writer);
   * await this.addWorkers(researcher, writer, { watch: false });
   */
  async addWorkers(...args: [...workers: BaseWorker[], options: AddWorkersOptions]): Promise<void>;
  async addWorkers(...workers: BaseWorker[]): Promise<void>;
  async addWorkers(...args: (BaseWorker | AddWorkersOptions)[]): Promise<void> {
    const [workers, options] = splitTrailingOptions<BaseWorker, AddWorkersOptions>(
      args,
      (v): v is BaseWorker => v instanceof BaseWorker,
    );
    const watch = options.watch ?? true;

    const addedNames: string[] = [];
    for (const worker of workers) {
      if (worker._parent !== null) {
        logger.warning(`Worker '${worker.name}' already has parent '${worker._parent}', skipping`);
        continue;
      }
      worker._parent = this.name;
      this._children.push(worker);
      addedNames.push(worker.name);
      await this.sendBusMessage(new BusAddWorkerMessage({ source: this.name, worker }));
    }
    if (watch && addedNames.length > 0) {
      await this.watchWorkers(...addedNames);
    }
  }

  /**
   * Activate a worker by name.
   *
   * The target worker's `onActivated` hook will be called with the provided
   * arguments. The target need not be active already: an activation reaches
   * an inactive worker, which is what lets it become active.
   *
   * @param workerName The name of the worker to activate.
   * @param options.args Optional `WorkerActivationArgs` forwarded to the
   *   target worker's `onActivated`.
   * @param options.deactivateSelf Whether to deactivate this worker before
   *   activating the target.
   */
  async activateWorker(workerName: string, options: ActivateWorkerOptions = {}): Promise<void> {
    const args = options.args ?? null;
    const deactivateSelf = options.deactivateSelf ?? false;
    if (this._active && deactivateSelf) {
      // Deactivate immediately (don't wait for the bus round-trip) so this
      // worker and the target are never briefly active at the same time.
      this._active = false;
      await this.deactivateWorker(this.name);
    }
    await this.sendBusMessage(
      new BusActivateWorkerMessage({
        source: this.name,
        target: workerName,
        args: args ? args.toDict() : null,
      }),
    );
  }

  /**
   * Deactivate a worker by name.
   *
   * The target worker's `onDeactivated` hook will be called.
   *
   * @param workerName The name of the worker to deactivate.
   */
  async deactivateWorker(workerName: string): Promise<void> {
    await this.sendBusMessage(
      new BusDeactivateWorkerMessage({ source: this.name, target: workerName }),
    );
  }

  /**
   * Request notification when one or more workers register.
   *
   * For each name: if the worker is already registered, `onWorkerReady`
   * fires immediately. Otherwise `onWorkerReady` fires when the worker
   * eventually registers.
   *
   * @param workerNames Names of workers to watch for.
   */
  async watchWorkers(...workerNames: string[]): Promise<void> {
    if (!this._registry) {
      return;
    }
    for (const workerName of workerNames) {
      logger.debug(`Worker '${this}': watching for worker '${workerName}'`);
      await this._registry.watch(workerName, this._onWatchedWorkerReadyHandler);
    }
  }

  /**
   * Send a job request to a single worker (fire-and-forget).
   *
   * Waits for the worker to be ready before sending the request. Does not
   * wait for the job to complete; use callbacks (`onJobResponse`,
   * `onJobCompleted`) or `job()` for that.
   *
   * @param workerName Name of the worker to send the job to.
   * @param options.params How to run the job. See `JobParams`.
   * @returns The generated jobId.
   */
  async requestJob(workerName: string, options: JobOptions = {}): Promise<string> {
    const jobParams = options.params ?? new JobParams();
    const group = await this.createJobGroupAndRequestJob([workerName], {
      params: new JobGroupParams({
        name: jobParams.name,
        payload: jobParams.payload,
        timeout: jobParams.timeout,
        label: jobParams.label,
        cancellable: jobParams.cancellable,
      }),
    });
    return group.jobId;
  }

  /**
   * Create a single-worker job context.
   *
   * Waits for the worker to be ready, sends a job request, and waits for the
   * response on exit. Supports `for await` inside the block to receive
   * intermediate events (updates and streaming data) from the worker while
   * waiting.
   *
   * On normal completion, the result is available via `response`. On worker
   * error or timeout, throws `JobError`.
   *
   * @param workerName Name of the worker to send the job to.
   * @param options.params How to run the job. See `JobParams`.
   * @returns A `JobContext` (Python's `async with` → `await ctx.run(...)`).
   *
   * @example
   * const t = this.job("worker", { params: new JobParams({ payload: data }) });
   * await t.run(async (t) => {
   *   for await (const event of t) {
   *     if (event.type === JobEvent.UPDATE) console.log(event.data);
   *   }
   * });
   * console.log(t.response);
   */
  job(workerName: string, options: JobOptions = {}): JobContext {
    return new JobContext(this, workerName, { params: options.params ?? new JobParams() });
  }

  /**
   * Send a job request to multiple workers (fire-and-forget).
   *
   * Waits for all workers to be ready before sending requests. Does not
   * wait for the job group to complete; use callbacks (`onJobResponse`,
   * `onJobCompleted`) or `jobGroup()` for that.
   *
   * @param args Names of the workers to send the job to, optionally followed
   *   by `{ params }` (see `JobGroupParams`).
   * @returns The generated jobId shared by all workers in the group.
   * @throws TypeError If a worker name is not a string.
   */
  async requestJobGroup(
    ...args: [...workerNames: string[], options: JobGroupOptions]
  ): Promise<string>;
  async requestJobGroup(...workerNames: string[]): Promise<string>;
  async requestJobGroup(...args: (string | JobGroupOptions)[]): Promise<string> {
    const [workerNames, options] = splitTrailingOptions<string, JobGroupOptions>(
      args,
      (v): v is string => typeof v === "string",
    );
    checkWorkerNames(this, workerNames);

    const groupParams = options.params ?? new JobGroupParams();
    const group = await this.createJobGroupAndRequestJob([...workerNames], {
      params: groupParams,
    });
    return group.jobId;
  }

  /**
   * Create a job group context.
   *
   * Waits for workers to be ready, sends job requests, and waits for all
   * responses on exit. Supports `for await` inside the block to receive
   * intermediate events (updates and streaming data) from workers while
   * waiting.
   *
   * On normal completion, results are available via `responses`. On worker
   * error (with `cancelOnError: true`) or timeout, throws `JobGroupError`.
   *
   * @param args Names of the workers to send the job to, optionally followed
   *   by `{ params }` (see `JobGroupParams`).
   * @returns A `JobGroupContext` (Python's `async with` → `await ctx.run(...)`).
   * @throws TypeError If a worker name is not a string.
   *
   * @example
   * const tg = this.jobGroup("w1", "w2", { params: new JobGroupParams({ payload: data }) });
   * await tg.run(async (tg) => {
   *   for await (const event of tg) {
   *     if (event.type === JobGroupEvent.UPDATE) console.log(`${event.workerName}: ${event.data}`);
   *   }
   * });
   * for (const [name, result] of Object.entries(tg.responses)) console.log(name, result);
   */
  jobGroup(...args: [...workerNames: string[], options: JobGroupOptions]): JobGroupContext;
  jobGroup(...workerNames: string[]): JobGroupContext;
  jobGroup(...args: (string | JobGroupOptions)[]): JobGroupContext {
    const [workerNames, options] = splitTrailingOptions<string, JobGroupOptions>(
      args,
      (v): v is string => typeof v === "string",
    );
    checkWorkerNames(this, workerNames);

    const groupParams = options.params ?? new JobGroupParams();
    return new JobGroupContext(this, workerNames, { params: groupParams });
  }

  /**
   * Cancel a running job group.
   *
   * @param jobId The job identifier to cancel.
   * @param options.reason Optional human-readable reason for cancellation.
   */
  async cancelJobGroup(jobId: string, options: { reason?: string | null } = {}): Promise<void> {
    const reason = options.reason ?? null;
    const group = this._jobGroups.get(jobId);
    this._jobGroups.delete(jobId);
    if (group) {
      // On the timeout path this runs on the timeout task itself, which is
      // already on its last statement. Cancelling it here would abandon the
      // rest of this method, leaving the group's waiter blocked forever.
      if (group.timeoutTask && group.timeoutTask !== currentTask()) {
        await this.cancelTask(group.timeoutTask);
      }
      for (const workerName of group.workerNames) {
        await this.sendBusMessage(
          new BusJobCancelMessage({ source: this.name, target: workerName, jobId, reason }),
        );
      }
      group.fail(reason);
    }
  }

  /**
   * Honor an externally requested cancellation, if the group allows it.
   *
   * The door for cancellation asked for from outside the worker, by a client
   * UI or an operator endpoint, which `JobGroupParams.cancellable` governs.
   * Cancellation the worker decides on itself (shutdown, a timeout,
   * `cancelOnError`) goes straight to `cancelJobGroup()` and is never
   * refused.
   *
   * @param jobId The job identifier to cancel.
   * @param options.reason Optional human-readable reason for cancellation.
   * @returns Whether the group was cancelled. False means it is unknown or
   *   was dispatched as non-cancellable.
   */
  async requestCancelJobGroup(
    jobId: string,
    options: { reason?: string | null } = {},
  ): Promise<boolean> {
    const group = this._jobGroups.get(jobId);
    if (group === undefined || !group.cancellable) {
      return false;
    }
    await this.cancelJobGroup(jobId, { reason: options.reason ?? null });
    return true;
  }

  /**
   * Request a progress update from a worker.
   *
   * @param jobId The job identifier.
   * @param workerName The name of the worker to request an update from.
   */
  async requestJobUpdate(jobId: string, workerName: string): Promise<void> {
    await this.sendBusMessage(
      new BusJobUpdateRequestMessage({ source: this.name, target: workerName, jobId }),
    );
  }

  /**
   * Wait for workers to be ready, create a job group, and send requests.
   *
   * Waits for all workers to be registered as ready, then creates the group
   * and sends a job request to each worker. Does not wait for the group to
   * complete; call `group.wait()` or use `jobGroup()` for that.
   *
   * @param workerNames Names of the workers to send the job to.
   * @param options.params How to run the group. See `JobGroupParams`.
   * @returns The created `JobGroup`.
   * @throws JobGroupError If workers are not ready within the timeout.
   */
  async createJobGroupAndRequestJob(
    workerNames: string[],
    options: JobGroupOptions = {},
  ): Promise<JobGroup> {
    const groupParams = options.params ?? new JobGroupParams();
    const allReady = await this._waitWorkersReady(workerNames);
    try {
      await waitFor(allReady, groupParams.timeout);
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new JobGroupError("workers not ready within timeout");
      }
      throw e;
    }

    const group = this._createJobGroup(workerNames, { params: groupParams });

    for (const workerName of workerNames) {
      await this._sendJobRequest(workerName, group.jobId, {
        jobName: groupParams.name,
        payload: groupParams.payload,
      });
    }

    return group;
  }

  /**
   * Send a job response back to the requester.
   *
   * After sending, the job is removed from the set of active jobs.
   *
   * @param jobId The identifier of the job being responded to.
   * @param response Optional result data.
   * @param options.status Completion status. Defaults to `JobStatus.COMPLETED`.
   * @param options.urgent When true, the response is delivered with system
   *   priority, preempting queued data messages.
   * @throws Error If there is no active job with this `jobId`.
   */
  async sendJobResponse(
    jobId: string,
    response: Dict | null = null,
    options: SendJobResponseOptions = {},
  ): Promise<void> {
    const status = options.status ?? JobStatus.COMPLETED;
    const urgent = options.urgent ?? false;
    const request = this._activeJobs.get(jobId);
    if (request === undefined) {
      throw new Error(`Worker '${this}': no active job '${jobId}' to respond to`);
    }
    const MsgClass = urgent ? BusJobResponseUrgentMessage : BusJobResponseMessage;
    await this.sendBusMessage(
      new MsgClass({
        source: this.name,
        target: request.source,
        jobId,
        response,
        status,
      }),
    );
    this._activeJobs.delete(jobId);
  }

  /**
   * Send a progress update to the requester.
   *
   * @param jobId The identifier of the job being updated.
   * @param update Optional progress data.
   * @param options.urgent When true, the update is delivered with system
   *   priority, preempting queued data messages.
   * @throws Error If there is no active job with this `jobId`.
   */
  async sendJobUpdate(
    jobId: string,
    update: Dict | null = null,
    options: SendJobUpdateOptions = {},
  ): Promise<void> {
    const urgent = options.urgent ?? false;
    const request = this._activeJobs.get(jobId);
    if (request === undefined) {
      throw new Error(`Worker '${this}': no active job '${jobId}' to update`);
    }
    const MsgClass = urgent ? BusJobUpdateUrgentMessage : BusJobUpdateMessage;
    await this.sendBusMessage(
      new MsgClass({
        source: this.name,
        target: request.source,
        jobId,
        update,
      }),
    );
  }

  /**
   * Begin streaming job results back to the requester.
   *
   * @param jobId The identifier of the job being streamed.
   * @param data Optional metadata about the stream.
   * @throws Error If there is no active job with this `jobId`.
   */
  async sendJobStreamStart(jobId: string, data: Dict | null = null): Promise<void> {
    const request = this._activeJobs.get(jobId);
    if (request === undefined) {
      throw new Error(`Worker '${this}': no active job '${jobId}' to stream`);
    }
    await this.sendBusMessage(
      new BusJobStreamStartMessage({
        source: this.name,
        target: request.source,
        jobId,
        data,
      }),
    );
  }

  /**
   * Send a streaming chunk to the requester.
   *
   * @param jobId The identifier of the job being streamed.
   * @param data The chunk payload.
   * @throws Error If there is no active job with this `jobId`.
   */
  async sendJobStreamData(jobId: string, data: Dict | null = null): Promise<void> {
    const request = this._activeJobs.get(jobId);
    if (request === undefined) {
      throw new Error(`Worker '${this}': no active job '${jobId}' to stream`);
    }
    await this.sendBusMessage(
      new BusJobStreamDataMessage({
        source: this.name,
        target: request.source,
        jobId,
        data,
      }),
    );
  }

  /**
   * End the current stream and mark this worker's job as complete.
   *
   * After sending, the job is removed from the set of active jobs.
   *
   * @param jobId The identifier of the job being streamed.
   * @param data Optional final metadata.
   * @throws Error If there is no active job with this `jobId`.
   */
  async sendJobStreamEnd(jobId: string, data: Dict | null = null): Promise<void> {
    const request = this._activeJobs.get(jobId);
    if (request === undefined) {
      throw new Error(`Worker '${this}': no active job '${jobId}' to stream`);
    }
    await this.sendBusMessage(
      new BusJobStreamEndMessage({
        source: this.name,
        target: request.source,
        jobId,
        data,
      }),
    );
    this._activeJobs.delete(jobId);
  }

  /**
   * Register this worker as ready in the shared registry.
   *
   * The registry notifies watchers (parent for children, runner for root
   * workers).
   */
  protected async _registerReady(): Promise<void> {
    if (this._registry) {
      // Send the bus message before registering. Registration fires watchers
      // synchronously, which may send additional messages (e.g.
      // ActivateWorker). Sending the ready message first preserves correct
      // chronological order for observers.
      await this.sendBusMessage(
        new BusWorkerReadyMessage({
          source: this.name,
          runner: this._registry.runnerName,
          parent: this._parent,
          active: this._active,
          bridged: this.bridged,
          startedAt: this._startedAt,
        }),
      );
      await this._registry.register(
        new WorkerReadyData({
          workerName: this.name,
          runner: this._registry.runnerName,
        }),
      );
    }
  }

  /** Activate the worker, call onActivated, and fire event handlers. */
  protected async _maybeActivate(): Promise<void> {
    if (this._startedAt !== null && this._pendingActivation) {
      logger.debug(`Worker '${this}': activated`);
      this._active = true;
      this._pendingActivation = false;
      await this.onActivated(this._activationArgs);
      await this._callEventHandler("on_activated", this._activationArgs);
    }
  }

  /** Register watches for all `workerReady` decorated handlers. */
  protected async _watchDecoratedWorkers(): Promise<void> {
    await this.watchWorkers(...this._workerReadyHandlers.keys());
  }

  /**
   * Called when a watched worker is ready.
   *
   * Dispatches to the `workerReady` handler if one exists for this worker,
   * otherwise proxies to `onWorkerReady`.
   */
  protected async _onWatchedWorkerReady(data: WorkerReadyData): Promise<void> {
    logger.debug(`Worker '${this}': worker '${data.workerName}' ready`);
    const handler = this._workerReadyHandlers.get(data.workerName);
    if (handler) {
      await handler(data);
    }
    await this.onWorkerReady(data);
    await this._callEventHandler("on_worker_ready", data);
  }

  /** Handle an error reported by a child or remote worker. */
  protected async _handleWorkerError(
    message: BusWorkerErrorMessage | BusWorkerLocalErrorMessage,
  ): Promise<void> {
    const childNames = new Set(this._children.map((child) => child.name));
    if (childNames.has(message.source)) {
      const errorInfo = new WorkerErrorData({ workerName: message.source, error: message.error });
      await this.onWorkerFailed(errorInfo);
      await this._callEventHandler("on_worker_failed", errorInfo);
    }
  }

  /**
   * Handle an activation message.
   *
   * Stores the activation arguments and marks the worker as pending
   * activation, then delegates to `_maybeActivate()`.
   *
   * @param message The `BusActivateWorkerMessage` requesting activation.
   */
  protected async _handleWorkerActivate(message: BusActivateWorkerMessage): Promise<void> {
    this._activationArgs = message.args;
    this._pendingActivation = true;
    await this._maybeActivate();
  }

  /**
   * Deactivate this worker.
   *
   * @param message The `BusDeactivateWorkerMessage` requesting deactivation.
   */
  protected async _handleWorkerDeactivate(_message: BusDeactivateWorkerMessage): Promise<void> {
    logger.debug(`Worker '${this}': deactivated`);
    this._active = false;
    this._activationArgs = null;
    await this.onDeactivated();
    await this._callEventHandler("on_deactivated");
  }

  /**
   * Propagate end to children, wait for them, then stop this worker.
   *
   * Subclasses with their own runtime (e.g. `PipelineWorker`) call
   * `_propagateEndToChildren()` directly and drive their own shutdown so
   * `_finishedEvent` fires at the right moment.
   *
   * @param message The `BusEndWorkerMessage` requesting a graceful end.
   */
  protected async _handleWorkerEnd(message: BusEndWorkerMessage): Promise<void> {
    logger.debug(`Worker '${this}': received end`);
    await this._propagateEndToChildren(message);
    await this.stop();
  }

  /**
   * Propagate cancel to children, then stop this worker.
   *
   * Subclasses with their own runtime (e.g. `PipelineWorker`) call
   * `_propagateCancelToChildren()` directly and drive their own shutdown so
   * `_finishedEvent` fires at the right moment.
   *
   * @param message The `BusCancelWorkerMessage` requesting cancellation.
   */
  protected async _handleWorkerCancel(message: BusCancelWorkerMessage): Promise<void> {
    logger.debug(`Worker '${this}': received cancel`);
    await this._propagateCancelToChildren(message);
    await this.stop();
  }

  /** Forward a `BusEndWorkerMessage` to each child and wait for them. */
  protected async _propagateEndToChildren(message: BusEndWorkerMessage): Promise<void> {
    for (const child of this._children) {
      await this.sendBusMessage(
        new BusEndWorkerMessage({ source: this.name, target: child.name, reason: message.reason }),
      );
    }
    await gather(...this._children.map((child) => () => child.wait()));
  }

  /** Forward a `BusCancelWorkerMessage` to each child. */
  protected async _propagateCancelToChildren(message: BusCancelWorkerMessage): Promise<void> {
    for (const child of this._children) {
      await this.sendBusMessage(
        new BusCancelWorkerMessage({
          source: this.name,
          target: child.name,
          reason: message.reason,
        }),
      );
    }
  }

  /**
   * Handle an incoming job request.
   *
   * Dispatches to `job()` handlers if any match, otherwise falls back to
   * onJobRequest. The handler always runs in its own task so the bus message
   * loop is never blocked. When the matched handler is marked
   * `sequential: true`, requests with the same job name are queued and run
   * one at a time in FIFO order.
   */
  protected async _handleJobRequest(message: BusJobRequestMessage): Promise<void> {
    this._activeJobs.set(message.jobId, message);

    let handler: JobHandlerFn | undefined = message.jobName
      ? this._jobHandlers.get(message.jobName)
      : undefined;
    if (handler === undefined) {
      handler = (m: BusJobRequestMessage) => this.onJobRequest(m);
    }

    let lock: Lock | null = null;
    if (message.jobName && (handler as { jobSequential?: boolean }).jobSequential) {
      lock = this._jobLocks.get(message.jobName) ?? null;
      if (lock === null) {
        lock = new Lock();
        this._jobLocks.set(message.jobName, lock);
      }
    }

    const jobHandler = handler;
    const task = this.createTask(
      () => this._runJobHandler(message.jobId, jobHandler, message, lock),
      `${this.name}::job_${message.jobName || "default"}`,
    );
    this._jobHandlerTasks.set(message.jobId, task);

    await this._callEventHandler("on_job_request", message);
  }

  protected async _runJobHandler(
    jobId: string,
    handler: JobHandlerFn,
    message: BusJobRequestMessage,
    lock: Lock | null = null,
  ): Promise<void> {
    try {
      if (lock !== null) {
        await lock.run(async () => {
          await handler(message);
        });
      } else {
        await handler(message);
      }
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    } finally {
      this._jobHandlerTasks.delete(jobId);
    }
  }

  /** Handle a job response and track group completion. */
  protected async _handleJobResponse(
    message: BusJobResponseMessage | BusJobResponseUrgentMessage,
  ): Promise<void> {
    this._markWorkerTerminated(message.jobId, message.source);
    await this.onJobResponse(message);
    await this._callEventHandler("on_job_response", message);

    // Auto-cancel the group on error/failed if cancelOnError is set
    if (message.status === JobStatus.ERROR || message.status === JobStatus.FAILED) {
      const group = this._jobGroups.get(message.jobId);
      if (group?.cancelOnError) {
        group.responses[message.source] = message.response ?? {};
        await this.onJobError(message);
        await this._callEventHandler("on_job_error", message);
        await this.cancelJobGroup(message.jobId, {
          reason: `worker '${message.source}' errored`,
        });
        return;
      }
    }

    await this._trackJobGroupResponse(message.jobId, message.source, message.response);
  }

  /**
   * Record that a worker of a group has reached a terminal state.
   *
   * A worker terminates either by responding or by ending its stream.
   * `cancelJobGroup` reads this to tell apart the workers a cancellation
   * actually cut short from those that had already finished on their own.
   */
  protected _markWorkerTerminated(jobId: string, workerName: string): void {
    const group = this._jobGroups.get(jobId);
    if (group) {
      group.terminated.add(workerName);
    }
  }

  /** Handle a job progress update. */
  protected async _handleJobUpdate(
    message: BusJobUpdateMessage | BusJobUpdateUrgentMessage,
  ): Promise<void> {
    await this.onJobUpdate(message);
    await this._callEventHandler("on_job_update", message);
    this._pushJobGroupEvent(
      message.jobId,
      new JobGroupEvent({
        type: JobGroupEvent.UPDATE,
        workerName: message.source,
        data: message.update,
      }),
    );
  }

  /** Handle a job update request from the requester. */
  protected async _handleJobUpdateRequest(message: BusJobUpdateRequestMessage): Promise<void> {
    if (this._activeJobs.has(message.jobId)) {
      await this.onJobUpdateRequested(message);
      await this._callEventHandler("on_job_update_requested", message);
    }
  }

  /**
   * Handle a job cancellation.
   *
   * Cancels the running handler task (if any), calls the `onJobCancelled`
   * hook for cleanup, then automatically sends a cancelled response back to
   * the requester. The requester receives `onJobResponse` with
   * `status: "cancelled"`, same path as completed or failed jobs.
   */
  protected async _handleJobCancel(message: BusJobCancelMessage): Promise<void> {
    if (this._activeJobs.has(message.jobId)) {
      const handlerTask = this._jobHandlerTasks.get(message.jobId);
      if (handlerTask) {
        await this.cancelTask(handlerTask);
      }
      await this.onJobCancelled(message);
      await this._callEventHandler("on_job_cancelled", message);
      await this.sendJobResponse(message.jobId, null, { status: JobStatus.CANCELLED });
    }
  }

  /** Handle the start of a streaming job response. */
  protected async _handleJobStreamStart(message: BusJobStreamStartMessage): Promise<void> {
    await this.onJobStreamStart(message);
    await this._callEventHandler("on_job_stream_start", message);
    this._pushJobGroupEvent(
      message.jobId,
      new JobGroupEvent({
        type: JobGroupEvent.STREAM_START,
        workerName: message.source,
        data: message.data,
      }),
    );
  }

  /** Handle a streaming job data chunk. */
  protected async _handleJobStreamData(message: BusJobStreamDataMessage): Promise<void> {
    await this.onJobStreamData(message);
    await this._callEventHandler("on_job_stream_data", message);
    this._pushJobGroupEvent(
      message.jobId,
      new JobGroupEvent({
        type: JobGroupEvent.STREAM_DATA,
        workerName: message.source,
        data: message.data,
      }),
    );
  }

  /** Handle the end of a streaming job response. */
  protected async _handleJobStreamEnd(message: BusJobStreamEndMessage): Promise<void> {
    this._markWorkerTerminated(message.jobId, message.source);
    await this.onJobStreamEnd(message);
    await this._callEventHandler("on_job_stream_end", message);
    this._pushJobGroupEvent(
      message.jobId,
      new JobGroupEvent({
        type: JobGroupEvent.STREAM_END,
        workerName: message.source,
        data: message.data,
      }),
    );
    await this._trackJobGroupResponse(message.jobId, message.source, message.data);
  }

  protected _createJobGroup(workerNames: string[], options: { params: JobGroupParams }): JobGroup {
    const { params } = options;
    const jobId = crypto.randomUUID();
    const group = new JobGroup({
      jobId,
      workerNames: [...workerNames],
      cancelOnError: params.cancelOnError,
      label: params.label,
      cancellable: params.cancellable,
    });
    this._jobGroups.set(jobId, group);

    const timeout = params.timeout;
    if (timeout !== null) {
      group.timeoutTask = this.createTask(
        () => this._taskTimeout(jobId, timeout),
        `task_timeout_${jobId.slice(0, 8)}`,
      );
    }

    return group;
  }

  /**
   * Return a coroutine function that resolves when all named workers are ready.
   *
   * The watches are registered before this returns; callers race the
   * returned function against a timeout (`waitFor(allReady, timeout)`) or a
   * group done signal. Upstream returns an `asyncio.Future`; a function is
   * returned here because awaiting an async function that returns a Task
   * would adopt (wait for) it.
   *
   * @throws Error If the registry is not available.
   */
  protected async _waitWorkersReady(workerNames: string[]): Promise<TaskFn<void>> {
    if (!this._registry) {
      throw new Error(`Worker '${this}': registry not available`);
    }

    const readyEvents = new Map<string, Event>();
    for (const name of workerNames) {
      const event = new Event();
      readyEvents.set(name, event);

      const onReady = async (_data: WorkerReadyData) => {
        event.set();
      };

      await this._registry.watch(name, onReady);
    }

    return async () => {
      await gather(...[...readyEvents.values()].map((ev) => () => ev.wait()));
    };
  }

  protected async _sendJobRequest(
    workerName: string,
    jobId: string,
    options: { jobName?: string | null; payload?: Dict | null } = {},
  ): Promise<void> {
    await this.sendBusMessage(
      new BusJobRequestMessage({
        source: this.name,
        target: workerName,
        jobId,
        jobName: options.jobName ?? null,
        payload: options.payload ?? null,
      }),
    );
  }

  protected async _taskTimeout(jobId: string, timeout: number): Promise<void> {
    try {
      await sleep(timeout);
    } catch (e) {
      if (e instanceof CancelledError) return;
      throw e;
    }
    await this.cancelJobGroup(jobId, { reason: "timeout" });
  }

  protected _pushJobGroupEvent(jobId: string, event: JobGroupEvent): void {
    const group = this._jobGroups.get(jobId);
    if (group?.eventQueue) {
      group.eventQueue.putNowait(event);
    }
  }

  /** Record a worker's response and fire completion when all have responded. */
  protected async _trackJobGroupResponse(
    jobId: string,
    source: string,
    response: Dict | null,
  ): Promise<void> {
    const group = this._jobGroups.get(jobId);
    if (group) {
      group.responses[source] = response ?? {};
      if (group.workerNames.every((name) => Object.hasOwn(group.responses, name))) {
        if (group.timeoutTask) {
          await this.cancelTask(group.timeoutTask);
        }
        this._jobGroups.delete(jobId);
        const result = new JobGroupResponse({ jobId, responses: group.responses });
        await this.onJobCompleted(result);
        await this._callEventHandler("on_job_completed", result);
        group.complete();
      }
    }
  }

  /** Warn about tasks left running on the task manager this worker owns. */
  protected _printDanglingTasks(): void {
    if (this._checkDanglingTasks && this._ownsTaskManager) {
      const tasks = this.taskManager.currentTasks().map((t) => t.getName());
      if (tasks.length > 0) {
        logger.warning(
          `${this} dangling tasks detected: [${tasks.map((t) => `'${t}'`).join(", ")}]`,
        );
      }
    }
  }
}
