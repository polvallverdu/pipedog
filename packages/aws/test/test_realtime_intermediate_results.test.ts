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
 * This file lives in `@pipedog/aws` and runs the Nova Sonic cases. The other
 * providers' cases are `test.todo`: their services live in other packages
 * (`@pipedog/openai`, `@pipedog/google`) or are not ported yet (xAI Grok,
 * Inworld, Ultravox), and `@pipedog/aws` does not depend on any of them.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  LLMMessagesAppendFrame,
} from "@pipedog/core/frames/frames";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import { AWSNovaSonicLLMService } from "../src/nova_sonic/llm.ts";

const WEATHER = { temperature: 75 };

function _append(
  text = "Backend: On it.",
  options: { runLlm?: boolean; role?: string } = {},
): LLMMessagesAppendFrame {
  return new LLMMessagesAppendFrame({
    messages: [{ role: options.role ?? "developer", content: text } as never],
    runLlm: options.runLlm ?? true,
  });
}

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

const OPENAI_PROTOCOL_CASES = [
  "test_an_intermediate_result_goes_in_beside_the_call",
  "test_a_final_result_answers_the_call",
  "test_a_result_for_a_call_the_api_lost_goes_in_as_a_message",
  "test_nothing_runs_the_model_until_the_aggregator_asks",
  "test_a_context_frame_from_downstream_records_rather_than_runs",
  "test_a_run_asked_for_during_a_response_waits_for_it_to_finish",
  "test_a_response_takes_in_what_was_delivered_before_it",
  "test_an_interruption_drops_a_run_that_was_waiting",
  "test_a_cancelled_call_is_settled",
  "test_an_appended_message_goes_in_as_an_item_and_runs_when_the_aggregator_asks",
  "test_an_appended_message_nobody_asks_about_runs_nothing",
  "test_nothing_is_appended_before_the_conversation_is_set_up",
  "test_the_context_scan_neither_errors_nor_resends",
];

describe("TestOpenAIRealtimeIntermediateResults", () => {
  for (const name of OPENAI_PROTOCOL_CASES) {
    test.todo(`${name} (pipecat.services.openai.realtime.llm lives in @pipedog/openai)`);
  }
});

describe("TestGrokRealtimeIntermediateResults", () => {
  for (const name of OPENAI_PROTOCOL_CASES) {
    test.todo(`${name} (pipecat.services.xai.realtime.llm is not ported)`);
  }
});

describe("TestInworldRealtimeIntermediateResults", () => {
  for (const name of [
    "test_it_declines_the_frontend_role",
    "test_it_says_it_takes_no_intermediate_results",
    "test_an_intermediate_result_is_dropped",
    "test_a_final_result_answers_the_call",
  ]) {
    test.todo(`${name} (ported in @pipedog/inworld's copy of this test)`);
  }
});

describe("TestGeminiLiveIntermediateResults", () => {
  for (const name of [
    "test_an_intermediate_result_keeps_the_call_open",
    "test_a_silent_result_asks_the_model_not_to_answer",
    "test_a_final_result_settles_the_call",
    "test_an_appended_message_goes_in_without_completing_the_turn",
    "test_the_aggregator_asking_to_run_completes_the_turn",
    "test_an_interruption_drops_a_reply_owed_for_appended_content",
    "test_without_a_context_an_append_starts_a_conversation",
    "test_a_model_without_non_blocking_tools_takes_no_intermediate_results",
  ]) {
    test.todo(`${name} (pipecat.services.google.gemini_live.llm lives in @pipedog/google)`);
  }
});

/** The protected members these tests reach into, as upstream does. */
interface NovaInternals {
  sendText: ReturnType<typeof mock>;
  _sendToolResult: ReturnType<typeof mock>;
  _stream: unknown;
  _promptName: string | null;
  _completedToolCalls: Set<string>;
  _handleMessagesAppend(frame: LLMMessagesAppendFrame): Promise<void>;
}

describe("TestNovaSonicIntermediateResults", () => {
  /** Nova Sonic takes them as text beside the call. */
  function setUp(): { service: AWSNovaSonicLLMService; internals: NovaInternals } {
    const service = new AWSNovaSonicLLMService({
      secretAccessKey: "k",
      accessKeyId: "i",
      region: "r",
    });
    const internals = service as unknown as NovaInternals;
    internals.sendText = mock(async () => {});
    internals._sendToolResult = mock(async () => {});
    internals._stream = {};
    internals._promptName = "prompt";
    return { service, internals };
  }

  function _texts(internals: NovaInternals): [string, boolean][] {
    // sendText(text, role, promptName, stream, interactive)
    return internals.sendText.mock.calls.map((c) => [c[0] as string, c[4] as boolean]);
  }

  test("test_an_intermediate_result_goes_in_as_interactive_text", async () => {
    const { service, internals } = setUp();
    await service.pushFrame(_result("call_1", { isFinal: false }));

    const texts = _texts(internals);
    expect(texts.length).toBe(1);
    const [text, interactive] = texts[0] as [string, boolean];
    const payload = asyncToolMessages.parseMessage({ role: "developer", content: text });
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe("intermediate");
    expect(interactive).toBe(true);
    expect(internals._sendToolResult).not.toHaveBeenCalled();
  });

  test("test_a_silent_result_goes_in_without_asking_for_a_reply", async () => {
    const { service, internals } = setUp();
    await service.pushFrame(_result("call_1", { isFinal: false, runLlm: false }));

    const texts = _texts(internals);
    expect(texts.length).toBe(1);
    expect((texts[0] as [string, boolean])[1]).toBe(false);
  });

  test("test_a_final_result_settles_the_call", async () => {
    const { service, internals } = setUp();
    await service.pushFrame(_result("call_1", { isFinal: true }));

    expect(_texts(internals)).toEqual([]);
    expect(internals._sendToolResult).toHaveBeenCalledTimes(1);
    expect(internals._completedToolCalls.has("call_1")).toBe(true);
  });

  test("test_an_appended_message_goes_in_as_text_interactive_as_asked", async () => {
    const { internals } = setUp();
    await internals._handleMessagesAppend(_append());
    await internals._handleMessagesAppend(
      _append("Backend (working): read_file()", { runLlm: false }),
    );

    expect(_texts(internals)).toEqual([
      ["Backend: On it.", true],
      ["Backend (working): read_file()", false],
    ]);
  });
});

describe("TestUltravoxIntermediateResults", () => {
  for (const name of [
    "test_it_declines_the_frontend_role",
    "test_an_intermediate_result_goes_in_as_text_to_speak_about",
    "test_a_silent_result_goes_in_as_context",
    "test_a_final_result_settles_the_call",
    "test_a_final_result_for_an_async_call_goes_in_as_text",
  ]) {
    test.todo(`${name} (ported in @pipedog/ultravox's copy of this test)`);
  }
});
