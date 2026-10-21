// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/types.py

/**
 * Type definitions for the conversation flow system.
 *
 * This module defines the core types used throughout the flow system:
 *
 * - FlowArgs: Function argument type
 * - NodeConfig: Node configuration type
 * - FlowsFunctionSchema: A uniform schema for function calls in flows
 *
 * These types provide structure and validation for flow configurations and
 * function interactions.
 *
 * Porting notes:
 *
 * - DIVERGENCE: `NodeConfig` and `ActionConfig` keys are camelCase
 *   (`taskMessages`, `roleMessage`, `preActions`, `appendTextToContext`, ...),
 *   as they are an API rather than a wire format. The declarative
 *   `FlowConfig` (YAML/JSON) keeps upstream's snake_case keys.
 * - DIVERGENCE: a "consolidated" result is a two-element array
 *   `[result, nextNode]` in place of Python's tuple. A handler whose plain
 *   result is itself a two-element array must return `[thatArray, null]`.
 * - DIVERGENCE: a Flows direct function's first parameter is `flowManager`
 *   (upstream: `flow_manager`). Its description and parameter schemas come
 *   from metadata attached to the function, as for core direct functions
 *   (see `DirectFunctionMetadata`).
 * - DIVERGENCE: handlers are called as `(args, flowManager)`, with the
 *   arguments object first, rather than upstream's keyword arguments.
 * - DIVERGENCE: there is no return-annotation warning (JavaScript has no
 *   runtime annotations).
 * - Deprecated upstream APIs are not ported: `FlowResult`,
 *   `flows_direct_function`, the legacy handler type aliases and
 *   `role_messages`. Handlers declaring fewer parameters than
 *   `(args, flowManager)` still work, since JavaScript ignores extra
 *   arguments.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  BaseDirectFunctionWrapper,
  type DirectFunctionMetadata,
  type ToolOptionsMetadata,
  toolOptions,
} from "@pipedog/core/adapters/schemas/direct_function";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import type { LLMStandardMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { InvalidFunctionError } from "./exceptions.ts";
import type { FlowManager } from "./manager.ts";

/**
 * Type alias for function handler arguments.
 *
 * Each invocation gets its own object, so handlers may mutate it freely
 * without affecting Pipecat's internal state.
 *
 * @example
 * { user_name: "John", age: 25, preferences: { color: "blue" } }
 */
export type FlowArgs = Record<string, any>;

/**
 * Action handler type that receives both the action and the flow manager.
 *
 * @example
 * async function advancedHandler(action: ActionConfig, flowManager: FlowManager) {
 *   await notify(action.text);
 * }
 */
export type FlowActionHandler = (
  action: ActionConfig,
  flowManager: FlowManager,
) => Promise<void> | void;

/**
 * Configuration for an action.
 *
 * - `type`: action type identifier (e.g. "tts_say", "notify_slack").
 * - `handler`: callable to handle the action.
 * - `text`: text to speak for the "tts_say" action, or the optional goodbye
 *   message for the "end_conversation" action.
 * - `appendTextToContext`: for the built-in TTS actions ("tts_say" and
 *   "end_conversation"), whether the spoken `text` is appended to the LLM
 *   context. Defaults to true.
 *
 * Additional fields are allowed and passed to the handler.
 */
export interface ActionConfig {
  type: string;
  handler?: FlowActionHandler;
  text?: string;
  appendTextToContext?: boolean;
  [key: string]: unknown;
}

/**
 * Strategy for managing context during node transitions.
 *
 * - `APPEND`: append new messages to existing context (default).
 * - `RESET`: reset context with new messages only.
 * - `RESET_WITH_SUMMARY`: reset context but include an LLM-generated summary.
 *   Upstream deprecates it (since 1.5.0) in favor of pushing an
 *   `LLMSummarizeContextFrame` in a pre-action; it is ported so existing
 *   flows carry over.
 */
export const ContextStrategy = {
  APPEND: "append",
  RESET: "reset",
  RESET_WITH_SUMMARY: "reset_with_summary",
} as const;
export type ContextStrategy = (typeof ContextStrategy)[keyof typeof ContextStrategy];

export interface ContextStrategyConfigOptions {
  /** Strategy to use for context management. */
  strategy: ContextStrategy;
  /** Required prompt text when using RESET_WITH_SUMMARY. */
  summaryPrompt?: string | null;
}

/**
 * Configuration for context management.
 *
 * - `strategy`: strategy to use for context management.
 * - `summaryPrompt`: required prompt text when using RESET_WITH_SUMMARY.
 */
export class ContextStrategyConfig {
  strategy: ContextStrategy;
  summaryPrompt: string | null;

  /**
   * @throws Error if `summaryPrompt` is missing when using RESET_WITH_SUMMARY.
   */
  constructor(options: ContextStrategyConfigOptions) {
    this.strategy = options.strategy;
    this.summaryPrompt = options.summaryPrompt ?? null;
    if (this.strategy === ContextStrategy.RESET_WITH_SUMMARY && !this.summaryPrompt) {
      throw new Error("summary_prompt is required when using RESET_WITH_SUMMARY strategy");
    }
  }
}

/**
 * Configuration for a single node in the flow.
 *
 * - `taskMessages`: list of messages defining the current node's objectives.
 * - `name`: name of the node, useful for debug logging when returning a next
 *   node from a "consolidated" function.
 * - `roleMessage`: the bot's role/personality as a plain string, sent as the
 *   LLM's system instruction via `LLMUpdateSettingsFrame`. When provided, the
 *   system instruction persists across node transitions until a new node
 *   explicitly sets `roleMessage` again.
 * - `functions`: list of FlowsFunctionSchema definitions or direct functions
 *   whose definitions are automatically extracted from their signatures.
 * - `preActions`: actions to execute before LLM inference.
 * - `postActions`: actions to execute after LLM inference.
 * - `contextStrategy`: strategy for updating context during transitions.
 * - `respondImmediately`: whether to run LLM inference as soon as the node is
 *   set (default: true).
 *
 * @example
 * const node: NodeConfig = {
 *   roleMessage: "You are a helpful assistant...",
 *   taskMessages: [{ role: "developer", content: "Ask the user for their name..." }],
 *   functions: [...],
 *   preActions: [...],
 *   postActions: [...],
 *   contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.APPEND }),
 *   respondImmediately: true,
 * };
 */
export interface NodeConfig {
  taskMessages: LLMStandardMessage[];
  name?: string;
  roleMessage?: string;
  functions?: (FlowsFunctionSchema | FlowsDirectFunction)[];
  preActions?: ActionConfig[];
  postActions?: ActionConfig[];
  contextStrategy?: ContextStrategyConfig;
  respondImmediately?: boolean;
}

/** Type of the `NO_RESPONSE` sentinel. */
export class NoResponse {
  toString(): string {
    return "NO_RESPONSE";
  }
}

/**
 * Function return value (in the "next node" slot) indicating "don't
 * immediately respond".
 *
 * Return `[result, NO_RESPONSE]` from a "consolidated" function when the bot
 * should remain silent after the function finishes, rather than immediately
 * responding. The function result will make it into the context, but the next
 * response will be triggered by something else, like a user utterance.
 *
 * For functions that transition to another node, `NodeConfig.respondImmediately`
 * provides the equivalent control.
 */
export const NO_RESPONSE: NoResponse = Object.freeze(new NoResponse());

/** Type of the `TRANSITION_IN_YAML` sentinel. */
export class TransitionInYaml {
  toString(): string {
    return "TRANSITION_IN_YAML";
  }
}

/**
 * Function return value (in the "next node" slot) deferring the transition to
 * a flow config.
 *
 * Return `[result, TRANSITION_IN_YAML]` from a tool that a `FlowConfig` names:
 * the config's `transition_to` for that entry decides the next node. Only a
 * flow built from a config accepts it; a node built in code rejects it, since
 * nothing there can decide.
 */
export const TRANSITION_IN_YAML: TransitionInYaml = Object.freeze(new TransitionInYaml());

/**
 * Return type for "consolidated" functions.
 *
 * Return type for "consolidated" functions that do either or both of:
 * - doing some work
 * - specifying the next node to transition to after the work is done
 *
 * The first element is the function-call result delivered to the LLM. Any
 * JSON-serializable value is accepted. The second element is the next node to
 * transition to, `null` to stay on the current node and respond, or
 * `NO_RESPONSE` to finish without transitioning or responding (or, in a flow
 * built from a `FlowConfig`, `TRANSITION_IN_YAML`). Pass a `null` *result* to
 * signal a transition-only handler; FlowManager substitutes an
 * acknowledgement result.
 */
export type ConsolidatedFunctionResult = readonly [
  unknown,
  NodeConfig | null | undefined | NoResponse | TransitionInYaml,
];

/**
 * Function handler that receives both arguments and flow manager.
 *
 * @param args Object of arguments from the function call.
 * @param flowManager Reference to the FlowManager instance.
 * @returns Any JSON-serializable value, or a `ConsolidatedFunctionResult` to
 *   also specify the next node.
 */
export type FlowFunctionHandler = (args: FlowArgs, flowManager: FlowManager) => Promise<unknown>;

/** The function handlers a `FlowsFunctionSchema` accepts. */
export type FunctionHandler = FlowFunctionHandler;

/**
 * Type alias for "direct" functions with automatic metadata extraction.
 *
 * "Direct" functions have their definition automatically extracted from the
 * function signature and attached metadata. This can be used in `NodeConfig`
 * directly, in lieu of a `FlowsFunctionSchema`.
 *
 * Expected shape: an async function whose first parameter is `flowManager`,
 * followed by the tool's named parameters, returning a
 * `ConsolidatedFunctionResult`. Typed permissively; the shape is validated at
 * runtime by `FlowsDirectFunctionWrapper.validateFunction`.
 *
 * @example
 * async function select_size(flowManager: FlowManager, size: string) {
 *   flowManager.state.size = size;
 *   return [{ size }, nextNode()] as const;
 * }
 * select_size.description = "Record the pizza size.";
 * select_size.parameters = { size: { type: "string", description: "small, medium or large" } };
 */
export type FlowsDirectFunction = ((
  flowManager: FlowManager,
  ...args: any[]
) => Promise<ConsolidatedFunctionResult>) &
  DirectFunctionMetadata &
  ToolOptionsMetadata;

export interface FlowsFunctionSchemaOptions {
  /** Name of the function. */
  name: string;
  /** Description of the function. */
  description: string;
  /** Object defining parameter types and descriptions. */
  properties: Record<string, unknown>;
  /** List of required parameter names. */
  required: string[];
  /** Function handler to process the function call. */
  handler: FunctionHandler;
  /**
   * Whether to cancel this function call when an interruption occurs.
   * Defaults to false.
   */
  cancelOnInterruption?: boolean;
  /**
   * Optional per-tool timeout in seconds, overriding the global
   * `functionCallTimeoutSecs`. Defaults to null (use global timeout).
   */
  timeoutSecs?: number | null;
}

/**
 * Function schema with Flows-specific properties.
 *
 * This class extends a standard function schema with the Flows-specific
 * `handler` that runs when the function is called, plus its call options.
 */
export class FlowsFunctionSchema {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  handler: FunctionHandler;
  cancelOnInterruption: boolean;
  timeoutSecs: number | null;

  constructor(options: FlowsFunctionSchemaOptions) {
    if (typeof options.handler !== "function") {
      // Python: a missing dataclass field raises TypeError at construction.
      throw new TypeError("FlowsFunctionSchema requires a 'handler'");
    }
    this.name = options.name;
    this.description = options.description;
    this.properties = options.properties;
    this.required = options.required;
    this.handler = options.handler;
    this.cancelOnInterruption = options.cancelOnInterruption ?? false;
    this.timeoutSecs = options.timeoutSecs ?? null;
  }

  /**
   * Convert to a standard FunctionSchema for use with LLMs.
   *
   * @returns FunctionSchema without flow-specific fields.
   */
  toFunctionSchema(): FunctionSchema {
    return new FunctionSchema({
      name: this.name,
      description: this.description,
      properties: this.properties,
      required: this.required,
    });
  }
}

export interface FlowsToolOptions {
  /**
   * Whether to cancel the function call when the user interrupts. Defaults
   * to false.
   */
  cancelOnInterruption?: boolean;
  /**
   * Optional per-tool timeout in seconds, overriding the global
   * `functionCallTimeoutSecs`. Defaults to null (use global timeout).
   */
  timeoutSecs?: number | null;
}

/**
 * Configure a Flows direct function's call options.
 *
 * This is optional; use it to override the defaults for a Flows direct
 * function (an async function whose first parameter is `flowManager`).
 *
 * @returns A decorator that attaches the metadata to the function.
 *
 * @example
 * const longRunningTask = flowsToolOptions({ cancelOnInterruption: false, timeoutSecs: 30 })(
 *   async function long_running_task(flowManager: FlowManager, query: string) {
 *     return [{ status: "complete" }, null] as const;
 *   },
 * );
 */
export function flowsToolOptions(
  options: FlowsToolOptions = {},
): <F extends object>(fn: F) => F & ToolOptionsMetadata {
  return <F extends object>(fn: F): F & ToolOptionsMetadata =>
    toolOptions(fn, {
      cancelOnInterruption: options.cancelOnInterruption ?? false,
      timeoutSecs: options.timeoutSecs ?? null,
    });
}

/**
 * Wrapper around a FlowsDirectFunction for metadata extraction and invocation.
 *
 * The wrapper:
 *
 * - extracts metadata from the function signature and attached metadata
 * - generates a corresponding FunctionSchema
 * - helps with function invocation
 */
export class FlowsDirectFunctionWrapper extends BaseDirectFunctionWrapper {
  declare function: FlowsDirectFunction;
  // Set by _initializeMetadata, which runs inside the base constructor, so
  // these must not be redefined (reset) by subclass field initialization.
  declare cancelOnInterruption: boolean;
  declare timeoutSecs: number | null;

  constructor(fn: FlowsDirectFunction) {
    super(fn);
  }

  /**
   * Get the special first parameter name for Flows direct functions.
   *
   * @returns The string "flowManager", which is expected as the first parameter.
   */
  static override specialFirstParamName(): string {
    return "flowManager";
  }

  /**
   * Validate the function signature.
   *
   * @param fn The function to validate.
   * @throws InvalidFunctionError If the function does not meet the requirements.
   */
  static override validateFunction(fn: (...args: any[]) => unknown): void {
    try {
      super.validateFunction(fn);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new InvalidFunctionError(e instanceof Error ? e.message : String(e), { cause: e });
    }
  }

  /** Initialize metadata from function signature, attached metadata, and call options. */
  protected override _initializeMetadata(): void {
    super._initializeMetadata();
    // Read the call options attached by flowsToolOptions (built on core's
    // toolOptions, which stores them under the _pipecat* properties). Fall
    // back to Flows' defaults when the function is undecorated.
    const fn = this.function as FlowsDirectFunction;
    this.cancelOnInterruption = fn._pipecatCancelOnInterruption ?? false;
    this.timeoutSecs = fn._pipecatTimeoutSecs ?? null;
  }

  /**
   * Invoke the wrapped function with the provided arguments.
   *
   * Arguments are matched to the function's parameters by name, like
   * Python's `function(flow_manager=flow_manager, **args)`.
   *
   * @param args Arguments to pass to the function.
   * @param flowManager FlowManager instance for function execution context.
   * @returns The result of the function call.
   */
  async invoke(
    args: Readonly<Record<string, unknown>>,
    flowManager: FlowManager,
  ): Promise<unknown> {
    const positional = this._argumentNames().map((name) => args[name]);
    return await this.function(flowManager, ...positional);
  }
}

/**
 * Get the node name from configuration or generate a UUID if not set.
 *
 * @param nodeConfig Node configuration.
 * @returns Node name from config or generated UUID string.
 */
export function getOrGenerateNodeName(nodeConfig: NodeConfig): string {
  return nodeConfig.name ?? crypto.randomUUID();
}
