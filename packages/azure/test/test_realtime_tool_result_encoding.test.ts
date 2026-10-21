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
 */

import { describe, expect, mock, test } from "bun:test";

import { OpenAIRealtimeLLMService } from "@pipedog/openai/realtime/llm";

// Imported by relative path: a test-only `workspace:` devDependency can't be published.
import { InworldRealtimeLLMService } from "../../inworld/src/realtime/llm.ts";
import { GrokRealtimeLLMService } from "../../xai/src/realtime/llm.ts";
import { AzureVoiceLiveLLMService } from "../src/voice_live/llm.ts";

// The protected members these tests reach into, as upstream does.
type Internals = any;

function _sentEvent(service: Internals): Internals {
  return service.sendClientEvent.mock.calls[0][0];
}

describe("TestOpenAIRealtimeToolResultEncoding", () => {
  test("test_send_tool_result_passes_through_pre_encoded_json", async () => {
    const service: Internals = new OpenAIRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});

    const alreadyEncoded = '{"temperature": 72}';
    await service._sendToolResult("call_123", alreadyEncoded);

    expect(_sentEvent(service).item.output).toBe(alreadyEncoded);
  });

  test("test_send_tool_result_preserves_completed_sentinel", async () => {
    const service: Internals = new OpenAIRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});

    await service._sendToolResult("call_123", "COMPLETED");

    expect(_sentEvent(service).item.output).toBe("COMPLETED");
  });
});

describe("TestInworldRealtimeToolResultEncoding", () => {
  test("test_send_tool_result_passes_through_pre_encoded_json", async () => {
    const service: Internals = new InworldRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});

    const alreadyEncoded = '{"temperature": 72}';
    await service._sendToolResult("call_123", alreadyEncoded);

    expect(_sentEvent(service).item.output).toBe(alreadyEncoded);
  });
});

describe("TestAzureVoiceLiveToolResultEncoding", () => {
  test("test_send_tool_result_passes_through_pre_encoded_json", async () => {
    const service: Internals = new AzureVoiceLiveLLMService({
      endpoint: "https://my-resource.services.ai.azure.com",
      apiKey: "test",
    });
    service.sendClientEvent = mock(async () => {});

    const alreadyEncoded = '{"temperature": 72}';
    await service._sendToolResult("call_123", alreadyEncoded);

    expect(_sentEvent(service).item.output).toBe(alreadyEncoded);
  });
});

describe("TestXAIRealtimeToolResultEncoding", () => {
  test("test_send_tool_result_passes_through_pre_encoded_json", async () => {
    const service: Internals = new GrokRealtimeLLMService({ apiKey: "test" });
    service.sendClientEvent = mock(async () => {});

    const alreadyEncoded = '{"temperature": 72}';
    await service._sendToolResult("call_123", alreadyEncoded);

    expect(_sentEvent(service).item.output).toBe(alreadyEncoded);
  });
});
