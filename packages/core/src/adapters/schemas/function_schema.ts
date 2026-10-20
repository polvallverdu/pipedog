// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/schemas/function_schema.py

/**
 * Function schema utilities for AI tool definitions.
 *
 * Provides standardized function schema representation for defining tools and
 * functions used with AI models, ensuring consistent formatting across
 * different AI service providers.
 */

import type { FunctionCallHandler } from "../../services/llm_service.ts";

export interface FunctionSchemaOptions {
  /** Name of the function to be called. */
  name: string;
  /** Description of what the function does. */
  description: string;
  /** Object defining parameter types, descriptions, and constraints. */
  properties: Record<string, unknown>;
  /** List of property names that are required parameters. */
  required: string[];
  /**
   * Optional handler for this function. When provided, the LLM service
   * registers it automatically wherever the schema is advertised in the
   * `LLMContext`, making a separate `registerFunction` call unnecessary. Wrap
   * the handler with `toolOptions` to override its default call options
   * (`cancelOnInterruption`, `timeoutSecs`).
   */
  handler?: FunctionCallHandler | null;
}

/**
 * Standardized function schema representation for tool definition.
 *
 * Provides a structured way to define function tools used with AI models like
 * OpenAI. This schema defines the function's name, description, parameter
 * properties, and required parameters, following specifications required by
 * AI service providers.
 *
 * A schema may also carry the `handler` that runs when the function is
 * called. When set, the LLM service registers it automatically for any
 * `LLMContext` that advertises the schema, so no separate `registerFunction`
 * call is needed.
 */
export class FunctionSchema {
  protected _name: string;
  protected _description: string;
  protected _properties: Record<string, unknown>;
  protected _required: string[];
  protected _handler: FunctionCallHandler | null;

  constructor(options: FunctionSchemaOptions) {
    this._name = options.name;
    this._description = options.description;
    this._properties = options.properties;
    this._required = options.required;
    this._handler = options.handler ?? null;
  }

  /**
   * Converts the function schema to a plain object.
   *
   * @returns Object representation of the function schema.
   */
  toDefaultDict(): Record<string, unknown> {
    return {
      name: this._name,
      description: this._description,
      parameters: {
        type: "object",
        properties: this._properties,
        required: this._required,
      },
    };
  }

  /** The function name. */
  get name(): string {
    return this._name;
  }

  /** The function description. */
  get description(): string {
    return this._description;
  }

  /** Object of parameter specifications. */
  get properties(): Record<string, unknown> {
    return this._properties;
  }

  /** List of required parameter names. */
  get required(): string[] {
    return this._required;
  }

  /**
   * The handler for this function, or `null` if it's provided separately,
   * through `registerFunction`.
   */
  get handler(): FunctionCallHandler | null {
    return this._handler;
  }
}
