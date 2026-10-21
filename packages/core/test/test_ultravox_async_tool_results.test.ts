// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ultravox_async_tool_results.py

/**
 * Ultravox delivers a tool's result once, on the channel its call is on.
 *
 * An async call gets a placeholder `client_tool_result` as soon as Ultravox
 * invokes it, so its actual result has to reach the model as user-side text
 * whether the context holds it as a deferred async message or, when it arrived
 * before the conversation moved on, as an ordinary tool result. A synchronous
 * call's result goes out as the `client_tool_result` itself.
 *
 * The service lives in `@pipedog/ultravox`; it is imported from its source so
 * this core test needs no package dependency on it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as mod from "../../ultravox/src/llm.ts";
import * as asyncToolMessages from "../src/processors/aggregators/async_tool_messages.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";

// The tests reach into the service's protected members, as upstream does.
type AnyService = any;

function _format(template: string, toolCallId: string, result: string): string {
  // Python's str.format with the template's named fields.
  return template.replace("{tool_call_id}", toolCallId).replace("{result}", result);
}

describe("TestUltravoxToolResultDelivery", () => {
  let service: AnyService;

  beforeEach(() => {
    service = new mod.UltravoxRealtimeLLMService({
      params: new mod.OneShotInputParams({ apiKey: "test-key", systemPrompt: "test" }),
    });
    service._send = mock(async () => {});
    service._sendUserText = mock(async () => {});
  });

  function _toolResult(toolCallId: string, content: string): Record<string, unknown> {
    return { role: "tool", tool_call_id: toolCallId, content };
  }

  test("test_sync_result_is_sent_as_client_tool_result", async () => {
    const context = new LLMContext({
      messages: [_toolResult("call-1", '{"temperature": 72}')] as any,
    });

    await service._handleContext(context);

    expect(service._send).toHaveBeenCalledTimes(1);
    expect(service._send).toHaveBeenCalledWith({
      type: "client_tool_result",
      invocationId: "call-1",
      result: '{"temperature": 72}',
    });
    expect(service._sendUserText).not.toHaveBeenCalled();
    expect(service._completedToolCalls.has("call-1")).toBe(true);
  });

  test("test_async_result_settled_in_place_is_sent_as_user_text", async () => {
    // The placeholder already answered the invocation on Ultravox's side.
    service._startedPlaceholderSent.add("call-1");
    const context = new LLMContext({
      messages: [_toolResult("call-1", '{"temperature": 72}')] as any,
    });

    await service._handleContext(context);

    expect(service._send).not.toHaveBeenCalled();
    expect(service._sendUserText).toHaveBeenCalledTimes(1);
    expect(service._sendUserText).toHaveBeenCalledWith(
      _format(mod._ASYNC_TOOL_FINAL_RESULT_TEMPLATE, "call-1", '{"temperature": 72}'),
    );
    expect(service._completedToolCalls.has("call-1")).toBe(true);
  });

  test("test_deferred_async_result_is_sent_as_user_text", async () => {
    service._startedPlaceholderSent.add("call-1");
    const context = new LLMContext({
      messages: [
        asyncToolMessages.buildStartedMessage("call-1"),
        asyncToolMessages.buildFinalResultMessage("call-1", '{"temperature": 72}'),
      ],
    });

    await service._handleContext(context);

    expect(service._send).not.toHaveBeenCalled();
    expect(service._sendUserText).toHaveBeenCalledTimes(1);
    expect(service._sendUserText).toHaveBeenCalledWith(
      _format(mod._ASYNC_TOOL_FINAL_RESULT_TEMPLATE, "call-1", '{"temperature": 72}'),
    );
  });

  test("test_result_is_delivered_once_across_context_pushes", async () => {
    service._startedPlaceholderSent.add("call-1");
    const context = new LLMContext({
      messages: [_toolResult("call-1", '{"temperature": 72}')] as any,
    });

    await service._handleContext(context);
    await service._handleContext(context);

    expect(service._sendUserText).toHaveBeenCalledTimes(1);
  });
});
