// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/serializers/json.py

/**
 * JSON-based bus message serializer with pluggable type adapters.
 *
 * PORTING NOTES (the wire format is upstream's, so TS and Python workers can
 * share a network bus):
 *
 * - Python tags a typed value with its fully qualified class name
 *   (`"pipecat.frames.frames.TextFrame"`) and resolves it back with
 *   `importlib`. JavaScript has neither module names on classes nor dynamic
 *   synchronous imports, so classes are resolved through a registry
 *   (`registerSerializableType()`). Every class exported by
 *   `frames/frames.ts`, `bus/messages.ts` and `bus/ui/messages.ts` is
 *   registered under its upstream name, along with the other Pipecat types
 *   bus messages carry. An instance of an unregistered class is skipped with
 *   the "unserializable type" warning.
 * - Dataclass field names travel in snake_case, as upstream sends them;
 *   class fields are camelCase in TS and are converted both ways. Keys of
 *   plain dicts are sent unchanged.
 * - `as const` enums are plain values in TS, so a value can't say which enum
 *   it belongs to. Fields holding a (non-string) upstream `Enum` are declared
 *   with `registerEnumField()` so they are tagged as upstream tags them
 *   (`BusFrameMessage.direction` is declared by default). Class-based enums
 *   (`ErrorCategory`) are recognized on their own. `StrEnum` values are plain
 *   strings on both sides.
 * - Pydantic models and dataclasses are both plain classes in TS and are
 *   serialized the same way (fields set to null are left out).
 * - On deserialization the decoded fields are passed to the class's options
 *   constructor and then assigned to the instance, which covers upstream's
 *   `init=False` fields.
 */

import { FunctionSchema } from "../../adapters/llm/schemas/function_schema.ts";
import { ToolsSchema } from "../../adapters/llm/schemas/tools_schema.ts";
import * as frames from "../../frames/frames.ts";
import * as metrics from "../../metrics/metrics.ts";
import { LLMContext, LLMSpecificMessage } from "../../processors/aggregators/llm_context.ts";
import { FrameDirection } from "../../processors/frame_processor.ts";
import * as registryTypes from "../../registry/types.ts";
import { base64ToBytes, bytesToBase64 } from "../../utils/base64.ts";
import { ErrorCategory } from "../../utils/errors.ts";
import { logger } from "../../utils/logger.ts";
import type { Ctor } from "../../utils/mixin.ts";
import type { TypeAdapter } from "../adapters/base.ts";
import { LLMContextAdapter, ToolsSchemaAdapter } from "../adapters/index.ts";
import * as messages from "../messages.ts";
import { BusFrameMessage, type BusMessage } from "../messages.ts";
import * as uiMessages from "../ui/messages.ts";
import { MessageSerializer } from "./base.ts";

/** An `as const` enum object: member names mapped to their values. */
export type EnumObject = Readonly<Record<string, unknown>>;

/** A type the serializer can name on the wire: a class or an `as const` enum. */
export type SerializableType = Ctor | EnumObject;

// Upstream's `_resolve_type` resolves any importable name; here, the registry.
const typesByName = new Map<string, SerializableType>();
const namesByType = new Map<SerializableType, string>();
// Fields that hold a value of an `as const` enum, by the class declaring them.
const enumFields = new Map<Ctor, Map<string, EnumObject>>();

/**
 * Register a type under its fully qualified (upstream) name, so it can be
 * tagged on serialization and resolved on deserialization.
 *
 * @param qualifiedName Dotted path like `"pipecat.frames.frames.TextFrame"`.
 * @param type The class, or the `as const` enum object.
 */
export function registerSerializableType(qualifiedName: string, type: SerializableType): void {
  typesByName.set(qualifiedName, type);
  namesByType.set(type, qualifiedName);
}

/**
 * Declare that a class field holds a value of an `as const` enum, so the
 * value is tagged with the enum's name as upstream tags an `Enum` member.
 * The enum must be registered with `registerSerializableType()`.
 *
 * @param type The class declaring the field (subclasses inherit it).
 * @param field The field's (camelCase) name.
 * @param enumType The enum object.
 */
export function registerEnumField(type: Ctor, field: string, enumType: EnumObject): void {
  let fields = enumFields.get(type);
  if (!fields) {
    fields = new Map();
    enumFields.set(type, fields);
  }
  fields.set(field, enumType);
}

function isClass(value: unknown): value is Ctor {
  return typeof value === "function" && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function registerModule(prefix: string, namespace: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(namespace)) {
    if (isClass(value) && !namesByType.has(value)) {
      registerSerializableType(`${prefix}.${name}`, value);
    }
  }
}

let defaultsRegistered = false;

function registerDefaultTypes(): void {
  if (defaultsRegistered) {
    return;
  }
  defaultsRegistered = true;
  registerModule("pipecat.frames.frames", frames as unknown as Record<string, unknown>);
  registerModule("pipecat.bus.messages", messages as unknown as Record<string, unknown>);
  registerModule("pipecat.bus.ui.messages", uiMessages as unknown as Record<string, unknown>);
  registerModule("pipecat.metrics.metrics", metrics as unknown as Record<string, unknown>);
  registerModule("pipecat.registry.types", registryTypes as unknown as Record<string, unknown>);
  registerSerializableType("pipecat.processors.aggregators.llm_context.LLMContext", LLMContext);
  registerSerializableType(
    "pipecat.processors.aggregators.llm_context.LLMSpecificMessage",
    LLMSpecificMessage,
  );
  registerSerializableType("pipecat.adapters.llm.schemas.tools_schema.ToolsSchema", ToolsSchema);
  registerSerializableType(
    "pipecat.adapters.llm.schemas.function_schema.FunctionSchema",
    FunctionSchema,
  );
  registerSerializableType("pipecat.processors.frame_processor.FrameDirection", FrameDirection);
  // ErrorCategory has a private constructor, so it is not a `Ctor` to the type checker.
  registerSerializableType(
    "pipecat.utils.errors.ErrorCategory",
    ErrorCategory as unknown as SerializableType,
  );
  registerEnumField(BusFrameMessage, "direction", FrameDirection);
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function snakeToCamel(name: string): string {
  return name.replace(/([a-z0-9])_([a-z0-9])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

function isJsonNative(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A class-based enum (static members with `name`, plus `values()` and `fromValue()`). */
function isClassEnum(type: unknown): boolean {
  const ctor = type as { values?: unknown; fromValue?: unknown };
  return typeof ctor?.values === "function" && typeof ctor?.fromValue === "function";
}

/** The `as const` enum declared for `field` on `type` or one of its bases. */
function enumFieldType(type: Ctor, field: string): EnumObject | undefined {
  let proto: object | null = type.prototype;
  while (proto && proto !== Object.prototype) {
    const found = enumFields.get(proto.constructor as Ctor)?.get(field);
    if (found) {
      return found;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

/**
 * Serialize bus messages as JSON with pluggable type adapters.
 *
 * Handles JSON-native types, enums, bytes, dataclasses, and any type with a
 * registered `TypeAdapter` (e.g. `LLMContext`, `ToolsSchema`). Adapters for
 * common Pipecat types are registered by default. Additional type adapters
 * can be registered via `registerAdapter()`.
 *
 * @example
 * const serializer = new JSONMessageSerializer();
 *
 * const data = serializer.serialize(message);
 * const restored = serializer.deserialize(data);
 */
export class JSONMessageSerializer extends MessageSerializer {
  protected _adapters: Map<Ctor, TypeAdapter>;

  /** Create a serializer with default adapters for `LLMContext` and `ToolsSchema`. */
  constructor() {
    super();
    registerDefaultTypes();
    this._adapters = new Map<Ctor, TypeAdapter>([
      [LLMContext, new LLMContextAdapter()],
      [ToolsSchema, new ToolsSchemaAdapter()],
    ]);
  }

  /**
   * Register a type adapter.
   *
   * @param type The type to handle.
   * @param adapter The adapter that serializes/deserializes instances of this type.
   */
  registerAdapter(type: Ctor, adapter: TypeAdapter): void {
    this._adapters.set(type, adapter);
  }

  /**
   * Convert a bus message to JSON bytes.
   *
   * @param message The bus message to serialize.
   * @returns UTF-8 encoded JSON bytes.
   */
  serialize(message: BusMessage): Uint8Array {
    const data = this._serializeValue(message);
    return new TextEncoder().encode(JSON.stringify(data));
  }

  /**
   * Reconstruct a bus message from JSON bytes.
   *
   * @param data The JSON bytes produced by `serialize()`.
   * @returns The reconstructed `BusMessage`, or null if deserialization fails.
   */
  deserialize(data: Uint8Array | string): BusMessage | null {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const payload = JSON.parse(text);
    return this._deserializeValue(payload) as BusMessage | null;
  }

  /** Recursively serialize a value to a JSON-compatible representation. */
  protected _serializeValue(value: unknown): unknown {
    if (isJsonNative(value)) {
      return value ?? null;
    }
    if (isClassEnum((value as object).constructor)) {
      const name = namesByType.get((value as object).constructor as Ctor);
      if (name !== undefined) {
        return { __type__: name, __data__: (value as { name: string }).name };
      }
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this._serializeValue(v)]),
      );
    }
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()].map(([k, v]) => [String(k), this._serializeValue(v)]),
      );
    }
    if (Array.isArray(value)) {
      return value.map((v) => this._serializeValue(v));
    }
    if (value instanceof Uint8Array) {
      return { __type__: "bytes", __data__: bytesToBase64(value) };
    }
    if (typeof value === "function") {
      return null;
    }
    const type = (value as object).constructor as Ctor;
    const typeName = namesByType.get(type);
    const adapter = this._findAdapter(type);
    if (adapter !== null && typeName !== undefined) {
      return {
        __type__: typeName,
        __data__: adapter.serialize(value, (v: unknown) => this._serializeValue(v)),
      };
    }
    if (typeof value === "object" && typeName !== undefined) {
      const fields: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === null || v === undefined) {
          continue;
        }
        const enumType = enumFieldType(type, key);
        const serialized = enumType ? this._serializeEnum(enumType, v) : this._serializeValue(v);
        if (serialized !== null) {
          fields[camelToSnake(key)] = serialized;
        }
      }
      return { __type__: typeName, __data__: fields };
    }
    logger.warning(
      `JSONMessageSerializer: skipping field with unserializable type ${type?.name ?? typeof value}`,
    );
    return null;
  }

  /** Tag a value of an `as const` enum with its member name. */
  protected _serializeEnum(enumType: EnumObject, value: unknown): unknown {
    const typeName = namesByType.get(enumType);
    const member = Object.entries(enumType).find(([, v]) => v === value)?.[0];
    if (typeName === undefined || member === undefined) {
      return this._serializeValue(value);
    }
    return { __type__: typeName, __data__: member };
  }

  /** Recursively deserialize a value from its JSON representation. */
  protected _deserializeValue(value: unknown): unknown {
    if (isJsonNative(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this._deserializeValue(v));
    }
    if (isPlainObject(value)) {
      if ("__type__" in value && "__data__" in value) {
        return this._deserializeTyped(value.__type__ as string, value.__data__);
      }
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this._deserializeValue(v)]),
      );
    }
    return value;
  }

  /** Deserialize a tagged value using its fully qualified type name. */
  protected _deserializeTyped(typeName: string, data: unknown): unknown {
    if (typeName === "bytes") {
      return base64ToBytes(data as string);
    }
    const type = resolveType(typeName);
    if (type === null) {
      logger.warning(`JSONMessageSerializer: could not resolve type ${typeName}`);
      return null;
    }
    if (!isClass(type)) {
      // An `as const` enum: look the member up by name.
      return enumMember(type, typeName, data as string);
    }
    if (isClassEnum(type)) {
      return enumMember(type as unknown as EnumObject, typeName, data as string);
    }
    const adapter = this._findAdapter(type);
    if (adapter !== null) {
      return adapter.deserialize(
        data as Record<string, unknown>,
        (v: unknown) => this._deserializeValue(v),
        type,
      );
    }
    if (isPlainObject(data)) {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        fields[snakeToCamel(key)] = this._deserializeValue(value);
      }
      const Concrete = type as unknown as new (options: Record<string, unknown>) => object;
      const obj = new Concrete({ ...fields }) as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        obj[key] = value;
      }
      return obj;
    }
    logger.warning(`JSONMessageSerializer: no adapter registered for type ${typeName}`);
    return null;
  }

  /** Find an adapter for a type, checking parent classes through the prototype chain. */
  protected _findAdapter(type: Ctor): TypeAdapter | null {
    let proto: object | null = type?.prototype ?? null;
    while (proto && proto !== Object.prototype) {
      const adapter = this._adapters.get(proto.constructor as Ctor);
      if (adapter) {
        return adapter;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
}

/** The enum member called `name`, as Python's `cls[name]` (which raises KeyError). */
function enumMember(type: EnumObject, typeName: string, name: string): unknown {
  if (!Object.hasOwn(type, name)) {
    throw new Error(`${typeName} has no member '${name}'`);
  }
  return type[name];
}

/**
 * Resolve a fully qualified type name to its class.
 *
 * @param qualifiedName Dotted path like `"pipecat.frames.frames.TextFrame"`.
 * @returns The resolved class (or enum), or null if it cannot be found.
 */
function resolveType(qualifiedName: string): SerializableType | null {
  const index = qualifiedName.lastIndexOf(".");
  if (index <= 0) {
    return null;
  }
  return typesByName.get(qualifiedName) ?? null;
}
