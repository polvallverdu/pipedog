// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_get_llm_invocation_params.py

/**
 * Upstream's file covers every adapter. This file holds its Grok Realtime
 * cases (`TestGrokRealtimeGetLLMInvocationParams`, and the
 * `GrokRealtimeLLMAdapter` sub-test of `TestRealtimePackedHistoryKeepsNonAscii`);
 * the other adapters' cases live with their own packages. Upstream patches
 * the adapter module's `logger`; here `logger.warning` is spied on.
 */

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";

import { GrokRealtimeLLMAdapter } from "../src/grok_realtime_adapter.ts";

function _context(messages: Record<string, unknown>[]): LLMContext {
  return new LLMContext({ messages: messages as any });
}

describe("TestRealtimePackedHistoryKeepsNonAscii", () => {
  test("test_packed_history_is_not_escaped", async () => {
    // Multi-message history packed into one text item keeps non-ASCII text readable.
    const messages = [
      { role: "user", content: "मेरा ऑर्डर कहाँ है?" },
      { role: "assistant", content: "आपका ऑर्डर कल पहुँचेगा।" },
    ];
    const params = await new GrokRealtimeLLMAdapter().getLlmInvocationParams(_context(messages));
    const text = params.messages[0]!.content![0]!.text as string;
    expect(text).toContain("मेरा ऑर्डर कहाँ है?");
    expect(text).toContain("आपका ऑर्डर कल पहुँचेगा।");
  });
});

describe("TestGrokRealtimeGetLLMInvocationParams", () => {
  let adapter: GrokRealtimeLLMAdapter;

  beforeEach(() => {
    adapter = new GrokRealtimeLLMAdapter();
  });

  test("test_system_message_extracted_as_instruction", async () => {
    // Initial system message is extracted as system_instruction.
    const params = await adapter.getLlmInvocationParams(
      _context([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ]),
    );

    expect(params.system_instruction).toBe("You are helpful.");
    expect(params.messages).toHaveLength(1);
  });

  test("test_developer_message_becomes_user", async () => {
    // Developer message is converted to user, not extracted as system instruction.
    const params = await adapter.getLlmInvocationParams(
      _context([
        { role: "developer", content: "Extra context." },
        { role: "user", content: "Hello" },
      ]),
    );

    expect(params.system_instruction).toBeNull();
    // Developer converted to user, then packed with the other user message
    expect(params.messages).toHaveLength(1);
  });

  test("test_subsequent_developer_message_becomes_user", async () => {
    // Non-initial developer message is converted to user.
    const params = await adapter.getLlmInvocationParams(
      _context([
        { role: "system", content: "You are helpful." },
        { role: "developer", content: "Extra context." },
      ]),
    );

    expect(params.system_instruction).toBe("You are helpful.");
    expect(params.messages).toHaveLength(1);
  });

  test("test_empty_messages", async () => {
    // Empty messages list returns empty.
    const params = await adapter.getLlmInvocationParams(_context([]));

    expect(params.messages).toEqual([]);
    expect(params.system_instruction).toBeNull();
  });

  test("test_both_system_instruction_and_system_message_warns", async () => {
    // systemInstruction + initial system message warns and uses systemInstruction.
    const warning = spyOn(logger, "warning");
    let calls: number;
    let params: Awaited<ReturnType<GrokRealtimeLLMAdapter["getLlmInvocationParams"]>>;
    try {
      params = await adapter.getLlmInvocationParams(
        _context([
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ]),
        { systemInstruction: "Be concise." },
      );
      calls = warning.mock.calls.length;
    } finally {
      warning.mockRestore();
    }

    expect(calls).toBe(1);
    expect(params.system_instruction).toBe("Be concise.");
  });

  test("test_both_system_instruction_and_developer_message_no_warning", async () => {
    // systemInstruction + initial developer message: no warning, developer becomes user.
    const warning = spyOn(logger, "warning");
    let calls: number;
    let params: Awaited<ReturnType<GrokRealtimeLLMAdapter["getLlmInvocationParams"]>>;
    try {
      params = await adapter.getLlmInvocationParams(
        _context([
          { role: "developer", content: "Extra context." },
          { role: "user", content: "Hello" },
        ]),
        { systemInstruction: "Be concise." },
      );
      calls = warning.mock.calls.length;
    } finally {
      warning.mockRestore();
    }

    expect(calls).toBe(0);
    expect(params.system_instruction).toBe("Be concise.");
  });

  test("test_system_instruction_only", async () => {
    // systemInstruction without context system message returns systemInstruction.
    const params = await adapter.getLlmInvocationParams(
      _context([{ role: "user", content: "Hello" }]),
      { systemInstruction: "Be concise." },
    );

    expect(params.system_instruction).toBe("Be concise.");
  });
});
