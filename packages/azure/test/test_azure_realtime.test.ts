// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_realtime.py

import { expect, test } from "bun:test";

import { AzureRealtimeLLMService } from "../src/realtime/llm.ts";

const BASE_URL = "wss://my-resource.openai.azure.com/openai/v1/realtime";

/** Exposes the protected `_authHeaders()` for the test, as Python reaches `_auth_headers()`. */
function authHeaders(service: AzureRealtimeLLMService): Promise<Record<string, string>> {
  return (service as unknown as { _authHeaders(): Promise<Record<string, string>> })._authHeaders();
}

test("test_auth_headers_use_api_key", async () => {
  const service = new AzureRealtimeLLMService({ baseUrl: BASE_URL, apiKey: "test-key" });

  expect(await authHeaders(service)).toEqual({ "api-key": "test-key" });
});

test("test_auth_headers_prefer_token_provider", async () => {
  const tokenProvider = async () => "entra-token";

  const service = new AzureRealtimeLLMService({ baseUrl: BASE_URL, tokenProvider });

  expect(await authHeaders(service)).toEqual({ Authorization: "Bearer entra-token" });
});
