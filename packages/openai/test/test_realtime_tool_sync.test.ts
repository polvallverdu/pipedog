// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_realtime_tool_sync.py

/**
 * Realtime services sync direct-function handlers on LLMSetToolsFrame.
 *
 * Continuous (speech-to-speech) sessions don't get a fresh context frame per turn,
 * so they sync registered handlers from the `LLMSetToolsFrame` themselves — the
 * base service only does this on `LLMContextFrame`.
 */

import { describe, expect, mock, test } from "bun:test";

import { LLMSetToolsFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type {
  FunctionCallParams,
  FunctionCallRegistryItem,
} from "@pipedog/core/services/llm_service";

import { OpenAIRealtimeLLMService } from "../src/realtime/llm.ts";

// DIVERGENCE (see core adapters/llm/schemas/direct_function.ts): JavaScript has no
// docstrings or runtime type hints, so the description and parameter types are
// attached as metadata.
async function sample_tool(params: FunctionCallParams, query: string) {
  void query;
  await params.resultCallback({});
}
sample_tool.description = "A sample direct function.";
sample_tool.parameters = { query: { type: "string", description: "The query to run." } };

/** The protected members these tests reach into, as upstream does. */
interface Internals {
  _functions: Map<string | null, FunctionCallRegistryItem>;
  _sendSessionUpdate: () => Promise<void>;
  pushFrame: (...args: unknown[]) => Promise<void>;
}

describe("TestRealtimeToolSync", () => {
  function _service(): OpenAIRealtimeLLMService {
    const service = new OpenAIRealtimeLLMService({ apiKey: "test-key" });
    // Stub the parts that would touch the network / pipeline so we can drive
    // processFrame without a live session.
    const internals = service as unknown as Internals;
    internals._sendSessionUpdate = mock(async () => {});
    internals.pushFrame = mock(async () => {});
    return service;
  }

  test("test_set_tools_frame_registers_direct_function", async () => {
    const service = _service();
    await service.processFrame(
      new LLMSetToolsFrame({ tools: [sample_tool] }),
      FrameDirection.DOWNSTREAM,
    );
    expect(service.hasFunction("sample_tool")).toBe(true);
  });

  test("test_set_tools_frame_prunes_deadvertised_direct_function", async () => {
    const service = _service();
    await service.processFrame(
      new LLMSetToolsFrame({ tools: [sample_tool] }),
      FrameDirection.DOWNSTREAM,
    );
    expect(service.hasFunction("sample_tool")).toBe(true);
    // Clearing the advertised tools prunes the auto-registered handler.
    await service.processFrame(new LLMSetToolsFrame({ tools: [] }), FrameDirection.DOWNSTREAM);
    expect((service as unknown as Internals)._functions.has("sample_tool")).toBe(false);
  });
});
