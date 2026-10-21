// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_get_llm_invocation_params.py

/**
 * Upstream's file covers every adapter. This file holds its Inworld Realtime
 * case (the `InworldRealtimeLLMAdapter` sub-test of
 * `TestRealtimePackedHistoryKeepsNonAscii`); the other adapters' cases live
 * with their own packages.
 */

import { describe, expect, test } from "bun:test";

import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

import { InworldRealtimeLLMAdapter } from "../src/inworld_realtime_adapter.ts";

describe("TestRealtimePackedHistoryKeepsNonAscii", () => {
  test("test_packed_history_is_not_escaped", async () => {
    // Multi-message history packed into one text item keeps non-ASCII text readable.
    const messages = [
      { role: "user", content: "मेरा ऑर्डर कहाँ है?" },
      { role: "assistant", content: "आपका ऑर्डर कल पहुँचेगा।" },
    ];
    const params = await new InworldRealtimeLLMAdapter().getLlmInvocationParams(
      new LLMContext({ messages: messages as any }),
    );
    const text = params.messages[0]!.content![0]!.text as string;
    expect(text).toContain("मेरा ऑर्डर कहाँ है?");
    expect(text).toContain("आपका ऑर्डर कल पहुँचेगा।");
  });
});
