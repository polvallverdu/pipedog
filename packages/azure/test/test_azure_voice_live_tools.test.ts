// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_tools.py

/**
 * Tests for function calls in AzureVoiceLiveLLMService.
 *
 * Voice Live announces a call as a `function_call` item and sends its
 * arguments in `response.function_call_arguments.done`; the service runs the
 * call then. Results come back through the context, either as regular tool
 * messages or, for tools registered with `cancelOnInterruption: false`, as
 * async-tool messages.
 */

import { expect, test } from "bun:test";

import * as asyncToolMessages from "@pipedog/core/processors/aggregators/async_tool_messages";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallFromLLM } from "@pipedog/core/services/llm_service";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import * as events from "../src/voice_live/events.ts";
import { AzureVoiceLiveLLMService } from "../src/voice_live/llm.ts";

// The protected members these tests reach into, as upstream does.
type Internals = any;
type Dict = Record<string, unknown>;

const CALL_ID = "call_1";

/** Records the client events sent via `sendClientEvent`. */
class _EventRecorder {
  events: events.ClientEvent[] = [];

  readonly call = async (event: events.ClientEvent): Promise<void> => {
    this.events.push(event);
  };

  toolOutputs(): [string | null, string | null][] {
    return this.events
      .filter(
        (e): e is events.ConversationItemCreateEvent =>
          e instanceof events.ConversationItemCreateEvent && e.item.type === "function_call_output",
      )
      .map((e) => [e.item.callId, e.item.output]);
  }

  responsesCreated(): number {
    return this.events.filter((e) => e instanceof events.ResponseCreateEvent).length;
  }
}

/** Records the messages passed to `pushError`. */
class _ErrorRecorder {
  messages: string[] = [];

  readonly call = async (errorMsg: string): Promise<void> => {
    this.messages.push(errorMsg);
  };
}

/** Async-iterable websocket that yields scripted JSON strings. */
class _ScriptedWebSocket {
  private readonly _messages: string[];

  constructor(messages: string[]) {
    this._messages = [...messages];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (this._messages.length > 0) {
      yield this._messages.shift()!;
    }
  }
}

/** Stand-in for methods that need a linked processor. */
async function _ignore(..._args: unknown[]): Promise<void> {}

/** Construct a service with recorded client events and errors, and no connection. */
function _makeService(): [Internals, _EventRecorder, _ErrorRecorder] {
  const service: Internals = new AzureVoiceLiveLLMService({
    apiKey: "test-key",
    endpoint: "https://my-resource.services.ai.azure.com",
  });
  const sent = new _EventRecorder();
  const errors = new _ErrorRecorder();
  service.sendClientEvent = sent.call;
  service.pushError = errors.call;
  service.pushFrame = _ignore;
  service.startProcessingMetrics = _ignore;
  service.startTtfbMetrics = _ignore;
  // The session is configured by the time tool results arrive.
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  return [service, sent, errors];
}

function _functionCallItem(name = "get_current_weather"): Dict {
  return {
    id: "item_call",
    object: "realtime.item",
    type: "function_call",
    status: "in_progress",
    call_id: CALL_ID,
    name,
    arguments: "",
  };
}

function _argumentsDone(name: string | null, callId: string = CALL_ID): Dict {
  return {
    type: "response.function_call_arguments.done",
    event_id: "event_args",
    response_id: "resp_1",
    item_id: "item_call",
    output_index: 0,
    call_id: callId,
    name,
    arguments: pyJsonDumps({ location: "Hyderabad", format: "celsius" }),
  };
}

/** Feed scripted server-event dicts through the receive handler. */
async function _drive(service: Internals, scripted: Dict[]): Promise<void> {
  service._websocket = new _ScriptedWebSocket(scripted.map((e) => pyJsonDumps(e)));
  await service._receiveTaskHandler();
}

test.each([
  ["named", "get_current_weather"],
  ["name-from-item", null],
])(
  "test_a_function_call_runs_once_its_arguments_are_done[%s]",
  async (_id, nameInArgumentsEvent) => {
    // The call item is announced twice, by conversation.item.created and
    // response.output_item.added, and runs once.
    const [service] = _makeService();
    service._context = new LLMContext();
    const calls: FunctionCallFromLLM[] = [];

    service.runFunctionCalls = async (functionCalls: FunctionCallFromLLM[]) => {
      calls.push(...functionCalls);
    };

    await _drive(service, [
      { type: "conversation.item.created", event_id: "e1", item: _functionCallItem() },
      {
        type: "response.output_item.added",
        event_id: "e2",
        response_id: "resp_1",
        output_index: 0,
        item: _functionCallItem(),
      },
      _argumentsDone(nameInArgumentsEvent),
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0]!.functionName).toBe("get_current_weather");
    expect(calls[0]!.toolCallId).toBe(CALL_ID);
    expect(calls[0]!.arguments).toEqual({ location: "Hyderabad", format: "celsius" });
    expect(service._pendingFunctionCalls.size).toBe(0);
  },
);

test("test_arguments_for_an_unannounced_call_run_nothing", async () => {
  const [service] = _makeService();
  service._context = new LLMContext();
  const calls: FunctionCallFromLLM[] = [];

  service.runFunctionCalls = async (functionCalls: FunctionCallFromLLM[]) => {
    calls.push(...functionCalls);
  };

  await _drive(service, [_argumentsDone("get_current_weather", "call_unknown")]);

  expect(calls).toEqual([]);
});

test("test_a_tool_result_is_sent_and_answered", async () => {
  const [service, sent] = _makeService();
  const context = new LLMContext();
  await service._handleContext(context);
  service._responseInFlight = false;
  sent.events.length = 0;

  context.addMessage({ role: "tool", tool_call_id: CALL_ID, content: '{"temp": 24}' });
  await service._handleContext(context);

  expect(sent.toolOutputs()).toEqual([[CALL_ID, '{"temp": 24}']]);
  expect(sent.responsesCreated()).toBe(1);
});

test("test_an_async_tool_final_result_is_sent_like_a_regular_one", async () => {
  // The started marker needs nothing sent: Voice Live is already waiting on the call.
  const [service, sent, errors] = _makeService();
  const context = new LLMContext({
    messages: [asyncToolMessages.buildStartedMessage(CALL_ID)],
  });
  await service._handleContext(context);
  service._responseInFlight = false;
  sent.events.length = 0;

  expect(sent.toolOutputs()).toEqual([]);

  context.addMessage(asyncToolMessages.buildFinalResultMessage(CALL_ID, '{"temp": 24}'));
  await service._handleContext(context);
  await service._handleContext(context);

  expect(sent.toolOutputs()).toEqual([[CALL_ID, '{"temp": 24}']]);
  expect(sent.responsesCreated()).toBe(1);
  expect(errors.messages).toEqual([]);
});

test("test_an_async_tool_intermediate_result_is_dropped_with_an_error", async () => {
  // Voice Live has no channel for streamed results.
  const [service, sent, errors] = _makeService();
  const context = new LLMContext({
    messages: [asyncToolMessages.buildStartedMessage(CALL_ID)],
  });
  await service._handleContext(context);
  service._responseInFlight = false;
  sent.events.length = 0;

  context.addMessage(asyncToolMessages.buildIntermediateResultMessage(CALL_ID, '{"progress": 50}'));
  await service._handleContext(context);

  expect(sent.toolOutputs()).toEqual([]);
  expect(sent.responsesCreated()).toBe(0);
  expect(errors.messages.length).toBe(1);
  expect(errors.messages[0]).toContain("streamed");
});
