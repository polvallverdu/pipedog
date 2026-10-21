// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/llm_service.py

/**
 * Base classes for Large Language Model services with function calling support.
 *
 * Porting notes:
 * - Cancelling a function call cancels the task running its handler. In
 *   JavaScript cancellation is delivered at cancellation points (see
 *   `@pipedog/asyncio`), so a handler awaiting foreign work (`fetch`, an
 *   SDK) should pass `currentSignal()` to it, or wrap the await in
 *   `abortable()`, to stop as promptly as the Python handler would.
 * - Deprecated upstream APIs are not ported: `FunctionCallParams.tool_resources`,
 *   `register_direct_function()`, `unregister_direct_function()`, the
 *   `enable_async_tool_cancellation` option, the warnings for application-set
 *   turn-completion settings, and the legacy `LLMUpdateSettingsFrame(settings={...})`
 *   dict path.
 */

import {
  CancelledError,
  Queue,
  rethrowIfCancelled,
  sleep,
  type Task,
  TimeoutError,
  wait,
  waitFor,
} from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "../adapters/base_llm_adapter.ts";
import { DirectFunctionWrapper } from "../adapters/schemas/direct_function.ts";
import { ToolsSchema } from "../adapters/schemas/tools_schema.ts";
import { OpenAILLMAdapter } from "../adapters/services/open_ai_adapter.ts";
import {
  type CancelFrame,
  EagerEndOfTurnCancelFrame,
  type EndFrame,
  type ErrorFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  FunctionCallsStartedFrame,
  InterruptionFrame,
  LLMConfigureOutputFrame,
  LLMContextFrame,
  LLMContextSummaryRequestFrame,
  LLMContextSummaryResultFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMServiceMetadataFrame,
  LLMTextFrame,
  LLMUpdateSettingsFrame,
  type StartFrame,
} from "../frames/frames.ts";
import type { PipelineWorker } from "../pipeline/worker.ts";
import { ASYNC_TOOL_INSTRUCTIONS } from "../processors/aggregators/async_tool_messages.ts";
import { LLMContext, type LLMSpecificMessage } from "../processors/aggregators/llm_context.ts";
import { FrameDirection, type FrameProcessorSetup } from "../processors/frame_processor.ts";
import { SpeculationGate } from "../turns/speculation_gate.ts";
import { UserTurnCompletionLLMServiceMixin } from "../turns/user_turn_completion_mixin.ts";
import {
  ASYNC_TOOL_CANCELLATION_INSTRUCTIONS,
  buildCancelToolSchema,
  CANCEL_TOOL_PREFIX,
  cancelToolName,
} from "../utils/async_tool_cancellation.ts";
import {
  DEFAULT_SUMMARIZATION_TIMEOUT,
  LLMContextSummarizationUtil,
} from "../utils/context/llm_context_summarization.ts";
import { ErrorCategory } from "../utils/errors.ts";
import { FileResolver } from "../utils/file_resolver.ts";
import { _getLlmContextLogMode, _LLMContextLogMode } from "../utils/log_config.ts";
import { logger } from "../utils/logger.ts";
import { assertGiven, isGiven, NOT_GIVEN } from "../utils/types.ts";
import type { WorkerRunner } from "../workers/runner.ts";
import { AIService, type AIServiceOptions } from "./ai_service.ts";
import { LLMSettings } from "./settings.ts";
import {
  ConnectionClosed,
  State,
  WebsocketService,
  type WebsocketServiceOptions,
} from "./websocket_service.ts";

/**
 * Raised by a method a service doesn't implement (Python's
 * `NotImplementedError`), e.g. `LLMService.runInference()`.
 */
export class NotImplementedError extends Error {
  override name = "NotImplementedError";
}

/** Type alias for a callable that handles LLM function calls. */
export type FunctionCallHandler = (params: FunctionCallParams) => Promise<void>;

/**
 * The two roles a service can fill in an `LLMWithBackend`: the conversational
 * frontend, or the LLM inside the backend worker.
 */
export type LLMWithBackendRole = "frontend" | "backend";

/**
 * Function call result callback.
 *
 * Used for both final results and intermediate updates. Pass
 * `properties: new FunctionCallResultProperties({ isFinal: false })` to send an
 * intermediate update (only valid for async function calls registered with
 * `cancelOnInterruption: false`).
 *
 * - `result`: the result of the function call, or an intermediate update.
 * - `options.properties`: optional properties. Set `isFinal: false` to send an
 *   intermediate update instead of the final result.
 */
export type FunctionCallResultCallback = (
  result: unknown,
  options?: { properties?: FunctionCallResultProperties | null },
) => Promise<void>;

export interface FunctionCallParamsOptions {
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  llm: LLMService<any>;
  pipelineWorker: PipelineWorker;
  context: LLMContext;
  resultCallback: FunctionCallResultCallback;
  appResources?: unknown;
  workerRunner?: WorkerRunner | null;
}

/**
 * Parameters for a function call.
 *
 * - `functionName`: the name of the function being called.
 * - `toolCallId`: a unique identifier for the function call.
 * - `arguments`: the arguments for the function.
 * - `llm`: the LLMService instance being used.
 * - `pipelineWorker`: the worker running the pipeline this call was made from.
 *   Carries worker-scoped state, most notably `pipelineWorker.appResources`.
 * - `context`: the LLM context.
 * - `resultCallback`: callback to deliver the result of the function call.
 *   For async function calls (`cancelOnInterruption: false`), call it with
 *   `properties: new FunctionCallResultProperties({ isFinal: false })` to push
 *   intermediate updates before the final result.
 * - `appResources`: the application-defined resources passed to
 *   `new PipelineWorker(..., { appResources })`. Same object — passed by
 *   reference, not a copy. Use it to share DB handles, clients, state, feature
 *   flags, etc. across all of a session's tool handlers.
 * - `workerRunner`: the runner hosting `pipelineWorker`. Use it to reach
 *   another worker on the runner by name, e.g.
 *   `params.workerRunner.getWorker("ui-jobs")`. Always set for a call made
 *   from a running pipeline; null only when these params were built by hand.
 *
 * A handler runs in its own task and is cancelled on interruption, timeout or
 * an LLM cancel request. Pass `currentSignal()` to `fetch` and other foreign
 * awaits so they stop too.
 */
export class FunctionCallParams {
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  llm: LLMService<any>;
  pipelineWorker: PipelineWorker;
  context: LLMContext;
  resultCallback: FunctionCallResultCallback;
  appResources: unknown;
  workerRunner: WorkerRunner | null;

  constructor(options: FunctionCallParamsOptions) {
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.llm = options.llm;
    this.pipelineWorker = options.pipelineWorker;
    this.context = options.context;
    this.resultCallback = options.resultCallback;
    this.appResources = options.appResources ?? null;
    this.workerRunner = options.workerRunner ?? null;
  }
}

export interface FunctionCallRegistryItemOptions {
  functionName: string | null;
  handler: FunctionCallHandler | DirectFunctionWrapper;
  cancelOnInterruption: boolean;
  timeoutSecs?: number | null;
  cancellableByLlm?: boolean;
  autoRegistered?: boolean;
}

/**
 * Internal record of a registered function-call handler.
 *
 * Created by the service when a function is registered — directly via
 * `registerFunction`, or automatically from a direct function advertised in
 * an `LLMContext` / `LLMSetToolsFrame`. Application code doesn't construct
 * these.
 *
 * - `functionName`: the name of the function (null for catch-all handler).
 * - `handler`: the handler for processing function call parameters.
 * - `cancelOnInterruption`: whether to cancel the call on interruption. When
 *   false the call is treated as asynchronous: the LLM continues the
 *   conversation immediately without waiting for the result, and the result
 *   is injected later via a developer message.
 * - `timeoutSecs`: optional per-tool timeout in seconds. Overrides the global
 *   `functionCallTimeoutSecs` for this specific function. A call that runs
 *   past it is cancelled.
 * - `cancellableByLlm`: whether the LLM may cancel this call while it runs.
 *   Only meaningful on an async call (`cancelOnInterruption: false`), since a
 *   synchronous one holds the LLM until it returns.
 * - `autoRegistered`: true only for a direct function that was auto-registered
 *   from an advertised tool set (listed in an `LLMContext` or
 *   `LLMSetToolsFrame`). False for every explicitly registered handler —
 *   direct or non-direct — and for the catch-all and built-in handlers.
 */
export class FunctionCallRegistryItem {
  functionName: string | null;
  handler: FunctionCallHandler | DirectFunctionWrapper;
  cancelOnInterruption: boolean;
  timeoutSecs: number | null;
  cancellableByLlm: boolean;
  autoRegistered: boolean;

  constructor(options: FunctionCallRegistryItemOptions) {
    this.functionName = options.functionName;
    this.handler = options.handler;
    this.cancelOnInterruption = options.cancelOnInterruption;
    this.timeoutSecs = options.timeoutSecs ?? null;
    this.cancellableByLlm = options.cancellableByLlm ?? false;
    this.autoRegistered = options.autoRegistered ?? false;
  }
}

export interface FunctionCallRunnerItemOptions {
  registryItem: FunctionCallRegistryItem;
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  context: LLMContext;
  runLlm?: boolean | null;
  groupId?: string | null;
  settled?: boolean;
}

/**
 * Internal function call entry for the function call runner.
 *
 * The runner executes function calls in order.
 *
 * - `registryItem`: the registry item containing handler information.
 * - `functionName`: the name of the function.
 * - `toolCallId`: a unique identifier for the function call.
 * - `arguments`: the arguments for the function.
 * - `context`: the LLM context.
 * - `runLlm`: optional flag to control LLM execution after function call.
 * - `groupId`: shared identifier for all function calls from the same LLM
 *   response batch. Used to trigger the LLM exactly once when the last call in
 *   the group completes.
 * - `settled`: whether the call has already reached a terminal state — a final
 *   result, a timeout, or a cancellation. Results reported after that are
 *   rejected, since the rest of the pipeline has stopped tracking the call.
 */
export class FunctionCallRunnerItem {
  registryItem: FunctionCallRegistryItem;
  functionName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  context: LLMContext;
  runLlm: boolean | null;
  groupId: string | null;
  settled: boolean;

  constructor(options: FunctionCallRunnerItemOptions) {
    this.registryItem = options.registryItem;
    this.functionName = options.functionName;
    this.toolCallId = options.toolCallId;
    this.arguments = options.arguments;
    this.context = options.context;
    this.runLlm = options.runLlm ?? null;
    this.groupId = options.groupId ?? null;
    this.settled = options.settled ?? false;
  }
}

/**
 * Attributes `toolOptions()` sets on a handler (upstream `@tool_options`),
 * with the option names the log lines use.
 */
const TOOL_OPTION_NAMES: Record<string, string> = {
  _pipecatCancelOnInterruption: "cancel_on_interruption",
  _pipecatTimeoutSecs: "timeout_secs",
  _pipecatCancellableByLlm: "cancellable_by_llm",
};

/** Python's `repr()` closely enough for log lines. */
function repr(value: unknown): string {
  if (typeof value === "string") {
    return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
  }
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** Python's `f"{e}"` for an exception. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A string attribute set on a handler function, if any. */
function handlerAttr(handler: unknown, attr: string): unknown {
  if (handler === null || handler === undefined) return null;
  return (handler as Record<string, unknown>)[attr] ?? null;
}

export interface LLMServiceOptions extends AIServiceOptions {
  /** Whether to run function calls in parallel or sequentially. Defaults to true. */
  runInParallel?: boolean;
  /**
   * Whether to group parallel function calls so the LLM is triggered exactly
   * once after all calls in the batch complete. When false, each function
   * call result triggers the LLM independently as it arrives. Defaults to true.
   */
  groupParallelTools?: boolean;
  /**
   * Optional timeout in seconds for function calls. A call that runs past it
   * is cancelled: its handler is cancelled (it gets a `CancelledError`), the
   * call is settled as cancelled, and inference runs so the LLM can report
   * that it didn't complete.
   */
  functionCallTimeoutSecs?: number | null;
  /** The runtime-updatable settings for the LLM service. */
  settings?: LLMSettings | null;
  /**
   * Resolves file URLs in the context that this provider can't fetch itself
   * (see `FileResolver`). Pass one configured with a `fileStorage` to resolve
   * uploaded-file URLs (`new FileResolver({ fileStorage: runnerArgs.fileStorage })`
   * when a runner hosts the bot), and share one instance across services that
   * may consume the same files (e.g. services switched between mid-session)
   * so downloads are reused. Defaults to a resolver that handles `data:` and
   * `http(s)` URLs only.
   */
  fileResolver?: FileResolver | null;
}

/** An adapter class `LLMService.adapterClass` can name. */
export type LLMAdapterClass = new () => BaseLLMAdapter<object>;

/**
 * Base class for all LLM services.
 *
 * Handles function calling registration and execution with support for both
 * parallel and sequential execution modes. Provides event handlers for
 * completion timeouts and function call lifecycle events.
 *
 * The service supports the following event handlers:
 *
 * - on_completion_timeout: called when an LLM completion timeout occurs
 * - on_function_calls_started: called when function calls are received and
 *   execution is about to start. Built-in tools (e.g. a `cancel_<name>` tool)
 *   are excluded from this event.
 * - on_function_calls_cancelled: called after one or more async tool calls are
 *   cancelled.
 *
 * @example
 * llm.eventHandler("on_completion_timeout", async (service) => {
 *   logger.warning("LLM completion timed out");
 * });
 * llm.eventHandler("on_function_calls_started", async (service, functionCalls: FunctionCallFromLLM[]) => {
 *   logger.info(`Starting ${functionCalls.length} function calls`);
 * });
 * llm.eventHandler("on_function_calls_cancelled", async (service, functionCalls: FunctionCallFromLLM[]) => {
 *   logger.info(`Cancelled ${functionCalls.length} function calls`);
 * });
 *
 * @throws InvalidEnvVarValueError (from the constructor) if
 *   `PIPECAT_LOG_LLM_CONTEXT` is set to an unknown mode.
 */
export class LLMService<
  TAdapter extends BaseLLMAdapter = BaseLLMAdapter,
> extends UserTurnCompletionLLMServiceMixin(AIService) {
  declare protected _settings: LLMSettings;
  protected _adapter: TAdapter;

  /**
   * Subclasses should set this to a more specific adapter when necessary.
   * `null` selects OpenAILLMAdapter, which aligns with most LLM
   * implementations.
   */
  static adapterClass: LLMAdapterClass | null = null;

  /**
   * Returned to the LLM as the tool result when an unavailable function is
   * called. Deliberately neutral about future availability so the LLM can
   * pick the function up again if it returns (e.g. via the
   * `addToolChangeMessages` activation message, or silently on a later
   * inference). `{function_name}` is substituted at runtime.
   */
  static MISSING_FUNCTION_CALL_MESSAGE_TEMPLATE =
    "The function `{function_name}` is not currently available.";

  /**
   * Returned to the LLM as the tool result when a handler raises. It names
   * the function as the thing that failed. The exception itself is
   * deliberately left out.
   */
  static FUNCTION_CALL_ERROR_MESSAGE_TEMPLATE =
    "The function `{function_name}` failed and returned no result.";

  /**
   * Whether the provider can enforce a response schema in `runInference()`.
   *
   * Services whose provider can set this to true. When only some of its
   * models can, they also override `modelSupportsResponseSchema()`.
   */
  static supportsResponseSchema = false;

  protected _runInParallel: boolean;
  protected _groupParallelTools: boolean;
  protected _functionCallTimeoutSecs: number | null;
  protected _fileResolver: FileResolver;
  protected _reportsTtfat: boolean | null = null;
  // Turn completion is owned by LLMTurnCompletionUserTurnStopStrategy, which
  // enables it over an LLMUpdateSettingsFrame once the pipeline starts.
  protected _filterIncompleteUserTurns = false;
  protected _loggedThinkingDefaultModel: string | null = null;
  // Holds a speculative response until its turn is confirmed. Frames are
  // routed through it on the way out, in `pushFrame`.
  protected _speculationGate: SpeculationGate;
  // The per-tool cancel tools currently advertised, by name.
  protected _cancelToolNames = new Set<string>();
  // Cancel-tool names that collide with a user's own tool, warned about once.
  protected _warnedCancelCollisions = new Set<string>();
  // The user's base system instruction, without composed addons. Captured
  // here and refreshed when the user changes `systemInstruction` at runtime;
  // `_composeSystemInstruction` always rebuilds the effective instruction
  // from this plus any appended / addon instructions.
  protected _baseSystemInstruction: string | null;
  protected _appendedSystemInstructions: string[] = [];
  // The instruction as last composed, so a recomposition that changes nothing
  // (every tool sync recomposes) is not logged again.
  protected _composedSystemInstruction: string | null = null;
  protected _functions = new Map<string | null, FunctionCallRegistryItem>();
  // Cleanup callables carried by registered tool handlers, awaited at service
  // teardown (see _recordToolCleanup).
  protected _toolCleanups: (() => Promise<void>)[] = [];
  // Names we've already warned about for a redundant manual registration (an
  // explicit registerFunction call for a tool whose advertised FunctionSchema
  // already carries a handler), so the warning fires once rather than on
  // every context frame.
  protected _redundantRegistrationWarned = new Set<string>();
  // Names explicitly unregistered (via unregisterFunction) that
  // auto-registration must not re-register while they're still advertised —
  // otherwise a standalone unregister would be undone by the next context
  // frame. Cleared when the name is registered again or stops being
  // advertised (see _syncRegisteredToolHandlers).
  protected _explicitlyUnregisteredFunctionNames = new Set<string | null>();
  protected _functionCallTasks = new Map<Task<unknown> | null, FunctionCallRunnerItem>();
  protected _sequentialRunnerTask: Task<unknown> | null = null;
  protected _sequentialRunnerQueue: Queue<FunctionCallRunnerItem> = new Queue();
  protected _skipTts: boolean | null = null;
  protected _summaryTask: Task<unknown> | null = null;
  // Whether the one-time realtime-service "no turn frames" warning has fired
  // (see _warnIfRealtimeServiceEmitsNoTurnFrames).
  protected _warnedRealtimeServiceNoTurnFrames = false;

  // Bound handlers, so they compare equal wherever they are stored (Python
  // bound methods compare equal; JavaScript closures don't).
  readonly #functionCallTaskDone = (task: Task<unknown>): void =>
    this._functionCallTaskFinished(task);
  readonly #missingFunctionCallHandler: FunctionCallHandler = (params) =>
    this._missingFunctionCallHandler(params);
  readonly #cancelToolHandler: FunctionCallHandler = (params) => this._cancelToolHandler(params);

  constructor(options: LLMServiceOptions = {}) {
    super({
      ...options,
      // Here in case subclass doesn't implement more specific settings (which
      // hopefully should be rare)
      settings: options.settings ?? new LLMSettings(),
    });
    // Filled in here rather than in every service's default settings, since
    // only the services with thinking defaults read it.
    if (!isGiven(this._settings.useProviderThinkingDefault)) {
      this._settings.useProviderThinkingDefault = false;
    }
    // Validated here so a bad value stops the bot at startup; otherwise it
    // would surface on the first inference, and only with DEBUG enabled.
    _getLlmContextLogMode();
    this._runInParallel = options.runInParallel ?? true;
    this._groupParallelTools = options.groupParallelTools ?? true;
    this._functionCallTimeoutSecs = options.functionCallTimeoutSecs ?? null;
    this._fileResolver = options.fileResolver ?? new FileResolver();
    this._speculationGate = new SpeculationGate({ name: `${this}::SpeculationGate` });
    const baseSi = this._settings.systemInstruction;
    this._baseSystemInstruction = typeof baseSi === "string" ? baseSi : null;
    const adapterClass = (this.constructor as typeof LLMService)._resolveAdapterClass();
    this._adapter = new adapterClass() as TAdapter;
    // The adapter reads the resolver's caches during every conversion —
    // invocation params and logging alike.
    this._adapter.fileResolver = this._fileResolver;

    this._registerEventHandler("on_function_calls_started");
    this._registerEventHandler("on_function_calls_cancelled");
    this._registerEventHandler("on_completion_timeout");
  }

  /** Return the adapter class to instantiate for this service. */
  static _resolveAdapterClass(): LLMAdapterClass {
    if (this.adapterClass !== null) {
      return this.adapterClass;
    }
    return OpenAILLMAdapter;
  }

  /**
   * Get the LLM adapter instance.
   *
   * @returns The adapter instance used for LLM communication.
   */
  getLlmAdapter(): TAdapter {
    return this._adapter;
  }

  /**
   * Create an LLM-specific message (as opposed to a standard message) for use
   * in an LLMContext.
   *
   * @param message The message content.
   * @returns A LLMSpecificMessage instance.
   */
  createLlmSpecificMessage(message: unknown): LLMSpecificMessage {
    return this.getLlmAdapter().createLlmSpecificMessage(message);
  }

  /**
   * Log that the service is generating a response from the given context.
   *
   * The context is included unless the LLM context log mode is `off`.
   *
   * @param context The context sent with the request.
   */
  protected _logLlmResponse(context: LLMContext): void {
    this._logLlmEvent("Generating LLM response", context);
  }

  /**
   * Log that a realtime service is seeding its server-side conversation.
   *
   * Realtime services upload the context once per session (and again after a
   * reset), then send only new items. The context is included unless the LLM
   * context log mode is `off`.
   *
   * @param context The context being uploaded.
   */
  protected _logLlmConversationSetup(context: LLMContext): void {
    this._logLlmEvent("Setting up LLM conversation", context);
  }

  protected _logLlmEvent(event: string, context: LLMContext): void {
    // Built only if a sink accepts DEBUG.
    if (!logger.isEnabledFor("DEBUG")) return;
    if (_getLlmContextLogMode() === _LLMContextLogMode.OFF) {
      logger.debug(`${this}: ${event}`);
      return;
    }
    const messages = this.getLlmAdapter().getMessagesForLogging(context);
    logger.debug(`${this}: ${event} ${JSON.stringify(messages)}`);
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the
   * given LLM context.
   *
   * Must be implemented by subclasses.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate. If
   *   provided, overrides the service's default max_tokens/max_completion_tokens
   *   setting.
   * @param options.systemInstruction Optional system instruction to use for
   *   this inference. If provided, overrides any system instruction in the
   *   context.
   * @param options.responseSchema Optional JSON schema the reply must follow.
   *   Services that can have the provider enforce it return JSON text matching
   *   the schema. When the service or its current model cannot enforce one
   *   (see `supportsResponseSchema`), the schema is ignored with a warning.
   *   The schema must satisfy the strictest provider in use: every object
   *   lists all its properties as required and sets `additionalProperties` to
   *   false.
   * @returns The LLM's response as a string, or null if no response is generated.
   */
  async runInference(
    _context: LLMContext,
    _options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    throw new NotImplementedError(`run_inference() not supported by ${this.constructor.name}`);
  }

  /** The schema to send, or null with a warning if it cannot be enforced. */
  protected _checkResponseSchema(
    responseSchema: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (responseSchema === null || responseSchema === undefined) {
      return null;
    }
    if (!this.supportsResponseSchema) {
      logger.warning(`${this}: response_schema is not supported and is ignored`);
      return null;
    }
    const model = this._settings.model;
    const cls = this.constructor as typeof LLMService;
    if (!cls.modelSupportsResponseSchema(isGiven(model) && model ? model : "")) {
      logger.warning(
        `${this}: response_schema is not supported by model ${model ?? "None"} and is ignored`,
      );
      return null;
    }
    return responseSchema;
  }

  /** Whether this service's provider can enforce a response schema. */
  get supportsResponseSchema(): boolean {
    return (this.constructor as typeof LLMService).supportsResponseSchema;
  }

  /**
   * Whether a model can enforce a response schema, on a provider that can.
   *
   * @param model The model name.
   */
  static modelSupportsResponseSchema(_model: string): boolean {
    return true;
  }

  /**
   * Whether this service reports time-to-first-answer-token.
   *
   * Speech-to-speech services answer in audio, which has no answer token to
   * measure to, so only text-answering services report it. Derived from
   * `serviceMetadataFrame()` and cached, since it is read once per streamed
   * token.
   */
  get reportsTtfat(): boolean {
    if (this._reportsTtfat === null) {
      this._reportsTtfat = !this.serviceMetadataFrame().isRealtimeService;
    }
    return this._reportsTtfat;
  }

  /**
   * Whether this service delivers a tool's intermediate results to the model.
   *
   * An intermediate result is one reported with
   * `new FunctionCallResultProperties({ isFinal: false })` while the call keeps
   * running. A text service passes them on as context messages. A
   * speech-to-speech service has to map them onto whatever second channel its
   * provider offers, and not all of them have one.
   */
  get acceptsIntermediateFunctionCallResults(): boolean {
    return true;
  }

  /**
   * Why this service can't take the given role in an `LLMWithBackend`, if it
   * can't.
   *
   * The composite raises with what this returns, so the objection says what
   * to do instead. Services that work in both roles, which is nearly all of
   * them, say nothing.
   *
   * @param role The role the service is being asked to take.
   * @returns The reason, or null when the service can take the role.
   */
  llmWithBackendRoleObjection(_role: LLMWithBackendRole): string | null {
    return null;
  }

  /**
   * Send a model the thinking default its service lists, and log it once per
   * model.
   *
   * Services that send each model its lowest thinking setting call this when
   * the request configures no thinking of its own. With
   * `useProviderThinkingDefault` set, the service sends no default. The first
   * request for each model logs the setting sent, or that the model runs at
   * the provider's default, warning when it has no default.
   *
   * @param params The request params, updated in place. Each field of
   *   `defaultParams` is merged into the dict already there, if any.
   * @param model The model the request is for.
   * @param defaultParams The request fields to send, or null if the service
   *   lists no default for the model.
   * @param options.canThink Whether the model can think, which decides
   *   whether a model with no default is warned about.
   * @param options.provider The provider's name, for the log lines.
   * @param options.settingsFields The settings fields that configure thinking,
   *   as the log lines name them, such as "`thinking`".
   */
  protected _applyThinkingDefault(
    params: Record<string, unknown>,
    model: string,
    defaultParams: Record<string, Record<string, unknown>> | null,
    options: { canThink: boolean; provider: string; settingsFields: string },
  ): void {
    const { canThink, provider, settingsFields } = options;
    const providerDefault = assertGiven(this._settings.useProviderThinkingDefault);
    if (defaultParams !== null && !providerDefault) {
      for (const [field, value] of Object.entries(defaultParams)) {
        params[field] = { ...((params[field] as Record<string, unknown>) ?? {}), ...value };
      }
    }
    if (model === this._loggedThinkingDefaultModel) {
      return;
    }
    this._loggedThinkingDefaultModel = model;
    const settingsClass = `${this.constructor.name}.Settings`;
    if (providerDefault) {
      if (canThink) {
        logger.debug(
          `${this}: use_provider_thinking_default is set, so ${model} runs at ${provider}'s ` +
            `default thinking. To change it, set ${settingsFields} in ${settingsClass}.`,
        );
      }
    } else if (defaultParams !== null) {
      const setting = Object.entries(defaultParams)
        .map(([field, value]) => `${field}=${repr(value)}`)
        .join(", ");
      logger.info(
        `${this}: sending ${setting} to ${model}, its lowest thinking setting, for the ` +
          "fastest responses. If your bot needs multistep reasoning, set " +
          `${settingsFields} in ${settingsClass}.`,
      );
    } else if (canThink) {
      logger.warning(
        `${this}: Pipecat has no thinking default for ${model}, so it runs at ` +
          `${provider}'s default, which can think before replying and slow responses. ` +
          `For the fastest responses, set ${settingsFields} in ${settingsClass} to the ` +
          `lowest setting ${model} supports.`,
      );
    }
  }

  /**
   * The metadata frame this LLM service broadcasts at start.
   *
   * The base returns a plain (non-realtime) frame; realtime (speech-to-speech)
   * subclasses override this to set `isRealtimeService: true` and, when their
   * turns are provider-driven, recommend `ExternalUserTurnStrategies` via
   * `userTurnStrategies`.
   *
   * Mostly here for conceptual consistency — today only realtime services
   * need to override it — but it's a natural placeholder for future
   * LLM-service metadata.
   */
  override serviceMetadataFrame(): LLMServiceMetadataFrame {
    return new LLMServiceMetadataFrame({ serviceName: this.name });
  }

  /**
   * Warn (once) when a realtime service won't emit its own turn frames.
   *
   * Realtime services call this from `serviceMetadataFrame()` at the point
   * they determine whether their turns are provider-driven. When they aren't,
   * downstream processors that expect `UserStarted/StoppedSpeakingFrame`
   * (e.g. RTVI) may need local VAD/turn detection.
   */
  protected _warnIfRealtimeServiceEmitsNoTurnFrames(emitsTurnFrames: boolean): void {
    if (emitsTurnFrames || this._warnedRealtimeServiceNoTurnFrames) {
      return;
    }
    this._warnedRealtimeServiceNoTurnFrames = true;
    logger.warning(
      `${this} is not emitting turn frames ` +
        "(UserStartedSpeakingFrame/UserStoppedSpeakingFrame) — this service " +
        "either doesn't support them or isn't configured to emit them. A " +
        "couple of things to keep in mind:\n" +
        "  - Other processors in the pipeline (e.g. RTVI) may expect " +
        "turn frames. You can enable local VAD/turn detection by " +
        "setting a vad_analyzer in LLMUserAggregatorParams.\n" +
        "  - Be aware that local turns may NOT perfectly align with " +
        'the "ground truth" of server-decided turns, so they should ' +
        "be thought of as APPROXIMATE (unless, of course, you've " +
        "also configured local turn detection to *drive* the " +
        "realtime service's turns, e.g. by setting " +
        "vad=GeminiVADParams(disabled=True)).",
    );
  }

  /**
   * Start the LLM service.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (!this._runInParallel) {
      await this._createSequentialRunnerTask();
    }
    // A realtime service can run a tool it was configured with before the
    // first context frame reaches it, so the handlers of its own tools are
    // registered up front. Context frames re-sync them from then on.
    this._syncRegisteredToolHandlers(null);
  }

  /**
   * Stop the LLM service.
   *
   * @param frame The end frame.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    if (!this._runInParallel) {
      await this._cancelSequentialRunnerTask();
    }
    await this._cancelSummaryTask();
  }

  /**
   * Cancel the LLM service.
   *
   * @param frame The cancel frame.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    if (!this._runInParallel) {
      await this._cancelSequentialRunnerTask();
    }
    await this._cancelSummaryTask();
  }

  /**
   * Release LLM service resources at teardown.
   *
   * Besides this service's own tasks, runs any cleanup callables carried by
   * registered tool handlers (e.g. closing an MCP client's connection).
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (!this._runInParallel) {
      await this._cancelSequentialRunnerTask();
    }
    await this._cancelSummaryTask();
    await this._cancelAllFunctionCallTasks();
    await this._runToolCleanups();
  }

  /**
   * Append durable text to the system instruction, preserving the user's
   * prompt.
   *
   * The text is composed onto the end of the system instruction (joined with
   * a blank line) and re-applied on every inference, so it survives
   * context-message resets (e.g. `new LLMMessagesUpdateFrame({ messages: [] })`).
   * Intended for framework components that own an LLM and need to add
   * standard guidance to a user-provided prompt — for example, `UIWorker`
   * appends the UI wire-format guide. Appended instructions compose after the
   * user's base prompt and alongside the turn-completion and
   * async-tool-cancellation instructions.
   *
   * @param instruction The instruction text to append.
   */
  appendSystemInstruction(instruction: string): void {
    this._appendedSystemInstructions.push(instruction);
    this._composeSystemInstruction();
  }

  /**
   * Whether any registered tool runs asynchronously.
   *
   * @returns True when a tool is registered with `cancelOnInterruption: false`,
   *   which is what makes the async-tool guidance worth composing in. The
   *   built-in cancellation tool is registered as a synchronous one, so it
   *   never counts on its own.
   */
  protected _hasAsyncTools(): boolean {
    for (const item of this._functions.values()) {
      if (!item.cancelOnInterruption) return true;
    }
    return false;
  }

  /**
   * Rebuild `systemInstruction` from the base prompt and all active addons.
   *
   * Joins the user's base system instruction (the single source of truth,
   * captured at construction and refreshed on runtime `systemInstruction`
   * updates) with any appended instructions (e.g. the `UIWorker` prompt
   * guide), turn completion instructions (when enabled), and async tool
   * cancellation instructions (when enabled). Safe to call repeatedly — it
   * always rebuilds from the base, so it never compounds, and it logs the
   * result only when it differs from the previous composition.
   */
  protected _composeSystemInstruction(): void {
    const base = this._baseSystemInstruction;
    const parts: string[] = base ? [base] : [];
    parts.push(...this._appendedSystemInstructions);
    if (this._filterIncompleteUserTurns) {
      parts.push(this._userTurnCompletionConfig.completionInstructions);
    }
    if (this._cancelToolNames.size > 0) {
      parts.push(ASYNC_TOOL_CANCELLATION_INSTRUCTIONS);
    }
    if (this._hasAsyncTools()) {
      parts.push(ASYNC_TOOL_INSTRUCTIONS);
    }
    const composed = parts.filter((p) => p).join("\n\n") || null;
    this._settings.systemInstruction = composed;
    if (composed !== this._composedSystemInstruction) {
      this._composedSystemInstruction = composed;
      logger.debug(`${this}: System instruction composed: ${composed}`);
    }
  }

  /**
   * Apply a settings delta, handling turn-completion fields.
   *
   * @param delta An LLM settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("filterIncompleteUserTurns" in changed) {
      const value = this._settings.filterIncompleteUserTurns;
      this._filterIncompleteUserTurns = isGiven(value) && Boolean(value);
      logger.info(
        `${this}: Incomplete turn filtering ` +
          `${this._filterIncompleteUserTurns ? "enabled" : "disabled"}`,
      );
    }

    if ("systemInstruction" in changed) {
      // The user replaced the base prompt; re-snapshot it so composition
      // rebuilds the effective instruction from the new value.
      const baseSi = this._settings.systemInstruction;
      this._baseSystemInstruction = typeof baseSi === "string" ? baseSi : null;
    }

    if ("userTurnCompletionConfig" in changed && this._filterIncompleteUserTurns) {
      this.setUserTurnCompletionConfig(assertGiven(this._settings.userTurnCompletionConfig));
    }

    // Any of these fields changes the composed instruction; rebuild it.
    if (
      "filterIncompleteUserTurns" in changed ||
      "systemInstruction" in changed ||
      "userTurnCompletionConfig" in changed
    ) {
      this._composeSystemInstruction();
    }

    return changed;
  }

  /**
   * Process a frame.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InterruptionFrame) {
      await this._handleInterruptions(frame);
    } else if (frame instanceof EagerEndOfTurnCancelFrame) {
      await this._handleEagerEndOfTurnCancel(frame);
    } else if (frame instanceof LLMConfigureOutputFrame) {
      this._skipTts = frame.skipTts;
    } else if (frame instanceof LLMUpdateSettingsFrame) {
      if (frame.service !== null && frame.service !== undefined && frame.service !== this) {
        await this.pushFrame(frame, direction);
      } else if (frame.delta !== null && frame.delta !== undefined) {
        await this._updateSettings(frame.delta);
      }
    } else if (frame instanceof LLMContextSummaryRequestFrame) {
      await this._handleSummaryRequest(frame);
    }

    if (frame instanceof LLMContextFrame) {
      // Runs before the subclass starts the completion, so the gate knows
      // what this inference answers before any of its frames arrive.
      this._speculationGate.beginSpeculation(frame.speculation);

      // Sync the registered handlers with the tools advertised in the
      // context: register any newly advertised handler, drop the ones we
      // auto-registered that are no longer advertised. The context carries
      // the current tool set on every inference, so this is the single place
      // tool changes take effect for text LLMs.
      //
      // Realtime (speech-to-speech) services run continuously and don't get a
      // fresh context frame per turn, so they additionally call
      // _syncRegisteredToolHandlers on their own LLMSetToolsFrame handling.
      this._syncRegisteredToolHandlers(frame.context.tools);
    }
  }

  /**
   * Pushes a frame.
   *
   * @param frame The frame to push.
   * @param direction The direction of frame pushing.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    if (
      frame instanceof LLMTextFrame ||
      frame instanceof LLMFullResponseStartFrame ||
      frame instanceof LLMFullResponseEndFrame
    ) {
      if (this._skipTts !== null) {
        frame.skipTts = this._skipTts;
      }
    }

    // The gate decides synchronously, so its verdict can't be torn by another
    // task pushing at the same time. Everything it hands back is pushed past
    // it — routing that back through here would re-gate it.
    const emitted = this._speculationGate.process(frame, direction);
    for (const [gatedFrame, gatedDirection] of emitted) {
      await super.pushFrame(gatedFrame, gatedDirection);
    }
  }

  /**
   * Push LLM text, using turn completion detection if enabled.
   *
   * This helper method simplifies text pushing in LLM implementations by
   * handling the conditional logic for turn completion internally.
   *
   * @param text The text content from the LLM to push.
   */
  protected async _pushLlmText(text: string): Promise<void> {
    // Measured before turn-completion filtering, which can hold text back or
    // drop it entirely — neither says anything about how fast the model
    // answered.
    if (this.reportsTtfat) {
      await this.stopTtfatMetrics();
    }

    if (this._filterIncompleteUserTurns) {
      await this._pushTurnText(text);
    } else {
      await this.pushFrame(new LLMTextFrame({ text }));
    }
  }

  protected async _handleInterruptions(_frame: InterruptionFrame): Promise<void> {
    for (const [functionName, entry] of [...this._functions.entries()]) {
      if (entry.cancelOnInterruption) {
        await this._cancelFunctionCall(functionName);
      }
    }
  }

  /**
   * Stop generating a response whose user turn turned out to be unfinished.
   *
   * The tokens are wasted either way; stopping keeps us from paying for the
   * rest of them. Unlike an interruption this leaves the turn open — the bot
   * never spoke, and the user is still mid-turn.
   */
  protected async _handleEagerEndOfTurnCancel(_frame: EagerEndOfTurnCancelFrame): Promise<void> {
    // Runs before the frame reaches the gate, which is what clears the
    // speculation, so this still sees the one being withdrawn.
    if (!this._speculationGate.isSpeculating) {
      return;
    }

    logger.debug(`${this}: eager end of turn withdrawn, stopping the speculative inference`);
    await this._startInterruption();
    await this.stopAllMetrics();
  }

  /**
   * Handle context summarization request from aggregator.
   *
   * Processes a summarization request by generating a compressed summary of
   * conversation history. Uses the adapter to format the summary according
   * to the provider's requirements. Broadcasts the result back to the
   * aggregator for context reconstruction.
   *
   * @param frame The summary request frame containing context and parameters.
   */
  protected async _handleSummaryRequest(frame: LLMContextSummaryRequestFrame): Promise<void> {
    logger.debug(`${this}: Processing summarization request ${frame.requestId}`);

    // Create a background task to generate the summary without blocking
    this._summaryTask = this.createTask(
      () => this._generateSummaryTask(frame),
      "_generate_summary_task",
    );
  }

  /**
   * Background task to generate summary without blocking the pipeline.
   *
   * @param frame The summary request frame containing context and parameters.
   */
  protected async _generateSummaryTask(frame: LLMContextSummaryRequestFrame): Promise<void> {
    let summary = "";
    let lastIndex = -1;
    let error: string | null = null;

    // Python `or`: a 0 timeout also falls back to the default.
    const timeout = frame.summarizationTimeout || DEFAULT_SUMMARIZATION_TIMEOUT;

    try {
      [summary, lastIndex] = await waitFor(() => this._generateSummary(frame), timeout);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof TimeoutError) {
        await this.pushError(`Context summarization timed out after ${timeout}s`);
      } else {
        error = `Error generating context summary: ${errorText(e)}`;
        await this.pushError(error, { exception: e });
      }
    }

    await this.broadcastFrame(LLMContextSummaryResultFrame, {
      requestId: frame.requestId,
      summary,
      lastSummarizedIndex: lastIndex,
      error,
    });

    this._summaryTask = null;
  }

  /**
   * Generate a compressed summary of conversation context.
   *
   * Uses the message selection logic to identify which messages to
   * summarize, formats them as a transcript, and invokes the LLM to generate
   * a concise summary. The summary is formatted according to the LLM
   * provider's requirements using the adapter.
   *
   * Requires the service to implement `runInference()` for one-shot LLM calls.
   *
   * @param frame The summary request frame containing context and configuration.
   * @returns Tuple of (formatted summary message, lastSummarizedIndex).
   * @throws Error if there are no messages to summarize, the service doesn't
   *   support runInference(), or the LLM returns an empty summary.
   */
  protected async _generateSummary(
    frame: LLMContextSummaryRequestFrame,
  ): Promise<[string, number]> {
    // Get messages to summarize using utility method
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(
      frame.context,
      frame.minMessagesToKeep,
    );

    if (result.messages.length === 0) {
      logger.debug(`${this}: No messages to summarize`);
      throw new Error("No messages to summarize");
    }

    logger.debug(
      `${this}: Generating summary for ${result.messages.length} messages ` +
        `(index 0 to ${result.lastSummarizedIndex}), ` +
        `target_context_tokens=${frame.targetContextTokens}`,
    );

    // Create summary context
    const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(result.messages);
    const summaryContext = new LLMContext({
      messages: [{ role: "user", content: `Conversation history:\n${transcript}` }],
    });

    // Generate summary using runInference. This will be overridden by each
    // LLM service implementation.
    let summaryText: string | null;
    try {
      summaryText = await this.runInference(summaryContext, {
        maxTokens: frame.targetContextTokens,
        systemInstruction: frame.summarizationPrompt,
      });
    } catch (e) {
      if (e instanceof NotImplementedError) {
        throw new Error(`LLM service ${this.constructor.name} does not implement run_inference`);
      }
      throw e;
    }

    if (!summaryText) {
      throw new Error("LLM returned empty summary");
    }

    summaryText = summaryText.trim();
    logger.info(
      `${this}: Generated summary of ${summaryText.length} characters ` +
        `for ${result.messages.length} messages`,
    );

    return [summaryText, result.lastSummarizedIndex];
  }

  /**
   * Register a function handler for LLM function calls.
   *
   * Call options resolve with the precedence **explicit argument >
   * `toolOptions()` attributes > default**. `null`/`undefined` (the default)
   * means "not provided" — the option falls back to the `toolOptions()` value
   * on the handler, then to the documented default.
   *
   * @param functionName The name of the function to handle. Use null to handle
   *   all function calls with a catch-all handler.
   * @param handler The function handler. Should accept a single
   *   FunctionCallParams parameter.
   * @param options.cancelOnInterruption Whether to cancel this function call
   *   when an interruption occurs. When false the call is treated as
   *   asynchronous: the LLM continues the conversation immediately without
   *   waiting for the result, and the result is injected later via a
   *   developer message. Defaults to null (fall back to the `toolOptions()`
   *   value, then to true). A speech-to-speech service takes intermediate
   *   results (reported via `new FunctionCallResultProperties({ isFinal: false })`)
   *   on whatever second channel its provider offers; one that can't says so
   *   with `acceptsIntermediateFunctionCallResults` and drops them with a
   *   warning.
   * @param options.timeoutSecs Optional per-tool timeout in seconds,
   *   overriding the global `functionCallTimeoutSecs`. A call that runs past it
   *   is cancelled: the handler is cancelled, the call is settled as
   *   cancelled, and inference runs so the LLM can report that it didn't
   *   complete. The deadline covers the handler's execution as a whole, so
   *   reporting an intermediate result neither clears it nor restarts it.
   *   Defaults to null (fall back to the `toolOptions()` value, then to the
   *   global timeout).
   * @param options.cancellableByLlm Whether the LLM may cancel this call while
   *   it runs, through the `cancel_<name>` tool advertised alongside it. Pair
   *   it with `cancelOnInterruption: false`; a synchronous call holds the LLM
   *   until it returns, so there is no moment at which it could ask for the
   *   call to stop. Defaults to null (fall back to the `toolOptions()` value,
   *   then to false).
   */
  registerFunction(
    functionName: string | null,
    handler: FunctionCallHandler,
    options: {
      cancelOnInterruption?: boolean | null;
      timeoutSecs?: number | null;
      cancellableByLlm?: boolean | null;
    } = {},
  ): void {
    if (functionName !== null && this._cancelToolNames.has(functionName)) {
      throw new Error(
        `'${functionName}' is a reserved built-in tool name and cannot be ` +
          "registered by user code.",
      );
    }
    // Explicitly registering a handler clears any standalone-unregister
    // suppression for its name.
    this._explicitlyUnregisteredFunctionNames.delete(functionName);
    // Registering a function with the functionName set to null will run that
    // handler for all functions
    const resolvedCancelOnInterruption = this._resolveToolOption(
      functionName,
      options.cancelOnInterruption,
      handler,
      "_pipecatCancelOnInterruption",
      { default: true },
    ) as boolean;
    this._functions.set(
      functionName,
      new FunctionCallRegistryItem({
        functionName,
        handler,
        cancelOnInterruption: resolvedCancelOnInterruption,
        timeoutSecs: this._resolveToolOption(
          functionName,
          options.timeoutSecs,
          handler,
          "_pipecatTimeoutSecs",
          { default: null },
        ) as number | null,
        cancellableByLlm: this._resolveCancellableByLlm(
          functionName,
          options.cancellableByLlm,
          handler,
          resolvedCancelOnInterruption,
        ),
      }),
    );
    this._recordToolCleanup(handler);
  }

  /**
   * Track cleanup work a registered tool handler asks to run at teardown.
   *
   * A handler backed by a resource that outlives the call — an MCP server
   * connection, for instance — can carry a zero-argument async callable under
   * `_pipecatCleanup`. It is awaited when this service is cleaned up, the hook
   * the pipeline guarantees to run at teardown, so the resource is released
   * without the developer wiring teardown manually. Handlers sharing a
   * resource carry the same callable, recorded once.
   *
   * Cleanups are kept for the service's lifetime even if their handlers are
   * later unregistered: the resource may outlive any one tool's
   * advertisement, and cleanups are expected to be idempotent.
   */
  protected _recordToolCleanup(handler: unknown): void {
    const cleanup = handlerAttr(handler, "_pipecatCleanup") as (() => Promise<void>) | null;
    if (cleanup === null || this._toolCleanups.includes(cleanup)) {
      return;
    }
    this._toolCleanups.push(cleanup);
  }

  /** Run recorded tool cleanups; errors are logged, not raised. */
  protected async _runToolCleanups(): Promise<void> {
    const cleanups = this._toolCleanups;
    this._toolCleanups = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error running tool cleanup ${cleanup.name}: ${errorText(e)}`);
      }
    }
  }

  /**
   * Register a direct function handler.
   *
   * Shared core behind automatic registration (from an `LLMContext` or
   * `LLMSetToolsFrame`). Call options resolve by precedence: explicit
   * argument > `toolOptions()` attributes > default.
   *
   * @param handler The direct function to register.
   * @param options.cancelOnInterruption Explicit override, or null to use the
   *   handler's value (then the true default).
   * @param options.timeoutSecs Explicit override, or null to use the handler's
   *   value (then the null default, i.e. the global timeout).
   * @param options.cancellableByLlm Explicit override, or null to use the
   *   handler's value (then the false default).
   */
  protected _registerDirectFunction(
    handler: (...args: any[]) => Promise<unknown>,
    options: {
      cancelOnInterruption?: boolean | null;
      timeoutSecs?: number | null;
      cancellableByLlm?: boolean | null;
    } = {},
  ): void {
    const wrapper = new DirectFunctionWrapper(handler);
    if (this._cancelToolNames.has(wrapper.name)) {
      throw new Error(
        `'${wrapper.name}' is a reserved built-in tool name and cannot be ` +
          "registered by user code.",
      );
    }
    const cancelOnInterruption = this._resolveToolOption(
      wrapper.name,
      options.cancelOnInterruption,
      handler,
      "_pipecatCancelOnInterruption",
      { default: true },
    ) as boolean;
    const timeoutSecs = this._resolveToolOption(
      wrapper.name,
      options.timeoutSecs,
      handler,
      "_pipecatTimeoutSecs",
      { default: null },
    ) as number | null;
    // Explicitly registering a handler clears any standalone-unregister
    // suppression for its name. (Auto-registration skips suppressed names
    // before reaching this method, so this only fires for explicit calls.)
    this._explicitlyUnregisteredFunctionNames.delete(wrapper.name);
    // The new entry defaults to autoRegistered=false, so a handler registered
    // through this method is treated as explicit and is never auto-pruned.
    this._functions.set(
      wrapper.name,
      new FunctionCallRegistryItem({
        functionName: wrapper.name,
        handler: wrapper,
        cancelOnInterruption,
        timeoutSecs,
        cancellableByLlm: this._resolveCancellableByLlm(
          wrapper.name,
          options.cancellableByLlm,
          handler,
          cancelOnInterruption,
        ),
      }),
    );
  }

  /**
   * Resolve whether the LLM may cancel a tool's calls.
   *
   * @param functionName The tool's name, for the warning below.
   * @param explicit The value passed to the register call, or null if omitted.
   * @param handler The handler, which may carry a `toolOptions()` value.
   * @param cancelOnInterruption The tool's interruption behaviour, already
   *   resolved by the caller — resolving it again here would read past
   *   whatever the caller was told explicitly.
   * @returns Whether the LLM may cancel this tool's calls.
   */
  protected _resolveCancellableByLlm(
    functionName: string | null,
    explicit: boolean | null | undefined,
    handler: unknown,
    cancelOnInterruption: boolean,
  ): boolean {
    const resolved = this._resolveToolOption(
      functionName,
      explicit,
      handler,
      "_pipecatCancellableByLlm",
      { default: false },
    );
    if (!resolved) {
      return false;
    }
    if (cancelOnInterruption) {
      // A synchronous call holds the LLM until it returns, so it is never
      // running at a moment the LLM could ask to cancel it.
      logger.warning(
        `${this}: '${functionName}' sets cancellable_by_llm=True with ` +
          "cancel_on_interruption=True. The LLM cannot cancel a synchronous " +
          "call; pair it with cancel_on_interruption=False.",
      );
      return false;
    }
    return true;
  }

  /**
   * Resolve a tool call option by precedence: explicit > handler attribute >
   * default.
   *
   * An explicit `null` is treated as "not provided" and falls back to the
   * handler's value, then the default — so `null` can't be passed to force a
   * default past a handler value (an intentionally unsupported niche; set
   * `functionCallTimeoutSecs` on the service for that).
   *
   * @param functionName The tool's name, for logging.
   * @param explicit The value passed to the register call, or null if the
   *   caller omitted it.
   * @param handler The handler, which may carry `toolOptions()` attributes.
   * @param attr The attribute to read (e.g. `_pipecatTimeoutSecs`).
   * @param options.default The value to use when neither an explicit argument
   *   nor a handler value is present.
   * @returns The resolved option value.
   */
  protected _resolveToolOption(
    functionName: string | null,
    explicit: unknown,
    handler: unknown,
    attr: string,
    options: { default: unknown },
  ): unknown {
    const decorated = handlerAttr(handler, attr);
    if (explicit !== null && explicit !== undefined) {
      if (decorated !== null && decorated !== explicit) {
        const optionName = TOOL_OPTION_NAMES[attr] ?? attr.replace(/^_pipecat/, "");
        logger.debug(
          `${this}: '${functionName}' registered with explicit ` +
            `${optionName}=${repr(explicit)}, overriding the ` +
            `decorator value ${repr(decorated)}.`,
        );
      }
      return explicit;
    }
    return decorated !== null ? decorated : options.default;
  }

  /**
   * Whether an advertised handler differs from the one already registered.
   *
   * Normalizes a `DirectFunctionWrapper` to its underlying `.function` on both
   * sides, then compares by identity. Flows reuses one closure per node across
   * repeated context frames (no change) but builds a fresh closure on
   * transition (a real change), so identity is the right test.
   *
   * @param item The currently registered entry.
   * @param newHandler The advertised handler — a raw callable or a
   *   `DirectFunctionWrapper`.
   * @returns True if `newHandler` is a different callable than `item` holds.
   */
  protected _advertisedHandlerChanged(
    item: FunctionCallRegistryItem,
    newHandler: unknown,
  ): boolean {
    const current =
      item.handler instanceof DirectFunctionWrapper ? item.handler.function : item.handler;
    const next = newHandler instanceof DirectFunctionWrapper ? newHandler.function : newHandler;
    return current !== next;
  }

  /**
   * Register handlers for any tools in the given set that carry one.
   *
   * A tool carries a handler when it's advertised as a direct function or as
   * a `FunctionSchema` with a `handler` set; either way the handler is
   * registered automatically, so no `registerFunction` call is needed. A
   * `FunctionSchema` without a handler is advertise-only and registers
   * nothing.
   *
   * Accepts whatever `LLMContext` accepts for tools — a `ToolsSchema`, a plain
   * list of direct functions / `FunctionSchema` objects, or `NOT_GIVEN` —
   * normalizing as needed.
   *
   * Explicit `registerFunction` registrations are always left untouched, so
   * explicit registration wins. An auto-registered entry (from a previous
   * advertised set) is rebound when the new set carries a *different* handler
   * for the same name — so a re-declared per-node handler takes effect — and
   * left untouched when the handler is unchanged, so repeated frames don't
   * churn.
   *
   * @param tools The tools to scan for handlers.
   */
  protected _registerAdvertisedToolHandlers(tools: unknown): void {
    // A context's `tools` may be null (rather than `NOT_GIVEN`) — e.g. from
    // realtime services or stand-in contexts in tests. isGiven(null) is true
    // and the normalizer rejects null, so guard it explicitly.
    if (tools === null || tools === undefined) {
      return;
    }
    const normalized = LLMContext._normalizeAndValidateTools(tools as any);
    if (!isGiven(normalized)) {
      return;
    }

    // Register direct functions.
    for (const wrapper of normalized.directFunctions) {
      const existing = this._functions.get(wrapper.name);
      if (existing !== undefined) {
        // An auto-registered entry whose advertised handler changed is
        // rebound to the new handler. Explicit registrations and unchanged
        // handlers are left untouched, so explicit wins and repeated frames
        // don't churn.
        if (existing.autoRegistered && this._advertisedHandlerChanged(existing, wrapper.function)) {
          this._registerDirectFunction(wrapper.function);
          this._markAutoRegistered(wrapper.name);
          logger.debug(
            `${this}: rebound advertised direct function '${wrapper.name}' to its new handler`,
          );
        }
        continue;
      }
      if (this._explicitlyUnregisteredFunctionNames.has(wrapper.name)) {
        // Explicitly unregistered while still advertised — leave it gone so
        // calls hit the missing-handler recovery path.
        continue;
      }
      this._registerDirectFunction(wrapper.function);
      // Mark the entry as advertised-tool-set-managed so it can be pruned on a
      // later sync that stops advertising it. Explicit registrations are
      // handled above and keep their default autoRegistered=false, so they
      // are never pruned.
      this._markAutoRegistered(wrapper.name);
      logger.debug(
        `${this}: auto-registered handler for advertised direct function '${wrapper.name}'`,
      );
    }

    // Register the handlers that FunctionSchemas carry. A schema handler
    // registers like any classic handler — registerFunction reads its
    // toolOptions() attributes off the handler — only marked autoRegistered
    // so it's pruned when no longer advertised.
    for (const schema of normalized.standardTools) {
      if (schema.handler === null || schema.handler === undefined) {
        continue;
      }
      const existing = this._functions.get(schema.name);
      if (existing !== undefined) {
        // Rebind an auto-registered entry whose advertised handler changed;
        // otherwise leave it (explicit wins, unchanged handlers don't churn)
        // and warn if a manual registration shadows a handler-carrying schema.
        if (existing.autoRegistered && this._advertisedHandlerChanged(existing, schema.handler)) {
          this.registerFunction(schema.name, schema.handler);
          this._markAutoRegistered(schema.name);
          logger.debug(
            `${this}: rebound advertised FunctionSchema '${schema.name}' to its new handler`,
          );
        } else {
          this._warnIfRedundantManualRegistration(schema.name);
        }
        continue;
      }
      if (this._explicitlyUnregisteredFunctionNames.has(schema.name)) {
        continue;
      }
      this.registerFunction(schema.name, schema.handler);
      this._markAutoRegistered(schema.name);
      logger.debug(
        `${this}: auto-registered handler for advertised FunctionSchema '${schema.name}'`,
      );
    }
  }

  /** Mark a registry entry as managed by the advertised tool set. */
  protected _markAutoRegistered(name: string): void {
    const item = this._functions.get(name);
    if (item) item.autoRegistered = true;
  }

  /**
   * Warn that a manual registration is unnecessary, once per function.
   *
   * Fires when a tool is registered explicitly via `registerFunction` yet its
   * advertised `FunctionSchema` already carries a handler — the schema alone
   * would register it. An auto-registered entry (e.g. from a same-named
   * direct function) is not a manual registration and is left silent.
   *
   * @param functionName The name shared by the manual registration and the
   *   handler-carrying schema. Must already be registered.
   */
  protected _warnIfRedundantManualRegistration(functionName: string): void {
    if (this._functions.get(functionName)?.autoRegistered) {
      return;
    }
    if (this._redundantRegistrationWarned.has(functionName)) {
      return;
    }
    this._redundantRegistrationWarned.add(functionName);
    logger.warning(
      `${this}: '${functionName}' is registered with register_function() but its ` +
        "advertised FunctionSchema already carries a handler. The manual registration " +
        "step is unnecessary when the handler is on the FunctionSchema.",
    );
  }

  /**
   * Return the service's own configured tools, if any.
   *
   * Used by the auto-registration mechanism. Tools normally reach a service
   * through the `LLMContext` on each inference. Some services (the realtime
   * services) also accept tools configured directly on the service (e.g. via
   * a constructor option) as an alternative; they override this to return
   * those tools verbatim, in whatever form they hold them — a `ToolsSchema` or
   * a provider-native tool list. When the context advertises no tools,
   * `_syncRegisteredToolHandlers` normalizes the result and registers handlers
   * for any standard tools it contains; provider-native tools carry no
   * handlers, so they contribute nothing to register.
   *
   * A service that overrides this **must follow the auto-registration
   * mechanism's preference rules: context tools, then service-configured
   * tools**.
   *
   * @returns The service's configured tools verbatim (e.g. a `ToolsSchema` or
   *   a provider-native tool list), or null when there are none (the default).
   */
  protected _serviceTools(): ToolsSchema | unknown[] | null {
    return null;
  }

  /**
   * Sync the registered handlers with the handlers advertised in `tools`.
   *
   * Registers handlers for any tools the set advertises with one (direct
   * functions, or `FunctionSchema` objects carrying a `handler`), then drops
   * the handlers we auto-registered for tools it no longer advertises — so
   * the registry matches what the LLM can see.
   *
   * This is the single path for keeping handlers in step with the advertised
   * tools. The base service runs it on every `LLMContextFrame` (the context
   * carries the current tool set on each inference). Realtime services that
   * support runtime tool changes also call it from their own
   * `LLMSetToolsFrame` handling, since they run continuously and don't get a
   * context frame per turn. When the context advertises no tools, handlers
   * fall back to `_serviceTools()` (the service's own configured tools).
   *
   * Explicit registrations (`registerFunction`), the catch-all handler, and
   * built-in tools are never pruned.
   *
   * @param tools The advertised tool set (a `ToolsSchema`, a plain list, or
   *   null / `NOT_GIVEN` for "no tools").
   */
  protected _syncRegisteredToolHandlers(tools: unknown): void {
    // null and an empty list both mean "no tools advertised" (the normalizer
    // collapses an empty set to NOT_GIVEN), in which case every
    // auto-registered handler is pruned.
    let normalized: unknown =
      tools !== null && tools !== undefined
        ? LLMContext._normalizeAndValidateTools(tools as any)
        : NOT_GIVEN;
    // No context tools? Fall back to the service's own configured tools.
    // Those may be provider-native (already formatted, carrying no handlers);
    // only standard tools (gathered into a ToolsSchema) contribute handlers.
    if (!isGiven(normalized)) {
      const serviceTools = this._serviceTools();
      if (serviceTools !== null) {
        const normalizedServiceTools = LLMContext._normalizeAndValidateTools(serviceTools as any, {
          allowProviderTools: true,
        });
        if (normalizedServiceTools instanceof ToolsSchema) {
          normalized = normalizedServiceTools;
        }
      }
    }
    this._registerAdvertisedToolHandlers(normalized);
    const advertised = new Set<string | null>();
    if (normalized instanceof ToolsSchema) {
      for (const wrapper of normalized.directFunctions) advertised.add(wrapper.name);
      for (const s of normalized.standardTools) {
        if (s.handler !== null && s.handler !== undefined) advertised.add(s.name);
      }
    }
    this._unregisterUnadvertisedToolHandlers(advertised);
    // A standalone unregister only suppresses re-registration while the tool
    // is still advertised. Once it leaves the advertised set, drop the
    // suppression so re-advertising it (a later tool-set change) registers it
    // afresh.
    for (const name of [...this._explicitlyUnregisteredFunctionNames]) {
      if (!advertised.has(name)) this._explicitlyUnregisteredFunctionNames.delete(name);
    }

    // What the registry holds decides both whether the async-tool guidance
    // belongs in the system instruction and whether the cancellation tools
    // do, and it is settled only here: tools advertised on a context frame
    // register during this sync, a manual registration never goes through
    // that path at all, and a context can advertise nothing.
    this._syncCancelTools();
    this._composeSystemInstruction();
  }

  /**
   * Drop auto-registered handlers for tools no longer advertised.
   *
   * Only entries with `autoRegistered: true` are eligible; explicit
   * registrations, the catch-all handler, and built-in tools are untouched.
   *
   * @param advertised Names of handler-carrying tools in the new advertised set.
   */
  protected _unregisterUnadvertisedToolHandlers(advertised: Set<string | null>): void {
    const stale = [...this._functions.entries()]
      .filter(([name, item]) => item.autoRegistered && !advertised.has(name))
      .map(([name]) => name);
    for (const name of stale) {
      this._functions.delete(name);
    }
  }

  /**
   * Remove a registered function handler.
   *
   * This removes the handler but does not stop advertising the tool to the
   * LLM. To remove a tool cleanly, prefer an `LLMSetToolsFrame` with the
   * updated tool set — that both stops advertising it and avoids the LLM
   * trying to call a tool that's no longer there.
   *
   * @param functionName The name of the function handler to remove.
   * @throws Error if no handler is registered under that name.
   */
  unregisterFunction(functionName: string | null): void {
    if (!this._functions.delete(functionName)) {
      throw new Error(`KeyError: ${repr(functionName)}`);
    }
    // Remember the explicit removal so auto-registration doesn't bring the
    // handler back on the next context frame while the tool is still
    // advertised.
    this._explicitlyUnregisteredFunctionNames.add(functionName);
  }

  /**
   * Remove a registered direct function handler (internal; no warning).
   *
   * @param handler The direct function handler to remove.
   * @throws Error if no handler is registered under its name.
   */
  protected _unregisterDirectFunction(handler: (...args: any[]) => Promise<unknown>): void {
    const wrapper = new DirectFunctionWrapper(handler);
    if (!this._functions.delete(wrapper.name)) {
      throw new Error(`KeyError: ${repr(wrapper.name)}`);
    }
    // Remember the explicit removal so auto-registration doesn't bring the
    // handler back on the next context frame while the tool is still advertised.
    this._explicitlyUnregisteredFunctionNames.add(wrapper.name);
    // Note: no need to remove start callback here, as direct functions don't support start callbacks.
  }

  /**
   * Check if a function handler is registered.
   *
   * @param functionName The name of the function to check.
   * @returns True if the function is registered or if a catch-all handler
   *   (null) is registered.
   */
  hasFunction(functionName: string): boolean {
    if (this._functions.has(null)) {
      return true;
    }
    return this._functions.has(functionName);
  }

  /**
   * Whether the named function was registered with cancelOnInterruption=false.
   *
   * Mirrors the registry-lookup pattern in `runFunctionCalls()`: a
   * name-specific entry takes precedence; if there isn't one, fall back to
   * the null-keyed catch-all entry. Returns false if no entry matches.
   */
  protected _functionIsAsync(functionName: string): boolean {
    const item = this._functions.get(functionName) ?? this._functions.get(null);
    return item !== undefined && !item.cancelOnInterruption;
  }

  /**
   * Execute a sequence of function calls from the LLM.
   *
   * Triggers the on_function_calls_started event and executes functions
   * either in parallel or sequentially based on the runInParallel setting.
   *
   * @param functionCalls The function calls to execute.
   */
  async runFunctionCalls(functionCalls: readonly FunctionCallFromLLM[]): Promise<void> {
    if (functionCalls.length === 0) {
      return;
    }

    if (this._speculationGate.isSpeculating) {
      // Tools run inside the service, so no downstream gate can undo their
      // side effects if the speculation is discarded. Withdraw it instead;
      // the inference that follows the committed transcript runs the call. A
      // turn confirmed before the call was reached leaves nothing pending,
      // and the call runs as an ordinary one.
      logger.debug(`${this}: speculative inference wants a tool call, cancelling it`);
      await this.broadcastFrame(EagerEndOfTurnCancelFrame);
      return;
    }

    // Exclude the built-in cancel tool — it's an internal mechanism and
    // should not be surfaced to user-facing event handlers or frames.
    const userVisibleCalls = functionCalls.filter(
      (fc) => !this._cancelToolNames.has(fc.functionName),
    );
    if (userVisibleCalls.length > 0) {
      await this._callEventHandler("on_function_calls_started", userVisibleCalls);
      await this.broadcastFrame(FunctionCallsStartedFrame, { functionCalls: userVisibleCalls });
    }

    // When groupParallelTools is true all calls share a groupId so the
    // aggregator triggers the LLM exactly once after the last one completes.
    // When false, groupId is null and each result triggers inference
    // independently.
    const groupId = this._groupParallelTools ? crypto.randomUUID() : null;

    const runnerItems: FunctionCallRunnerItem[] = [];
    for (const functionCall of functionCalls) {
      let item = this._functions.get(functionCall.functionName) ?? this._functions.get(null);
      if (item === undefined) {
        this._logMissingFunctionCall(functionCall.functionName, functionCall.context);
        item = this._buildMissingFunctionCallRegistryItem(functionCall.functionName);
      }

      runnerItems.push(
        new FunctionCallRunnerItem({
          registryItem: item,
          functionName: functionCall.functionName,
          toolCallId: functionCall.toolCallId,
          arguments: functionCall.arguments as Record<string, unknown>,
          context: functionCall.context as LLMContext,
          groupId,
        }),
      );
    }

    if (this._runInParallel) {
      await this._runParallelFunctionCalls(runnerItems);
    } else {
      await this._runSequentialFunctionCalls(runnerItems);
    }
  }

  protected async _createSequentialRunnerTask(): Promise<void> {
    if (!this._sequentialRunnerTask) {
      this._sequentialRunnerQueue = new Queue();
      this._sequentialRunnerTask = this.createTask(
        () => this._sequentialRunnerHandler(),
        "_sequential_runner_handler",
      );
    }
  }

  protected async _cancelSequentialRunnerTask(): Promise<void> {
    if (this._sequentialRunnerTask) {
      await this.cancelTask(this._sequentialRunnerTask);
      this._sequentialRunnerTask = null;
    }
  }

  protected async _cancelSummaryTask(): Promise<void> {
    if (this._summaryTask) {
      await this.cancelTask(this._summaryTask);
      this._summaryTask = null;
    }
  }

  protected async _cancelAllFunctionCallTasks(): Promise<void> {
    // Snapshot first: cancelTask awaits, during which done callbacks may
    // mutate _functionCallTasks.
    for (const task of [...this._functionCallTasks.keys()]) {
      if (task) {
        task.removeDoneCallback(this.#functionCallTaskDone);
        await this.cancelTask(task);
      }
    }
    this._functionCallTasks.clear();
  }

  protected async _sequentialRunnerHandler(): Promise<void> {
    while (true) {
      const runnerItem = await this._sequentialRunnerQueue.get();
      const task = this.createTask(
        () => this._runFunctionCall(runnerItem),
        "_run_function_call",
      ) as Task<unknown>;
      this._functionCallTasks.set(task, runnerItem);
      // Since we run tasks sequentially we don't need to add the
      // _functionCallTaskFinished done callback.
      try {
        // Wait on the task rather than awaiting it directly: a function call
        // cancelled from elsewhere (interruption, timeout) must not tear down
        // the runner along with it.
        await wait([task]);
      } finally {
        // Waiting doesn't hand cancellation down the way awaiting the task
        // would, so a runner going away has to cancel the call it was running
        // itself.
        if (!task.done()) {
          await this.cancelTask(task);
        }
        // The canceller may already have dropped the entry.
        this._functionCallTasks.delete(task);
      }
    }
  }

  protected async _runParallelFunctionCalls(
    runnerItems: readonly FunctionCallRunnerItem[],
  ): Promise<void> {
    for (const runnerItem of runnerItems) {
      const task = this.createTask(
        () => this._runFunctionCall(runnerItem),
        "_run_function_call",
      ) as Task<unknown>;
      this._functionCallTasks.set(task, runnerItem);
      task.addDoneCallback(this.#functionCallTaskDone);
    }
  }

  protected async _runSequentialFunctionCalls(
    runnerItems: readonly FunctionCallRunnerItem[],
  ): Promise<void> {
    // Enqueue all function calls for background execution.
    for (const runnerItem of runnerItems) {
      await this._sequentialRunnerQueue.put(runnerItem);
    }
  }

  protected async _runFunctionCall(runnerItem: FunctionCallRunnerItem): Promise<void> {
    // Re-resolve the registry item at execution time. The function may have
    // been unregistered between queuing and execution, in which case we fall
    // back to the missing-function handler so the call still terminates with
    // a normal tool result.
    let item: FunctionCallRegistryItem;
    const named = this._functions.get(runnerItem.functionName);
    const catchAll = this._functions.get(null);
    if (named !== undefined) {
      item = named;
    } else if (catchAll !== undefined) {
      item = catchAll;
    } else if (runnerItem.registryItem.handler === this.#missingFunctionCallHandler) {
      item = runnerItem.registryItem;
    } else {
      // Function was unregistered between queue and execution; the
      // registry-item-handler check above already covered the
      // missing-from-the-start case.
      logger.warning(
        `${this}: '${runnerItem.functionName}' was just unregistered ` +
          "between queueing and execution.",
      );
      item = this._buildMissingFunctionCallRegistryItem(runnerItem.functionName);
    }

    logger.debug(
      `${this} Calling function [${runnerItem.functionName}:${runnerItem.toolCallId}] with arguments ${JSON.stringify(runnerItem.arguments)}`,
    );

    // Broadcast function call in-progress. This frame will let our assistant
    // context aggregator know that we are in the middle of a function call.
    // Some contexts/aggregators may not need this. But some definitely do
    // (Anthropic, for example).
    await this.broadcastFrame(FunctionCallInProgressFrame, {
      functionName: runnerItem.functionName,
      toolCallId: runnerItem.toolCallId,
      arguments: runnerItem.arguments,
      cancelOnInterruption: item.cancelOnInterruption,
      groupId: runnerItem.groupId,
    });

    let timeoutTask: Task<unknown> | null = null;
    // Set when the handler raises, so the result settling the call on its
    // behalf can say what went wrong.
    let callError: string | null = null;

    // Single callback for both intermediate updates and final results. Pass
    // properties: new FunctionCallResultProperties({ isFinal: false }) for updates.
    const functionCallResultCallback: FunctionCallResultCallback = async (result, options = {}) => {
      const properties = options.properties ?? null;
      const isFinal = properties ? properties.isFinal : true;
      if (!isFinal && item.cancelOnInterruption) {
        logger.warning(
          `${this} result_callback called with is_final=False on sync function call` +
            ` [${runnerItem.functionName}:${runnerItem.toolCallId}].` +
            " Intermediate updates are only valid for async function calls" +
            " (cancel_on_interruption=False).",
        );
        return;
      }

      // A handler can outlive its call and still hold this callback, so late
      // results are rejected here rather than broadcast for the aggregator to
      // drop.
      if (runnerItem.settled) {
        logger.warning(
          `${this} Ignoring result for function call` +
            ` [${runnerItem.functionName}:${runnerItem.toolCallId}]: the call has` +
            " already finished (it reported a result, timed out, or was cancelled).",
        );
        return;
      }

      if (isFinal) {
        runnerItem.settled = true;
        // Only a final result settles the call, so only a final result clears
        // the deadline. An intermediate update must leave it armed —
        // otherwise a progress report permanently unbounds a hanging async
        // tool.
        if (timeoutTask && !timeoutTask.done()) {
          await this.cancelTask(timeoutTask);
        }
      }

      await this.broadcastFrame(FunctionCallResultFrame, {
        functionName: runnerItem.functionName,
        toolCallId: runnerItem.toolCallId,
        arguments: runnerItem.arguments,
        result,
        runLlm: runnerItem.runLlm,
        properties,
        error: callError,
      });
    };

    // Python `or`: a 0 per-tool timeout falls back to the global one.
    const effectiveTimeout = item.timeoutSecs || this._functionCallTimeoutSecs;

    // Start a timeout task for deferred function calls
    const timeoutHandler = async (): Promise<void> => {
      // This task is only started when one of the two is set.
      const timeout = effectiveTimeout as number;
      await sleep(timeout);
      logger.warning(
        `${this} Function call [${runnerItem.functionName}:${runnerItem.toolCallId}] timed out after ${timeout} seconds and is being cancelled.` +
          " You can increase this timeout by passing `timeout_secs` to `register_function()`," +
          " or set a global default via `function_call_timeout_secs` on the LLM constructor.",
      );
      // Settle the call before cancelling, so a result racing in while the
      // handler unwinds is rejected instead of broadcast.
      runnerItem.settled = true;
      // Cancelling goes through a detached task because it awaits the
      // function call task this handler runs inside of.
      this.createTask(() => this._timeoutFunctionCall(runnerItem), "_timeout_function_call");
    };

    if (effectiveTimeout) {
      timeoutTask = this.createTask(timeoutHandler, "timeout_handler") as Task<unknown>;
    }

    try {
      const params = new FunctionCallParams({
        functionName: runnerItem.functionName,
        toolCallId: runnerItem.toolCallId,
        arguments: runnerItem.arguments,
        llm: this,
        pipelineWorker: this.pipelineWorker,
        context: runnerItem.context,
        resultCallback: functionCallResultCallback,
        appResources: this.pipelineWorker.appResources,
        workerRunner: this.pipelineWorker.workerRunner,
      });
      if (item.handler instanceof DirectFunctionWrapper) {
        // Handler is a DirectFunctionWrapper
        await item.handler.invoke(runnerItem.arguments, params);
      } else {
        // Handler is a FunctionCallHandler
        await item.handler(params);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        // Backstop for cancellation that doesn't run through
        // _cancelFunctionCallTasks, e.g. teardown.
        runnerItem.settled = true;
        throw e;
      }
      const errorMessage = `Error executing function call [${runnerItem.functionName}]: ${errorText(e)}`;
      // Pushing the error with category "APPLICATION" since the failure came
      // from the application's function handler code.
      await this.pushError(errorMessage, { exception: e, category: ErrorCategory.APPLICATION });
      // A handler that raised will never report, so settle the call on its
      // behalf.
      callError = e instanceof Error ? `${e.name}: ${e.message}` : `Error: ${String(e)}`;
      const cls = this.constructor as typeof LLMService;
      await functionCallResultCallback(
        cls.FUNCTION_CALL_ERROR_MESSAGE_TEMPLATE.replaceAll(
          "{function_name}",
          runnerItem.functionName,
        ),
      );
    } finally {
      if (timeoutTask && !timeoutTask.done()) {
        await this.cancelTask(timeoutTask);
      }
    }
  }

  /** Build a registry item that routes to the missing-function handler. */
  protected _buildMissingFunctionCallRegistryItem(functionName: string): FunctionCallRegistryItem {
    return new FunctionCallRegistryItem({
      functionName,
      handler: this.#missingFunctionCallHandler,
      cancelOnInterruption: true,
    });
  }

  /** Return a terminal tool result when the LLM calls an unknown function. */
  protected async _missingFunctionCallHandler(params: FunctionCallParams): Promise<void> {
    const cls = this.constructor as typeof LLMService;
    await params.resultCallback(
      cls.MISSING_FUNCTION_CALL_MESSAGE_TEMPLATE.replaceAll("{function_name}", params.functionName),
    );
  }

  /**
   * Return the set of standard-tool names currently advertised to the LLM.
   *
   * Custom (LLM-specific) tools are not included, since they have no
   * consistent name field across adapters.
   */
  static _advertisedToolNames(context: LLMContext | null | undefined): Set<string> {
    const tools = context !== null && context !== undefined ? context.tools : null;
    if (tools === null || tools === undefined || !isGiven(tools)) {
      return new Set();
    }
    return new Set((tools as ToolsSchema).standardTools.map((t) => t.name));
  }

  /**
   * Log an appropriate message when a tool is called with no handler.
   *
   * Distinguishes two cases:
   *
   * - **Developer error:** the tool is advertised to the LLM but no handler
   *   was wired up (a `FunctionSchema` must've been provided with neither
   *   `handler` nor accompanying `registerFunction` call). Logged at error
   *   level since this almost always indicates a bug.
   * - **Hallucination:** the tool is not in the currently advertised tool
   *   set. Logged at warning level since this is model behavior the
   *   application can do little about beyond returning a terminal result.
   */
  protected _logMissingFunctionCall(functionName: string, context: unknown): void {
    if (LLMService._advertisedToolNames(context as LLMContext | null).has(functionName)) {
      logger.error(
        `${this}: tool '${functionName}' is advertised to the LLM but has ` +
          "no handler — set FunctionSchema.handler (recommended) or call " +
          "register_function().",
      );
    } else {
      logger.warning(
        `${this}: LLM called '${functionName}', which is not in the ` +
          "currently advertised tool set.",
      );
    }
  }

  /**
   * Whether the LLM may cancel calls of a registered tool.
   *
   * The one place that decides it, so what gets advertised and what a cancel
   * tool will actually stop can't drift apart.
   *
   * @param item The registered tool to judge.
   * @returns True if the tool opted in with `cancellableByLlm`.
   */
  protected _isCancellable(item: FunctionCallRegistryItem): boolean {
    return item.cancellableByLlm;
  }

  /**
   * Names of the registered tools the LLM may cancel.
   *
   * @returns The tools that opted in with `cancellableByLlm: true`.
   */
  protected _cancellableToolNames(): Set<string> {
    const names = new Set<string>();
    for (const [name, item] of this._functions) {
      if (name && this._isCancellable(item)) names.add(name);
    }
    return names;
  }

  /**
   * Match the advertised cancel tools to the tools currently registered.
   *
   * One cancel tool per cancellable tool, named for it, reconciled from a
   * single reading of the registry so the advertised set can never drift from
   * what is actually cancellable. A tool that never opted in has no cancel
   * tool at all, so there is nothing for the LLM to call against it.
   */
  protected _syncCancelTools(): void {
    const wanted = new Map<string, string>();
    for (const name of this._cancellableToolNames()) {
      wanted.set(cancelToolName(name), name);
    }

    for (const stale of [...this._cancelToolNames]) {
      if (wanted.has(stale)) continue;
      delete this._adapter.builtinTools[stale];
      this._functions.delete(stale);
      this._cancelToolNames.delete(stale);
    }

    for (const [name, target] of wanted) {
      if (this._cancelToolNames.has(name)) {
        continue;
      }
      if (this._functions.has(name)) {
        // Once per name: this runs on every context frame, and the collision
        // persists for as long as both tools are registered.
        if (!this._warnedCancelCollisions.has(name)) {
          this._warnedCancelCollisions.add(name);
          logger.warning(
            `${this}: '${target}' is cancellable but its cancel tool can't be ` +
              `advertised — '${name}' is already registered as a tool of its own. ` +
              `Rename one of them, or the LLM has no way to stop ${target}.`,
          );
        }
        continue;
      }
      this._adapter.builtinTools[name] = buildCancelToolSchema(target);
      this._functions.set(
        name,
        new FunctionCallRegistryItem({
          functionName: name,
          handler: this.#cancelToolHandler,
          cancelOnInterruption: true,
        }),
      );
      this._cancelToolNames.add(name);
    }
  }

  /**
   * Handle a `cancel_<tool>` invocation from the LLM.
   *
   * Which work to stop comes from the tool the model called, so the common
   * case takes no arguments at all. `tool_call_id` only has to be given to
   * choose between several running calls of the same tool.
   *
   * @param params Function call parameters, optionally carrying `tool_call_id`.
   */
  protected async _cancelToolHandler(params: FunctionCallParams): Promise<void> {
    const target = (params.functionName || "").slice(CANCEL_TOOL_PREFIX.length);
    const toolCallId = (params.arguments.tool_call_id as string | null | undefined) ?? null;

    const refuse = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
      logger.debug(`${this}: declining to cancel ${target} — ${reason}`);
      await params.resultCallback(
        { cancelled: null, reason, ...extra },
        { properties: new FunctionCallResultProperties({ runLlm: true }) },
      );
    };

    const candidates = [...this._functionCallTasks.values()].filter(
      (item) => item.functionName === target && this._isCancellable(item.registryItem),
    );
    if (candidates.length === 0) {
      await refuse(`no ${target} call is running`);
      return;
    }
    let match: FunctionCallRunnerItem;
    if (toolCallId) {
      const found = candidates.find((i) => i.toolCallId === toolCallId);
      if (found === undefined) {
        await refuse(`no running ${target} call has that tool_call_id`);
        return;
      }
      match = found;
    } else if (candidates.length > 1) {
      // Several calls of the one tool: the model has to say which, so the
      // refusal carries the ids to say it with.
      // Spell the choices out in the reason itself: a model reading a refusal
      // acts on what it says far more readily than on a field beside it.
      const choices = candidates
        .map(
          (i) =>
            `${i.toolCallId} (called with ${JSON.stringify(i.arguments, (_k, v) =>
              typeof v === "bigint" ? String(v) : v,
            )})`,
        )
        .join("; ");
      await refuse(
        `${candidates.length} ${target} calls are running: ${choices}. Call ` +
          `${params.functionName} again with tool_call_id set to the one to stop.`,
        {
          running: candidates.map((i) => ({ tool_call_id: i.toolCallId, arguments: i.arguments })),
        },
      );
      return;
    } else {
      match = candidates[0] as FunctionCallRunnerItem;
    }

    logger.debug(`${this}: cancelling [${match.functionName}:${match.toolCallId}]`);
    await this._cancelFunctionCallsByToolCallId(match.toolCallId);
    await params.resultCallback(
      { cancelled: match.toolCallId, function_name: match.functionName },
      { properties: new FunctionCallResultProperties({ runLlm: true }) },
    );
  }

  /**
   * Cancel the in-flight function calls selected by a predicate.
   *
   * Cancelling a call cancels its handler's task (delivering a
   * `CancelledError`) so cancel-aware handlers run their cleanup, broadcasts a
   * `FunctionCallCancelFrame` so the rest of the pipeline can settle the
   * call, and notifies application code via `on_function_calls_cancelled`.
   *
   * @param predicate Selects which in-flight calls to cancel.
   * @param options.reason Short description of what triggered the
   *   cancellation, included in the log messages.
   * @param options.runLlm Whether inference should run once the cancelled
   *   calls are settled in the context.
   * @returns The function calls that were cancelled.
   */
  protected async _cancelFunctionCallTasks(
    predicate: (item: FunctionCallRunnerItem) => boolean,
    options: { reason: string; runLlm?: boolean },
  ): Promise<FunctionCallFromLLM[]> {
    const runLlm = options.runLlm ?? false;
    const cancelledTasks = new Set<Task<unknown>>();
    const cancelledItems: FunctionCallFromLLM[] = [];
    // Snapshot first: cancelTask awaits, during which done callbacks may
    // mutate _functionCallTasks.
    for (const [task, runnerItem] of [...this._functionCallTasks.entries()]) {
      if (!predicate(runnerItem)) {
        continue;
      }

      const name = runnerItem.functionName;
      const toolCallId = runnerItem.toolCallId;

      logger.debug(
        `${this} Cancelling function call [${name}:${toolCallId}] (${options.reason})...`,
      );

      // Settle before cancelling: a handler that catches its CancelledError
      // and reports a result while unwinding must not be able to reopen a
      // call the pipeline has stopped tracking.
      runnerItem.settled = true;

      if (task) {
        // We remove the callback because we are going to cancel the task
        // next, otherwise we will be removing it from the map while we are
        // iterating.
        task.removeDoneCallback(this.#functionCallTaskDone);
        await this.cancelTask(task);
        cancelledTasks.add(task);
      }

      cancelledItems.push(await this._broadcastFunctionCallCancelled(runnerItem, { runLlm }));
      logger.debug(`${this} Function call [${name}:${toolCallId}] has been cancelled`);
    }

    // Remove all cancelled tasks from our map.
    for (const task of cancelledTasks) {
      this._functionCallTaskFinished(task);
    }

    if (cancelledItems.length > 0) {
      await this._callEventHandler("on_function_calls_cancelled", cancelledItems);
    }

    return cancelledItems;
  }

  /**
   * Settle a cancelled function call downstream.
   *
   * @param runnerItem The function call that was cancelled.
   * @param options.runLlm Whether inference should run once the call is
   *   settled in the context.
   * @returns The cancelled call, described for `on_function_calls_cancelled`.
   */
  protected async _broadcastFunctionCallCancelled(
    runnerItem: FunctionCallRunnerItem,
    options: { runLlm?: boolean } = {},
  ): Promise<FunctionCallFromLLM> {
    await this.broadcastFrame(FunctionCallCancelFrame, {
      functionName: runnerItem.functionName,
      toolCallId: runnerItem.toolCallId,
      runLlm: options.runLlm ?? false,
    });
    return new FunctionCallFromLLM({
      functionName: runnerItem.functionName,
      toolCallId: runnerItem.toolCallId,
      arguments: runnerItem.arguments,
      context: runnerItem.context,
    });
  }

  /**
   * Cancel a function call that ran past its deadline.
   *
   * The handler usually still owns the call and is cancelled outright. If it
   * happened to finish while the timeout was being processed its task is
   * already gone and there is nothing left to cancel, but the deadline has
   * settled the call, so its result is rejected — the pipeline is told the
   * call is over regardless, or it waits on a result that can never arrive.
   *
   * A deadline is the one cancellation nothing else follows up on, so it asks
   * for inference: without it the LLM never learns the call is over and the
   * user is left waiting on an answer that never comes.
   *
   * @param runnerItem The function call that timed out.
   */
  protected async _timeoutFunctionCall(runnerItem: FunctionCallRunnerItem): Promise<void> {
    const cancelled = await this._cancelFunctionCallTasks(
      (item) => item.toolCallId === runnerItem.toolCallId,
      { reason: "timeout", runLlm: true },
    );
    if (cancelled.length > 0) {
      return;
    }

    const item = await this._broadcastFunctionCallCancelled(runnerItem, { runLlm: true });
    await this._callEventHandler("on_function_calls_cancelled", [item]);
  }

  /**
   * Cancel every function call in flight, whether or not it survives
   * interruptions.
   *
   * Each handler is cancelled, the call is settled downstream as cancelled,
   * and `on_function_calls_cancelled` fires. No inference runs for the
   * cancellations.
   *
   * @param options.reason What triggered the cancellation, for the logs.
   * @returns The calls that were cancelled.
   */
  async cancelFunctionCalls(options: { reason?: string } = {}): Promise<FunctionCallFromLLM[]> {
    return await this._cancelFunctionCallTasks(() => true, {
      reason: options.reason ?? "cancelled",
    });
  }

  /**
   * Cancel in-progress function call tasks by their toolCallId.
   *
   * @param toolCallId toolCallId to cancel.
   */
  protected async _cancelFunctionCallsByToolCallId(toolCallId: string): Promise<void> {
    await this._cancelFunctionCallTasks((item) => item.toolCallId === toolCallId, {
      reason: "User request",
    });
  }

  protected async _cancelFunctionCall(functionName: string | null): Promise<void> {
    await this._cancelFunctionCallTasks((item) => item.registryItem.functionName === functionName, {
      reason: "interruption",
    });
  }

  protected _functionCallTaskFinished(task: Task<unknown>): void {
    this._functionCallTasks.delete(task);
  }
}

// ---------------------------------------------------------------------------
// WebSocket LLM service base
// ---------------------------------------------------------------------------

/**
 * Raised by `_wsSend`/`_wsRecv` after a transparent reconnection.
 *
 * Signals that the WebSocket connection was lost and automatically
 * re-established. The current inference should be restarted — any
 * connection-local state on the server (e.g. cached responses) is gone.
 */
export class WebsocketReconnectedError extends Error {
  override name = "WebsocketReconnectedError";
}

export interface WebsocketLLMServiceOptions extends LLMServiceOptions, WebsocketServiceOptions {}

/**
 * Base class for websocket-based LLM services.
 *
 * Each LLM inference is a discrete request/response exchange: send one
 * request, receive events inline until a terminal event, then wait for the
 * next frame to trigger an inference. This contrasts with
 * `WebsocketTTSService` / `WebsocketSTTService` which stream data
 * continuously via a background receive loop (`_receiveTaskHandler`). This
 * class does **not** start a background receive loop.
 *
 * Provides connection lifecycle management (connect on setup, disconnect on
 * stop/cancel), automatic reconnection with exponential backoff, and three
 * helpers for running each inference:
 *
 * 1. `_ensureConnected()` — verify the websocket is alive, reconnect with
 *    exponential backoff if not.
 * 2. `_wsSend(message)` — send the inference request as JSON.
 * 3. `_wsRecv()` — receive and parse response events one at a time until the
 *    caller sees a terminal event.
 *
 * `_wsSend` and `_wsRecv` catch `ConnectionClosed` transparently,
 * auto-reconnect via `_tryReconnect`, and raise `WebsocketReconnectedError`
 * so callers know the inference must be restarted. If reconnection fails,
 * the original `ConnectionClosed` propagates.
 *
 * Subclasses must implement:
 * - `_connectWebsocket()`: establish the websocket connection.
 * - `_disconnectWebsocket()`: close the websocket and clean up.
 *
 * Event handlers:
 * - on_connection_error: called when a websocket connection error occurs.
 *
 * @example
 * llm.eventHandler("on_connection_error", async (llm: LLMService, error: string) => {
 *   logger.error(`LLM connection error: ${error}`);
 * });
 */
export abstract class WebsocketLLMService<
  TAdapter extends BaseLLMAdapter = BaseLLMAdapter,
> extends WebsocketService(LLMService)<TAdapter> {
  constructor(options: WebsocketLLMServiceOptions = {}) {
    super(options);
    this._registerEventHandler("on_connection_error");
  }

  // -- lifecycle ------------------------------------------------------------

  /** Connect: reset flags and establish the websocket. */
  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
  }

  /** Disconnect: set flags and close the websocket. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();
    await this._disconnectWebsocket();
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /**
   * Stop the service and close WebSocket connection.
   *
   * @param frame The end frame triggering service shutdown.
   */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._disconnect();
  }

  /**
   * Cancel the service and close WebSocket connection.
   *
   * @param frame The cancel frame triggering service cancellation.
   */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._disconnect();
  }

  // -- per-inference helpers ------------------------------------------------

  /**
   * Send a JSON message over the websocket.
   *
   * Guards against sends during intentional disconnect. If the send fails
   * with `ConnectionClosed`, attempts to reconnect and raises
   * `WebsocketReconnectedError` on success so the caller can restart the
   * inference. If reconnection fails, the original `ConnectionClosed`
   * propagates.
   *
   * @param message The message dict to serialize and send.
   */
  protected async _wsSend(message: Record<string, unknown>): Promise<void> {
    if (this._disconnecting || !this._websocket) {
      return;
    }
    try {
      await this._websocket.send(JSON.stringify(message));
    } catch (e) {
      if (!(e instanceof ConnectionClosed)) throw e;
      if (this._disconnecting) {
        return;
      }
      const success = await this._tryReconnect({
        reportError: (error, options) => this._reportError(error, options),
      });
      if (success) {
        throw new WebsocketReconnectedError();
      }
      throw e;
    }
  }

  /**
   * Receive and parse a JSON message from the websocket.
   *
   * If the receive fails with `ConnectionClosed`, attempts to reconnect and
   * raises `WebsocketReconnectedError` on success. If reconnection fails, the
   * original `ConnectionClosed` propagates.
   *
   * @returns The parsed JSON message as a dict.
   */
  protected async _wsRecv(): Promise<any> {
    // Should never happen — `_ensureConnected` (which callers must invoke
    // first) raises if it can't establish a websocket. Match that contract
    // here.
    if (this._websocket === null) {
      throw new Error(`${this} _ws_recv called without a websocket`);
    }
    try {
      const raw = await this._websocket.recv();
      return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      if (!(e instanceof ConnectionClosed)) throw e;
      if (this._disconnecting) {
        throw e;
      }
      const success = await this._tryReconnect({
        reportError: (error, options) => this._reportError(error, options),
      });
      if (success) {
        throw new WebsocketReconnectedError();
      }
      throw e;
    }
  }

  /**
   * Ensure the websocket is connected, reconnecting if needed.
   *
   * Uses `_tryReconnect` with exponential backoff.
   *
   * @throws Error if the connection could not be established.
   */
  protected async _ensureConnected(): Promise<void> {
    if (this._websocket && this._websocket.state !== State.CLOSED) {
      return;
    }
    const success = await this._tryReconnect({
      reportError: (error, options) => this._reportError(error, options),
    });
    if (!success) {
      throw new Error(`${this} failed to establish WebSocket connection`);
    }
  }

  // -- WebsocketService interface -------------------------------------------

  /**
   * Not used — messages are received inline during each inference.
   *
   * This satisfies the `WebsocketService` abstract method but is never called
   * because `_receiveTaskHandler` is never started.
   */
  override async _receiveMessages(): Promise<void> {
    throw new NotImplementedError(
      "WebsocketLLMService receives messages inline during inference, " +
        "not via a continuous background loop",
    );
  }

  protected async _reportError(
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> {
    await this._callEventHandler("on_connection_error", error.error);
    await this.pushErrorFrame(error, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  }
}
