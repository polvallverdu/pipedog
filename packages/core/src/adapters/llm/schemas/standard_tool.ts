// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Typed tools from Standard Schema (https://standardschema.dev).
 *
 * pipedog-only: Pipecat has no equivalent. `defineTool` takes a schema object
 * from any Standard Schema library (Zod, Valibot, ArkType, ...) and returns a
 * regular `FunctionSchema` that carries a handler. The schema gives the JSON
 * schema the LLM sees, the type of the handler's `args`, and the validation of
 * the arguments the LLM sends.
 *
 * Nothing existing changes: the result is a `FunctionSchema`, so it goes into
 * a `ToolsSchema` (and is registered automatically by the LLM service) like
 * any other, for every provider adapter.
 *
 * @example
 * const getWeather = defineTool({
 *   name: "get_weather",
 *   description: "Get the current weather for a location.",
 *   parameters: z.object({ location: z.string(), unit: z.enum(["c", "f"]).default("c") }),
 *   handler: async ({ location, unit }) => ({ temperature: 21, unit }),
 * });
 * const context = new LLMContext({ tools: new ToolsSchema({ standardTools: [getWeather] }) });
 */

import type {
  FunctionCallHandler,
  FunctionCallParams,
  LLMService,
} from "../../../services/llm_service.ts";
import { logger } from "../../../utils/logger.ts";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "../../../utils/standard_schema.ts";
import { type ToolOptions, toolOptions } from "./direct_function.ts";
import { FunctionSchema } from "./function_schema.ts";

type JsonObject = Record<string, unknown>;

/** A schema usable as tool parameters: validates, and describes an object. */
export type ToolParametersSchema = StandardSchemaV1<any, Record<string, any>>;

export interface DefineToolOptions<S extends ToolParametersSchema> extends ToolOptions {
  /** Name of the function the LLM calls. */
  name: string;
  /** What the function does; the LLM reads it. */
  description: string;
  /** A Standard Schema describing the arguments, e.g. `z.object({...})`. */
  parameters: S;
  /**
   * The parameters' JSON schema, when the schema doesn't provide one itself
   * (`~standard.jsonSchema`), or to override it: an object, or a converter
   * called with `parameters` (e.g. `(s) => toJsonSchema(s)`).
   */
  jsonSchema?: JsonObject | ((schema: S) => JsonObject);
  /** JSON Schema dialect requested from the schema. Defaults to `draft-07`. */
  target?: StandardJSONSchemaV1.Target;
  /**
   * Runs with the validated, typed arguments. Its return value is sent to the
   * LLM as the function result, unless the handler already reported one
   * through `params.resultCallback`.
   */
  handler: (args: StandardSchemaV1.InferOutput<S>, params: FunctionCallParams) => unknown;
}

/** A `FunctionSchema` whose handler is set. */
export type ToolDefinition = FunctionSchema & { readonly handler: FunctionCallHandler };

function hasJsonSchema(schema: unknown): schema is StandardJSONSchemaV1 {
  const std = (schema as { "~standard"?: { jsonSchema?: { input?: unknown } } } | null)?.[
    "~standard"
  ];
  return typeof std?.jsonSchema?.input === "function";
}

/**
 * Inline `$ref`s into `#/$defs/*` / `#/definitions/*`, since the tool formats
 * take only `properties` and `required`. Recursive schemas can't be inlined
 * and are rejected.
 */
function inlineRefs(root: JsonObject, name: string): JsonObject {
  const defs = {
    ...(root.$defs as JsonObject | undefined),
    ...(root.definitions as JsonObject | undefined),
  };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (node === null || typeof node !== "object") return node;
    const obj = node as JsonObject;
    if (typeof obj.$ref === "string") {
      const key = obj.$ref.replace(/^#\/(\$defs|definitions)\//, "");
      const target = defs[key];
      if (key === obj.$ref || target === undefined) {
        throw new Error(
          `Tool '${name}': unresolvable $ref '${obj.$ref}' in the parameters schema.`,
        );
      }
      if (stack.includes(key)) {
        throw new Error(`Tool '${name}': recursive parameters schemas can't be sent to an LLM.`);
      }
      const { $ref: _ref, ...siblings } = obj;
      return {
        ...(walk(target, [...stack, key]) as JsonObject),
        ...(walk(siblings, stack) as JsonObject),
      };
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$defs" || k === "definitions") continue;
      out[k] = walk(v, stack);
    }
    return out;
  };
  return walk(root, []) as JsonObject;
}

/**
 * The JSON schema for a tool's parameters: the explicit `jsonSchema`, else the
 * schema's own `~standard.jsonSchema.input()` (Standard JSON Schema), else an
 * error that says how to provide one.
 */
function parametersJsonSchema<S extends ToolParametersSchema>(
  options: DefineToolOptions<S>,
): JsonObject {
  const { name, parameters, jsonSchema, target = "draft-07" } = options;
  let raw: JsonObject;
  if (typeof jsonSchema === "function") raw = jsonSchema(parameters);
  else if (jsonSchema !== undefined) raw = jsonSchema;
  else if (hasJsonSchema(parameters)) {
    // The LLM supplies the input side (before defaults and transforms).
    raw = parameters["~standard"].jsonSchema.input({ target });
  } else {
    throw new Error(
      `Tool '${name}': the ${parameters["~standard"].vendor} schema doesn't implement Standard JSON Schema. ` +
        "Pass `jsonSchema` (an object, or a converter function) to defineTool.",
    );
  }
  const schema = inlineRefs(raw, name);
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error(
      `Tool '${name}': parameters must be an object schema, got type '${String(schema.type)}'.`,
    );
  }
  return schema;
}

function formatPath(path: StandardSchemaV1.Issue["path"]): string | null {
  if (!path || path.length === 0) return null;
  return path
    .map((seg) => String(typeof seg === "object" ? (seg as { key: PropertyKey }).key : seg))
    .join(".");
}

/**
 * Define a tool from a Standard Schema.
 *
 * Returns a `FunctionSchema` (name, description, and the properties/required
 * from the schema's JSON schema) that carries the handler. Put it in a
 * `ToolsSchema` and the LLM service registers it; or use `registerTools`.
 *
 * Arguments are validated before the handler runs. If they are invalid the
 * handler is not called: a warning is logged and the issues are returned to
 * the LLM as the function result, so it can retry with corrected arguments.
 *
 * The JSON schema comes from `~standard.jsonSchema` (Standard JSON Schema) when
 * the schema has it, else from `jsonSchema`. `FunctionSchema` models only
 * `properties` and `required`, so other top-level keywords
 * (`additionalProperties`, `$schema`) are not sent.
 *
 * @throws Error when no JSON schema is available or it isn't an object schema.
 */
export function defineTool<S extends ToolParametersSchema>(
  options: DefineToolOptions<S>,
): ToolDefinition {
  const { name, parameters, handler } = options;
  const schema = parametersJsonSchema(options);

  const run: FunctionCallHandler = async (params) => {
    const result = await parameters["~standard"].validate(params.arguments);
    if (result.issues) {
      const issues = result.issues.map((i) => ({ message: i.message, path: formatPath(i.path) }));
      logger.warning(
        `Tool '${name}' called with invalid arguments, handler not run: ${issues
          .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
          .join("; ")}`,
      );
      await params.resultCallback({
        error: "Invalid arguments. Fix the issues and call the function again.",
        issues,
      });
      return;
    }

    // The handler may report through resultCallback itself (a final result
    // with properties, say); otherwise its return value is the result.
    let reported = false;
    const wrapped = Object.create(params) as FunctionCallParams;
    wrapped.resultCallback = async (value, opts) => {
      if (opts?.properties?.isFinal !== false) reported = true;
      await params.resultCallback(value, opts);
    };
    const value = await handler(result.value, wrapped);
    if (!reported) await params.resultCallback(value ?? null);
  };

  const hasOptions =
    options.cancelOnInterruption !== undefined ||
    options.timeoutSecs !== undefined ||
    options.cancellableByLlm !== undefined;

  return new FunctionSchema({
    name,
    description: options.description,
    properties: (schema.properties as JsonObject | undefined) ?? {},
    required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
    handler: hasOptions
      ? toolOptions(run, {
          cancelOnInterruption: options.cancelOnInterruption,
          timeoutSecs: options.timeoutSecs,
          cancellableByLlm: options.cancellableByLlm,
        })
      : run,
  }) as ToolDefinition;
}

/**
 * Register tools on an LLM service explicitly, with `registerFunction`. Not
 * needed when the tools are advertised in a `ToolsSchema`, which registers
 * them automatically.
 */
export function registerTools(llm: LLMService<any>, tools: readonly ToolDefinition[]): void {
  for (const t of tools) llm.registerFunction(t.name, t.handler);
}
