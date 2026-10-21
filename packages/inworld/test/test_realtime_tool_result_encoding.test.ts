// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_realtime_tool_result_encoding.py

/**
 * The context aggregator stores tool call results as already JSON-encoded
 * strings. `_sendToolResult()` on the realtime LLM services must send that
 * string through unchanged, not re-encode it with another `json.dumps()`
 * (which would turn `{"temp": 72}` into the string literal `"{\"temp\": 72}"`).
 *
 * Upstream's file covers every realtime service. This file holds its Inworld
 * section (`TestInworldRealtimeToolResultEncoding`); the other providers'
 * sections live with their own packages.
 */

import { describe, expect, mock, test } from "bun:test";

import { InworldRealtimeLLMService } from "../src/realtime/llm.ts";

describe("TestInworldRealtimeToolResultEncoding", () => {
  test("test_send_tool_result_passes_through_pre_encoded_json", async () => {
    const service: any = new InworldRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});

    const alreadyEncoded = '{"temperature": 72}';
    await service._sendToolResult("call_123", alreadyEncoded);

    const calls = service.sendClientEvent.mock.calls;
    const sentEvent = calls[calls.length - 1][0];
    expect(sentEvent.item.output).toBe(alreadyEncoded);
  });
});
