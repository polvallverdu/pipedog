// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// AISDKLLMService against the AI SDK's mock language model (`ai/test`):
// text streaming, a tool call round trip through pipedog's function calling,
// interruption, metrics and settings.

import { describe, expect, test } from "bun:test";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMRunFrame,
  LLMTextFrame,
  LLMUpdateSettingsFrame,
  MetricsFrame,
} from "@pipedog/core/frames/frames";
import { LLMUsageMetricsData, TTFBMetricsData } from "@pipedog/core/metrics/metrics";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AISDKLLMService, AISDKLLMSettings } from "../src/llm.ts";

type StreamPart = Record<string, unknown>;

const USAGE = {
  inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 7, text: 5, reasoning: 2 },
};

function finish(reason: "stop" | "tool-calls" = "stop"): StreamPart {
  return { type: "finish", finishReason: { unified: reason, raw: reason }, usage: USAGE };
}

function textParts(...chunks: string[]): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...chunks.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    finish(),
  ];
}

function streamOf(parts: StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts as any[] }) };
}

function mockModel(...responses: StreamPart[][]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => streamOf(responses[Math.min(call++, responses.length - 1)]!),
  });
}

function texts(frames: Frame[]): string[] {
  return frames.filter((f): f is LLMTextFrame => f instanceof LLMTextFrame).map((f) => f.text);
}

function contextFrame(context: LLMContext): LLMContextFrame {
  return new LLMContextFrame({ context });
}

describe("AISDKLLMService", () => {
  test("streams text between response start and end frames", async () => {
    const model = mockModel(textParts("Hello", ", ", "world!"));
    const llm = new AISDKLLMService({
      model,
      settings: new AISDKLLMSettings({ systemInstruction: "Be brief.", temperature: 0.3 }),
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });

    const [down] = await runTest(llm, { framesToSend: [contextFrame(context)] });

    const kinds = down
      .filter(
        (f) =>
          f instanceof LLMFullResponseStartFrame ||
          f instanceof LLMTextFrame ||
          f instanceof LLMFullResponseEndFrame,
      )
      .map((f) => f.constructor.name);
    expect(kinds).toEqual([
      "LLMFullResponseStartFrame",
      "LLMTextFrame",
      "LLMTextFrame",
      "LLMTextFrame",
      "LLMFullResponseEndFrame",
    ]);
    expect(texts(down).join("")).toBe("Hello, world!");

    const call = model.doStreamCalls[0]!;
    expect(call.temperature).toBe(0.3);
    expect(call.prompt).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  test("tool call round trip runs the pipedog handler and re-prompts", async () => {
    const model = mockModel(
      [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "get_weather",
          input: '{"city":"Paris"}',
          providerMetadata: { google: { thoughtSignature: "sig-1" } },
        },
        finish("tool-calls"),
      ],
      textParts("It is sunny in Paris."),
    );
    const llm = new AISDKLLMService({ model });
    const seen: Record<string, unknown>[] = [];
    llm.registerFunction("get_weather", async (params: FunctionCallParams) => {
      seen.push(params.arguments);
      await params.resultCallback({ conditions: "sunny" });
    });

    const tools = new ToolsSchema({
      standardTools: [
        new FunctionSchema({
          name: "get_weather",
          description: "Get the weather",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
      ],
    });
    const context = new LLMContext({
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools,
    });
    const pair = new LLMContextAggregatorPair(context);
    const pipeline = new Pipeline([pair.user(), llm, pair.assistant()]);

    await runTest(pipeline, {
      framesToSend: [new LLMRunFrame(), new SleepFrame({ sleep: 0.5 })],
    });

    expect(seen).toEqual([{ city: "Paris" }]);
    expect(model.doStreamCalls.length).toBe(2);

    // The first request offers the tool as a JSON-schema function.
    const firstTools = model.doStreamCalls[0]!.tools as any[];
    expect(firstTools.map((t) => [t.type, t.name])).toEqual([["function", "get_weather"]]);
    expect(firstTools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });

    // The second request carries the call (with its provider metadata) and
    // the handler's result.
    const prompt = model.doStreamCalls[1]!.prompt as any[];
    const assistant = prompt.find((m) => m.role === "assistant");
    expect(assistant.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "get_weather",
        input: { city: "Paris" },
        providerOptions: { google: { thoughtSignature: "sig-1" } },
      }),
    ]);
    const toolMessage = prompt.find((m) => m.role === "tool");
    expect(toolMessage.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "get_weather",
      output: { type: "text", value: '{"conditions": "sunny"}' },
    });

    // The assistant aggregator consumed the reply into the context.
    expect(context.getMessages().at(-1)).toEqual({
      role: "assistant",
      content: "It is sunny in Paris.",
    });
  });

  test("an interruption aborts the request", async () => {
    let abortSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        abortSignal = options.abortSignal;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "Once upon" });
            // Then nothing more, until aborted.
            options.abortSignal?.addEventListener("abort", () =>
              controller.error(options.abortSignal?.reason),
            );
          },
        });
        return { stream };
      },
    });
    const llm = new AISDKLLMService({ model });
    const context = new LLMContext({ messages: [{ role: "user", content: "A story" }] });

    const [down] = await runTest(llm, {
      framesToSend: [
        contextFrame(context),
        new SleepFrame({ sleep: 0.2 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });

    expect(abortSignal?.aborted).toBe(true);
    expect(texts(down)).toEqual(["Once upon"]);
    expect(down.some((f) => f instanceof ErrorFrame)).toBe(false);
  });

  test("reports TTFB and token usage metrics", async () => {
    const llm = new AISDKLLMService({ model: mockModel(textParts("Hi there")) });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });

    const [down] = await runTest(llm, {
      framesToSend: [contextFrame(context)],
      pipelineParams: new PipelineParams({ enableMetrics: true, enableUsageMetrics: true }),
    });

    const data = down.filter((f) => f instanceof MetricsFrame).flatMap((f) => f.data);
    const ttfb = data.filter((d) => d instanceof TTFBMetricsData);
    expect(ttfb.length).toBeGreaterThan(0);
    const usage = data.find((d) => d instanceof LLMUsageMetricsData) as LLMUsageMetricsData;
    expect(usage).toBeDefined();
    expect(usage.model).toBe("mock-model");
    expect(usage.value).toMatchObject({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19,
      cacheReadInputTokens: 2,
      reasoningTokens: 2,
    });
  });

  test("streams reasoning as thought frames and sends it back", async () => {
    const model = mockModel(
      [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "Thinking..." },
        {
          type: "reasoning-end",
          id: "r1",
          providerMetadata: { anthropic: { signature: "s" } },
        },
        ...textParts("Answer").slice(1),
      ],
      textParts("Second"),
    );
    const llm = new AISDKLLMService({ model });
    const context = new LLMContext({ messages: [{ role: "user", content: "Q1" }] });
    const pair = new LLMContextAggregatorPair(context);
    const pipeline = new Pipeline([pair.user(), llm, pair.assistant()]);

    const thoughts: string[] = [];
    pair.assistant().eventHandler("on_assistant_thought", async (_agg: unknown, message: any) => {
      thoughts.push(message.content);
    });
    await runTest(pipeline, {
      framesToSend: [new LLMRunFrame(), new SleepFrame({ sleep: 0.2 })],
    });
    expect(thoughts).toEqual(["Thinking..."]);

    context.addMessage({ role: "user", content: "Q2" });
    await runTest(llm, { framesToSend: [contextFrame(context)] });
    const prompt = model.doStreamCalls[1]!.prompt as any[];
    expect(prompt[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Thinking...",
          providerOptions: { anthropic: { signature: "s" } },
        },
        { type: "text", text: "Answer" },
      ],
    });
  });

  test("a provider error is pushed as an ErrorFrame", async () => {
    const model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "error", error: new Error("boom") },
    ]);
    const llm = new AISDKLLMService({ model, maxRetries: 0 });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });

    const [down, up] = await runTest(llm, { framesToSend: [contextFrame(context)] });
    const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("boom");
    expect(down.some((f) => f instanceof LLMFullResponseEndFrame)).toBe(true);
  });

  test("settings map to call options and update at runtime", async () => {
    const other = mockModel(textParts("from other"));
    const model = mockModel(textParts("ok"));
    const llm = new AISDKLLMService({
      model,
      provider: (id) => (id === "other" ? other : model),
      settings: new AISDKLLMSettings({
        maxTokens: 50,
        topP: 0.9,
        stopSequences: ["END"],
        providerOptions: { mock: { flag: true } },
      }),
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hi" }] });

    await runTest(llm, {
      framesToSend: [
        contextFrame(context),
        new SleepFrame({ sleep: 0.1 }),
        new LLMUpdateSettingsFrame({ delta: new AISDKLLMSettings({ model: "other" }) }),
        contextFrame(context),
      ],
    });

    const call = model.doStreamCalls[0]!;
    expect(call.maxOutputTokens).toBe(50);
    expect(call.topP).toBe(0.9);
    expect(call.stopSequences).toEqual(["END"]);
    expect(call.providerOptions).toEqual({ mock: { flag: true } });
    expect(other.doStreamCalls.length).toBe(1);
  });

  test("runInference returns the generated text", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "summary" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      },
    });
    const llm = new AISDKLLMService({ model });
    const context = new LLMContext({ messages: [{ role: "user", content: "Summarize" }] });
    const result = await llm.runInference(context, {
      maxTokens: 20,
      systemInstruction: "Summarize.",
    });
    expect(result).toBe("summary");
    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(20);
    expect(model.doGenerateCalls[0]!.prompt[0]).toEqual({
      role: "system",
      content: "Summarize.",
    });
  });
});
