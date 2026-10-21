// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Azure OpenAI services (LLM, Realtime, image) against local fakes: the API
 * surface the endpoint selects, the auth headers, the realtime URL, and the
 * image submit/poll/download flow.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { BaseObject } from "@pipedog/core/utils/base_object";
import type OpenAI from "openai";
import { AzureOpenAI } from "openai";

import { AzureImageGenServiceREST } from "../src/image.ts";
import { AzureLLMService, DATED_API_VERSION } from "../src/llm.ts";
import { AzureRealtimeLLMService } from "../src/realtime/llm.ts";

type Server = ReturnType<typeof Bun.serve>;
let server: Server | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

interface SeenRequest {
  url: string;
  headers: Headers;
}

/** A fake chat-completions endpoint that records each request. */
function startChatServer(seen: SeenRequest[]): Server {
  return Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ url: req.url, headers: req.headers });
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "my-deployment",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
}

function clientOf(service: AzureLLMService): OpenAI {
  return (service as unknown as { _client: OpenAI })._client;
}

describe("AzureLLMService", () => {
  test("requires an api key or a token provider", () => {
    expect(() => new AzureLLMService({ endpoint: "https://r.openai.azure.com" })).toThrow(
      "Either `api_key` or `token_provider` is required.",
    );
  });

  test("a /openai/v1 endpoint uses the plain OpenAI client at that base URL", () => {
    const service = new AzureLLMService({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com/openai/v1/",
    });
    const client = clientOf(service);
    expect(client).not.toBeInstanceOf(AzureOpenAI);
    expect(client.baseURL).toBe("https://r.openai.azure.com/openai/v1/");
    expect(client.apiKey).toBe("k");
  });

  test("other endpoints use AzureOpenAI with the dated api-version", () => {
    const service = new AzureLLMService({ apiKey: "k", endpoint: "https://r.openai.azure.com" });
    const client = clientOf(service) as AzureOpenAI;
    expect(client).toBeInstanceOf(AzureOpenAI);
    expect(client.apiVersion).toBe(DATED_API_VERSION);
    expect(client.baseURL).toBe("https://r.openai.azure.com/openai");
  });

  test("the model defaults to gpt-4.1 and settings name the deployment", () => {
    const service = new AzureLLMService({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com/openai/v1",
      settings: new AzureLLMService.Settings({ model: "my-deployment" }),
    });
    expect((service as unknown as { _settings: { model: string } })._settings.model).toBe(
      "my-deployment",
    );
  });

  test("dated surface sends api-key and api-version", async () => {
    const seen: SeenRequest[] = [];
    server = startChatServer(seen);
    const service = new AzureLLMService({
      apiKey: "azure-key",
      endpoint: `http://localhost:${server.port}`,
    });
    await clientOf(service).chat.completions.create({
      model: "my-deployment",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/openai/deployments/my-deployment/chat/completions");
    expect(url.searchParams.get("api-version")).toBe(DATED_API_VERSION);
    expect(seen[0]!.headers.get("api-key")).toBe("azure-key");
  });

  test("v1 surface with a token provider sends a bearer token", async () => {
    const seen: SeenRequest[] = [];
    server = startChatServer(seen);
    const service = new AzureLLMService({
      tokenProvider: async () => "entra-token",
      endpoint: `http://localhost:${server.port}/openai/v1`,
    });
    await clientOf(service).chat.completions.create({
      model: "my-deployment",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/openai/v1/chat/completions");
    expect(url.searchParams.get("api-version")).toBeNull();
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer entra-token");
  });

  test("dated surface with a token provider sends a bearer token", async () => {
    const seen: SeenRequest[] = [];
    server = startChatServer(seen);
    const service = new AzureLLMService({
      tokenProvider: async () => "entra-token",
      endpoint: `http://localhost:${server.port}`,
    });
    await clientOf(service).chat.completions.create({
      model: "my-deployment",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer entra-token");
    expect(seen[0]!.headers.get("api-key")).toBeNull();
  });
});

describe("AzureRealtimeLLMService", () => {
  /** A websocket server that records the upgrade request. */
  function startWsServer(seen: SeenRequest[]): Server {
    return Bun.serve({
      port: 0,
      fetch(req, srv) {
        seen.push({ url: req.url, headers: req.headers });
        if (srv.upgrade(req)) return undefined;
        return new Response("expected a websocket", { status: 400 });
      },
      websocket: { message() {} },
    });
  }

  type Internals = {
    baseUrl: string;
    _connect(): Promise<void>;
    _disconnect(): Promise<void>;
  };

  test("requires an api key or a token provider", () => {
    expect(
      () => new AzureRealtimeLLMService({ baseUrl: "wss://r.openai.azure.com/openai/v1/realtime" }),
    ).toThrow("Either `api_key` or `token_provider` is required.");
  });

  test("appends the deployment, unless the URL has a query", () => {
    const plain = new AzureRealtimeLLMService({
      apiKey: "k",
      baseUrl: "wss://r.openai.azure.com/openai/v1/realtime",
      settings: new AzureRealtimeLLMService.Settings({ model: "my-deployment" }),
    }) as unknown as Internals;
    expect(plain.baseUrl).toBe("wss://r.openai.azure.com/openai/v1/realtime?model=my-deployment");

    const verbatim = new AzureRealtimeLLMService({
      apiKey: "k",
      baseUrl: "wss://r.openai.azure.com/openai/v1/realtime?model=other",
    }) as unknown as Internals;
    expect(verbatim.baseUrl).toBe("wss://r.openai.azure.com/openai/v1/realtime?model=other");
  });

  test("connects with the api-key header", async () => {
    const seen: SeenRequest[] = [];
    server = startWsServer(seen);
    const service = new AzureRealtimeLLMService({
      apiKey: "azure-key",
      baseUrl: `ws://localhost:${server.port}/openai/v1/realtime`,
      settings: new AzureRealtimeLLMService.Settings({ model: "my-deployment" }),
    }) as unknown as Internals;
    await BaseObject.prototype.setup.call(service, new TaskManager());
    await service._connect();
    await service._disconnect();
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/openai/v1/realtime");
    expect(url.searchParams.get("model")).toBe("my-deployment");
    expect(seen[0]!.headers.get("api-key")).toBe("azure-key");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
  });

  test("connects with a bearer token from the token provider", async () => {
    const seen: SeenRequest[] = [];
    server = startWsServer(seen);
    const service = new AzureRealtimeLLMService({
      tokenProvider: async () => "entra-token",
      baseUrl: `ws://localhost:${server.port}/openai/v1/realtime`,
    }) as unknown as Internals;
    await BaseObject.prototype.setup.call(service, new TaskManager());
    await service._connect();
    await service._disconnect();
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer entra-token");
    expect(seen[0]!.headers.get("api-key")).toBeNull();
  });
});

describe("AzureImageGenServiceREST", () => {
  async function collect(gen: AsyncGenerator<Frame, void, unknown>): Promise<Frame[]> {
    const out: Frame[] = [];
    for await (const f of gen) out.push(f);
    return out;
  }

  test("submits, polls the operation and downloads the image", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("generations:submit")) {
        return new Response("{}", {
          status: 202,
          headers: { "operation-location": "https://r.openai.azure.com/operations/1" },
        });
      }
      if (url.endsWith("/operations/1")) {
        return Response.json({
          status: "succeeded",
          result: { data: [{ url: "https://blob/img.png" }] },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;

    const service = new AzureImageGenServiceREST({
      apiKey: "azure-key",
      endpoint: "https://r.openai.azure.com/",
      fetch: fakeFetch,
      decodeImage: () => ({ image: new Uint8Array(12), size: [2, 2] }),
      settings: new AzureImageGenServiceREST.Settings({ imageSize: "1024x1024" }),
    });

    const frames = await collect(service.runImageGen("a cat"));

    expect(calls[0]!.url).toBe(
      "https://r.openai.azure.com/openai/images/generations:submit?api-version=2023-06-01-preview",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      prompt: "a cat",
      n: 1,
      size: "1024x1024",
    });
    expect((calls[0]!.init!.headers as Record<string, string>)["api-key"]).toBe("azure-key");
    expect(calls[1]!.url).toBe("https://r.openai.azure.com/operations/1");
    expect(calls[2]!.url).toBe("https://blob/img.png");

    expect(frames).toHaveLength(1);
    const frame = frames[0] as URLImageRawFrame;
    expect(frame).toBeInstanceOf(URLImageRawFrame);
    expect(frame.url).toBe("https://blob/img.png");
    expect(frame.size).toEqual([2, 2]);
    expect(frame.format).toBe("RGB");
  });

  test("a result without a URL is an error", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("generations:submit")) {
        return new Response("{}", { headers: { "operation-location": "https://op" } });
      }
      return Response.json({ status: "succeeded", result: { data: [{ url: null }] } });
    }) as typeof fetch;

    const service = new AzureImageGenServiceREST({
      apiKey: "k",
      endpoint: "https://r.openai.azure.com/",
      fetch: fakeFetch,
    });
    const frames = await collect(service.runImageGen("a cat"));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toBe("Image generation failed");
  });
});
