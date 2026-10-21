// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// CerebrasLLMService against a local OpenAI-compatible server (the examples' mock), and
// its client setup: the API key it requires, and the default base URL. The
// key checks follow upstream's tests/test_openai_compatible_api_key.py, whose
// port (with every provider) belongs to another package.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { LLMContextFrame, LLMTextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";
import { type MockOpenAI, startMockOpenAI } from "../../../examples/test-mocks/src/mock_openai.ts";
import { CerebrasLLMService } from "../src/llm.ts";

let savedKey: string | undefined;

beforeEach(() => {
  // A key for OpenAI itself, which must never reach another provider.
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "openai-key";
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

describe("CerebrasLLMService client", () => {
  test.each([[undefined], [""]])("a missing API key raises (%p)", (apiKey) => {
    expect(() => new CerebrasLLMService({ apiKey: apiKey as any })).toThrow("requires an api_key");
  });

  test("the explicit API key is used", () => {
    const service: any = new CerebrasLLMService({ apiKey: "provider-key" });
    expect(service._client.apiKey).toBe("provider-key");
  });

  test("uses the provider's base URL by default", () => {
    const service: any = new CerebrasLLMService({ apiKey: "provider-key" });
    expect(service._client.baseURL).toBe("https://api.cerebras.ai/v1");
  });

  test("defaults to gpt-oss-120b", () => {
    const service: any = new CerebrasLLMService({ apiKey: "provider-key" });
    expect(service._settings.model).toBe("gpt-oss-120b");
  });

  test("sends developer messages as is", () => {
    expect(CerebrasLLMService.supportsDeveloperRole).toBe(true);
  });
});

describe("CerebrasLLMService with a local OpenAI-compatible server", () => {
  let server: MockOpenAI;

  beforeAll(() => {
    server = startMockOpenAI();
  });

  afterAll(() => {
    server.stop();
  });

  test("streams the reply and sends the provider key", async () => {
    const service = new CerebrasLLMService({ apiKey: "provider-key", baseUrl: server.baseUrl });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const [down] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context })],
    });

    const text = down
      .filter((f) => f instanceof LLMTextFrame)
      .map((f) => (f as LLMTextFrame).text)
      .join("");
    expect(text).toBe("Hello, I am your voice assistant. Ask me anything.");

    const request = server.chatRequests.at(-1)!;
    expect(request.authorization).toBe("Bearer provider-key");
    expect(request.body.model).toBe("gpt-oss-120b");
    expect(request.body.stream).toBe(true);
    expect(request.body.messages.at(-1)).toEqual({ role: "user", content: "Hello" });
  });
});
