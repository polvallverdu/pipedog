// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/__init__.py

/**
 * Pipecat Flows - Structured conversation framework for pipedog.
 *
 * This package provides a framework for building structured conversations.
 * The FlowManager handles conversation flows with support for state
 * management, function calling, and cross-provider compatibility.
 *
 * Flows determines conversation structure at runtime, supporting function
 * calling, action execution, and seamless transitions between conversation
 * states.
 *
 * Upstream re-exports its submodules here (as the former standalone
 * pipecat-flows package did), so everything is importable from
 * `@pipedog/flows` as well as from its submodules.
 */

export { ActionFinishedFrame, ActionManager, FunctionActionFrame } from "./actions.ts";
export { LLMAdapter } from "./adapters.ts";
export {
  caseKey,
  FlowConfig,
  FlowConfigAction,
  FlowConfigBranch,
  FlowConfigFunction,
  FlowConfigMessage,
  FlowConfigNode,
  ValidationError,
} from "./config.ts";
export {
  ActionError,
  FlowError,
  FlowInitializationError,
  FlowProblem,
  FlowReferenceError,
  FlowTransitionError,
  InvalidFunctionError,
} from "./exceptions.ts";
export { Flow, type FlowHandlers, type FlowOptions } from "./flow.ts";
export { type FlowContextAggregator, FlowManager, type FlowManagerOptions } from "./manager.ts";
export {
  type ActionConfig,
  type ConsolidatedFunctionResult,
  ContextStrategy,
  ContextStrategyConfig,
  type FlowActionHandler,
  type FlowArgs,
  type FlowFunctionHandler,
  type FlowsDirectFunction,
  FlowsDirectFunctionWrapper,
  FlowsFunctionSchema,
  flowsToolOptions,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "./types.ts";
