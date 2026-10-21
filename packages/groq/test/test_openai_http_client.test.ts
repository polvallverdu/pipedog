// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_http_client.py

/**
 * Unit tests for custom http_client support in OpenAI TTS and Whisper-based STT
 * services.
 *
 * Porting notes:
 * - `http_client` (an httpx client) is `httpClient`, a custom `fetch` that the
 *   OpenAI JS SDK stores as `client.fetch`. `assertIs(service._client._client,
 *   http_client)` → `expect(service._client.fetch).toBe(httpClient)`.
 * - DIVERGENCE: `fetch` has no timeout object, so the `timeout` assertions
 *   are dropped. The custom-client tests instead check that a request goes
 *   through the custom `fetch`.
 */

import { describe, expect, mock, test } from "bun:test";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { GroqSTTService } from "../src/stt.ts";

function makeHttpClient() {
  return mock(async (_input: unknown, _init?: unknown) =>
    Response.json({ data: [], object: "list" }),
  ) as unknown as typeof fetch & ReturnType<typeof mock>;
}

async function usesClient(service: any, httpClient: ReturnType<typeof makeHttpClient>) {
  await service._client.models.list();
  expect(httpClient).toHaveBeenCalled();
}

describe("TestOpenAIHttpClient", () => {
  test("test_openai_tts_uses_custom_http_client", async () => {
    const httpClient = makeHttpClient();
    const service: any = new OpenAITTSService({ apiKey: "test-key", httpClient });
    expect(service._client.fetch).toBe(httpClient);
    await usesClient(service, httpClient);
  });

  test("test_openai_stt_uses_custom_http_client", async () => {
    const httpClient = makeHttpClient();
    const service: any = new OpenAISTTService({ apiKey: "test-key", httpClient });
    expect(service._client.fetch).toBe(httpClient);
    await usesClient(service, httpClient);
  });

  test("test_groq_stt_uses_custom_http_client", async () => {
    const httpClient = makeHttpClient();
    const service: any = new GroqSTTService({ apiKey: "test-key", httpClient });
    expect(service._client.fetch).toBe(httpClient);
    await usesClient(service, httpClient);
  });

  test("test_openai_tts_defaults_to_sdk_client", () => {
    const service: any = new OpenAITTSService({ apiKey: "test-key" });
    expect(typeof service._client.fetch).toBe("function");
  });

  test("test_openai_stt_defaults_to_sdk_client", () => {
    const service: any = new OpenAISTTService({ apiKey: "test-key" });
    expect(typeof service._client.fetch).toBe("function");
  });
});
