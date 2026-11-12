// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Live smoke test against Google Gemini through `@ai-sdk/google`. Skipped
// unless GOOGLE_API_KEY is set; the model can be changed with
// AI_SDK_LIVE_GOOGLE_MODEL.

import { expect, test } from "bun:test";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMRunFrame, MetricsFrame } from "@pipedog/core/frames/frames";
import { LLMUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { LLMContext, standardMessageText } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { AISDKLLMService, AISDKLLMSettings } from "../src/llm.ts";

const apiKey = process.env.GOOGLE_API_KEY;
const modelId = process.env.AI_SDK_LIVE_GOOGLE_MODEL ?? "gemini-3.5-flash-lite";

test.skipIf(!apiKey)(
  "Gemini answers and completes a tool call round trip",
  async () => {
    const google = createGoogleGenerativeAI({ apiKey });
    const llm = new AISDKLLMService({
      model: google(modelId),
      provider: google,
      settings: new AISDKLLMSettings({
        systemInstruction: "You are a terse assistant. Use tools when they help.",
      }),
    });
    const calls: Record<string, unknown>[] = [];
    llm.registerFunction("get_weather", async (params: FunctionCallParams) => {
      calls.push(params.arguments);
      await params.resultCallback({ city: params.arguments.city, conditions: "sunny", c: 21 });
    });

    const context = new LLMContext({
      messages: [{ role: "user", content: "What's the weather in Paris? Answer in one sentence." }],
      tools: new ToolsSchema({
        standardTools: [
          new FunctionSchema({
            name: "get_weather",
            description: "Get the current weather for a city",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          }),
        ],
      }),
    });
    const pair = new LLMContextAggregatorPair(context);
    const pipeline = new Pipeline([pair.user(), llm, pair.assistant()]);

    const [down, up] = await runTest(pipeline, {
      framesToSend: [new LLMRunFrame(), new SleepFrame({ sleep: 8 })],
      pipelineParams: new PipelineParams({ enableMetrics: true, enableUsageMetrics: true }),
    });

    const errors = up.filter((f) => f.constructor.name === "ErrorFrame");
    expect(errors).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    const last = context.getMessages().at(-1)!;
    const answer = standardMessageText(last);
    console.log(`[live] tool calls: ${JSON.stringify(calls)}`);
    console.log(`[live] answer: ${answer}`);
    const metadata = context
      .getMessages(llm.getLlmAdapter().idForLlmSpecificMessages)
      .filter((m: any) => m.message?.type === "provider_metadata");
    console.log(
      `[live] provider metadata kept: ${metadata.map((m: any) => Object.keys(m.message.bookmark))}`,
    );
    expect(answer.toLowerCase()).toContain("sunny");
    const usage = down
      .filter((f) => f instanceof MetricsFrame)
      .flatMap((f) => f.data)
      .filter((d) => d instanceof LLMUsageMetricsData) as LLMUsageMetricsData[];
    console.log(`[live] usage: ${JSON.stringify(usage.map((u) => u.value))}`);
    expect(usage.length).toBeGreaterThan(0);
  },
  30_000,
);
