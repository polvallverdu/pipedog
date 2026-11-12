// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Tests for `defineTool`: typed tools from Standard Schema (pipedog-only). */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";

import { defineTool, registerTools } from "../src/adapters/llm/schemas/standard_tool.ts";
import { ToolsSchema } from "../src/adapters/llm/schemas/tools_schema.ts";
import { OpenAILLMAdapter } from "../src/adapters/llm/services/open_ai_adapter.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import { FunctionCallFromLLM, FunctionCallResultFrame } from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { FrameProcessorSetup } from "../src/processors/frame_processor.ts";
import { LLMService } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import type { BaseTaskManager } from "../src/utils/asyncio/task_manager.ts";
import { logger } from "../src/utils/logger.ts";

/** An LLM service test double. */
class FakeLLMService extends LLMService {
  constructor() {
    super({
      settings: new LLMSettings({
        model: "test-model",
        systemInstruction: null,
        temperature: null,
        maxTokens: null,
        topP: null,
        topK: null,
        frequencyPenalty: null,
        presencePenalty: null,
        seed: null,
        filterIncompleteUserTurns: null,
        userTurnCompletionConfig: null,
      }),
    });
    this._setup = new FrameProcessorSetup({
      clock: new SystemClock(),
      pipelineWorker: { appResources: null, workerRunner: null } as any,
      taskManager: null as unknown as BaseTaskManager,
    });
  }
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
});

function harness() {
  const service = new FakeLLMService();
  const internals = service as any;
  internals._callEventHandler = mock(async () => {});
  const runInline = async (items: unknown[]) => {
    for (const item of items) await internals._runFunctionCall(item);
  };
  internals._runParallelFunctionCalls = runInline;
  internals._runSequentialFunctionCalls = runInline;
  const results: FunctionCallResultFrame[] = [];
  internals.broadcastFrame = async (cls: any, options?: any) => {
    if (cls === FunctionCallResultFrame) results.push(new cls(options));
  };
  const warnings: string[] = [];
  const w = spyOn(logger, "warning").mockImplementation((m: string) => {
    warnings.push(m);
  });
  restores.push(() => w.mockRestore());
  const run = (name: string, args: Record<string, unknown>, context = new LLMContext()) =>
    service.runFunctionCalls([
      new FunctionCallFromLLM({
        functionName: name,
        toolCallId: "call_1",
        arguments: args,
        context,
      }),
    ]);
  return { service, run, results, warnings };
}

const weatherParams = z.object({
  location: z.string().describe("City name"),
  unit: z.enum(["c", "f"]).default("c"),
});

describe("defineTool JSON schema", () => {
  test("zod: properties and required come from the schema", () => {
    const t = defineTool({
      name: "get_weather",
      description: "Weather.",
      parameters: weatherParams,
      handler: () => null,
    });
    expect(t.name).toBe("get_weather");
    expect(t.properties.location).toEqual({ type: "string", description: "City name" });
    expect((t.properties.unit as any).enum).toEqual(["c", "f"]);
    // The LLM supplies the input side: a defaulted field is optional.
    expect(t.required).toEqual(["location"]);
    expect(t.toDefaultDict().parameters).toMatchObject({ type: "object", required: ["location"] });
  });

  test("valibot via toStandardJsonSchema", () => {
    const t = defineTool({
      name: "add",
      description: "Add.",
      parameters: toStandardJsonSchema(v.object({ a: v.number(), b: v.optional(v.number()) })),
      handler: () => null,
    });
    expect(t.properties.a).toMatchObject({ type: "number" });
    expect(t.required).toEqual(["a"]);
  });

  test("arktype", () => {
    const t = defineTool({
      name: "add",
      description: "Add.",
      parameters: type({ a: "number", "b?": "string" }),
      handler: () => null,
    });
    expect(Object.keys(t.properties).sort()).toEqual(["a", "b"]);
    expect(t.required).toEqual(["a"]);
  });

  test("explicit jsonSchema object and converter function", () => {
    // A schema without ~standard.jsonSchema.
    const bare = v.object({ q: v.string() });
    expect(() =>
      defineTool({ name: "s", description: "", parameters: bare, handler: () => null }),
    ).toThrow(/Standard JSON Schema/);

    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const a = defineTool({
      name: "s",
      description: "",
      parameters: bare,
      jsonSchema: schema,
      handler: () => null,
    });
    expect(a.required).toEqual(["q"]);
    const b = defineTool({
      name: "s",
      description: "",
      parameters: bare,
      jsonSchema: () => schema,
      handler: () => null,
    });
    expect(b.properties).toEqual({ q: { type: "string" } });
  });

  test("$defs are inlined; recursion and non-objects are rejected", () => {
    const Addr = z.object({ city: z.string() });
    const t = defineTool({
      name: "s",
      description: "",
      parameters: z.object({ home: Addr, work: Addr }),
      handler: () => null,
    });
    expect(JSON.stringify(t.properties)).not.toContain("$ref");
    expect((t.properties.home as any).properties.city).toEqual({ type: "string" });

    const bare = v.object({});
    const withSchema = (root: object) => () =>
      defineTool({
        name: "s",
        description: "",
        parameters: bare,
        jsonSchema: root as any,
        handler: () => null,
      });
    expect(
      withSchema({
        type: "object",
        properties: { n: { $ref: "#/$defs/N" } },
        $defs: { N: { type: "object", properties: { n: { $ref: "#/$defs/N" } } } },
      }),
    ).toThrow(/recursive/);
    expect(withSchema({ type: "string" })).toThrow(/object schema/);
  });
});

describe("defineTool types", () => {
  test("handler args are inferred from the schema (output side)", () => {
    defineTool({
      name: "t",
      description: "",
      parameters: weatherParams,
      handler: (args) => {
        const location: string = args.location;
        const unit: "c" | "f" = args.unit; // defaulted: not optional
        // @ts-expect-error not in the schema
        void args.nope;
        return [location, unit];
      },
    });
    expect(true).toBe(true);
  });
});

describe("defineTool through an LLM service", () => {
  test("success: validated, typed args reach the handler; return value is the result", async () => {
    const { service, run, results, warnings } = harness();
    const handler = mock((args: { location: string; unit: "c" | "f" }) => ({ t: 21, args }));
    registerTools(service, [
      defineTool({ name: "get_weather", description: "W", parameters: weatherParams, handler }),
    ]);

    await run("get_weather", { location: "Paris" });
    // The default is applied by validation.
    expect(handler.mock.calls[0]?.[0]).toEqual({ location: "Paris", unit: "c" });
    expect(results.at(-1)?.result).toEqual({ t: 21, args: { location: "Paris", unit: "c" } });
    expect(warnings).toEqual([]);
  });

  test("failure: handler not called, issues go back to the LLM, a warning is logged", async () => {
    const { service, run, results, warnings } = harness();
    const handler = mock(() => "x");
    registerTools(service, [
      defineTool({ name: "get_weather", description: "W", parameters: weatherParams, handler }),
    ]);

    await run("get_weather", { unit: "k" });
    expect(handler).not.toHaveBeenCalled();
    const res = results.at(-1)?.result as {
      error: string;
      issues: { message: string; path: string | null }[];
    };
    expect(res.error).toContain("Invalid arguments");
    expect(res.issues.map((i) => i.path).sort()).toEqual(["location", "unit"]);
    expect(warnings.some((w) => w.includes("get_weather") && w.includes("invalid arguments"))).toBe(
      true,
    );
  });

  test("a handler that reports through resultCallback is not reported twice", async () => {
    const { service, run, results } = harness();
    registerTools(service, [
      defineTool({
        name: "t",
        description: "",
        parameters: z.object({}),
        handler: async (_a, params) => {
          await params.resultCallback("final");
          return "ignored";
        },
      }),
    ]);
    await run("t", {});
    expect(results.map((r) => r.result)).toEqual(["final"]);
  });

  test("a ToolsSchema carrying it registers it automatically, and adapters see the schema", async () => {
    const { service, run, results } = harness();
    const tool = defineTool({
      name: "get_weather",
      description: "W",
      parameters: weatherParams,
      handler: ({ location }) => `sunny in ${location}`,
    });
    const slow = defineTool({
      name: "slow",
      description: "S",
      parameters: z.object({}),
      timeoutSecs: 5,
      handler: () => null,
    });
    const tools = new ToolsSchema({ standardTools: [tool, slow] });
    const context = new LLMContext({ tools });
    (service as any)._syncRegisteredToolHandlers(context.tools);

    await run("get_weather", { location: "Rome" }, context);
    expect(results.at(-1)?.result).toBe("sunny in Rome");
    expect((service as any)._functions.get("slow").timeoutSecs).toBe(5);

    const adapter = new OpenAILLMAdapter();
    const [openai] = adapter.toProviderToolsFormat(tools) as any[];
    expect(openai.function.name).toBe("get_weather");
    expect(openai.function.parameters.required).toEqual(["location"]);
  });
});
