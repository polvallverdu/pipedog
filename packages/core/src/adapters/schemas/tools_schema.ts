// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/schemas/tools_schema.py

/**
 * Tools schema definitions for function calling adapters.
 *
 * Provides schemas for managing both standardized function tools and custom
 * adapter-specific tools in the Pipecat framework.
 */

import { type DirectFunction, DirectFunctionWrapper } from "./direct_function.ts";
import { FunctionSchema } from "./function_schema.ts";

/**
 * Supported adapter types for custom tools.
 *
 * - GEMINI: Google Gemini adapter.
 * - OPENAI: OpenAI adapter (Chat Completions, Responses, and Realtime API).
 */
export const AdapterType = {
  GEMINI: "gemini",
  OPENAI: "openai",
} as const;
export type AdapterType = (typeof AdapterType)[keyof typeof AdapterType];

/** Custom tool definitions keyed by adapter type. */
export type CustomTools = Partial<Record<AdapterType, Record<string, unknown>[]>>;

export interface ToolsSchemaOptions {
  /** List of tools following the standardized FunctionSchema format (or direct functions). */
  standardTools: readonly (FunctionSchema | DirectFunction)[];
  /**
   * Object mapping adapter types to their custom tool definitions. These
   * tools may not follow the FunctionSchema format (e.g., search_tool).
   */
  customTools?: CustomTools | null;
}

/**
 * Schema for managing both standard and custom function calling tools.
 *
 * Provides a unified interface for handling standardized function schemas
 * alongside custom tools that may not follow the standard format, such as
 * adapter-specific search tools.
 */
export class ToolsSchema {
  protected _standardTools: FunctionSchema[];
  protected _directFunctions: DirectFunctionWrapper[];
  protected _customTools: CustomTools | null;

  constructor(options: ToolsSchemaOptions) {
    const mapStandardTools = (
      tools: readonly (FunctionSchema | DirectFunction)[],
    ): [FunctionSchema[], DirectFunctionWrapper[]] => {
      const schemas: FunctionSchema[] = [];
      const directFunctions: DirectFunctionWrapper[] = [];
      for (const tool of tools) {
        if (tool instanceof FunctionSchema) {
          schemas.push(tool);
        } else if (typeof tool === "function") {
          const wrapper = new DirectFunctionWrapper(tool);
          schemas.push(wrapper.toFunctionSchema());
          directFunctions.push(wrapper);
        } else {
          throw new TypeError(`Unsupported tool type: ${typeof tool}`);
        }
      }
      return [schemas, directFunctions];
    };

    [this._standardTools, this._directFunctions] = mapStandardTools(options.standardTools);
    this._customTools = options.customTools ?? null;
  }

  /** The list of tools following the FunctionSchema format. */
  get standardTools(): FunctionSchema[] {
    return this._standardTools;
  }

  /**
   * The wrappers for standard tools that were given as direct functions.
   *
   * These retain a reference to the original function, allowing the LLM
   * service to register their handlers automatically. Standard tools given as
   * `FunctionSchema` objects (advertise-only) are not included.
   */
  get directFunctions(): DirectFunctionWrapper[] {
    return this._directFunctions;
  }

  /** Object mapping adapter types to their custom tool definitions. */
  get customTools(): CustomTools | null {
    return this._customTools;
  }

  set customTools(value: CustomTools | null) {
    this._customTools = value;
  }
}
