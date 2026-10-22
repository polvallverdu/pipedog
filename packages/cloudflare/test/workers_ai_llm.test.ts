// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// WorkersAILLMService: its client setup (account URL, token), and a streamed
// reply from a local OpenAI-compatible server (the examples' mock).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LLMContextFrame, LLMTextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";
import { type MockOpenAI, startMockOpenAI } from "../../../examples/test-mocks/src/mock_openai.ts";
import { WorkersAIClient } from "../src/client.ts";
import { DEFAULT_WORKERS_AI_LLM_MODEL, WorkersAILLMService } from "../src/llm.ts";

describe("WorkersAILLMService client", () => {
  test("builds the account's OpenAI-compatible URL and uses the token as the key", () => {
    const service: any = new WorkersAILLMService({ accountId: "acc", apiToken: "tok" });
    expect(service._client.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1");
    expect(service._client.apiKey).toBe("tok");
    expect(service._settings.model).toBe(DEFAULT_WORKERS_AI_LLM_MODEL);
  });

  test("takes the account and token from a REST client", () => {
    const client = new WorkersAIClient({ accountId: "acc2", apiToken: "tok2" });
    const service: any = new WorkersAILLMService({ client });
    expect(service._client.baseURL).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc2/ai/v1",
    );
    expect(service._client.apiKey).toBe("tok2");
  });

  test("needs a token", () => {
    expect(() => new WorkersAILLMService({ accountId: "acc" })).toThrow("requires an api_key");
  });

  test("needs an account", () => {
    expect(() => new WorkersAILLMService({ apiToken: "tok" })).toThrow("accountId");
  });

  test("a binding-only client is refused with an explanation", () => {
    const client = new WorkersAIClient({ ai: { run: async () => ({}) } });
    expect(() => new WorkersAILLMService({ client })).toThrow("REST API");
  });
});

describe("WorkersAILLMService with a local OpenAI-compatible server", () => {
  let server: MockOpenAI;

  beforeAll(() => {
    server = startMockOpenAI();
  });

  afterAll(() => {
    server.stop();
  });

  test("streams the reply, sending the token and the Workers AI model", async () => {
    const service = new WorkersAILLMService({
      apiToken: "cf-token",
      baseUrl: server.baseUrl,
      settings: new WorkersAILLMService.Settings({ model: "@cf/zai-org/glm-4.7-flash" }),
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const [down] = await runTest(service, { framesToSend: [new LLMContextFrame({ context })] });

    const text = down
      .filter((f) => f instanceof LLMTextFrame)
      .map((f) => (f as LLMTextFrame).text)
      .join("");
    expect(text).toBe("Hello, I am your voice assistant. Ask me anything.");
    const request = server.chatRequests.at(-1)!;
    expect(request.authorization).toBe("Bearer cf-token");
    expect((request.body as { model: string }).model).toBe("@cf/zai-org/glm-4.7-flash");
  });
});
