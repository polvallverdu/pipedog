// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/adapters/base.py

/** Abstract base class for type adapters used by message serializers. */

import type { Ctor } from "../../utils/mixin.ts";

export type SerializeFunc = (value: unknown) => unknown;
export type DeserializeFunc = (value: unknown) => unknown;

/**
 * Serialize and deserialize instances of a specific type for network transport.
 *
 * Each adapter handles one or more types, converting them to/from a
 * JSON-compatible dict. Register adapters on a `JSONMessageSerializer` to
 * handle non-JSON-native field values (e.g. `LLMContext`, `ToolsSchema`).
 *
 * Adapters receive `serializeValue` and `deserializeValue` callbacks from the
 * serializer so they can recursively serialize nested fields without
 * importing the serializer itself.
 */
export abstract class TypeAdapter {
  /**
   * Convert an object to a JSON-compatible dict.
   *
   * @param obj The object to serialize.
   * @param serializeValue Callback to recursively serialize nested values.
   * @returns A dict representation of the object.
   */
  abstract serialize(obj: unknown, serializeValue: SerializeFunc): Record<string, unknown>;

  /**
   * Reconstruct an object from a dict.
   *
   * @param data The dict representation produced by `serialize()`.
   * @param deserializeValue Callback to recursively deserialize nested values.
   * @param targetType The resolved target class. Defaults to null.
   * @returns The reconstructed object.
   */
  abstract deserialize(
    data: Record<string, unknown>,
    deserializeValue: DeserializeFunc,
    targetType?: Ctor | null,
  ): unknown;
}
