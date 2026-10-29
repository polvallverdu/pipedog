// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aws_bedrock_llm_thinking.py

/**
 * Unit tests for AWSBedrockLLMService's handling of model reasoning.
 *
 * Reasoning arrives either as `reasoningContent` deltas (Claude, Nova 2) or, for
 * Amazon Nova (v1) models, in the answer text wrapped in `<thinking>` tags before
 * a tool call. Either way it is emitted as thoughts and must not reach TTS.
 */

import { expect, mock, test } from "bun:test";

import {
  type Frame,
  type FunctionCallFromLLM,
  LLMTextFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import { AWSBedrockLLMService } from "../src/llm.ts";

type Dict = Record<string, any>;

// Text deltas from a real us.amazon.nova-lite-v1:0 ConverseStream response to
// "Get the weather in Paris and in Tokyo." with a get_weather tool (trimmed in
// the middle). Nova sends one token per delta, so the tags are split.
const NOVA_THINKING_DELTAS = [
  "<thinking",
  ">",
  "The",
  " User",
  " wants",
  " to",
  " know",
  " the",
  " weather",
  " in",
  " both",
  " cities",
  ".</",
  "thinking",
  ">\n",
];

function _textEvents(deltas: string[]): Dict[] {
  const events: Dict[] = [{ messageStart: { role: "assistant" } }];
  events.push(
    ...deltas.map((d) => ({ contentBlockDelta: { delta: { text: d }, contentBlockIndex: 0 } })),
  );
  events.push({ contentBlockStop: { contentBlockIndex: 0 } });
  return events;
}

function _toolEvents(): Dict[] {
  return [
    {
      contentBlockStart: {
        start: { toolUse: { toolUseId: "tooluse_1", name: "get_weather" } },
        contentBlockIndex: 1,
      },
    },
    {
      contentBlockDelta: {
        delta: { toolUse: { input: '{"city":"Paris"}' } },
        contentBlockIndex: 1,
      },
    },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 409, outputTokens: 76, totalTokens: 485 } } },
  ];
}

function makeService(model: string): AWSBedrockLLMService {
  return new AWSBedrockLLMService({
    awsAccessKey: "test",
    awsSecretKey: "test",
    awsRegion: "us-east-1",
    settings: new AWSBedrockLLMService.Settings({ model }),
  });
}

async function _run(events: Dict[]): Promise<[any, Frame[]]> {
  const service: any = makeService("us.amazon.nova-lite-v1:0");
  const frames: Frame[] = [];
  service.pushFrame = mock(async (frame: Frame) => {
    frames.push(frame);
  });
  service.runFunctionCalls = mock(async () => {});

  async function* stream() {
    for (const event of events) {
      yield event;
    }
  }

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "Get the weather in Paris and in Tokyo." });
  service._createConverseStream = mock(async () => ({ stream: stream() }));
  await service._processContext(context);
  return [service, frames];
}

function texts(frames: Frame[], cls: typeof LLMTextFrame | typeof LLMThoughtTextFrame): string {
  return frames
    .filter((f) => f instanceof cls)
    .map((f) => (f as LLMTextFrame).text)
    .join("");
}

function count(frames: Frame[], cls: abstract new (...args: any[]) => Frame): number {
  return frames.filter((f) => f instanceof cls).length;
}

test("test_nova_thinking_tags_are_emitted_as_thoughts_not_text", async () => {
  const [service, frames] = await _run([..._textEvents(NOVA_THINKING_DELTAS), ..._toolEvents()]);

  const spoken = texts(frames, LLMTextFrame);
  const thought = texts(frames, LLMThoughtTextFrame);
  expect(spoken).not.toContain("thinking");
  expect(spoken).not.toContain("User wants");
  expect(thought).toBe("The User wants to know the weather in both cities.");
  expect(count(frames, LLMThoughtStartFrame)).toBe(1);
  expect(count(frames, LLMThoughtEndFrame)).toBe(1);

  const lastArgs = service.runFunctionCalls.mock.lastCall;
  expect(lastArgs.length).toBe(1);
  const calls: FunctionCallFromLLM[] = lastArgs[0];
  expect(calls.map((c) => [c.functionName, c.arguments])).toEqual([
    ["get_weather", { city: "Paris" }],
  ]);
});

test("test_text_after_thinking_block_is_still_spoken", async () => {
  const deltas = [...NOVA_THINKING_DELTAS, "Let", " me", " check", "."];
  const [, frames] = await _run([..._textEvents(deltas), ..._toolEvents()]);

  const spoken = texts(frames, LLMTextFrame);
  expect(spoken.trim()).toBe("Let me check.");
});

test("test_text_without_thinking_tags_is_unchanged", async () => {
  const deltas = ["Sure", "! I'll", " fetch", " the", " weather", "."];
  const [, frames] = await _run([..._textEvents(deltas), ..._toolEvents()]);

  expect(texts(frames, LLMTextFrame)).toBe("Sure! I'll fetch the weather.");
  expect(frames.some((f) => f instanceof LLMThoughtTextFrame)).toBe(false);
});

test("test_short_text_that_is_a_tag_prefix_is_flushed_at_the_end", async () => {
  const [, frames] = await _run([..._textEvents(["<"]), ..._toolEvents()]);

  expect(texts(frames, LLMTextFrame)).toBe("<");
});

// Reasoning deltas from a real us.anthropic.claude-haiku-4-5 ConverseStream
// response with extended thinking enabled (trimmed in the middle).
const CLAUDE_REASONING_EVENTS: Dict[] = [
  { messageStart: { role: "assistant" } },
  ...["The user is asking for", " the weather in Paris.", ""].map((t) => ({
    contentBlockDelta: { delta: { reasoningContent: { text: t } }, contentBlockIndex: 0 },
  })),
  {
    contentBlockDelta: {
      delta: { reasoningContent: { signature: "sig" } },
      contentBlockIndex: 0,
    },
  },
  { contentBlockStop: { contentBlockIndex: 0 } },
];

test("test_reasoning_content_is_emitted_as_a_thought_for_the_context", async () => {
  const [service, frames] = await _run([...CLAUDE_REASONING_EVENTS, ..._toolEvents()]);

  const starts = frames.filter((f) => f instanceof LLMThoughtStartFrame) as LLMThoughtStartFrame[];
  const ends = frames.filter((f) => f instanceof LLMThoughtEndFrame) as LLMThoughtEndFrame[];
  expect(starts.length).toBe(1);
  expect(ends.length).toBe(1);
  const [start] = starts;
  const [end] = ends;
  const thought = texts(frames, LLMThoughtTextFrame);
  expect(start!.appendToContext).toBeTruthy();
  expect(start!.llm).toBe("aws");
  expect(end!.signature).toBe("sig");
  expect(thought).toBe("The user is asking for the weather in Paris.");
  expect(frames.some((f) => f instanceof LLMTextFrame)).toBe(false);

  const lastArgs = service.runFunctionCalls.mock.lastCall;
  expect(lastArgs.length).toBe(1);
  const calls: FunctionCallFromLLM[] = lastArgs[0];
  expect(calls.map((c) => c.functionName)).toEqual(["get_weather"]);
});

test("test_reasoning_cut_short_is_closed_without_a_signature", async () => {
  async function* failingStream() {
    for (const event of CLAUDE_REASONING_EVENTS.slice(0, 2)) {
      yield event;
    }
    throw new Error("stream dropped");
  }

  const service: any = makeService("us.anthropic.claude-haiku-4-5");
  const frames: Frame[] = [];
  service.pushFrame = mock(async (frame: Frame) => {
    frames.push(frame);
  });
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "What's the weather in Paris?" });
  service._createConverseStream = mock(async () => ({ stream: failingStream() }));
  await service._processContext(context);

  const ends = frames.filter((f) => f instanceof LLMThoughtEndFrame) as LLMThoughtEndFrame[];
  expect(ends.length).toBe(1);
  expect(ends[0]!.signature).toBeNull();
});

test("test_each_text_block_can_open_with_a_thought", async () => {
  function textBlock(index: number, deltas: string[]): Dict[] {
    return [
      ...deltas.map((d) => ({
        contentBlockDelta: { delta: { text: d }, contentBlockIndex: index },
      })),
      { contentBlockStop: { contentBlockIndex: index } },
    ];
  }

  function toolBlock(index: number, city: string): Dict[] {
    return [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: `tooluse_${index}`, name: "get_weather" } },
          contentBlockIndex: index,
        },
      },
      {
        contentBlockDelta: {
          delta: { toolUse: { input: `{"city":"${city}"}` } },
          contentBlockIndex: index,
        },
      },
      { contentBlockStop: { contentBlockIndex: index } },
    ];
  }

  const events: Dict[] = [
    { messageStart: { role: "assistant" } },
    ...textBlock(0, ["<thinking>", "Paris first.", "</thinking>"]),
    ...toolBlock(1, "Paris"),
    ...textBlock(2, ["<thinking>", "Now Tokyo.", "</thinking>\n"]),
    ...toolBlock(3, "Tokyo"),
    { messageStop: { stopReason: "tool_use" } },
  ];
  const [service, frames] = await _run(events);

  const thoughts: string[] = [];
  for (const f of frames) {
    if (f instanceof LLMThoughtStartFrame) {
      thoughts.push("");
    } else if (f instanceof LLMThoughtTextFrame) {
      thoughts[thoughts.length - 1] += f.text;
    }
  }
  expect(thoughts).toEqual(["Paris first.", "Now Tokyo."]);
  expect(count(frames, LLMThoughtEndFrame)).toBe(2);
  expect(frames.some((f) => f instanceof LLMTextFrame)).toBe(false);

  const lastArgs = service.runFunctionCalls.mock.lastCall;
  expect(lastArgs.length).toBe(1);
  const calls: FunctionCallFromLLM[] = lastArgs[0];
  expect(calls.map((c) => c.arguments.city)).toEqual(["Paris", "Tokyo"]);
});
