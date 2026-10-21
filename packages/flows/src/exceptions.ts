// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/exceptions.py

/**
 * Custom exceptions for the conversation flow system.
 *
 * This module defines the exception hierarchy used throughout the flow system
 * for better error handling and debugging. All exceptions inherit from
 * FlowError to provide a common base for flow-related errors.
 */

/**
 * Base exception for all flow-related errors.
 *
 * This is the parent class for all flow system exceptions. Use this for
 * generic flow errors or when a more specific exception doesn't apply.
 */
export class FlowError extends Error {
  override name = "FlowError";
}

/**
 * Raised when flow initialization fails.
 *
 * This exception occurs during flow manager setup, typically due to invalid
 * configuration, missing dependencies, or initialization errors.
 */
export class FlowInitializationError extends FlowError {
  override name = "FlowInitializationError";
}

/**
 * Raised when a state transition fails.
 *
 * This exception occurs when transitioning between nodes fails due to invalid
 * node configurations, missing target nodes, or transition errors.
 */
export class FlowTransitionError extends FlowError {
  override name = "FlowTransitionError";
}

/**
 * Raised when an invalid or unavailable function is called.
 *
 * This exception occurs when attempting to call functions that are not
 * properly registered, have invalid signatures, or cannot be found.
 */
export class InvalidFunctionError extends FlowError {
  override name = "InvalidFunctionError";
}

/**
 * Raised when an action execution fails.
 *
 * This exception occurs during action execution, including built-in actions
 * like TTS or custom actions, due to invalid configuration or execution errors.
 */
export class ActionError extends FlowError {
  override name = "ActionError";
}

export interface FlowProblemOptions {
  /** The node the problem is about, when there is one. */
  node?: string | null;
  /** The function entry the problem is about, when there is one. */
  function?: string | null;
}

/**
 * One reference a flow config makes that its handlers do not satisfy.
 *
 * - `code`: stable identifier for the kind of problem: `missing_tool`,
 *   `ambiguous_tool`, `invalid_tool`, `missing_handler`, or `ambiguous_handler`.
 * - `message`: human-readable description naming the node, function, or
 *   variable involved.
 * - `node`: the node the problem is about, when there is one.
 * - `function`: the function entry the problem is about, when there is one.
 */
export class FlowProblem {
  code: string;
  message: string;
  node: string | null;
  function: string | null;

  constructor(code: string, message: string, options: FlowProblemOptions = {}) {
    this.code = code;
    this.message = message;
    this.node = options.node ?? null;
    this.function = options.function ?? null;
  }
}

/**
 * Raised when a flow config's references cannot all be resolved.
 *
 * Constructing a `Flow` checks every tool, action handler, and template
 * variable the config names and raises this once, with every unresolved
 * reference, rather than stopping at the first.
 */
export class FlowReferenceError extends FlowError {
  override name = "FlowReferenceError";
  problems: FlowProblem[];

  /**
   * Initialize with the unresolved references.
   *
   * @param problems Every unresolved reference, in the order found.
   */
  constructor(problems: FlowProblem[]) {
    const lines = problems.map((p) => `- ${p.message}`).join("\n");
    const count = `${problems.length} problem${problems.length === 1 ? "" : "s"}`;
    super(`flow config has ${count}:\n${lines}`);
    this.problems = problems;
  }
}
