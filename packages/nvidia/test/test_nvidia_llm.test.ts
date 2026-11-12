// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_nvidia_llm.py

/**
 * Tests for NVIDIA NIM LLM service behavior.
 *
 * Porting notes:
 * - `patch.object(NvidiaLLMService, "create_client")` → `spyOn` on the
 *   prototype's `createClient`, restored after construction.
 * - `patch.object(FrameProcessor, "metrics_enabled", new_callable=PropertyMock)`
 *   → the getter is redefined on `FrameProcessor.prototype` and restored after.
 * - `pytest.mark.parametrize` → `test.each` with the upstream ids.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  type Frame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
  MetricsFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { NvidiaLLMService } from "../src/llm.ts";

/** Minimal asynchronous completion stream for service tests. */
class _FakeStream {
  #chunks: unknown[];

  constructor(chunks: unknown[]) {
    this.#chunks = chunks;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.#iterate();
  }

  async *#iterate(): AsyncGenerator<unknown> {
    for (const chunk of this.#chunks) {
      yield chunk;
    }
  }

  async close(): Promise<void> {}
}

/** Build an OpenAI-compatible chunk containing NVIDIA reasoning output. */
function _reasoningChunk(options: { reasoningContent: string | null; content: string | null }) {
  return {
    usage: null,
    model: null,
    choices: [
      {
        delta: {
          reasoning_content: options.reasoningContent,
          content: options.content,
          tool_calls: null,
        },
      },
    ],
  };
}

/** Create an NVIDIA service with its API client disabled. */
function _service(): any {
  const spy = spyOn(NvidiaLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
  try {
    return new NvidiaLLMService({
      apiKey: "test-key",
      settings: new NvidiaLLMService.Settings({ model: "test-model" }),
    });
  } finally {
    spy.mockRestore();
  }
}

/** Run `fn` with `getChatCompletions` and `metricsEnabled` patched. */
async function _withPatches(stream: _FakeStream, fn: () => Promise<void>): Promise<void> {
  const completionsSpy = spyOn(OpenAILLMService.prototype, "getChatCompletions").mockImplementation(
    (async () => stream) as any,
  );
  const descriptor = Object.getOwnPropertyDescriptor(FrameProcessor.prototype, "metricsEnabled")!;
  Object.defineProperty(FrameProcessor.prototype, "metricsEnabled", {
    configurable: true,
    get: () => true,
  });
  try {
    await fn();
  } finally {
    Object.defineProperty(FrameProcessor.prototype, "metricsEnabled", descriptor);
    completionsSpy.mockRestore();
  }
}

describe("test_reasoning_output_reports_ttfb_before_thought_frames", () => {
  test.each([
    ["reasoning-content", "Let me think.", null],
    ["think-tags", null, "<think>Let me think.</think>Answer"],
  ] as const)(
    "test_reasoning_output_reports_ttfb_before_thought_frames[%s]",
    async (_id, reasoningContent, content) => {
      // Reasoning is observable only after its TTFB metric is reported.
      const service = _service();
      const pushed: Frame[] = [];

      service.pushFrame = async (frame: Frame, ..._args: unknown[]) => {
        pushed.push(frame);
      };
      service._pushLlmText = mock(async (_text: string) => {});

      const stream = new _FakeStream([_reasoningChunk({ reasoningContent, content })]);
      await _withPatches(stream, async () => {
        await service._processContext(
          new LLMContext({ messages: [{ role: "user", content: "Hi" }] }),
        );
      });

      const ttfbFrames = pushed.filter((frame) => frame instanceof MetricsFrame);
      expect(ttfbFrames.length).toEqual(1);
      expect(pushed[0]).toBeInstanceOf(MetricsFrame);
      expect(pushed[1]).toBeInstanceOf(LLMThoughtStartFrame);
    },
  );
});

test("test_non_reasoning_output_reports_ttfb_without_thought_frames", async () => {
  // A normal response reports TTFB without emitting thought frames.
  const service = _service();
  const pushed: Frame[] = [];

  service.pushFrame = async (frame: Frame, ..._args: unknown[]) => {
    pushed.push(frame);
  };
  service._pushLlmText = mock(async (_text: string) => {});

  const stream = new _FakeStream([_reasoningChunk({ reasoningContent: null, content: "Answer" })]);
  await _withPatches(stream, async () => {
    await service._processContext(new LLMContext({ messages: [{ role: "user", content: "Hi" }] }));
  });

  const ttfbFrames = pushed.filter((frame) => frame instanceof MetricsFrame);
  expect(ttfbFrames.length).toEqual(1);
  expect(
    pushed.some(
      (frame) =>
        frame instanceof LLMThoughtStartFrame ||
        frame instanceof LLMThoughtTextFrame ||
        frame instanceof LLMThoughtEndFrame,
    ),
  ).toBe(false);
  // assert_awaited_once_with("Answer")
  expect(service._pushLlmText).toHaveBeenCalledTimes(1);
  expect(service._pushLlmText).toHaveBeenCalledWith("Answer");
});
