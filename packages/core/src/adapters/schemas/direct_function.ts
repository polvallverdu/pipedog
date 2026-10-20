// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/schemas/direct_function.py

/**
 * Direct function wrapper utilities for LLM function calling.
 *
 * Provides utilities for wrapping "direct" functions that handle LLM function
 * calls. Direct functions have their metadata automatically extracted from
 * function signatures (and, in TypeScript, metadata attached to the function),
 * allowing them to be used without accompanying configurations (as
 * FunctionSchemas or in provider-specific formats).
 *
 * DIVERGENCE: JavaScript has no runtime type hints or docstrings. Parameter
 * names and which ones are required (no default value) are read from the
 * function's source; the description and parameter types come from optional
 * metadata attached to the function (`DirectFunctionMetadata`). Parameters
 * without metadata get an empty (any-type) JSON schema. Minified functions
 * lose their parameter names, so direct functions must ship unminified.
 */

import type { FunctionCallParams } from "../../services/llm_service.ts";
import { FunctionSchema } from "./function_schema.ts";

/**
 * Metadata a direct function may carry in place of Python's type hints and
 * docstring.
 */
export interface DirectFunctionMetadata {
  /** The function description (Python: the docstring's description). */
  description?: string;
  /**
   * Per-parameter type hints: a JSON schema object, a JS constructor
   * (`String`, `Number`, `Boolean`, `Object`, `Array`, `BigInt` for an
   * integer), `null`, or an array of those (a union).
   */
  parameters?: Record<string, unknown>;
}

/**
 * A "direct" function that handles LLM function calls.
 *
 * A direct function is an async function whose first parameter is `params`
 * (a `FunctionCallParams`), followed by the tool's arguments. Its metadata
 * (name, description, and parameter schemas) is extracted automatically, so
 * it can be used without an accompanying `FunctionSchema` or
 * provider-specific configuration.
 *
 * Typed permissively so that concrete function signatures type-check when
 * passed to public APIs. The precise contract — async, with a first parameter
 * named `params` — is validated at runtime by
 * `DirectFunctionWrapper.validateFunction`.
 */
export type DirectFunction = ((params: FunctionCallParams, ...args: any[]) => Promise<unknown>) &
  DirectFunctionMetadata;

type AnyFunction = ((...args: any[]) => unknown) & DirectFunctionMetadata;

interface ParsedParameter {
  name: string;
  hasDefault: boolean;
}

/**
 * Parse a function's parameter list from its source: names, and whether each
 * has a default value. Skips strings, template literals, comments and nested
 * brackets in default values.
 */
function parseParameters(fn: AnyFunction): ParsedParameter[] {
  const src = Function.prototype.toString.call(fn);

  // `async x => ...` (single parameter, no parentheses).
  const single = /^\s*async\s+([A-Za-z_$][\w$]*)\s*=>/.exec(src);
  if (single) {
    return [{ name: single[1] as string, hasDefault: false }];
  }

  const open = src.indexOf("(");
  if (open < 0) return [];

  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = open + 1;
  for (; i < src.length; i++) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      current += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      // A top-level "=" (not "=>", "==") marks a default value.
      let d = 0;
      let eq = -1;
      for (let k = 0; k < part.length; k++) {
        const c = part[k];
        if (c === "(" || c === "[" || c === "{") d++;
        else if (c === ")" || c === "]" || c === "}") d--;
        else if (c === "=" && d === 0 && part[k + 1] !== ">" && part[k + 1] !== "=") {
          eq = k;
          break;
        }
      }
      const rawName = (eq >= 0 ? part.slice(0, eq) : part).trim().replace(/^\.\.\./, "");
      return { name: rawName, hasDefault: eq >= 0 };
    });
}

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

/**
 * Base class for a wrapper around a DirectFunction.
 *
 * Provides functionality to:
 *
 * - extract metadata from the function signature and attached metadata
 * - use that metadata to generate a corresponding FunctionSchema
 */
export class BaseDirectFunctionWrapper {
  function: AnyFunction;
  name!: string;
  description!: string;
  properties!: Record<string, Record<string, unknown>>;
  required!: string[];

  /**
   * Initialize the direct function wrapper.
   *
   * @param fn The function to wrap and extract metadata from.
   */
  constructor(fn: AnyFunction) {
    (this.constructor as typeof BaseDirectFunctionWrapper).validateFunction(fn);
    this.function = fn;
    this._initializeMetadata();
  }

  /**
   * Get the name of the special first function parameter.
   *
   * The special first parameter is ignored by metadata extraction as it's not
   * relevant to the LLM (e.g., 'params' for FunctionCallParams).
   *
   * @returns The name of the special first parameter.
   */
  static specialFirstParamName(): string {
    throw new Error("Subclasses must define the special first parameter name.");
  }

  /**
   * Validate that the function meets direct function requirements.
   *
   * @param fn The function to validate.
   * @throws Error if function doesn't meet requirements (not async, missing
   *   parameters, incorrect first parameter name).
   */
  static validateFunction(fn: AnyFunction): void {
    if (!isAsyncFunction(fn)) {
      throw new Error(`Direct function ${fn.name} must be async`);
    }
    const params = parseParameters(fn);
    // `this` is the class validating (like Python's `cls`), so subclasses
    // supply their own special first parameter name.
    // biome-ignore lint/complexity/noThisInStatic: classmethod semantics.
    const specialFirstParamName = this.specialFirstParamName();
    if (params.length === 0) {
      throw new Error(
        `Direct function ${fn.name} must have at least one parameter (${specialFirstParamName})`,
      );
    }
    const firstParamName = (params[0] as ParsedParameter).name;
    if (firstParamName !== specialFirstParamName) {
      throw new Error(
        `Direct function ${fn.name} first parameter must be named '${specialFirstParamName}'`,
      );
    }
  }

  /**
   * Convert the wrapped function to a FunctionSchema.
   *
   * @returns A FunctionSchema instance with extracted metadata.
   */
  toFunctionSchema(): FunctionSchema {
    return new FunctionSchema({
      name: this.name,
      description: this.description,
      properties: this.properties,
      required: this.required,
    });
  }

  /** Initialize metadata from function signature and attached metadata. */
  protected _initializeMetadata(): void {
    // Get function name
    this.name = this.function.name;

    // Get function description
    this.description = (this.function.description ?? "").trim();

    // Get function parameters as JSON schemas, and the list of required parameters
    [this.properties, this.required] = this._getParametersAsJsonschema(this.function);
  }

  /** Names of the parameters after the special first one, in order. */
  protected _argumentNames(): string[] {
    return parseParameters(this.function)
      .slice(1)
      .map((p) => p.name)
      .filter((name) => name !== "self");
  }

  /**
   * Get function parameters as an object of JSON schemas and a list of
   * required parameters.
   *
   * Ignore the first parameter, as it's expected to be the "special" one.
   *
   * @param func Function to get parameters from.
   * @returns A tuple of an object mapping each function parameter to its JSON
   *   schema, and a list of required parameter names.
   */
  protected _getParametersAsJsonschema(
    func: AnyFunction,
  ): [Record<string, Record<string, unknown>>, string[]] {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    const hints = func.parameters ?? {};

    const params = parseParameters(func);
    for (let i = 0; i < params.length; i++) {
      const { name, hasDefault } = params[i] as ParsedParameter;
      // Ignore 'self' parameter
      if (name === "self") continue;

      // Ignore the first parameter, which is expected to be the "special" one
      // (We have already validated that this is the case in validateFunction())
      if (i === 0) continue;

      const typeHint = Object.hasOwn(hints, name) ? hints[name] : undefined;

      // Convert type hint to JSON schema
      properties[name] = this._typehintToJsonschema(typeHint);

      // Add whether the parameter is required
      // If the parameter has no default value, it's required
      if (!hasDefault) {
        required.push(name);
      }
    }

    return [properties, required];
  }

  /**
   * Convert a type hint to a JSON Schema.
   *
   * @param typeHint A JSON schema, a JS constructor, `null`, or an array of
   *   those (a union).
   * @returns An object representing the JSON Schema
   */
  protected _typehintToJsonschema(typeHint: unknown): Record<string, unknown> {
    if (typeHint === undefined) {
      return {};
    }

    // Handle basic types
    if (typeHint === null) return { type: "null" };
    if (typeHint === String) return { type: "string" };
    if (typeHint === BigInt) return { type: "integer" };
    if (typeHint === Number) return { type: "number" };
    if (typeHint === Boolean) return { type: "boolean" };
    if (typeHint === Object) return { type: "object" };
    if (typeHint === Array) return { type: "array" };

    // Handle union types
    if (Array.isArray(typeHint)) {
      return { anyOf: typeHint.map((arg) => this._typehintToJsonschema(arg)) };
    }

    // A JSON schema given directly (copied, so the caller's object isn't shared)
    if (typeof typeHint === "object") {
      return structuredClone(typeHint as Record<string, unknown>);
    }

    // Default to any type if we can't determine the specific schema
    return {};
  }
}

/**
 * Wrapper around a DirectFunction for LLM function calling.
 *
 * This class:
 *
 * - Extracts metadata from the function signature and attached metadata
 * - Generates a corresponding FunctionSchema
 * - Helps with function invocation
 */
export class DirectFunctionWrapper extends BaseDirectFunctionWrapper {
  declare function: DirectFunction;

  /**
   * Get the special first parameter name for direct functions.
   *
   * @returns The string "params" which is expected as the first parameter.
   */
  static override specialFirstParamName(): string {
    return "params";
  }

  /**
   * Invoke the wrapped function with the provided arguments.
   *
   * Arguments are matched to the function's parameters by name, like
   * Python's `function(params=params, **args)`.
   *
   * @param args Arguments to pass to the function.
   * @param params Function call parameters from the LLM service.
   * @returns The result of the function call.
   */
  async invoke(
    args: Readonly<Record<string, unknown>>,
    params: FunctionCallParams,
  ): Promise<unknown> {
    const positional = this._argumentNames().map((name) => args[name]);
    return await this.function(params, ...positional);
  }
}

export interface ToolOptions {
  /**
   * Whether to cancel this function call when an interruption occurs.
   * Defaults to true.
   */
  cancelOnInterruption?: boolean;
  /**
   * Optional per-tool timeout in seconds. A call that runs past it is
   * cancelled. Defaults to null (uses the LLM service default).
   */
  timeoutSecs?: number | null;
  /**
   * Whether the LLM may cancel this call once it is running, by calling the
   * `cancel_<name>` tool advertised alongside it. Only meaningful together
   * with `cancelOnInterruption: false`: a synchronous call blocks the LLM
   * until it returns, so there is no moment at which it could ask for the
   * call to stop. What decides it is duration: the LLM reaches the cancel tool
   * a few seconds in at best, so work that finishes before then can't be
   * stopped whatever it costs. Every tool that opts in also adds a tool for
   * the LLM to weigh. Defaults to false.
   */
  cancellableByLlm?: boolean;
}

/** Call-option metadata `toolOptions()` attaches to a handler (internal). */
export interface ToolOptionsMetadata {
  _pipecatCancelOnInterruption?: boolean;
  _pipecatTimeoutSecs?: number | null;
  _pipecatCancellableByLlm?: boolean;
}

/**
 * Configure a handler's call options.
 *
 * This is optional. A handler advertised in an `LLMContext`'s tools — a
 * direct function, or the `handler` a `FunctionSchema` carries — is
 * registered automatically with default call options, so this is only needed
 * when you want to override those defaults. It attaches the options to the
 * handler and returns it unchanged — it does not register anything, so
 * configured handlers can stay at module level.
 *
 * On an `LLMWorker`, use `tool` instead, which applies these same options and
 * additionally marks the method for collection as one of the worker's tools.
 *
 * Can be used with or without options:
 *
 * @example
 * const getWeather = toolOptions(async function get_weather(params, location) { ... });
 * const endCall = toolOptions({ cancelOnInterruption: false, timeoutSecs: 60 })(
 *   async function end_call(params, reason) { ... },
 * );
 *
 * @returns The function, unchanged except for pipecat call-option metadata
 *   attached under private `_pipecat*` properties (read internally; not part
 *   of the public API).
 */
export function toolOptions<F extends object>(
  fn: F,
  options?: ToolOptions,
): F & ToolOptionsMetadata;
export function toolOptions(
  options?: ToolOptions,
): <F extends object>(fn: F) => F & ToolOptionsMetadata;
export function toolOptions<F extends object>(
  fnOrOptions?: F | ToolOptions,
  maybeOptions?: ToolOptions,
): (F & ToolOptionsMetadata) | (<G extends object>(fn: G) => G & ToolOptionsMetadata) {
  const options: ToolOptions =
    typeof fnOrOptions === "function" ? (maybeOptions ?? {}) : ((fnOrOptions as ToolOptions) ?? {});
  const cancelOnInterruption = options.cancelOnInterruption ?? true;
  const timeoutSecs = options.timeoutSecs ?? null;
  const cancellableByLlm = options.cancellableByLlm ?? false;

  const decorator = <G extends object>(fn: G): G & ToolOptionsMetadata => {
    const target = fn as G & ToolOptionsMetadata;
    target._pipecatCancelOnInterruption = cancelOnInterruption;
    target._pipecatTimeoutSecs = timeoutSecs;
    target._pipecatCancellableByLlm = cancellableByLlm;
    return target;
  };

  if (typeof fnOrOptions === "function") {
    return decorator(fnOrOptions as F);
  }
  return decorator;
}
