// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: streams a reply from the AI SDK's mock
// language model through AISDKLLMService, with a tool call run by pipedog,
// and checks the text and the re-prompt.

import { AISDKLLMService } from "@pipedog/ai-sdk";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { LLMContextFrame, LLMTextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  },
};

const responses: unknown[][] = [
  [{ type: "tool-call", toolCallId: "c1", toolName: "ping", input: "{}" }, finish],
  [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Hello from " },
    { type: "text-delta", id: "t", delta: "the AI SDK" },
    { type: "text-end", id: "t" },
    finish,
  ],
];

export default async function smoke(): Promise<void> {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: responses[call++]! as any[] }),
    }),
  });
  const llm = new AISDKLLMService({ model });
  let pinged = false;
  llm.registerFunction("ping", async (params: FunctionCallParams) => {
    pinged = true;
    // Answer with the text reply directly, instead of a second context frame.
    await params.resultCallback("pong");
  });
  const context = new LLMContext({
    messages: [{ role: "user", content: "Hi" }],
    tools: new ToolsSchema({
      standardTools: [
        new FunctionSchema({ name: "ping", description: "Ping", properties: {}, required: [] }),
      ],
    }),
  });

  const [down] = await runTest(llm, {
    framesToSend: [
      new LLMContextFrame({ context }),
      new SleepFrame({ sleep: 0.1 }),
      new LLMContextFrame({ context }),
    ],
    expectedDownFrames: null,
  });
  const text = down
    .filter((f): f is LLMTextFrame => f instanceof LLMTextFrame)
    .map((f) => f.text)
    .join("");
  if (!pinged) throw new Error("ai-sdk smoke: the tool was not called");
  if (text !== "Hello from the AI SDK")
    throw new Error(`ai-sdk smoke: got ${JSON.stringify(text)}`);
  if (model.doStreamCalls.length !== 2) throw new Error("ai-sdk smoke: expected two requests");
}
