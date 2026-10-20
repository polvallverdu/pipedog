// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/adapters/tools_schema_adapter.py

/** Type adapter for ToolsSchema serialization. */

import { type DeserializeFunc, type SerializeFunc, TypeAdapter } from "./base.ts";
import { FunctionSchema } from "../../adapters/schemas/function_schema.ts";
import {
  AdapterType,
  type CustomTools,
  ToolsSchema,
} from "../../adapters/schemas/tools_schema.ts";
import type { Ctor } from "../../utils/mixin.ts";

const ADAPTER_TYPES: readonly string[] = Object.values(AdapterType);

/** Python's `AdapterType(value)`: the adapter type with this value, or a ValueError. */
function toAdapterType(value: string): AdapterType {
  if (!ADAPTER_TYPES.includes(value)) {
    throw new Error(`'${value}' is not a valid AdapterType`);
  }
  return value as AdapterType;
}

/** Serialize and deserialize `ToolsSchema` instances for network transport. */
export class ToolsSchemaAdapter extends TypeAdapter {
  /**
   * Serialize a `ToolsSchema` to a JSON-compatible dict.
   *
   * @param obj A `ToolsSchema` instance.
   * @param _serializeValue Callback to recursively serialize nested values.
   * @returns A dict with a `standard_tools` list and, if present, a
   *   `custom_tools` mapping.
   */
  serialize(obj: unknown, _serializeValue: SerializeFunc): Record<string, unknown> {
    const schema = obj as ToolsSchema;
    const result: Record<string, unknown> = {
      standard_tools: schema.standardTools.map((tool) => tool.toDefaultDict()),
    };
    const customTools = schema.customTools;
    if (customTools && Object.keys(customTools).length > 0) {
      // AdapterType values are the wire keys already.
      result.custom_tools = { ...customTools };
    }
    return result;
  }

  /**
   * Reconstruct a `ToolsSchema` from a serialized dict.
   *
   * @param data A dict produced by `serialize()`.
   * @param _deserializeValue Callback to recursively deserialize nested values.
   * @param _targetType Unused. `ToolsSchema` is always the target.
   * @returns A new `ToolsSchema` instance, including `customTools` if present
   *   in `data`.
   */
  deserialize(
    data: Record<string, unknown>,
    _deserializeValue: DeserializeFunc,
    _targetType: Ctor | null = null,
  ): unknown {
    const tools: FunctionSchema[] = [];
    for (const item of data.standard_tools as Record<string, unknown>[]) {
      const params = (item.parameters ?? {}) as Record<string, unknown>;
      tools.push(
        new FunctionSchema({
          name: item.name as string,
          description: (item.description ?? "") as string,
          properties: (params.properties ?? {}) as Record<string, unknown>,
          required: (params.required ?? []) as string[],
        }),
      );
    }
    let customTools: CustomTools | null = null;
    if ("custom_tools" in data) {
      customTools = {};
      for (const [key, value] of Object.entries(data.custom_tools as Record<string, unknown>)) {
        customTools[toAdapterType(key)] = value as Record<string, unknown>[];
      }
    }
    return new ToolsSchema({ standardTools: tools, customTools });
  }
}
