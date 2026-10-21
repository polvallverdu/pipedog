// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ollama_llm.py

/** Unit tests for the Ollama LLM service's client configuration. */

import { expect, test } from "bun:test";
import { OLLamaLLMService } from "../src/llm.ts";

test("test_api_key_is_sent_to_the_server", () => {
  const service: any = new OLLamaLLMService({ apiKey: "proxy-key" });

  expect(service._client.apiKey).toBe("proxy-key");
});

test("test_local_ollama_needs_no_api_key", () => {
  const service: any = new OLLamaLLMService();

  expect(service._client.apiKey).toBe("ollama");
});
