// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/config.py

/**
 * Declarative flow configuration.
 *
 * A `FlowConfig` describes a conversation flow as data: the nodes, what each
 * one says, which tools each node offers, and where each tool leads. It
 * contains no callables. Every tool a node references is a Flows direct
 * function that lives in the application's code and is resolved by name when
 * the config is joined to the application's handlers by constructing a
 * `Flow`. The exception is a `transition_only` function, which does nothing but
 * move the conversation to another node: the config supplies its description
 * and it needs no code.
 *
 * The config loads from YAML, JSON, or a plain object, and is validated
 * structurally on load: the initial node exists, every transition names a
 * node, tool names are unique within a node, and every action is well-formed.
 * Constructing a `Flow` validates the references to code.
 *
 * @example
 * ```yaml
 * initial_node: greet
 *
 * nodes:
 *   greet:
 *     role_message: You are a friendly order-taking assistant.
 *     task_messages:
 *       - role: developer
 *         content: Greet the caller and ask whether they want pizza or sushi.
 *     functions:
 *       - name: choose_pizza
 *         transition_only: true
 *         description: The caller wants to order pizza.
 *         transition_to: pizza
 *       - name: choose_sushi
 *         transition_only: true
 *         description: The caller wants to order sushi.
 *         transition_to: sushi
 *
 *   pizza:
 *     task_messages:
 *       - role: developer
 *         content: Take a pizza order.
 *     functions:
 *       - name: select_pizza_order
 *         transition_to:
 *           field: status
 *           cases:
 *             ok: confirm
 *             unavailable: pizza
 *           default: confirm
 *
 * global_functions:
 *   - name: get_delivery_estimate
 * ```
 *
 * Porting notes: DIVERGENCE: upstream validates with Pydantic models; here the classes
 * validate their input by hand and raise `ValidationError` with every problem
 * found. The file format keeps upstream's snake_case keys; the classes expose
 * camelCase fields (`initialNode`, `taskMessages`, `transitionTo`, ...), and
 * `modelDump()` returns the snake_case form. DIVERGENCE: there is no
 * filesystem in core, so `fromFile` and `!include` read files through an
 * injected synchronous `readFile` (e.g. `(p) => readFileSync(p, "utf8")`).
 */

import { includeLoader, load, SafeLoader, type YamlFileReader } from "@pipedog/core/utils/yaml";
import { ContextStrategy } from "./types.ts";

/** Built-in action types whose behavior is fixed, so a `handler` is not allowed. */
export const BUILT_IN_ACTIONS_WITHOUT_HANDLER: ReadonlySet<string> = new Set([
  "tts_say",
  "end_conversation",
]);

/** Every action type the runtime provides without registration. */
export const BUILT_IN_ACTIONS: ReadonlySet<string> = new Set([
  ...BUILT_IN_ACTIONS_WITHOUT_HANDLER,
  "function",
]);

/**
 * The canonical string a branch matches a case key or result value on.
 *
 * Booleans, and strings spelling one in any case, become `true` and `false`;
 * everything else is its `String()`. So `true:`, `"True":`, and a result of
 * `true` all meet at the same case.
 */
export function caseKey(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  const text = String(value);
  const lowered = text.toLowerCase();
  return lowered === "true" || lowered === "false" ? lowered : text;
}

/** One problem found validating a flow config (pydantic's error entry). */
export interface ValidationIssue {
  /** Where in the config: keys and indexes from the top. */
  loc: (string | number)[];
  /** What is wrong. */
  msg: string;
}

/**
 * Raised when a flow config does not match the format (pydantic's
 * `ValidationError`). Carries every problem found.
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly errors: ValidationIssue[];

  constructor(title: string, errors: ValidationIssue[]) {
    const count = `${errors.length} validation error${errors.length === 1 ? "" : "s"}`;
    const lines = errors.map((e) => `${e.loc.join(".") || "(root)"}\n  ${e.msg}`).join("\n");
    super(`${count} for ${title}\n${lines}`);
    this.errors = errors;
  }
}

type Loc = (string | number)[];

/** Collects validation problems while a config is parsed. */
class Validator {
  readonly errors: ValidationIssue[] = [];

  error(loc: Loc, msg: string): void {
    this.errors.push({ loc, msg });
  }

  isMapping(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** Check `data` is a mapping with only `allowed` keys and every `required` key. */
  object(
    data: unknown,
    loc: Loc,
    allowed: readonly string[] | null,
    required: readonly string[],
  ): Record<string, unknown> | null {
    if (!this.isMapping(data)) {
      this.error(loc, "Input should be a valid dictionary or object");
      return null;
    }
    for (const key of required) {
      if (!Object.hasOwn(data, key)) this.error([...loc, key], "Field required");
    }
    if (allowed) {
      for (const key of Object.keys(data)) {
        if (!allowed.includes(key)) this.error([...loc, key], "Extra inputs are not permitted");
      }
    }
    return data;
  }

  string(value: unknown, loc: Loc): string | null {
    if (typeof value !== "string") {
      this.error(loc, "Input should be a valid string");
      return null;
    }
    return value;
  }

  optionalString(value: unknown, loc: Loc): string | null {
    return value === null || value === undefined ? null : this.string(value, loc);
  }

  boolean(value: unknown, loc: Loc, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      this.error(loc, "Input should be a valid boolean");
      return fallback;
    }
    return value;
  }

  list<T>(value: unknown, loc: Loc, item: (v: unknown, loc: Loc) => T | null): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.error(loc, "Input should be a valid list");
      return [];
    }
    const out: T[] = [];
    value.forEach((v, i) => {
      const parsed = item(v, [...loc, i]);
      if (parsed !== null) out.push(parsed);
    });
    return out;
  }
}

/** Raise every problem `v` collected, if any. */
function raiseIfInvalid(v: Validator, title: string): void {
  if (v.errors.length > 0) throw new ValidationError(title, v.errors);
}

/** A model-level check failed (pydantic: a `ValueError` in a model validator). */
function valueError(v: Validator, loc: Loc, message: string): void {
  v.error(loc, `Value error, ${message}`);
}

export interface FlowConfigMessageOptions {
  /** Message role, e.g. `developer` or `system`. */
  role: string;
  /** Message text. May contain `{{ key }}` placeholders; see `FlowConfig`. */
  content: string;
}

/**
 * One message in a node's `task_messages`.
 *
 * - `role`: message role, e.g. `developer` or `system`.
 * - `content`: message text. May contain `{{ key }}` placeholders; see `FlowConfig`.
 */
export class FlowConfigMessage {
  role: string;
  content: string;

  constructor(options: FlowConfigMessageOptions) {
    this.role = options.role;
    this.content = options.content;
  }

  static _parse(v: Validator, data: unknown, loc: Loc): FlowConfigMessage | null {
    const obj = v.object(data, loc, ["role", "content"], ["role", "content"]);
    if (!obj) return null;
    const role = Object.hasOwn(obj, "role") ? v.string(obj.role, [...loc, "role"]) : null;
    const content = Object.hasOwn(obj, "content")
      ? v.string(obj.content, [...loc, "content"])
      : null;
    if (role === null || content === null) return null;
    return new FlowConfigMessage({ role, content });
  }

  modelDump(): Record<string, unknown> {
    return { role: this.role, content: this.content };
  }
}

export interface FlowConfigBranchOptions {
  /** Key of the tool's result whose value selects the case. */
  field: string;
  /** Result value to node name. Keys are canonicalized with `caseKey`. */
  cases: Record<string, string>;
  /** Node to transition to when the value matches no case. */
  default?: string | null;
}

/**
 * A transition chosen by a field of the tool's result.
 *
 * - `field`: key of the tool's result whose value selects the case.
 * - `cases`: result value to node name. Keys may be written as strings,
 *   booleans, or numbers; they match the result value by its canonical string
 *   (see `caseKey`), so `true:` matches a result of `true`.
 * - `default`: node to transition to when the value matches no case. When
 *   omitted, an unmatched value stays on the current node.
 */
export class FlowConfigBranch {
  field: string;
  cases: Record<string, string>;
  default: string | null;

  constructor(options: FlowConfigBranchOptions) {
    this.field = options.field;
    this.cases = Object.fromEntries(
      Object.entries(options.cases).map(([k, value]) => [caseKey(k), value]),
    );
    this.default = options.default ?? null;
  }

  static _parse(v: Validator, data: unknown, loc: Loc): FlowConfigBranch | null {
    const obj = v.object(data, loc, ["field", "cases", "default"], ["field", "cases"]);
    if (!obj) return null;
    const before = v.errors.length;
    const field = Object.hasOwn(obj, "field") ? v.string(obj.field, [...loc, "field"]) : null;
    let cases: Record<string, string> | null = null;
    if (Object.hasOwn(obj, "cases")) {
      if (!v.isMapping(obj.cases)) {
        v.error([...loc, "cases"], "Input should be a valid dictionary");
      } else if (Object.keys(obj.cases).length < 1) {
        v.error(
          [...loc, "cases"],
          "Dictionary should have at least 1 item after validation, not 0",
        );
      } else {
        cases = {};
        for (const [key, value] of Object.entries(obj.cases)) {
          const target = v.string(value, [...loc, "cases", key]);
          if (target !== null) cases[caseKey(key)] = target;
        }
      }
    }
    const dflt = v.optionalString(obj.default, [...loc, "default"]);
    if (v.errors.length > before || field === null || cases === null) return null;
    return new FlowConfigBranch({ field, cases, default: dflt });
  }

  /** Every node name this branch can transition to. */
  targets(): string[] {
    return [...Object.values(this.cases), ...(this.default ? [this.default] : [])];
  }

  modelDump(): Record<string, unknown> {
    return { field: this.field, cases: { ...this.cases }, default: this.default };
  }
}

export interface FlowConfigFunctionOptions {
  /** The tool's name, as the LLM sees it. */
  name: string;
  /** Whether the tool is defined here rather than in code. */
  transitionOnly?: boolean;
  /** What the tool is for, for the LLM. Only a `transition_only` entry has one. */
  description?: string | null;
  /** Node to transition to after the tool completes, or a branch. */
  transitionTo?: string | FlowConfigBranch | null;
}

/**
 * A tool offered at a node.
 *
 * Ordinarily the entry names a Flows direct function in the handlers a `Flow`
 * is constructed with, and the tool's description and parameters come from
 * that function. A `transition_only` entry is defined entirely here instead: it
 * takes no parameters, runs no code, and moves the conversation to
 * `transition_to` when the LLM calls it.
 *
 * - `name`: the tool's name, as the LLM sees it. For an ordinary entry, also
 *   the name of the direct function in the handlers.
 * - `transitionOnly`: whether the tool is defined here rather than in code.
 *   Requires `description` and a `transitionTo` that names a node.
 * - `description`: what the tool is for, for the LLM. Only a `transition_only`
 *   entry has one; a direct function describes itself in its metadata.
 * - `transitionTo`: node to transition to after the tool completes, or a
 *   `FlowConfigBranch`. Omitted for tools that stay on the current node.
 */
export class FlowConfigFunction {
  name: string;
  transitionOnly: boolean;
  description: string | null;
  transitionTo: string | FlowConfigBranch | null;

  /** @throws ValidationError If the entry's shape is invalid. */
  constructor(options: FlowConfigFunctionOptions) {
    this.name = options.name;
    this.transitionOnly = options.transitionOnly ?? false;
    this.description = options.description ?? null;
    this.transitionTo = options.transitionTo ?? null;
    const v = new Validator();
    this._checkShape(v, []);
    raiseIfInvalid(v, "Function");
  }

  static _parse(v: Validator, data: unknown, loc: Loc): FlowConfigFunction | null {
    const obj = v.object(
      data,
      loc,
      ["name", "transition_only", "description", "transition_to"],
      ["name"],
    );
    if (!obj) return null;
    const before = v.errors.length;
    const name = Object.hasOwn(obj, "name") ? v.string(obj.name, [...loc, "name"]) : null;
    const transitionOnly = v.boolean(obj.transition_only, [...loc, "transition_only"], false);
    const description = v.optionalString(obj.description, [...loc, "description"]);
    let transitionTo: string | FlowConfigBranch | null = null;
    const raw = obj.transition_to;
    if (typeof raw === "string") {
      transitionTo = raw;
    } else if (raw !== null && raw !== undefined) {
      transitionTo = FlowConfigBranch._parse(v, raw, [...loc, "transition_to"]);
    }
    if (v.errors.length > before || name === null) return null;
    const fn = Object.create(FlowConfigFunction.prototype) as FlowConfigFunction;
    fn.name = name;
    fn.transitionOnly = transitionOnly;
    fn.description = description;
    fn.transitionTo = transitionTo;
    fn._checkShape(v, loc);
    return fn;
  }

  protected _checkShape(v: Validator, loc: Loc): void {
    if (this.transitionOnly) {
      if (!this.description) {
        valueError(v, loc, `function '${this.name}' is transition_only and needs a description`);
      }
      if (typeof this.transitionTo !== "string") {
        valueError(
          v,
          loc,
          `function '${this.name}' is transition_only and must name the node it transitions to`,
        );
      }
    } else if (this.description !== null) {
      valueError(
        v,
        loc,
        `function '${this.name}' has a description, which only a transition_only ` +
          "function takes; a direct function describes itself in its metadata",
      );
    }
  }

  /** Every node name this function can transition to. */
  targets(): string[] {
    if (this.transitionTo === null) return [];
    if (typeof this.transitionTo === "string") return [this.transitionTo];
    return this.transitionTo.targets();
  }

  modelDump(): Record<string, unknown> {
    return {
      name: this.name,
      transition_only: this.transitionOnly,
      description: this.description,
      transition_to:
        this.transitionTo instanceof FlowConfigBranch
          ? this.transitionTo.modelDump()
          : this.transitionTo,
    };
  }
}

export interface FlowConfigActionOptions {
  /** Action type identifier. */
  type: string;
  /** Name of the handler in the handlers a `Flow` is constructed with. */
  handler?: string | null;
  /** Additional keys, passed through to the handler. */
  extras?: Record<string, unknown>;
}

/**
 * A pre- or post-action on a node.
 *
 * The built-in `tts_say` and `end_conversation` types take no handler. The
 * built-in `function` type requires one: the handler runs inline in the
 * pipeline, queued behind the bot's turn. A custom type may name a handler
 * too, which then runs immediately when the node's actions execute; a custom
 * type without one must be registered in code with
 * `FlowManager.registerAction`. Any additional keys pass through to the
 * handler. The `text` of a `tts_say` action may contain `{{ key }}`
 * placeholders; see `FlowConfig`.
 *
 * - `type`: action type identifier.
 * - `handler`: name of the handler in the handlers a `Flow` is constructed
 *   with. Required for `function`, optional for custom types, not allowed on
 *   `tts_say` or `end_conversation`.
 */
export class FlowConfigAction {
  type: string;
  handler: string | null;
  protected _extras: Record<string, unknown>;

  /** @throws ValidationError If the action is malformed. */
  constructor(options: FlowConfigActionOptions) {
    this.type = options.type;
    this.handler = options.handler ?? null;
    this._extras = { ...(options.extras ?? {}) };
    const v = new Validator();
    this._checkHandler(v, []);
    raiseIfInvalid(v, "Action");
  }

  static _parse(v: Validator, data: unknown, loc: Loc): FlowConfigAction | null {
    const obj = v.object(data, loc, null, ["type"]);
    if (!obj) return null;
    const before = v.errors.length;
    const type = Object.hasOwn(obj, "type") ? v.string(obj.type, [...loc, "type"]) : null;
    const handler = v.optionalString(obj.handler, [...loc, "handler"]);
    if (v.errors.length > before || type === null) return null;
    const { type: _type, handler: _handler, ...extras } = obj;
    const action = Object.create(FlowConfigAction.prototype) as FlowConfigAction;
    action.type = type;
    action.handler = handler;
    action._extras = extras;
    action._checkHandler(v, loc);
    return action;
  }

  protected _checkHandler(v: Validator, loc: Loc): void {
    if (this.type === "function" && !this.handler) {
      valueError(v, loc, "a 'function' action requires a 'handler' name");
    }
    if (BUILT_IN_ACTIONS_WITHOUT_HANDLER.has(this.type) && this.handler !== null) {
      valueError(v, loc, `the built-in '${this.type}' action does not take a 'handler'`);
    }
  }

  /** Whether this is a custom type whose handler the config does not name. */
  get registeredInCode(): boolean {
    return !BUILT_IN_ACTIONS.has(this.type) && this.handler === null;
  }

  /** The pass-through keys beyond `type` and `handler`. */
  extras(): Record<string, unknown> {
    return { ...this._extras };
  }

  modelDump(): Record<string, unknown> {
    return { type: this.type, handler: this.handler, ...this._extras };
  }
}

const NODE_CONTEXT_STRATEGIES = ["append", "reset"] as const;

export interface FlowConfigNodeOptions {
  /** What the LLM should do at this node. */
  taskMessages: FlowConfigMessage[];
  /** The bot's role or personality. */
  roleMessage?: string | null;
  /** Tools offered at this node. */
  functions?: FlowConfigFunction[];
  /** Actions run before the LLM responds at this node. */
  preActions?: FlowConfigAction[];
  /** Actions run after the LLM responds at this node. */
  postActions?: FlowConfigAction[];
  /** How the LLM context is updated on entering this node. */
  contextStrategy?: "append" | "reset" | null;
  /** Whether the LLM responds as soon as the node is entered. Defaults to true. */
  respondImmediately?: boolean;
}

/**
 * One node of the flow.
 *
 * - `taskMessages`: what the LLM should do at this node.
 * - `roleMessage`: the bot's role or personality, sent as the LLM's system
 *   instruction on entering this node. It persists across transitions until
 *   another node sets its own. May contain `{{ key }}` placeholders; see
 *   `FlowConfig`.
 * - `functions`: tools offered at this node, in addition to the config's
 *   `global_functions`.
 * - `preActions`: actions run before the LLM responds at this node.
 * - `postActions`: actions run after the LLM responds at this node.
 * - `contextStrategy`: how the LLM context is updated on entering this node.
 *   Defaults to the `FlowManager`'s strategy.
 * - `respondImmediately`: whether the LLM responds as soon as the node is
 *   entered. Defaults to true.
 */
export class FlowConfigNode {
  taskMessages: FlowConfigMessage[];
  roleMessage: string | null;
  functions: FlowConfigFunction[];
  preActions: FlowConfigAction[];
  postActions: FlowConfigAction[];
  contextStrategy: "append" | "reset" | null;
  respondImmediately: boolean;

  constructor(options: FlowConfigNodeOptions) {
    this.taskMessages = options.taskMessages;
    this.roleMessage = options.roleMessage ?? null;
    this.functions = options.functions ?? [];
    this.preActions = options.preActions ?? [];
    this.postActions = options.postActions ?? [];
    this.contextStrategy = options.contextStrategy ?? null;
    this.respondImmediately = options.respondImmediately ?? true;
  }

  static _parse(v: Validator, data: unknown, loc: Loc): FlowConfigNode | null {
    const obj = v.object(
      data,
      loc,
      [
        "task_messages",
        "role_message",
        "functions",
        "pre_actions",
        "post_actions",
        "context_strategy",
        "respond_immediately",
      ],
      ["task_messages"],
    );
    if (!obj) return null;
    const before = v.errors.length;
    const taskMessages = Object.hasOwn(obj, "task_messages")
      ? v.list(obj.task_messages, [...loc, "task_messages"], (d, l) =>
          FlowConfigMessage._parse(v, d, l),
        )
      : [];
    const roleMessage = v.optionalString(obj.role_message, [...loc, "role_message"]);
    const functions = v.list(obj.functions, [...loc, "functions"], (d, l) =>
      FlowConfigFunction._parse(v, d, l),
    );
    const preActions = v.list(obj.pre_actions, [...loc, "pre_actions"], (d, l) =>
      FlowConfigAction._parse(v, d, l),
    );
    const postActions = v.list(obj.post_actions, [...loc, "post_actions"], (d, l) =>
      FlowConfigAction._parse(v, d, l),
    );
    let contextStrategy: "append" | "reset" | null = null;
    const strategy = obj.context_strategy;
    if (strategy !== null && strategy !== undefined) {
      if ((NODE_CONTEXT_STRATEGIES as readonly unknown[]).includes(strategy)) {
        contextStrategy = strategy as "append" | "reset";
      } else {
        v.error([...loc, "context_strategy"], "Input should be 'append' or 'reset'");
      }
    }
    const respondImmediately = v.boolean(
      obj.respond_immediately,
      [...loc, "respond_immediately"],
      true,
    );
    if (v.errors.length > before) return null;
    const node = new FlowConfigNode({
      taskMessages,
      roleMessage,
      functions,
      preActions,
      postActions,
      contextStrategy,
      respondImmediately,
    });
    node._checkUniqueFunctionNames(v, loc);
    return node;
  }

  protected _checkUniqueFunctionNames(v: Validator, loc: Loc): void {
    const problem = duplicate(
      this.functions.map((f) => f.name),
      "node",
    );
    if (problem) valueError(v, loc, problem);
  }

  /** The node's `contextStrategy` as a `ContextStrategy`. */
  contextStrategyEnum(): ContextStrategy | null {
    return this.contextStrategy
      ? this.contextStrategy === "reset"
        ? ContextStrategy.RESET
        : ContextStrategy.APPEND
      : null;
  }

  modelDump(): Record<string, unknown> {
    return {
      task_messages: this.taskMessages.map((m) => m.modelDump()),
      role_message: this.roleMessage,
      functions: this.functions.map((f) => f.modelDump()),
      pre_actions: this.preActions.map((a) => a.modelDump()),
      post_actions: this.postActions.map((a) => a.modelDump()),
      context_strategy: this.contextStrategy,
      respond_immediately: this.respondImmediately,
    };
  }
}

export interface FlowConfigOptions {
  /** Name of the node the flow starts in. */
  initialNode: string;
  /** The flow's nodes, keyed by name. */
  nodes: Record<string, FlowConfigNode>;
  /** Tools offered at every node. */
  globalFunctions?: FlowConfigFunction[];
}

export interface FromYamlOptions {
  /**
   * Directory that `!include` paths resolve against. When omitted, `!include`
   * is unavailable. An include can read any file the process can read, so
   * omit `baseDir` for text from an untrusted source.
   */
  baseDir?: string | null;
  /** Reads `!include`d files. Required with `baseDir`. */
  readFile?: YamlFileReader | null;
}

export interface FromFileOptions {
  /** Reads the config file and any `!include`d files, e.g. `(p) => readFileSync(p, "utf8")`. */
  readFile: YamlFileReader;
}

/**
 * A conversation flow described as data.
 *
 * Load one with `fromFile` for a YAML or JSON file, `fromYaml` for YAML text,
 * `fromJson` for JSON text, or `modelValidate` for an object that is already
 * parsed.
 *
 * `!include` resolves paths on the application's file system and can read any
 * file the process can read, so it belongs only in configs the application
 * ships. Load a config from another source, such as a request body, with
 * `fromYaml` and no `baseDir`, which rejects `!include`, or with `fromJson`.
 *
 * Prompt text may refer to the manager's state with `{{ key }}` placeholders:
 * a node's `role_message`, the `content` of its `task_messages`, and the
 * `text` of a `tts_say` action. `FlowManager` fills them from
 * `flowManager.state` each time it enters the node, so a value stored by a
 * handler earlier in the conversation can appear in a later prompt.
 * `{{ order.size }}` walks into a stored object. A key that is not in state
 * throws `FlowError` when the node is entered. To show the LLM a literal
 * `{{ key }}`, escape it as `\{{ key }}`.
 *
 * - `initialNode`: name of the node the flow starts in.
 * - `nodes`: the flow's nodes, keyed by name.
 * - `globalFunctions`: tools offered at every node.
 */
export class FlowConfig {
  static Message = FlowConfigMessage;
  static Branch = FlowConfigBranch;
  static Function = FlowConfigFunction;
  static Action = FlowConfigAction;
  static Node = FlowConfigNode;

  initialNode: string;
  nodes: Record<string, FlowConfigNode>;
  globalFunctions: FlowConfigFunction[];

  /** @throws ValidationError If the graph is inconsistent. */
  constructor(options: FlowConfigOptions) {
    this.initialNode = options.initialNode;
    this.nodes = options.nodes;
    this.globalFunctions = options.globalFunctions ?? [];
    const v = new Validator();
    this._checkGraph(v);
    raiseIfInvalid(v, "FlowConfig");
  }

  /**
   * Validate a parsed config (an object with the file format's snake_case
   * keys), like pydantic's `model_validate`.
   *
   * @throws ValidationError Listing every problem found.
   */
  static modelValidate(data: unknown): FlowConfig {
    const v = new Validator();
    const obj = v.object(
      data,
      [],
      ["initial_node", "nodes", "global_functions"],
      ["initial_node", "nodes"],
    );
    let initialNode: string | null = null;
    const nodes: Record<string, FlowConfigNode> = {};
    let globalFunctions: FlowConfigFunction[] = [];
    if (obj) {
      if (Object.hasOwn(obj, "initial_node")) {
        initialNode = v.string(obj.initial_node, ["initial_node"]);
      }
      if (Object.hasOwn(obj, "nodes")) {
        if (!v.isMapping(obj.nodes)) {
          v.error(["nodes"], "Input should be a valid dictionary");
        } else if (Object.keys(obj.nodes).length < 1) {
          v.error(["nodes"], "Dictionary should have at least 1 item after validation, not 0");
        } else {
          for (const [name, node] of Object.entries(obj.nodes)) {
            const parsed = FlowConfigNode._parse(v, node, ["nodes", name]);
            if (parsed) nodes[name] = parsed;
          }
        }
      }
      globalFunctions = v.list(obj.global_functions, ["global_functions"], (d, l) =>
        FlowConfigFunction._parse(v, d, l),
      );
    }
    raiseIfInvalid(v, "FlowConfig");
    const config = Object.create(FlowConfig.prototype) as FlowConfig;
    config.initialNode = initialNode as string;
    config.nodes = nodes;
    config.globalFunctions = globalFunctions;
    config._checkGraph(v);
    raiseIfInvalid(v, "FlowConfig");
    return config;
  }

  protected _checkGraph(v: Validator): void {
    if (!Object.hasOwn(this.nodes, this.initialNode)) {
      valueError(v, [], `initial_node '${this.initialNode}' is not a defined node`);
      return;
    }

    const globalProblem = duplicate(
      this.globalFunctions.map((f) => f.name),
      "global_functions",
    );
    if (globalProblem) {
      valueError(v, [], globalProblem);
      return;
    }
    const globalNames = new Set(this.globalFunctions.map((f) => f.name));

    for (const [nodeName, node] of Object.entries(this.nodes)) {
      for (const func of node.functions) {
        if (globalNames.has(func.name)) {
          valueError(v, [], `node '${nodeName}' function '${func.name}' is also a global function`);
          return;
        }
      }
      for (const func of node.functions) {
        const problem = checkTargets(func, this.nodes, `node '${nodeName}'`);
        if (problem) {
          valueError(v, [], problem);
          return;
        }
      }
    }
    for (const func of this.globalFunctions) {
      const problem = checkTargets(func, this.nodes, "global_functions");
      if (problem) {
        valueError(v, [], problem);
        return;
      }
    }
  }

  /**
   * Load a config from YAML text.
   *
   * @param text The YAML document.
   * @param options.baseDir Directory that `!include` paths resolve against.
   *   When omitted, `!include` is unavailable.
   * @param options.readFile Reads `!include`d files. Required with `baseDir`.
   * @returns The validated config.
   */
  static fromYaml(text: string, options: FromYamlOptions = {}): FlowConfig {
    let loader = SafeLoader;
    if (options.baseDir !== null && options.baseDir !== undefined) {
      if (!options.readFile) {
        throw new Error("FlowConfig.fromYaml: `readFile` is required with `baseDir`");
      }
      loader = includeLoader(options.baseDir, { readFile: options.readFile });
    }
    return FlowConfig.modelValidate(requireMapping(load(text, loader)));
  }

  /**
   * Load a config from JSON text.
   *
   * @param text The JSON document.
   * @returns The validated config.
   */
  static fromJson(text: string): FlowConfig {
    return FlowConfig.modelValidate(requireMapping(JSON.parse(text)));
  }

  /**
   * Load a config from a `.yaml`, `.yml`, or `.json` file.
   *
   * YAML files may use `!include` with paths relative to the file's directory.
   * Included paths are not confined to that directory, so load only files you
   * control. For a config from another source, such as a request body, use
   * `fromYaml` without `baseDir` or `fromJson`.
   *
   * @param path Path to the file.
   * @param options.readFile Reads the file and its includes.
   * @returns The validated config.
   */
  static fromFile(path: string, options: FromFileOptions): FlowConfig {
    const text = options.readFile(path);
    if (path.endsWith(".json")) {
      return FlowConfig.fromJson(text);
    }
    return FlowConfig.fromYaml(text, { baseDir: dirname(path), readFile: options.readFile });
  }

  /**
   * The JSON Schema of the file format, for editors and other tools.
   *
   * The package also ships it as `flow_config.schema.json`.
   */
  static modelJsonSchema(): Record<string, unknown> {
    return structuredClone(FLOW_CONFIG_JSON_SCHEMA);
  }

  /** The config as a plain object in the file format (snake_case keys). */
  modelDump(): Record<string, unknown> {
    return {
      initial_node: this.initialNode,
      nodes: Object.fromEntries(
        Object.entries(this.nodes).map(([name, node]) => [name, node.modelDump()]),
      ),
      global_functions: this.globalFunctions.map((f) => f.modelDump()),
    };
  }
}

function requireMapping(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("flow config: top level must be a mapping");
  }
  return data as Record<string, unknown>;
}

/** The directory part of a path (`Path(path).parent`). */
function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return ".";
  return i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

/** The duplicate-name problem in `names`, if any. */
function duplicate(names: string[], where: string): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return `duplicate function '${name}' in ${where}`;
    seen.add(name);
  }
  return null;
}

function checkTargets(
  func: FlowConfigFunction,
  nodes: Record<string, unknown>,
  where: string,
): string | null {
  for (const target of func.targets()) {
    if (!Object.hasOwn(nodes, target)) {
      return `${where} function '${func.name}' transitions to unknown node '${target}'`;
    }
  }
  return null;
}

// The JSON Schema upstream generates from its Pydantic models
// (`FlowConfig.model_json_schema()`), as shipped in flow_config.schema.json.
const FLOW_CONFIG_JSON_SCHEMA: Record<string, unknown> = {
  $defs: {
    Action: {
      additionalProperties: true,
      description:
        "A pre- or post-action on a node.\n\nThe built-in ``tts_say`` and ``end_conversation`` types take no\nhandler. The built-in ``function`` type requires one: the handler runs\ninline in the pipeline, queued behind the bot's turn. A custom type\nmay name a handler too, which then runs immediately when the node's\nactions execute; a custom type without one must be registered in code\nwith ``FlowManager.register_action``. Any additional keys pass through\nto the handler. The ``text`` of a ``tts_say`` action may contain\n``{{ key }}`` placeholders; see :class:`FlowConfig`.\n\nParameters:\n    type: Action type identifier.\n    handler: Name of the handler in the handlers a\n        :class:`~pipecat.flows.Flow` is constructed with. Required\n        for ``function``, optional for custom types, not allowed on\n        ``tts_say`` or ``end_conversation``.",
      properties: {
        type: {
          title: "Type",
          type: "string",
        },
        handler: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Handler",
        },
      },
      required: ["type"],
      title: "Action",
      type: "object",
    },
    Branch: {
      additionalProperties: false,
      description:
        "A transition chosen by a field of the tool's result.\n\nParameters:\n    field: Key of the tool's result whose value selects the case.\n    cases: Result value to node name. Keys may be written as strings,\n        booleans, or numbers; they match the result value by its\n        canonical string (see :func:`case_key`), so ``true:`` matches a\n        result of ``True``.\n    default: Node to transition to when the value matches no case.\n        When omitted, an unmatched value stays on the current node.",
      properties: {
        field: {
          title: "Field",
          type: "string",
        },
        cases: {
          additionalProperties: {
            type: "string",
          },
          minProperties: 1,
          title: "Cases",
          type: "object",
        },
        default: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Default",
        },
      },
      required: ["field", "cases"],
      title: "Branch",
      type: "object",
    },
    Function: {
      additionalProperties: false,
      description:
        "A tool offered at a node.\n\nOrdinarily the entry names a Flows direct function in the handlers a\n:class:`~pipecat.flows.Flow` is constructed with, and the tool's\ndescription and parameters come from that function. A\n``transition_only`` entry is defined entirely here instead: it takes\nno parameters, runs no code, and moves the conversation to\n``transition_to`` when the LLM calls it.\n\nParameters:\n    name: The tool's name, as the LLM sees it. For an ordinary\n        entry, also the name of the direct function in the handlers.\n    transition_only: Whether the tool is defined here rather than in\n        code. Requires ``description`` and a ``transition_to`` that\n        names a node.\n    description: What the tool is for, for the LLM. Only a\n        ``transition_only`` entry has one; a direct function\n        describes itself in its docstring.\n    transition_to: Node to transition to after the tool completes,\n        or a :class:`FlowConfig.Branch`. Omitted for tools that stay\n        on the current node.",
      else: {
        not: {
          required: ["description"],
        },
      },
      if: {
        properties: {
          transition_only: {
            const: true,
          },
        },
        required: ["transition_only"],
      },
      properties: {
        name: {
          title: "Name",
          type: "string",
        },
        transition_only: {
          default: false,
          title: "Transition Only",
          type: "boolean",
        },
        description: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Description",
        },
        transition_to: {
          anyOf: [
            {
              type: "string",
            },
            {
              $ref: "#/$defs/Branch",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Transition To",
        },
      },
      required: ["name"],
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword, not a thenable.
      then: {
        properties: {
          transition_to: {
            type: "string",
          },
        },
        required: ["description", "transition_to"],
      },
      title: "Function",
      type: "object",
    },
    Message: {
      additionalProperties: false,
      description:
        "One message in a node's ``task_messages``.\n\nParameters:\n    role: Message role, e.g. ``developer`` or ``system``.\n    content: Message text. May contain ``{{ key }}`` placeholders;\n        see :class:`FlowConfig`.",
      properties: {
        role: {
          title: "Role",
          type: "string",
        },
        content: {
          title: "Content",
          type: "string",
        },
      },
      required: ["role", "content"],
      title: "Message",
      type: "object",
    },
    Node: {
      additionalProperties: false,
      description:
        "One node of the flow.\n\nParameters:\n    task_messages: What the LLM should do at this node.\n    role_message: The bot's role or personality, sent as the LLM's\n        system instruction on entering this node. It persists across\n        transitions until another node sets its own. May contain\n        ``{{ key }}`` placeholders; see :class:`FlowConfig`.\n    functions: Tools offered at this node, in addition to the\n        config's ``global_functions``.\n    pre_actions: Actions run before the LLM responds at this node.\n    post_actions: Actions run after the LLM responds at this node.\n    context_strategy: How the LLM context is updated on entering this\n        node. Defaults to the ``FlowManager``'s strategy.\n    respond_immediately: Whether the LLM responds as soon as the node\n        is entered. Defaults to True.",
      properties: {
        task_messages: {
          items: {
            $ref: "#/$defs/Message",
          },
          title: "Task Messages",
          type: "array",
        },
        role_message: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Role Message",
        },
        functions: {
          items: {
            $ref: "#/$defs/Function",
          },
          title: "Functions",
          type: "array",
        },
        pre_actions: {
          items: {
            $ref: "#/$defs/Action",
          },
          title: "Pre Actions",
          type: "array",
        },
        post_actions: {
          items: {
            $ref: "#/$defs/Action",
          },
          title: "Post Actions",
          type: "array",
        },
        context_strategy: {
          anyOf: [
            {
              enum: ["append", "reset"],
              type: "string",
            },
            {
              type: "null",
            },
          ],
          default: null,
          title: "Context Strategy",
        },
        respond_immediately: {
          default: true,
          title: "Respond Immediately",
          type: "boolean",
        },
      },
      required: ["task_messages"],
      title: "Node",
      type: "object",
    },
  },
  additionalProperties: false,
  description:
    "A conversation flow described as data.\n\nLoad one with :meth:`from_file` for a YAML or JSON file, :meth:`from_yaml`\nfor YAML text, :meth:`from_json` for JSON text, or Pydantic's\n``model_validate`` for a dict that is already parsed.\n\n``!include`` resolves paths on the application's file system and can read\nany file the process can read, so it belongs only in configs the\napplication ships. Load a config from another source, such as a request\nbody, with :meth:`from_yaml` and no ``base_dir``, which rejects\n``!include``, or with :meth:`from_json`.\n\nPrompt text may refer to the manager's state with ``{{ key }}``\nplaceholders: a node's ``role_message``, the ``content`` of its\n``task_messages``, and the ``text`` of a ``tts_say`` action.\n:class:`~pipecat.flows.FlowManager` fills them from ``flow_manager.state``\neach time it enters the node, so a value stored by a handler earlier in the\nconversation can appear in a later prompt. ``{{ order.size }}`` walks into\na stored mapping, and values are rendered with ``str()``. A key that is not\nin state raises :class:`~pipecat.flows.FlowError` when the node is entered.\nTo show the LLM a literal ``{{ key }}``, escape it as ``\\{{ key }}``.\n\nParameters:\n    initial_node: Name of the node the flow starts in.\n    nodes: The flow's nodes, keyed by name.\n    global_functions: Tools offered at every node.",
  properties: {
    initial_node: {
      title: "Initial Node",
      type: "string",
    },
    nodes: {
      additionalProperties: {
        $ref: "#/$defs/Node",
      },
      minProperties: 1,
      title: "Nodes",
      type: "object",
    },
    global_functions: {
      items: {
        $ref: "#/$defs/Function",
      },
      title: "Global Functions",
      type: "array",
    },
  },
  required: ["initial_node", "nodes"],
  title: "FlowConfig",
  type: "object",
};
