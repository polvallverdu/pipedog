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
 * Results are delivered from the `FunctionCallResultFrame` the service
 * broadcasts, as it is produced. What runs the model is the context frame the
 * assistant aggregator pushes upstream afterwards.
 *
 * Upstream's file covers every realtime service. This file holds its Grok
 * section (`TestGrokRealtimeIntermediateResults`, which runs the shared
 * `OpenAIProtocolIntermediateResultsTests` suite) and the helpers it uses; the
 * other providers' sections live with their own packages.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  FunctionCallCancelFrame,
  FunctionCallResultFrame,
  FunctionCallResultProperties,
  LLMMessagesAppendFrame,
} from "@pipedog/core/frames/frames";
import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";

import { GrokRealtimeLLMService } from "../src/realtime/llm.ts";

const WEATHER = { temperature: 75 };

function _append(
  text = "Backend: On it.",
  options: { runLlm?: boolean; role?: string } = {},
): LLMMessagesAppendFrame {
  return new LLMMessagesAppendFrame({
    messages: [{ role: options.role ?? "developer", content: text }] as any,
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

/** The fields the response handlers read. */
function _response(): Record<string, unknown> {
  return {
    id: "resp_1",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    status: "completed",
    statusDetails: null,
    output: [],
  };
}

/**
 * The checks every service speaking the OpenAI realtime protocol answers.
 *
 * Each service has its own module and its own event models, so the suite runs
 * once per service rather than testing one and assuming the rest.
 */
function openAIProtocolIntermediateResultsTests(buildService: () => any, appendRole: string): void {
  let service: any;

  beforeEach(() => {
    service = buildService();
    service.sendClientEvent = mock(async () => {});
    service._apiSessionReady = true;
    service._llmNeedsConversationSetup = false;
    service._context = new LLMContext();
    // The API is waiting on this call.
    service._openFunctionCalls.add("call_1");
  });

  function _sent(): any[] {
    return service.sendClientEvent.mock.calls.map((c: unknown[]) => c[0]);
  }

  function _items(): any[] {
    return _sent()
      .filter((e) => "item" in e)
      .map((e) => e.item);
  }

  function _responses(): any[] {
    return _sent().filter((e) => e.type === "response.create");
  }

  async function _pushContextUpstream(): Promise<void> {
    await service._handleContext(service._context, FrameDirection.UPSTREAM);
  }

  async function _responseCreated(): Promise<void> {
    await service._handleEvtResponseCreated({ response: _response() });
  }

  /** Feed the service a response.done, which is where a held run fires. */
  async function _responseDone(): Promise<void> {
    await service._handleEvtResponseDone({
      response: _response(),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  }

  test("test_an_intermediate_result_goes_in_beside_the_call", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false }));

    const items = _items();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.type).toBe("message");
    const payload = asyncToolMessages.parseMessage({
      role: "developer",
      content: item.content[0].text,
    } as any);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("intermediate");
    expect(JSON.parse(payload!.result ?? "")).toEqual(WEATHER);
    // The call stays open for the result that settles it.
    expect(service._openFunctionCalls.has("call_1")).toBe(true);
  });

  test("test_a_final_result_answers_the_call", async () => {
    await service.pushFrame(_result(undefined, { isFinal: true }));

    const items = _items();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.type).toBe("function_call_output");
    expect(item.callId).toBe("call_1");
    expect(JSON.parse(item.output)).toEqual(WEATHER);
    expect(service._openFunctionCalls.has("call_1")).toBe(false);
  });

  test("test_a_result_for_a_call_the_api_lost_goes_in_as_a_message", async () => {
    // A reconnect replays the conversation as text, so the API no longer
    // knows the id and would reject an output for it.
    service._openFunctionCalls.clear();

    await service.pushFrame(_result(undefined, { isFinal: true }));

    const items = _items();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.type).toBe("message");
    const payload = asyncToolMessages.parseMessage({
      role: "developer",
      content: item.content[0].text,
    } as any);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("final");
  });

  test("test_nothing_runs_the_model_until_the_aggregator_asks", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false }));
    expect(_responses()).toEqual([]);

    await _pushContextUpstream();
    expect(_responses()).toHaveLength(1);
  });

  test("test_a_context_frame_from_downstream_records_rather_than_runs", async () => {
    await service.pushFrame(_result(undefined, { isFinal: false }));

    await service._handleContext(service._context, FrameDirection.DOWNSTREAM);

    expect(_responses()).toEqual([]);
  });

  test("test_a_run_asked_for_during_a_response_waits_for_it_to_finish", async () => {
    await _responseCreated();
    await service.pushFrame(_result(undefined, { isFinal: true }));

    await _pushContextUpstream();
    expect(_responses()).toEqual([]);

    await _responseDone();
    expect(_responses()).toHaveLength(1);
  });

  test("test_a_response_takes_in_what_was_delivered_before_it", async () => {
    await service.pushFrame(_result(undefined, { isFinal: true }));
    await _responseCreated();

    await _responseDone();
    await _pushContextUpstream();

    expect(_responses()).toEqual([]);
  });

  test("test_an_interruption_drops_a_run_that_was_waiting", async () => {
    await _responseCreated();
    await service.pushFrame(_result(undefined, { isFinal: true }));
    await _pushContextUpstream();

    await service._handleInterruption();
    await _responseDone();

    expect(_responses()).toEqual([]);
  });

  test("test_a_cancelled_call_is_settled", async () => {
    await service.pushFrame(
      new FunctionCallCancelFrame({ functionName: "delegate", toolCallId: "call_1" }),
    );

    const items = _items();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("function_call_output");
    expect(items[0].output).toBe("CANCELLED");
  });

  test("test_an_appended_message_goes_in_as_an_item_and_runs_when_the_aggregator_asks", async () => {
    await service._handleMessagesAppend(_append());

    const items = _items();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.type).toBe("message");
    expect(item.role).toBe(appendRole);
    expect(item.content[0].text).toBe("Backend: On it.");
    expect(_responses()).toEqual([]);

    await _pushContextUpstream();
    expect(_responses()).toHaveLength(1);
  });

  test("test_an_appended_message_nobody_asks_about_runs_nothing", async () => {
    await service._handleMessagesAppend(_append(undefined, { runLlm: false }));

    expect(_items()).toHaveLength(1);
    expect(_responses()).toEqual([]);
  });

  test("test_nothing_is_appended_before_the_conversation_is_set_up", async () => {
    service._llmNeedsConversationSetup = true;

    await service._handleMessagesAppend(_append());

    expect(_items()).toEqual([]);
  });

  test("test_the_context_scan_neither_errors_nor_resends", async () => {
    service.pushError = mock(async () => {});
    await service.pushFrame(_result(undefined, { isFinal: false }));
    await service.pushFrame(_result(undefined, { isFinal: true }));
    const sent = _items().length;

    // The same results, as the aggregator records them in the context.
    service._context.addMessage(
      asyncToolMessages.buildIntermediateResultMessage("call_1", JSON.stringify(WEATHER)),
    );
    service._context.addMessage(
      asyncToolMessages.buildFinalResultMessage("call_1", JSON.stringify(WEATHER)),
    );
    await _pushContextUpstream();

    expect(_items()).toHaveLength(sent);
    const complaints = service.pushError.mock.calls.map((c: unknown[]) => String(c[0] ?? ""));
    expect(complaints.filter((c: string) => c.includes("intermediate"))).toEqual([]);
  });
}

describe("TestGrokRealtimeIntermediateResults", () => {
  openAIProtocolIntermediateResultsTests(
    () => new GrokRealtimeLLMService({ apiKey: "test" }),
    "user",
  );
});
