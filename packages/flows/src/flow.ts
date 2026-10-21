// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/flow.py

/**
 * A flow config joined to the application's handlers.
 *
 * A `Flow` is a `FlowConfig` joined to the code it names: the config's nodes
 * turned into runnable `NodeConfig` objects, with every tool reference resolved
 * to a Flows direct function, every `transition_only` function built from the
 * config alone, and every transition wired to the node the config names.
 *
 * Constructing a flow validates the references the config could not: each
 * tool exists and has a valid direct-function signature, each `function`
 * action names a callable. Tool return values are checked at call time against
 * the configured-flow contract: a tool returns `[result, TRANSITION_IN_YAML]`
 * and the config decides the next node. `{{ key }}` placeholders in prompts are
 * left in place; `FlowManager` fills them from its state when it enters the
 * node.
 *
 * Porting notes: DIVERGENCE: upstream logs a warning when a tool's return
 * annotation names `NodeConfig`. JavaScript has no runtime annotations, so
 * there is no such warning. An action's `append_text_to_context` key becomes
 * the `ActionConfig`'s `appendTextToContext`; other extra keys pass through
 * unchanged.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import {
  caseKey,
  type FlowConfig,
  type FlowConfigAction,
  FlowConfigBranch,
  type FlowConfigFunction,
  type FlowConfigNode,
} from "./config.ts";
import { FlowError, FlowProblem, FlowReferenceError } from "./exceptions.ts";
import type { FlowManager } from "./manager.ts";
import {
  type ActionConfig,
  type ConsolidatedFunctionResult,
  ContextStrategyConfig,
  type FlowActionHandler,
  type FlowArgs,
  type FlowFunctionHandler,
  type FlowsDirectFunction,
  FlowsDirectFunctionWrapper,
  FlowsFunctionSchema,
  NO_RESPONSE,
  type NodeConfig,
  TRANSITION_IN_YAML,
} from "./types.ts";

/**
 * A namespace of handlers: an object (or `Map`) of names to callables,
 * typically a module namespace (`import * as handlers from "./handlers.ts"`).
 */
export type FlowHandlers = Record<string, unknown> | ReadonlyMap<string, unknown>;

export interface FlowOptions {
  /**
   * The code behind the config: the direct functions that implement its tools
   * and the callables that implement its actions. A namespace of names to
   * callables, typically a module. A list of those lets tools and action
   * handlers live in separate modules; a name that resolves to different
   * callables in more than one of them is an error rather than a silent
   * choice. Only the names the config references are looked up.
   */
  handlers: FlowHandlers | readonly FlowHandlers[];
}

/**
 * A `FlowConfig` joined to handlers.
 *
 * The flow hands ready-made node configs to `FlowManager`:
 *
 * @example
 * const config = FlowConfig.fromFile("flow.yaml", { readFile: (p) => readFileSync(p, "utf8") });
 * const flow = new Flow(config, { handlers });
 * const flowManager = new FlowManager({ ..., globalFunctions: flow.globalFunctions });
 * await flowManager.initialize(flow.initialNode);
 */
export class Flow {
  protected _config: FlowConfig;
  protected _handlers: FlowHandlers[];
  protected _problems: FlowProblem[] = [];
  protected _nodes: Record<string, NodeConfig>;
  protected _globalFunctions: FlowsFunctionSchema[];

  /**
   * Join a config to the handlers it refers to.
   *
   * @param config The flow config.
   * @param options.handlers The code behind the config.
   * @throws FlowReferenceError If a referenced tool or handler is missing or
   *   ambiguous, or a tool is not a valid direct function. Every such problem
   *   is collected and reported together.
   */
  constructor(config: FlowConfig, options: FlowOptions) {
    this._config = config;
    this._handlers = Array.isArray(options.handlers)
      ? [...(options.handlers as readonly FlowHandlers[])]
      : [options.handlers as FlowHandlers];

    this._nodes = {};
    for (const [name, node] of Object.entries(config.nodes)) {
      this._nodes[name] = this._buildNode(name, node);
    }
    this._globalFunctions = [];
    for (const ref of config.globalFunctions) {
      const schema = this._buildFunction(ref, "global_functions", null);
      if (schema) this._globalFunctions.push(schema);
    }
    // Building continues past each problem so all of them are found; the
    // partially built state never escapes because this throw comes last.
    if (this._problems.length > 0) {
      throw new FlowReferenceError(this._problems);
    }
  }

  /** The config this flow was constructed from. */
  get config(): FlowConfig {
    return this._config;
  }

  /** The node config the flow starts in. */
  get initialNode(): NodeConfig {
    return this._nodes[this._config.initialNode] as NodeConfig;
  }

  /**
   * Tools available at every node, for `new FlowManager({ globalFunctions })`.
   *
   * A fresh list each time, so the caller may extend it.
   */
  get globalFunctions(): (FlowsFunctionSchema | FlowsDirectFunction)[] {
    return [...this._globalFunctions];
  }

  /**
   * The node config for `name`.
   *
   * @param name A node name from the config.
   * @throws FlowError If the config has no such node.
   */
  node(name: string): NodeConfig {
    if (!Object.hasOwn(this._nodes, name)) {
      throw new FlowError(`flow has no node '${name}'`);
    }
    return this._nodes[name] as NodeConfig;
  }

  // Building

  protected _buildNode(name: string, node: FlowConfigNode): NodeConfig {
    const where = `node '${name}'`;
    const config: NodeConfig = {
      name,
      taskMessages: node.taskMessages.map((m) => ({ role: m.role, content: m.content })),
      respondImmediately: node.respondImmediately,
    };
    if (node.roleMessage !== null) {
      config.roleMessage = node.roleMessage;
    }
    if (node.functions.length > 0) {
      config.functions = [];
      for (const ref of node.functions) {
        const schema = this._buildFunction(ref, where, name);
        if (schema) config.functions.push(schema);
      }
    }
    if (node.preActions.length > 0) {
      config.preActions = node.preActions.map((a) =>
        this._buildAction(a, `${where} pre_actions`, name),
      );
    }
    if (node.postActions.length > 0) {
      config.postActions = node.postActions.map((a) =>
        this._buildAction(a, `${where} post_actions`, name),
      );
    }
    const strategy = node.contextStrategyEnum();
    if (strategy !== null) {
      config.contextStrategy = new ContextStrategyConfig({ strategy });
    }
    return config;
  }

  /** Build the schema for one function entry, or record why it cannot be built. */
  protected _buildFunction(
    ref: FlowConfigFunction,
    where: string,
    node: string | null,
  ): FlowsFunctionSchema | null {
    if (ref.transitionOnly) {
      return new FlowsFunctionSchema({
        name: ref.name,
        description: ref.description ?? "",
        properties: {},
        required: [],
        handler: this._makeTransitionHandler(ref),
      });
    }
    const fn = this._lookup(ref.name, "tool", where, node);
    if (fn === null) {
      return null;
    }
    let wrapper: FlowsDirectFunctionWrapper;
    try {
      wrapper = new FlowsDirectFunctionWrapper(fn as FlowsDirectFunction);
    } catch (e) {
      rethrowIfCancelled(e);
      this._problem(
        "invalid_tool",
        `${where} tool '${ref.name}' is not a valid direct function: ${e instanceof Error ? e.message : String(e)}`,
        { node, function: ref.name },
      );
      return null;
    }

    // The config's name is the tool's identity: it is what the LLM sees, what
    // the config's other entries and the evals refer to, and it may map
    // several names to one callable.
    const schema = wrapper.toFunctionSchema();
    return new FlowsFunctionSchema({
      name: ref.name,
      description: schema.description,
      properties: schema.properties,
      required: schema.required,
      handler: this._makeHandler(ref, wrapper, where),
      cancelOnInterruption: wrapper.cancelOnInterruption,
      timeoutSecs: wrapper.timeoutSecs,
    });
  }

  protected _buildAction(action: FlowConfigAction, where: string, node: string): ActionConfig {
    const config: ActionConfig = { type: action.type };
    if (action.handler !== null) {
      const handler = this._lookup(action.handler, "action handler", where, node);
      if (handler !== null) {
        config.handler = handler as FlowActionHandler;
      }
    }
    for (const [key, value] of Object.entries(action.extras())) {
      config[key === "append_text_to_context" ? "appendTextToContext" : key] = value;
    }
    return config;
  }

  /** Resolve `name` in the handlers, or record why it cannot be resolved. */
  protected _lookup(
    name: string,
    kind: string,
    where: string,
    node: string | null,
  ): ((...args: any[]) => unknown) | null {
    const isTool = kind === "tool";
    // The same callable reachable through two namespaces is one tool, not a
    // conflict.
    const matches = new Map<unknown, number>();
    this._handlers.forEach((namespace, index) => {
      const target = getHandler(namespace, name);
      if (target !== null && target !== undefined && !matches.has(target)) {
        matches.set(target, index);
      }
    });
    if (matches.size > 1) {
      const found = [...matches.values()].map((i) => `handlers[${i}]`).join(", ");
      this._problem(
        isTool ? "ambiguous_tool" : "ambiguous_handler",
        `${where} ${kind} '${name}' is defined in more than one of the handlers (${found})`,
        { node, function: isTool ? name : null },
      );
      return null;
    }
    const target = matches.size > 0 ? [...matches.keys()][0] : null;
    if (target === null || target === undefined) {
      this._problem(
        isTool ? "missing_tool" : "missing_handler",
        `${where} references ${kind} '${name}', which is not in the handlers`,
        { node, function: isTool ? name : null },
      );
      return null;
    }
    if (typeof target !== "function") {
      this._problem(
        isTool ? "invalid_tool" : "missing_handler",
        `${where} ${kind} '${name}' is not callable`,
        { node, function: isTool ? name : null },
      );
      return null;
    }
    return target as (...args: any[]) => unknown;
  }

  protected _problem(
    code: string,
    message: string,
    options: { node?: string | null; function?: string | null } = {},
  ): void {
    this._problems.push(new FlowProblem(code, message, options));
  }

  // Calling

  protected _makeHandler(
    ref: FlowConfigFunction,
    wrapper: FlowsDirectFunctionWrapper,
    where: string,
  ): FlowFunctionHandler {
    return async (
      args: FlowArgs,
      flowManager: FlowManager,
    ): Promise<ConsolidatedFunctionResult> => {
      const response = await wrapper.invoke(args, flowManager);
      const [result, nextNode] = checkContract(response, ref.name, where);
      if (nextNode === NO_RESPONSE) {
        return [result, NO_RESPONSE];
      }
      return [result, this._destination(ref, result, where)];
    };
  }

  protected _makeTransitionHandler(ref: FlowConfigFunction): FlowFunctionHandler {
    return async (): Promise<ConsolidatedFunctionResult> => {
      return [null, this._nodes[ref.transitionTo as string] as NodeConfig];
    };
  }

  protected _destination(
    ref: FlowConfigFunction,
    result: unknown,
    where: string,
  ): NodeConfig | null {
    const target = ref.transitionTo;
    if (target === null) {
      return null;
    }
    if (typeof target === "string") {
      return this._nodes[target] as NodeConfig;
    }

    if (
      !(target instanceof FlowConfigBranch) ||
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Object.hasOwn(result, target.field)
    ) {
      throw new FlowError(
        `${where} tool '${ref.name}' branches on result field '${(target as FlowConfigBranch).field}', ` +
          "but its result has no such field",
      );
    }
    const value = (result as Record<string, unknown>)[target.field];
    const key = caseKey(value);
    const nodeName = Object.hasOwn(target.cases, key) ? target.cases[key] : target.default;
    if (nodeName === null || nodeName === undefined) {
      logger.debug(`${where} tool '${ref.name}': no branch case matched, staying`);
      return null;
    }
    return this._nodes[nodeName] as NodeConfig;
  }
}

/** Look up `name` in one handlers namespace. */
function getHandler(namespace: FlowHandlers, name: string): unknown {
  if (namespace instanceof Map) {
    return namespace.get(name);
  }
  // A module namespace or plain object: own or inherited properties, but not
  // Object.prototype's (`toString` is not a handler).
  if (name in Object.prototype && !Object.hasOwn(namespace, name)) {
    return undefined;
  }
  return (namespace as Record<string, unknown>)[name];
}

/** A short name for a value's type (Python: `type(x).__name__`). */
function typeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}

/**
 * Check a tool's return value against the configured-flow contract.
 *
 * A tool returns `[result, TRANSITION_IN_YAML]`, or `[result, NO_RESPONSE]` to
 * stay on the node without a bot turn.
 */
function checkContract(response: unknown, name: string, where: string): [unknown, unknown] {
  if (!Array.isArray(response) || response.length !== 2) {
    throw new FlowError(
      `${where} tool '${name}' must return a (result, next) tuple; got ${typeName(response)}`,
    );
  }
  const [result, nextNode] = response;
  if (nextNode === NO_RESPONSE || nextNode === TRANSITION_IN_YAML) {
    return [result, nextNode];
  }
  if (typeof nextNode === "string") {
    throw new FlowError(
      `${where} tool '${name}' returned node name '${nextNode}', but the flow config ` +
        `decides its transition; return (result, ${TRANSITION_IN_YAML})`,
    );
  }
  if (nextNode === null || nextNode === undefined) {
    throw new FlowError(
      `${where} tool '${name}' returned null as the next node; in a configured flow ` +
        `return (result, ${TRANSITION_IN_YAML}) to let the config decide`,
    );
  }
  throw new FlowError(
    `${where} tool '${name}' returned a next node; in a configured flow the config ` +
      `owns transitions, so return (result, ${TRANSITION_IN_YAML})`,
  );
}
