// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/manager.py

/**
 * Core conversation flow management system.
 *
 * This module provides the FlowManager class which orchestrates conversations
 * across different LLM providers. It supports:
 *
 * - Flows with runtime-determined transitions
 * - State management and transitions
 * - Function registration and execution
 * - Action handling
 * - Cross-provider compatibility
 *
 * The flow manager coordinates all aspects of a conversation, including:
 *
 * - LLM context management
 * - Function registration
 * - State transitions
 * - Action execution
 * - Error handling
 *
 * Porting notes: deprecated upstream APIs are not ported: the `task` option
 * and property (use `worker`), `role_messages` (use `roleMessage`), and the
 * deprecation warnings for zero-argument and one-argument handlers (handlers
 * are always called as `(args, flowManager)`; JavaScript ignores the extra
 * arguments).
 */

import { rethrowIfCancelled, TimeoutError, waitFor } from "@pipedog/asyncio";
import { toolOptions } from "@pipedog/core/adapters/llm/schemas/direct_function";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type Frame,
  FunctionCallResultProperties,
  LLMMessagesAppendFrame,
  LLMMessagesUpdateFrame,
  LLMRunFrame,
  LLMSetToolsFrame,
  LLMUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import type { LLMSwitcher } from "@pipedog/core/pipeline/llm_switcher";
import type { PipelineWorker } from "@pipedog/core/pipeline/worker";
import {
  type LLMContext,
  type LLMContextMessage,
  type LLMStandardMessage,
  NOT_GIVEN,
  type NotGiven,
} from "@pipedog/core/processors/aggregators/llm_context";
import type {
  FunctionCallHandler,
  FunctionCallParams,
  LLMService,
} from "@pipedog/core/services/llm_service";
import { LLMSettings } from "@pipedog/core/services/settings";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { warnDeprecated } from "@pipedog/core/utils/deprecation";
import { logger } from "@pipedog/core/utils/logger";
import { ActionManager, type ActionWorker } from "./actions.ts";
import { LLMAdapter, type SummaryInferenceLLM } from "./adapters.ts";
import {
  ActionError,
  FlowError,
  FlowInitializationError,
  FlowTransitionError,
  InvalidFunctionError,
} from "./exceptions.ts";
import {
  type ActionConfig,
  ContextStrategy,
  ContextStrategyConfig,
  type FlowActionHandler,
  type FlowArgs,
  type FlowsDirectFunction,
  FlowsDirectFunctionWrapper,
  FlowsFunctionSchema,
  type FunctionHandler,
  getOrGenerateNodeName,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "./types.ts";

// A `{{ key }}` or `{{ key.sub.key }}` placeholder in a node's prompt text.
// Only identifiers and dots are accepted, so prose braces are left alone. A
// leading backslash escapes it: `\{{ key }}` renders as `{{ key }}`.
const PLACEHOLDER = /(\\?)\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/**
 * The context aggregator pair the flow manager reads: the user aggregator's
 * context, and whether the assistant aggregator has function calls in
 * progress. `LLMContextAggregatorPair` satisfies it.
 */
export interface FlowContextAggregator {
  user(): { readonly context: LLMContext };
  assistant(): { readonly hasFunctionCallsInProgress: boolean };
}

/** The part of a `PipelineWorker` the flow manager uses. */
export type FlowWorker = ActionWorker;

/** A pending node transition, executed once every function call has finished. */
interface PendingTransition {
  nextNode: NodeConfig;
  functionName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface FlowManagerOptions {
  /** LLM service or LLMSwitcher. */
  llm: LLMService<any> | LLMSwitcher<any> | SummaryInferenceLLM;
  /** Context aggregator for updating user context. */
  contextAggregator: FlowContextAggregator | null;
  /** PipelineWorker instance for queueing frames. */
  worker: PipelineWorker | FlowWorker;
  /**
   * Context strategy configuration for managing conversation context during
   * transitions.
   */
  contextStrategy?: ContextStrategyConfig | null;
  /** Transport instance for communication. */
  transport?: BaseTransport | null;
  /**
   * Optional list of FlowsFunctionSchemas or FlowsDirectFunctions that will be
   * available at every node. These functions are registered once during
   * initialization and automatically included alongside node-specific
   * functions.
   */
  globalFunctions?: (FlowsFunctionSchema | FlowsDirectFunction)[] | null;
}

/** Python's `str()` of a state value, for a rendered placeholder. */
function renderValue(value: unknown): string {
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Manages conversation flows.
 *
 * The FlowManager orchestrates conversation flows by managing state
 * transitions, function registration, and message handling across different
 * LLM providers, with comprehensive action handling and error management.
 *
 * The manager coordinates all aspects of a conversation including LLM context
 * management, function registration, state transitions, and action execution.
 *
 * A node's prompts may refer to `state` with `{{ key }}` placeholders, in
 * `roleMessage`, `taskMessages` content, and `tts_say` text. They are filled
 * in each time the node is entered, so a value a handler stored earlier in the
 * conversation can appear in a later prompt, including after a context reset.
 * `{{ order.size }}` walks into a stored object, a key that is missing throws
 * `FlowError` on entry, and `\{{ key }}` is left as the literal `{{ key }}`.
 */
export class FlowManager {
  _worker: FlowWorker;
  _llm: LLMService<any> | LLMSwitcher<any> | SummaryInferenceLLM;
  _actionManager: ActionManager;
  _adapter: LLMAdapter;
  _initialized = false;
  _contextAggregator: FlowContextAggregator | null;
  _pendingTransition: PendingTransition | null = null;
  _contextStrategy: ContextStrategyConfig;
  _transport: BaseTransport | null;
  _globalFunctions: (FlowsFunctionSchema | FlowsDirectFunction)[];

  _state: Record<string, any> = {}; // Internal state storage
  _currentFunctions = new Set<string>(); // Track registered functions
  _currentNode: string | null = null;

  protected _showedDeprecationWarningForResetWithSummary = false;

  /**
   * Initialize the flow manager.
   *
   * @throws Error If no `worker` is given.
   */
  constructor(options: FlowManagerOptions) {
    if (!options.worker) {
      throw new Error("FlowManager requires a 'worker' (PipelineWorker).");
    }

    this._worker = options.worker as FlowWorker;
    this._llm = options.llm;
    this._actionManager = new ActionManager(this._worker, this);
    this._adapter = new LLMAdapter();
    this._contextAggregator = options.contextAggregator;
    this._contextStrategy =
      options.contextStrategy ?? new ContextStrategyConfig({ strategy: ContextStrategy.APPEND });
    this._transport = options.transport ?? null;
    this._globalFunctions = options.globalFunctions ?? [];
  }

  /**
   * The shared state object across nodes.
   *
   * A persistent object that maintains data across node transitions. It can be
   * used to store and retrieve conversation state, user preferences, or any
   * other data that needs to persist throughout the flow.
   *
   * @example
   * flowManager.state.user_name = "Alice";
   * const name = flowManager.state.user_name ?? "Unknown";
   */
  get state(): Record<string, any> {
    return this._state;
  }

  /**
   * The transport instance used for communication, if one was provided.
   *
   * The transport can be used to interact with participants, manage
   * audio/video settings, or access platform-specific features.
   */
  get transport(): BaseTransport | null {
    return this._transport;
  }

  /**
   * The identifier of the currently active conversation node, or null if no
   * node has been set yet.
   *
   * @example
   * async function participantJoined(action: ActionConfig, flowManager: FlowManager) {
   *   if (flowManager.currentNode === "collecting_payment") await setupSecureSession();
   * }
   */
  get currentNode(): string | null {
    return this._currentNode;
  }

  /**
   * The pipeline worker instance used for frame queueing.
   *
   * The worker can be used to queue custom frames directly into the pipeline,
   * enabling advanced flow control and custom frame injection.
   *
   * @example
   * await flowManager.worker.queueFrame(
   *   new TTSUpdateSettingsFrame({ delta: new TTSSettings({ voice: "your-new-voice-id" }) }),
   * );
   */
  get worker(): PipelineWorker {
    return this._worker as PipelineWorker;
  }

  /**
   * Initialize the flow manager.
   *
   * @param initialNode Optional initial node configuration. If provided, the
   *   flow will start at this node immediately; otherwise set it later with
   *   `setNodeFromConfig()`.
   * @throws FlowInitializationError If initialization fails.
   *
   * @example
   * const flowManager = new FlowManager({ ... });
   * await flowManager.initialize(createInitialNode());
   */
  async initialize(initialNode: NodeConfig | null = null): Promise<void> {
    if (this._initialized) {
      logger.warning(`${this.constructor.name} already initialized`);
      return;
    }

    try {
      this._initialized = true;
      logger.debug(`Initialized ${this.constructor.name}`);

      // Set initial node if provided (otherwise initial node
      // will be set later via setNodeFromConfig())
      if (initialNode) {
        const nodeName = getOrGenerateNodeName(initialNode);
        logger.debug(`Setting initial node: ${nodeName}`);
        await this._setNode(nodeName, initialNode);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      this._initialized = false;
      throw new FlowInitializationError(
        `Failed to initialize flow: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /**
   * Get the current conversation context.
   *
   * @returns List of messages in the current context, including system
   *   messages, user messages, and assistant responses.
   * @throws FlowError If context aggregator is not available.
   */
  getCurrentContext(): LLMContextMessage[] {
    if (!this._contextAggregator) {
      throw new FlowError("No context aggregator available");
    }

    const context = this._contextAggregator.user().context;

    return context.getMessages();
  }

  /**
   * Register a handler for a specific action type.
   *
   * @param actionType String identifier for the action (e.g., "tts_say").
   * @param handler Async or sync function that handles the action.
   *
   * @example
   * flowManager.registerAction("notify", async (action) => {
   *   await notifyUser(action.text);
   * });
   */
  registerAction(actionType: string, handler: FlowActionHandler): void {
    this._actionManager._registerAction(actionType, handler);
  }

  /**
   * Register an action handler from action configuration.
   *
   * @param action Action configuration containing type and optional handler.
   * @throws ActionError If action type is not registered and no valid handler provided.
   */
  protected _registerActionFromConfig(action: ActionConfig): void {
    const actionType = action.type;
    const handler = action.handler;

    // Register action if not already registered
    if (actionType && !this._actionManager._actionHandlers.has(actionType)) {
      // Register handler if provided
      if (handler && typeof handler === "function") {
        this.registerAction(actionType, handler);
        logger.debug(`Registered action handler from config: ${actionType}`);
      } else {
        throw new ActionError(
          `Action '${actionType}' not registered. ` +
            "Provide handler in action config or register manually.",
        );
      }
    }
  }

  /**
   * Call a handler with the function call's arguments and this flow manager.
   *
   * @param handler The function handler to call.
   * @param args Arguments object from the function call.
   * @returns The result returned by the handler.
   */
  async _callHandler(handler: FunctionHandler, args: FlowArgs): Promise<unknown> {
    return await handler(args, this);
  }

  /**
   * Create a transition function for the given name and handler.
   *
   * @param name Name of the function being registered.
   * @param handler Function to process the call: a Flows function handler or
   *   a direct-function wrapper.
   * @returns Async function that handles the tool invocation.
   */
  async _createTransitionFunc(
    name: string,
    handler: FunctionHandler | FlowsDirectFunctionWrapper,
  ): Promise<FunctionCallHandler> {
    const transitionFunc = async (params: FunctionCallParams): Promise<void> => {
      try {
        logger.debug(`Function called: ${name}`);

        let isTransitionOnlyFunction = false;
        const acknowledgedResult = { status: "acknowledged" };

        // Invoke the handler with the provided arguments
        let handlerResponse: unknown;
        if (handler instanceof FlowsDirectFunctionWrapper) {
          handlerResponse = await handler.invoke(params.arguments, this);
        } else {
          // Copy the arguments so handlers may mutate them without touching
          // Pipecat's internal state.
          handlerResponse = await this._callHandler(handler, { ...params.arguments });
        }
        // Support both "consolidated" handlers that return [result, nextNode] and handlers
        // that return just the result.
        let result: unknown;
        let nextNode: unknown;
        if (Array.isArray(handlerResponse) && handlerResponse.length === 2) {
          [result, nextNode] = handlerResponse;
          if (result === null || result === undefined) {
            result = acknowledgedResult;
            isTransitionOnlyFunction = true;
          }
        } else {
          result = handlerResponse;
          nextNode = null;
          // FlowsDirectFunctions should always be "consolidated" functions that return a tuple
          if (handler instanceof FlowsDirectFunctionWrapper) {
            throw new InvalidFunctionError(
              `Direct function ${name} expected to return a tuple (result, next_node) but got ${typeName(result)}`,
            );
          }
        }

        logger.debug(
          `${isTransitionOnlyFunction ? "Transition-only function called for" : "Function handler completed for"} ${name}`,
        );

        if (nextNode === TRANSITION_IN_YAML) {
          throw new InvalidFunctionError(
            `Function ${name} returned TRANSITION_IN_YAML, but this node was not ` +
              "built from a flow config, so nothing can decide the transition; " +
              "return a NodeConfig or null",
          );
        }

        const isNoResponse = nextNode === NO_RESPONSE;
        let properties: FunctionCallResultProperties;
        if (isNoResponse || !nextNode) {
          // Node function: stay on the current node.
          properties = new FunctionCallResultProperties({
            runLlm: !isNoResponse,
            onContextUpdated: null,
          });
        } else {
          // Edge function: transition to the returned node.
          this._pendingTransition = {
            nextNode: nextNode as NodeConfig,
            functionName: name,
            arguments: params.arguments,
            result,
          };
          properties = new FunctionCallResultProperties({
            runLlm: false,
            onContextUpdated: () => this._checkAndExecuteTransition(),
          });
        }

        await params.resultCallback(result, { properties });
      } catch (e) {
        rethrowIfCancelled(e);
        const message = e instanceof Error ? e.message : String(e);
        logger.error(`Error in transition function ${name}: ${message}`);
        const errorResult = { status: "error", error: message };
        await params.resultCallback(errorResult);
      }
    };

    return transitionFunc;
  }

  /** Check if all functions are complete and execute transition if so. */
  async _checkAndExecuteTransition(): Promise<void> {
    if (!this._pendingTransition) {
      return;
    }

    // Check if all function calls are complete using Pipecat's state
    const assistantAggregator = this._contextAggregator!.assistant();
    if (!assistantAggregator.hasFunctionCallsInProgress) {
      // All functions complete, execute transition
      const transitionInfo = this._pendingTransition;
      this._pendingTransition = null;

      await this._executeTransition(transitionInfo);
    }
  }

  /** Execute the stored transition. */
  protected async _executeTransition(transitionInfo: PendingTransition): Promise<void> {
    const nextNode = transitionInfo.nextNode;

    try {
      if (nextNode) {
        const nodeName = getOrGenerateNodeName(nextNode);
        logger.debug(`Transition to function-returned node: ${nodeName}`);
        await this._setNode(nodeName, nextNode);
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Error executing transition: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  /**
   * Build a FunctionSchema that carries the handler the LLM service will run.
   *
   * Flows wraps each tool's handler in a "transition function" that runs the
   * tool's work and coordinates any node transition.
   *
   * @param tool The node's function, as a `FlowsFunctionSchema` or a wrapped
   *   direct function.
   * @returns A `FunctionSchema` describing the tool and carrying its handler.
   */
  protected async _createFunctionSchema(
    tool: FlowsFunctionSchema | FlowsDirectFunctionWrapper,
  ): Promise<FunctionSchema> {
    // For a direct function the wrapper itself is the handler; a
    // FlowsFunctionSchema carries its handler separately.
    const handler = tool instanceof FlowsDirectFunctionWrapper ? tool : tool.handler;
    // Stamp the resolved call options onto the handler so the LLM service
    // applies them when it registers the advertised tool. This is core's
    // `toolOptions` (not `flowsToolOptions`): the handler rides on a base
    // `FunctionSchema`, and `tool` already carries Flows' resolved option values.
    const transitionFunc = toolOptions(await this._createTransitionFunc(tool.name, handler), {
      cancelOnInterruption: tool.cancelOnInterruption,
      timeoutSecs: tool.timeoutSecs,
    });
    const base = tool.toFunctionSchema();
    return new FunctionSchema({
      name: base.name,
      description: base.description,
      properties: base.properties,
      required: base.required,
      handler: transitionFunc,
    });
  }

  /**
   * Set up a new conversation node and transition to it.
   *
   * Used to manually transition between nodes in a flow.
   *
   * @param nodeConfig Configuration for the new node.
   * @throws FlowTransitionError If manager not initialized.
   * @throws FlowError If node setup fails.
   */
  async setNodeFromConfig(nodeConfig: NodeConfig): Promise<void> {
    await this._setNode(getOrGenerateNodeName(nodeConfig), nodeConfig);
  }

  /**
   * Fill `{{ key }}` placeholders in the node's prompts from `this.state`.
   *
   * Placeholders are rendered in `roleMessage`, each `taskMessages` content,
   * and `tts_say` action text. `{{ order.size }}` walks into a stored object,
   * and `\{{ key }}` is left as the literal `{{ key }}`. Rendering happens on
   * every entry, so a prompt sees whatever handlers have stored by then.
   *
   * DIVERGENCE: values render with `String()` (objects as JSON), where upstream
   * uses Python's `str()`.
   *
   * @throws FlowError If a placeholder names a key that is not in state.
   */
  _renderNode(nodeId: string, nodeConfig: NodeConfig): NodeConfig {
    const value = (path: string): string => {
      let current: unknown = this.state;
      for (const part of path.split(".")) {
        if (
          current === null ||
          typeof current !== "object" ||
          Array.isArray(current) ||
          !Object.hasOwn(current, part)
        ) {
          throw new FlowError(`node '${nodeId}' uses '{{ ${path} }}', which is not in state`);
        }
        current = (current as Record<string, unknown>)[part];
      }
      return renderValue(current);
    };

    const render = (text: string): string =>
      text.replace(PLACEHOLDER, (match: string, escaped: string, path: string) =>
        escaped ? match.slice(1) : value(path),
      );

    const rendered: NodeConfig = { ...nodeConfig };
    if (nodeConfig.roleMessage) {
      rendered.roleMessage = render(nodeConfig.roleMessage);
    }
    rendered.taskMessages = nodeConfig.taskMessages.map((message: LLMStandardMessage) =>
      typeof message.content === "string"
        ? { ...message, content: render(message.content) }
        : message,
    );
    for (const key of ["preActions", "postActions"] as const) {
      const actions = nodeConfig[key];
      if (actions && actions.length > 0) {
        rendered[key] = actions.map((action) =>
          action.type === "tts_say" && typeof action.text === "string"
            ? { ...action, text: render(action.text) }
            : action,
        );
      }
    }
    return rendered;
  }

  /**
   * Set up a new conversation node and transition to it.
   *
   * Handles the complete node transition process in the following order:
   * 1. Execute pre-actions (if any)
   * 2. Set up messages (role and task)
   * 3. Register node functions
   * 4. Update LLM context with messages and tools
   * 5. Update state (current node and functions)
   * 6. Trigger LLM completion with new context
   * 7. Execute post-actions (if any)
   *
   * @param nodeId Identifier for the new node.
   * @param nodeConfig Complete configuration for the node.
   * @throws FlowTransitionError If manager not initialized.
   * @throws FlowError If node setup fails.
   */
  async _setNode(nodeId: string, nodeConfig: NodeConfig): Promise<void> {
    if (!this._initialized) {
      throw new FlowTransitionError(`${this.constructor.name} must be initialized first`);
    }

    try {
      // Clear any pending transition state when starting a new node
      // This ensures clean state regardless of how we arrived here:
      // - Normal transition flow (already cleared in _checkAndExecuteTransition)
      // - Direct calls to setNodeFromConfig
      this._pendingTransition = null;

      this._validateNodeConfig(nodeId, nodeConfig);
      nodeConfig = this._renderNode(nodeId, nodeConfig);
      logger.debug(`Setting node: ${nodeId}`);

      // Clear any deferred post-actions from previous node
      this._actionManager.clearDeferredPostActions();

      // Register action handlers from config
      for (const actionList of [nodeConfig.preActions ?? [], nodeConfig.postActions ?? []]) {
        for (const action of actionList) {
          this._registerActionFromConfig(action);
        }
      }

      // Execute pre-actions if any
      const preActions = nodeConfig.preActions;
      if (preActions && preActions.length > 0) {
        await this._executeActions({ preActions });
      }

      // Build the node's function schemas (carrying handlers)
      const newFunctions = new Set<string>();

      // Mix in global functions that should be available at every node
      const functionsList = [...this._globalFunctions, ...(nodeConfig.functions ?? [])];

      const standardFunctions: FunctionSchema[] = [];
      for (const funcConfig of functionsList) {
        let tool: FlowsFunctionSchema | FlowsDirectFunctionWrapper;
        if (typeof funcConfig === "function") {
          tool = new FlowsDirectFunctionWrapper(funcConfig);
        } else if (funcConfig instanceof FlowsFunctionSchema) {
          tool = funcConfig;
        } else {
          throw new InvalidFunctionError(
            `Invalid function format in node '${nodeId}'. ` +
              "Use FlowsFunctionSchema or direct functions.",
          );
        }
        standardFunctions.push(await this._createFunctionSchema(tool));
        newFunctions.add(tool.name);
      }

      const formattedTools =
        standardFunctions.length > 0
          ? new ToolsSchema({ standardTools: standardFunctions })
          : NOT_GIVEN;

      // Update LLM context
      await this._updateLlmContext({
        roleMessage: nodeConfig.roleMessage ?? null,
        taskMessages: nodeConfig.taskMessages,
        functions: formattedTools,
        strategy: nodeConfig.contextStrategy ?? null,
      });
      logger.debug("Updated LLM context");

      // Update state
      this._currentNode = nodeId;
      this._currentFunctions = newFunctions;

      // Trigger completion with new context
      const respondImmediately = nodeConfig.respondImmediately ?? true;
      if (respondImmediately) {
        await this._worker.queueFrames([new LLMRunFrame()]);
      }

      // Execute post-actions if any
      const postActions = nodeConfig.postActions;
      if (postActions && postActions.length > 0) {
        if (respondImmediately) {
          await this._executeActions({ postActions });
        } else {
          // Schedule post-actions for execution after first LLM response in this node
          this._scheduleDeferredPostActions(postActions);
        }
      }

      logger.debug(`Successfully set node: ${nodeId}`);
    } catch (e) {
      rethrowIfCancelled(e);
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`Error setting node ${nodeId}: ${message}`);
      throw new FlowError(`Failed to set node ${nodeId}: ${message}`, { cause: e });
    }
  }

  protected _scheduleDeferredPostActions(postActions: ActionConfig[]): void {
    this._actionManager.scheduleDeferredPostActions(postActions);
  }

  /** Generate a conversation summary from a given context. */
  protected async _createConversationSummary(
    summaryPrompt: string,
    context: LLMContext,
  ): Promise<string | null> {
    return await this._adapter.generateSummary(
      this._llm as SummaryInferenceLLM,
      summaryPrompt,
      context,
    );
  }

  /**
   * Update LLM context with new messages and functions.
   *
   * If `roleMessage` is provided, it is sent as an `LLMUpdateSettingsFrame`
   * (system instruction on the LLM itself).
   *
   * @param options.roleMessage Optional role/personality string sent as the LLM
   *   system instruction via `LLMUpdateSettingsFrame`.
   * @param options.taskMessages Task messages to add to context.
   * @param options.functions New functions to make available.
   * @param options.strategy Optional context update configuration.
   * @throws FlowError If context update fails.
   */
  async _updateLlmContext(options: {
    roleMessage?: string | null;
    taskMessages: LLMStandardMessage[];
    functions: ToolsSchema | NotGiven | FunctionSchema[];
    strategy?: ContextStrategyConfig | null;
  }): Promise<void> {
    try {
      const frames: Frame[] = [];

      // role_message as LLM system instruction (persists until changed)
      if (options.roleMessage) {
        frames.push(
          new LLMUpdateSettingsFrame({
            delta: new LLMSettings({ systemInstruction: options.roleMessage }),
          }),
        );
      }

      const messages: LLMContextMessage[] = [];

      const updateConfig = options.strategy ?? this._contextStrategy;

      if (updateConfig.strategy === ContextStrategy.RESET_WITH_SUMMARY) {
        if (!this._showedDeprecationWarningForResetWithSummary) {
          this._showedDeprecationWarningForResetWithSummary = true;
          warnDeprecated(
            "`RESET_WITH_SUMMARY` is deprecated since 1.5.0 and will be removed " +
              "in 2.0.0. Use Pipecat's native context summarization instead. To trigger " +
              "on-demand summarization during a node transition, push an " +
              "LLMSummarizeContextFrame in a pre-action. See " +
              "https://docs.pipecat.ai/guides/fundamentals/context-summarization",
            2,
          );
        }
      }

      if (
        updateConfig.strategy === ContextStrategy.RESET_WITH_SUMMARY &&
        this._contextAggregator &&
        this._contextAggregator.user().context
      ) {
        // We know summaryPrompt exists because ContextStrategyConfig validates it
        const summaryPrompt = updateConfig.summaryPrompt as string;
        try {
          // Try to get summary with 5 second timeout
          const summary = await waitFor(
            () =>
              this._createConversationSummary(
                summaryPrompt,
                this._contextAggregator!.user().context,
              ),
            5.0,
          );

          if (summary) {
            const summaryMessage = this._adapter.formatSummaryMessage(summary);
            messages.push(summaryMessage);
            logger.debug(
              `Added conversation summary to context: ${JSON.stringify(summaryMessage)}`,
            );
          } else {
            // Fall back to APPEND strategy if summary fails
            logger.warning("Failed to generate summary, falling back to APPEND strategy");
            updateConfig.strategy = ContextStrategy.APPEND;
          }
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          logger.warning("Summary generation timed out, falling back to APPEND strategy");
          updateConfig.strategy = ContextStrategy.APPEND;
        }
      }

      // Add task messages
      messages.push(...options.taskMessages);

      // Use an "update" (replace) frame for the RESET/RESET_WITH_SUMMARY
      // strategies; otherwise append. (Note that even the first node follows
      // the same rule: appending ensures any prior context contributions,
      // such as by tts_say pre-actions, is preserved rather than replaced).
      const reset =
        updateConfig.strategy === ContextStrategy.RESET ||
        updateConfig.strategy === ContextStrategy.RESET_WITH_SUMMARY;

      // A node's context and tools must land even if the user interrupts
      // while they are queued, or the LLM runs with the previous node's.
      const contextFrame = reset
        ? new LLMMessagesUpdateFrame({ messages })
        : new LLMMessagesAppendFrame({ messages });
      contextFrame.interruptible = false;
      const tools = Array.isArray(options.functions)
        ? options.functions.length > 0
          ? new ToolsSchema({ standardTools: options.functions })
          : NOT_GIVEN
        : options.functions;
      const toolsFrame = new LLMSetToolsFrame({ tools });
      toolsFrame.interruptible = false;
      frames.push(contextFrame, toolsFrame);

      await this._worker.queueFrames(frames);

      logger.debug(
        `Updated LLM context using ${contextFrame.constructor.name} with strategy ${updateConfig.strategy}`,
      );
    } catch (e) {
      rethrowIfCancelled(e);
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to update LLM context: ${message}`);
      throw new FlowError(`Context update failed: ${message}`, { cause: e });
    }
  }

  /**
   * Execute pre and post actions.
   *
   * @param options.preActions Actions to execute before context update.
   * @param options.postActions Actions to execute after context update.
   */
  async _executeActions(
    options: { preActions?: ActionConfig[] | null; postActions?: ActionConfig[] | null } = {},
  ): Promise<void> {
    if (options.preActions && options.preActions.length > 0) {
      await this._actionManager.executeActions(options.preActions);
    }
    if (options.postActions && options.postActions.length > 0) {
      await this._actionManager.executeActions(options.postActions);
    }
  }

  /**
   * Validate the configuration of a conversation node.
   *
   * This method ensures that:
   * 1. Required fields (taskMessages) are present.
   * 2. Each function is either a `FlowsFunctionSchema` or a valid direct
   *    function.
   *
   * @param nodeId Identifier for the node being validated.
   * @param config Complete node configuration to validate.
   * @throws FlowError If required fields are missing.
   * @throws InvalidFunctionError If function format is invalid.
   */
  protected _validateNodeConfig(nodeId: string, config: NodeConfig): void {
    // Check required fields
    if (!("taskMessages" in config)) {
      throw new FlowError(`Node '${nodeId}' missing required 'taskMessages' field`);
    }

    // Get functions list with default empty list if not provided
    const functionsList = config.functions ?? [];

    // Validate each function configuration if there are any
    for (const func of functionsList) {
      if (typeof func === "function") {
        FlowsDirectFunctionWrapper.validateFunction(func);
      } else if (!(func instanceof FlowsFunctionSchema)) {
        throw new InvalidFunctionError(
          `Invalid function format in node '${nodeId}'. ` +
            "Use FlowsFunctionSchema or direct functions.",
        );
      }
    }
  }
}

/** A short name for a value's type, for error messages (Python: `type(x)`). */
function typeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value;
}
