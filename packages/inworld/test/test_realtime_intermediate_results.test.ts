// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_realtime_intermediate_results.py

/**
 * Realtime services deliver a tool's results as they are produced.
 *
 * A speech-to-speech provider takes one output per function call, so an
 * intermediate result — one reported with
 * `FunctionCallResultProperties({ isFinal: false })` while the call keeps
 * running — goes in beside the call rather than through it. Each service maps
 * that onto whatever second channel its provider offers, and onto what the
 * provider needs to be told about when to speak.
 *
 * Upstream's file covers every realtime service. This file holds its Inworld
 * section (`TestInworldRealtimeIntermediateResults`) and the helpers it uses;
 * the other providers' sections live with their own packages.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { FunctionCallResultFrame, FunctionCallResultProperties } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import { InworldRealtimeLLMService } from "../src/realtime/llm.ts";

const WEATHER = { temperature: 75 };

function _result(
  callId = "call_1",
  options: { isFinal: boolean; runLlm?: boolean; result?: unknown },
): FunctionCallResultFrame {
  return new FunctionCallResultFrame({
    functionName: "delegate",
    toolCallId: callId,
    arguments: {},
    result: options.result !== undefined ? options.result : WEATHER,
    properties: new FunctionCallResultProperties({
      isFinal: options.isFinal,
      runLlm: options.runLlm ?? true,
    }),
  });
}

// The tests reach into the service's protected members, as upstream does.
type AnyService = any;

/** Inworld takes none: its model calls the tool again instead of relaying. */
describe("TestInworldRealtimeIntermediateResults", () => {
  let service: AnyService;

  beforeEach(() => {
    service = new InworldRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});
    service._apiSessionReady = true;
    service._llmNeedsConversationSetup = false;
    service._context = new LLMContext();
    service._openFunctionCalls.add("call_1");
  });

  function _items(): any[] {
    return service.sendClientEvent.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .filter((e: Record<string, unknown>) => "item" in e)
      .map((e: Record<string, unknown>) => e.item);
  }

  test("test_it_declines_the_frontend_role", async () => {
    expect(service.llmWithBackendRoleObjection("frontend") ?? "").toContain(
      "cannot be an LLMWithBackend frontend",
    );
    expect(service.llmWithBackendRoleObjection("backend")).toBeNull();
  });

  test("test_it_says_it_takes_no_intermediate_results", async () => {
    expect(service.acceptsIntermediateFunctionCallResults).toBe(false);
  });

  test("test_an_intermediate_result_is_dropped", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false }));

    expect(_items()).toEqual([]);
  });

  test("test_a_final_result_answers_the_call", async () => {
    await service.pushFrame(_result(undefined, { isFinal: true }));

    const items = _items();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("function_call_output");
  });
});
