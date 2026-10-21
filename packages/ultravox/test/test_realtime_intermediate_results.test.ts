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
 * Upstream's file covers every realtime service. This file holds its Ultravox
 * section (`TestUltravoxIntermediateResults`) and the helpers it uses; the
 * other providers' sections live with their own packages.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { FunctionCallResultFrame, FunctionCallResultProperties } from "@pipedog/core/frames/frames";

import { OneShotInputParams, UltravoxRealtimeLLMService } from "../src/llm.ts";

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

/** Ultravox takes them as user-side text, urgent or not. */
describe("TestUltravoxIntermediateResults", () => {
  let service: AnyService;

  beforeEach(() => {
    service = new UltravoxRealtimeLLMService({
      params: new OneShotInputParams({ apiKey: "test", systemPrompt: "test" }),
    });
    service._socket = {};
    service._send = mock(async () => {});
  });

  function _sent(): Record<string, any>[] {
    return service._send.mock.calls.map((c: unknown[]) => c[0]);
  }

  test("test_it_declines_the_frontend_role", async () => {
    expect(service.llmWithBackendRoleObjection("frontend") ?? "").toContain(
      "cannot be an LLMWithBackend frontend",
    );
  });

  test("test_an_intermediate_result_goes_in_as_text_to_speak_about", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false }));

    const sent = _sent();
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message!.type).toBe("user_text_message");
    expect(message!.text).toContain("still running");
    expect(message!.urgency).toBe("soon");
  });

  test("test_a_silent_result_goes_in_as_context", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false, runLlm: false }));

    const sent = _sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.urgency).toBe("later");
  });

  test("test_a_final_result_settles_the_call", async () => {
    await service.pushFrame(_result(undefined, { isFinal: true }));

    const sent = _sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("client_tool_result");
    expect(sent[0]!.invocationId).toBe("call_1");
  });

  test("test_a_final_result_for_an_async_call_goes_in_as_text", async () => {
    // The placeholder already settled the call, so the result can't.
    service._startedPlaceholderSent.add("call_1");

    await service.pushFrame(_result(undefined, { isFinal: true }));

    const sent = _sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("user_text_message");
    expect(sent[0]!.text).toContain("Async tool result");
  });
});
