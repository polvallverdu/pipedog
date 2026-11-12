// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/llm/llm_worker.py

/**
 * LLM worker with tool registration.
 *
 * Provides the `LLMWorker` class that extends `PipelineWorker` with an LLM
 * pipeline and automatic tool registration.
 *
 * Porting notes:
 * - The deprecated `messages` / `resultCallback` arguments of `end()` and
 *   `activateWorker()` are not ported, nor is `_finishFunctionCall`, which
 *   only they used. Call `params.resultCallback(result)` before `end()` /
 *   `activateWorker()` instead.
 * - `_IN_TOOL_CALL` is a context variable upstream. JavaScript has no
 *   context variables in core (no `node:async_hooks` outside
 *   `@pipedog/asyncio`), so the worker running a tool is recorded per
 *   asyncio-style task instead. DIVERGENCE: a task the tool handler spawns
 *   (e.g. with `gather` or `createTask`) does not inherit it, so frames
 *   queued from such a task are not held.
 * - Tools are registered with `llm.registerFunction` and a bound direct
 *   function wrapper, rather than upstream's private
 *   `_register_direct_function`, because a bound (or wrapping) function no
 *   longer exposes the parameter list its direct-function schema is read
 *   from. The registration is explicit either way, so the advertised tools
 *   never auto-register over it.
 */

import { currentTask, type Task } from "@pipedog/asyncio";
import { DirectFunctionWrapper } from "../../adapters/llm/schemas/direct_function.ts";
import { ToolsSchema } from "../../adapters/llm/schemas/tools_schema.ts";
import { type Frame, LLMMessagesAppendFrame, LLMSetToolsFrame } from "../../frames/frames.ts";
import { Pipeline } from "../../pipeline/pipeline.ts";
import { PipelineParams, PipelineWorker } from "../../pipeline/worker.ts";
import type { LLMContextMessage } from "../../processors/aggregators/llm_context.ts";
import { FrameDirection } from "../../processors/frame_processor.ts";
import type { FunctionCallParams, LLMService } from "../../services/llm_service.ts";
import { WorkerActivationArgs, type WorkerActivationArgsOptions } from "../base_worker.ts";
import { _collectTools, type LLMTool } from "./tool_decorator.ts";

type Dict = Record<string, unknown>;

export interface LLMWorkerActivationArgsOptions extends WorkerActivationArgsOptions {
  /** LLM context messages to inject on activation. */
  messages?: LLMContextMessage[] | null;
  /**
   * Whether to run the LLM after appending messages. Defaults to true when
   * `messages` is set.
   */
  runLlm?: boolean | null;
}

/**
 * Activation arguments for LLM workers.
 *
 * - `messages`: LLM context messages to inject on activation.
 * - `runLlm`: whether to run the LLM after appending messages. Defaults to
 *   true when `messages` is set.
 */
export class LLMWorkerActivationArgs extends WorkerActivationArgs {
  messages: LLMContextMessage[] | null;
  runLlm: boolean | null;

  constructor(options: LLMWorkerActivationArgsOptions = {}) {
    super(options);
    this.messages = options.messages ?? null;
    this.runLlm = options.runLlm ?? null;
  }
}

/**
 * The worker whose `tool` handler is running, for the duration of that
 * handler. Upstream this is a context variable rather than a counter so it
 * answers "did this come from a tool", not "is a tool running somewhere": the
 * bus dispatch tasks were created before any tool and carry a context where
 * this is unset, so their frames are never mistaken for a handler's. It holds
 * the worker rather than a flag because a handler can reach another worker,
 * and only the worker running the tool will release what it holds.
 *
 * Here it is kept per task (see the module notes).
 */
const IN_TOOL_CALL = new WeakMap<Task<unknown>, LLMWorker | null>();

function getInToolCall(): LLMWorker | null {
  const task = currentTask();
  return task ? (IN_TOOL_CALL.get(task) ?? null) : null;
}

/** Set the current task's value; returns a token to restore the previous one. */
function setInToolCall(worker: LLMWorker): {
  task: Task<unknown> | undefined;
  previous: LLMWorker | null;
} {
  const task = currentTask();
  const previous = task ? (IN_TOOL_CALL.get(task) ?? null) : null;
  if (task) {
    IN_TOOL_CALL.set(task, worker);
  }
  return { task, previous };
}

function resetInToolCall(token: {
  task: Task<unknown> | undefined;
  previous: LLMWorker | null;
}): void {
  if (!token.task) return;
  if (token.previous === null) {
    IN_TOOL_CALL.delete(token.task);
  } else {
    IN_TOOL_CALL.set(token.task, token.previous);
  }
}

/**
 * A direct function wrapper that invokes the function with `this` bound to
 * its owner, so a tool method keeps both its parameter list (read from its
 * source) and its worker.
 */
class _BoundDirectFunctionWrapper extends DirectFunctionWrapper {
  readonly #thisArg: object;

  constructor(fn: LLMTool, thisArg: object) {
    super(fn);
    this.#thisArg = thisArg;
  }

  override async invoke(
    args: Readonly<Record<string, unknown>>,
    params: FunctionCallParams,
  ): Promise<unknown> {
    const positional = this._argumentNames().map((name) => args[name]);
    return await this.function.call(this.#thisArg, params, ...positional);
  }
}

export interface LLMWorkerOptions {
  /**
   * Unique name for this worker on the bus. Auto-generated when omitted; give
   * one when other workers address this one by name, as they must when it
   * runs in another process.
   */
  name?: string | null;
  /** The LLM service. `tool` decorated methods are automatically registered on it. */
  llm: LLMService;
  /**
   * Optional pipeline override. When null, defaults to `new Pipeline([llm])`.
   * Subclasses can pass a custom pipeline that wraps the LLM with additional
   * processors.
   */
  pipeline?: Pipeline | null;
  /** Whether the worker starts active. Defaults to false. */
  active?: boolean;
  /**
   * Bridge configuration forwarded to `PipelineWorker`. Pass `[]` to wrap the
   * LLM pipeline with bus edge processors so it can exchange frames with
   * another bridged worker.
   */
  bridged?: readonly string[] | null;
  /**
   * Whether to defer frames queued during tool execution until all tools
   * complete. Defaults to true.
   */
  deferToolFrames?: boolean;
}

/**
 * Worker with an LLM pipeline and automatic tool registration.
 *
 * Methods decorated with `tool` are registered as direct functions on the LLM
 * and tracked so that frames queued during tool execution can be deferred
 * until all tools complete.
 *
 * @example
 * class MyTask extends LLMWorker {
 *   async my_function(params: FunctionCallParams, arg: string) { ... }
 *   static {
 *     tool(this.prototype.my_function);
 *   }
 * }
 *
 * const worker = new MyTask({ name: "worker", llm: new OpenAILLMService({ apiKey: "..." }) });
 */
export class LLMWorker extends PipelineWorker {
  // State referenced by tool wrapper closures.
  protected _deferToolFrames: boolean;
  protected _toolCallInflight = 0;
  protected _deferredFrames: [Frame, FrameDirection][] = [];
  // A handover or ending a tool asked for, held until its call is done.
  protected _pendingHandover: (() => Promise<void>) | null = null;
  protected _closing = false;

  protected _llm: LLMService;

  /** Initialize the LLMWorker. */
  constructor(options: LLMWorkerOptions) {
    const pipeline = options.pipeline ?? new Pipeline([options.llm]);

    super(pipeline, {
      name: options.name ?? null,
      bridged: options.bridged ?? null,
      idleTimeoutSecs: null,
      params: new PipelineParams({
        enableMetrics: true,
        enableUsageMetrics: true,
      }),
      active: options.active ?? false,
    });

    this._deferToolFrames = options.deferToolFrames ?? true;
    this._llm = options.llm;
    this._registerTools(this._llm);
  }

  /** The LLM service this worker wraps. */
  get llm(): LLMService {
    return this._llm;
  }

  /** True when one or more `tool` methods are executing. */
  get toolCallActive(): boolean {
    return this._toolCallInflight > 0;
  }

  /**
   * Configure the LLM with tools and activation messages.
   *
   * @param args Optional activation arguments with messages to append.
   */
  override async onActivated(args: Dict | null): Promise<void> {
    await super.onActivated(args);

    const activation = args
      ? LLMWorkerActivationArgs.fromDict(args)
      : new LLMWorkerActivationArgs();

    const tools = this.buildTools();
    if (tools.length > 0) {
      await this.queueFrame(
        new LLMSetToolsFrame({ tools: new ToolsSchema({ standardTools: tools }) }),
      );
    }

    if (activation.messages && activation.messages.length > 0) {
      const runLlm = activation.runLlm !== null ? activation.runLlm : true;
      await this.queueFrame(new LLMMessagesAppendFrame({ messages: activation.messages, runLlm }));
    }
  }

  /**
   * Queue a frame, holding it if a tool handler queued it.
   *
   * A frame queued from inside one of this worker's `tool` handlers, or from
   * anything that handler awaits, is held and delivered once the last tool
   * finishes. Frames from anywhere else are queued immediately: the worker's
   * own traffic and frames arriving over the bus, which run outside any
   * handler's context, and frames a handler on a different worker queues
   * here, which this worker would never release.
   *
   * @param frame Any `Frame` to deliver.
   * @param direction Direction the frame should travel. Defaults to
   *   `FrameDirection.DOWNSTREAM`.
   */
  override async queueFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (this._deferToolFrames && getInToolCall() === this && !this._closing) {
      this._deferredFrames.push([frame, direction]);
    } else {
      await super.queueFrame(frame, direction);
    }
  }

  /**
   * Return the tools for this worker's LLM.
   *
   * By default, returns all methods decorated with `tool`. Override to
   * provide additional or different tools.
   *
   * @returns List of tool functions.
   */
  buildTools(): LLMTool[] {
    return _collectTools(this);
  }

  /**
   * Request a graceful end of the session.
   *
   * When called from a `tool` handler, deliver the function call result first
   * with `await params.resultCallback(result)`: the LLM output it triggers is
   * delivered before the session ends.
   *
   * @param options.reason Optional human-readable reason for ending.
   */
  override async end(options: { reason?: string | null } = {}): Promise<void> {
    this._closing = true;
    await this._afterToolCalls(() => super.end({ reason: options.reason ?? null }));
  }

  /**
   * Activate another worker, draining this worker's pipeline to hand over.
   *
   * When called from a `tool` handler, deliver the function call result first
   * with `await params.resultCallback(result)`: the output it triggers is
   * delivered before the target is activated. The handover itself waits
   * until the tool call asking for it has finished.
   *
   * @param workerName The name of the worker to activate.
   * @param options.args Optional `WorkerActivationArgs` forwarded to the
   *   target worker's `onActivated` handler.
   * @param options.deactivateSelf Whether to deactivate this worker before
   *   activating the target. Deactivating this worker drains its pipeline
   *   first; staying active does not. A worker that stays active and wants to
   *   drain anyway can call `flushPipeline` before this.
   */
  override async activateWorker(
    workerName: string,
    options: { args?: WorkerActivationArgs | null; deactivateSelf?: boolean } = {},
  ): Promise<void> {
    await this._afterToolCalls(() =>
      super.activateWorker(workerName, {
        args: options.args ?? null,
        deactivateSelf: options.deactivateSelf ?? false,
      }),
    );
  }

  /**
   * Process deferred frames before they are flushed.
   *
   * Called after all in-flight tools complete, before the deferred frames are
   * queued into the pipeline. Override to inspect, modify, reorder, or filter
   * the frames.
   *
   * @param frames The deferred frames collected during tool execution.
   * @returns The frames to queue. Return the list as-is for default behavior.
   */
  async processDeferredToolFrames(
    frames: [Frame, FrameDirection][],
  ): Promise<[Frame, FrameDirection][]> {
    return frames;
  }

  /** Register `tool` methods on the LLM in place. */
  protected _registerTools(llm: LLMService): void {
    for (const method of _collectTools(this)) {
      const tracked = this._trackToolCall(method);
      llm.registerFunction(method.name, tracked, {
        cancelOnInterruption: method._pipecatCancelOnInterruption ?? true,
        timeoutSecs: method._pipecatTimeoutSecs ?? null,
      });
    }
  }

  /**
   * Run a handover once no tool call is in flight.
   *
   * A tool asking to end or hand over is still running when it asks, and
   * deactivating a worker mid-call leaves the rest of that call to a worker
   * nobody is listening to. Held here and run once the last call finishes;
   * outside a call there is nothing to wait for, so it runs now.
   *
   * @param handover What to do once the calls are done.
   */
  protected async _afterToolCalls(handover: () => Promise<void>): Promise<void> {
    if (this._toolCallInflight) {
      this._pendingHandover = handover;
    } else {
      await handover();
    }
  }

  protected _trackToolCall(method: LLMTool): (params: FunctionCallParams) => Promise<void> {
    const wrapper = new _BoundDirectFunctionWrapper(method, this);
    return async (params: FunctionCallParams): Promise<void> => {
      this._toolCallInflight += 1;
      const token = setInToolCall(this);
      try {
        await wrapper.invoke(params.arguments, params);
      } finally {
        resetInToolCall(token);
        this._toolCallInflight = Math.max(0, this._toolCallInflight - 1);
        if (this._toolCallInflight === 0) {
          if (!this._closing) {
            await this._flushDeferredFrames();
          }
          const handover = this._pendingHandover;
          this._pendingHandover = null;
          if (handover) {
            await handover();
          }
        }
      }
    };
  }

  protected async _flushDeferredFrames(): Promise<void> {
    const frames = [...this._deferredFrames];
    this._deferredFrames.length = 0;

    // Held frames go back in behind the function call result, so wait for
    // that to be processed first. With nothing held there is nothing to
    // order, and the round-trip would buy nothing.
    if (frames.length > 0) {
      await this.flushPipeline();
    }

    for (const [frame, direction] of await this.processDeferredToolFrames(frames)) {
      await this.queueFrame(frame, direction);
    }
  }
}
