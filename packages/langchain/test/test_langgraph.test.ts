// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * LangGraph through `LangchainProcessor`. Upstream has no LangGraph
 * processor: a compiled graph is a LangChain `Runnable`, so it goes through
 * the same processor. These tests run real graphs (no mocks) to show both
 * ways of using one: streaming the graph's final answer, and streaming the
 * chat model's tokens from inside the graph (`streamMode: "messages"`).
 */

import { describe, expect, test } from "bun:test";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import {
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { LangchainProcessor } from "../src/langchain.ts";

function buildGraph(response: string) {
  const model = new FakeListChatModel({ responses: [response] });
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => ({ messages: [await model.invoke(state.messages)] }))
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__")
    .compile();
}

function userContext(text: string): LLMContextFrame {
  return new LLMContextFrame({
    context: new LLMContext({ messages: [{ role: "user", content: text }] }),
  });
}

async function run(proc: LangchainProcessor, text: string): Promise<string[]> {
  const [down] = await runTest(proc, {
    framesToSend: [userContext(text)],
    expectedDownFrames: null,
  });
  expect(down[0]).toBeInstanceOf(LLMFullResponseStartFrame);
  expect(down[down.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
  return down.filter((f): f is TextFrame => f instanceof TextFrame).map((f) => f.text);
}

describe("LangGraph", () => {
  test("a compiled graph's final answer", async () => {
    const graph = buildGraph("Hello from the graph");
    let seenInput: BaseMessage[] = [];
    // `graph.stream()` yields state updates, not text (upstream's processor
    // would speak nothing for them either), so speak the final message.
    const chain = RunnableLambda.from(async (input: { messages: string }, config) => {
      const state = await graph.invoke(input, config);
      seenInput = state.messages;
      return state.messages[state.messages.length - 1]?.content as string;
    });
    const proc = new LangchainProcessor(chain, { transcriptKey: "messages" });

    expect((await run(proc, "Hi graph")).join("")).toBe("Hello from the graph");
    expect(seenInput[0]?.content).toBe("Hi graph");
  });

  test("streaming the model's tokens from inside the graph", async () => {
    const graph = buildGraph("Streaming tokens");
    let threadId: unknown;
    const chain = RunnableLambda.from(async function* (
      input: { messages: string },
      config,
    ): AsyncGenerator<AIMessageChunk> {
      // The processor sets `configurable.session_id`; LangGraph checkpointers
      // key on `thread_id`.
      threadId = config?.configurable?.session_id;
      const stream = await graph.stream(input, { ...config, streamMode: "messages" });
      for await (const [chunk] of stream) {
        if (AIMessageChunk.isInstance(chunk)) yield chunk;
      }
    });
    const proc = new LangchainProcessor(chain, { transcriptKey: "messages" });
    proc.setParticipantId("participant-1");

    const tokens = await run(proc, "Hi graph");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join("")).toBe("Streaming tokens");
    expect(threadId).toBe("participant-1");
  });

  test("an interruption aborts the graph", async () => {
    let aborted = false;
    const chain = RunnableLambda.from(async function* (_input: unknown, config) {
      yield "Thinking";
      // A long-running node: resolves only when the run is aborted.
      await new Promise<void>((resolve) => {
        config?.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      yield " (never spoken)";
    });
    const proc = new LangchainProcessor(chain);

    const [down] = await runTest(proc, {
      framesToSend: [userContext("Hi"), new SleepFrame({ sleep: 0.1 }), new InterruptionFrame()],
      expectedDownFrames: null,
    });
    const text = down.filter((f): f is TextFrame => f instanceof TextFrame).map((f) => f.text);
    expect(aborted).toBe(true);
    expect(text).toEqual(["Thinking"]);
  });
});
