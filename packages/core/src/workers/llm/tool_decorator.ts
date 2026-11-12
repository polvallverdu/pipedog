// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/workers/llm/tool_decorator.py

/**
 * Decorator for marking methods as LLM tools.
 *
 * Porting notes:
 * - The deprecated `timeout` alias of `timeoutSecs` is not ported.
 * - `_collectTools` returns the (unbound) methods found on the prototype
 *   chain, not bound methods: direct-function metadata is read from a
 *   function's source, which a bound function does not expose. `LLMWorker`
 *   binds each one to the worker when it registers it on the LLM.
 */

import {
  type ToolOptionsMetadata,
  toolOptions,
} from "../../adapters/llm/schemas/direct_function.ts";

type AnyFn = (...args: any[]) => any;

/** Options accepted by `tool()`. */
export interface ToolDecoratorOptions {
  /**
   * Whether to cancel this tool call when an interruption occurs. Defaults to
   * true. Only applies to `LLMWorker` tools.
   */
  cancelOnInterruption?: boolean;
  /**
   * Optional timeout in seconds for this tool call. A call that runs past it
   * is cancelled. Defaults to null (uses the LLM service default). Only
   * applies to `LLMWorker` tools.
   */
  timeoutSecs?: number | null;
}

/** A function marked by `tool()`. */
export type LLMTool<F extends AnyFn = AnyFn> = F &
  ToolOptionsMetadata & {
    _pipecatIsLlmTool: true;
  };

/**
 * Mark a method as a tool.
 *
 * On `LLMWorker` subclasses, decorated methods are automatically registered
 * with the LLM and included in `buildTools()`.
 *
 * This is the worker-flavored variant of `toolOptions`: it attaches the same
 * `cancelOnInterruption` / `timeoutSecs` call options and additionally marks
 * the method (with `_pipecatIsLlmTool`) so the worker collects it from the
 * prototype chain.
 *
 * Can be used with or without options, as a standard (TC39) method decorator
 * or as a plain function (runtimes that strip types do not run decorator
 * syntax):
 *
 * @example
 * class MyWorker extends LLMWorker {
 *   async my_tool(params: FunctionCallParams, arg: string) { ... }
 *   async my_other_tool(params: FunctionCallParams, arg: string) { ... }
 *   static {
 *     tool(this.prototype.my_tool);
 *     tool({ cancelOnInterruption: false, timeoutSecs: 60 })(this.prototype.my_other_tool);
 *   }
 * }
 */
export function tool<F extends AnyFn>(fn: F, context?: unknown): LLMTool<F>;
export function tool(
  options?: ToolDecoratorOptions,
): <F extends AnyFn>(fn: F, context?: unknown) => LLMTool<F>;
export function tool<F extends AnyFn>(
  fnOrOptions?: F | ToolDecoratorOptions,
  _context?: unknown,
): LLMTool<F> | (<G extends AnyFn>(fn: G, context?: unknown) => LLMTool<G>) {
  const options: ToolDecoratorOptions =
    typeof fnOrOptions === "function" ? {} : ((fnOrOptions as ToolDecoratorOptions) ?? {});
  const cancelOnInterruption = options.cancelOnInterruption ?? true;
  const timeoutSecs = options.timeoutSecs ?? null;

  const decorator = <G extends AnyFn>(fn: G, _ctx?: unknown): LLMTool<G> => {
    const decorated = toolOptions(fn, { cancelOnInterruption, timeoutSecs }) as LLMTool<G>;
    decorated._pipecatIsLlmTool = true;
    return decorated;
  };

  if (typeof fnOrOptions === "function") {
    return decorator(fnOrOptions as F);
  }
  return decorator;
}

/**
 * Collect all `tool` decorated methods from an object.
 *
 * Walks the prototype chain so that overridden methods in subclasses take
 * precedence over base-class definitions.
 *
 * DIVERGENCE: returns the unbound methods (see the module notes).
 */
export function _collectTools(obj: object): LLMTool[] {
  const seen = new Set<string>();
  const tools: LLMTool[] = [];
  let proto: object | null = Object.getPrototypeOf(obj);
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      // Skip accessors so collecting never runs a getter.
      const val = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof val === "function" && val._pipecatIsLlmTool === true) {
        tools.push(val as LLMTool);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return tools;
}
