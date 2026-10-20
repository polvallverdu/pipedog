// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/adapters/llm_context_adapter.py

/** Type adapter for LLMContext serialization. */

import { type DeserializeFunc, type SerializeFunc, TypeAdapter } from "./base.ts";
import { ToolsSchemaAdapter } from "./tools_schema_adapter.ts";
import type { ToolsSchema } from "../../adapters/schemas/tools_schema.ts";
import {
  LLMContext,
  type LLMContextMessage,
  type LLMContextToolChoice,
  LLMSpecificMessage,
  NOT_GIVEN,
} from "../../processors/aggregators/llm_context.ts";
import type { Ctor } from "../../utils/mixin.ts";
import { isGiven } from "../../utils/types.ts";

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize and deserialize `LLMContext` instances.
 *
 * The `NOT_GIVEN` sentinel is preserved across serialization: missing keys
 * are restored as `NOT_GIVEN` on deserialization.
 */
export class LLMContextAdapter extends TypeAdapter {
  protected _toolsSchemaAdapter = new ToolsSchemaAdapter();

  /**
   * Serialize an `LLMContext` to a JSON-compatible dict.
   *
   * @param obj An `LLMContext` instance.
   * @param serializeValue Callback to recursively serialize nested values.
   * @returns A dict with `messages` and, optionally, `tools` and
   *   `tool_choice` keys.
   */
  serialize(obj: unknown, serializeValue: SerializeFunc): Record<string, unknown> {
    const context = obj as LLMContext;
    const result: Record<string, unknown> = {
      messages: context.messages.map((m) => this._serializeMessage(m, serializeValue)),
    };
    if (isGiven(context.tools)) {
      result.tools = this._toolsSchemaAdapter.serialize(context.tools, serializeValue);
    }
    if (isGiven(context.toolChoice)) {
      result.tool_choice = serializeValue(context.toolChoice);
    }
    return result;
  }

  /**
   * Reconstruct an `LLMContext` from a serialized dict.
   *
   * Missing `tools` and `tool_choice` keys are restored as `NOT_GIVEN`.
   *
   * @param data A dict produced by `serialize()`.
   * @param deserializeValue Callback to recursively deserialize nested values.
   * @param _targetType Unused. `LLMContext` is always the target.
   * @returns A new `LLMContext` instance.
   */
  deserialize(
    data: Record<string, unknown>,
    deserializeValue: DeserializeFunc,
    _targetType: Ctor | null = null,
  ): unknown {
    const messages = (data.messages as unknown[]).map((m) =>
      this._deserializeMessage(m, deserializeValue),
    );
    const tools =
      "tools" in data
        ? (this._toolsSchemaAdapter.deserialize(
            data.tools as Record<string, unknown>,
            deserializeValue,
          ) as ToolsSchema)
        : NOT_GIVEN;
    const toolChoice =
      "tool_choice" in data
        ? (deserializeValue(data.tool_choice) as LLMContextToolChoice)
        : NOT_GIVEN;
    return new LLMContext({ messages, tools, toolChoice });
  }

  protected _serializeMessage(msg: unknown, serializeValue: SerializeFunc): unknown {
    if (msg instanceof LLMSpecificMessage) {
      return {
        __specific__: true,
        llm: msg.llm,
        message: serializeValue(msg.message),
      };
    }
    return serializeValue(msg);
  }

  protected _deserializeMessage(
    data: unknown,
    deserializeValue: DeserializeFunc,
  ): LLMContextMessage {
    if (isDict(data) && data.__specific__) {
      return new LLMSpecificMessage({
        llm: data.llm as string,
        message: deserializeValue(data.message),
      });
    }
    return deserializeValue(data) as LLMContextMessage;
  }
}
