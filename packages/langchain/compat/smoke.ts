// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: streams a LangChain prompt -> fake chat
// model chain through LangchainProcessor and checks the spoken text.

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { LLMContextFrame, TextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";
import { LangchainProcessor } from "@pipedog/langchain/langchain";

export default async function smoke(): Promise<void> {
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Be brief."],
    ["human", "{input}"],
  ]);
  const chain = prompt.pipe(new FakeListChatModel({ responses: ["Hello from LangChain"] }));
  const proc = new LangchainProcessor(chain);

  const [down] = await runTest(proc, {
    framesToSend: [
      new LLMContextFrame({
        context: new LLMContext({ messages: [{ role: "user", content: "Hi" }] }),
      }),
    ],
    expectedDownFrames: null,
  });
  const text = down
    .filter((f): f is TextFrame => f instanceof TextFrame)
    .map((f) => f.text)
    .join("");
  if (text !== "Hello from LangChain")
    throw new Error(`langchain smoke: got ${JSON.stringify(text)}`);
}
