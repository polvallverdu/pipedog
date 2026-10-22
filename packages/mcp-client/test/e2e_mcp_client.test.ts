// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End to end: MCPClient against real MCP servers built with the official SDK, over each transport
// (a spawned stdio process, streamable HTTP and SSE served by Bun.serve), then through a real
// pipeline with a real LLM service, once per provider (OpenAI, Google). The provider APIs are
// replaced by the scripted tool-calling mock in examples/test-mocks, so the test needs no API key.
// The model calls an MCP tool, the call goes over the wire to the server, and the result comes back
// into the conversation as the model's next input.

import { afterEach, describe, expect, test } from "bun:test";
import { Event, waitFor } from "@pipedog/asyncio";
import { EndFrame, type Frame, LLMRunFrame, LLMTextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { GoogleLLMService } from "@pipedog/google/llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import {
  type MockToolLLM,
  startMockToolLLM,
  type ToolLLMProvider,
  type ToolLLMScript,
} from "../../../examples/test-mocks/src/mock_tool_llm.ts";
import {
  MCPClient,
  type MCPClientOptions,
  type ServerParameters,
  SseServerParameters,
  StdioServerParameters,
  StreamableHttpParameters,
} from "../src/mcp_service.ts";
import { inProcessFetch, SseMcpServer, StreamableHttpMcpServer } from "./fixtures/servers.ts";

const STDIO_SERVER = new URL("./fixtures/stdio_server.ts", import.meta.url).pathname;

/** A running MCP server and how to reach it. */
interface Harness {
  name: string;
  params(options?: { headers?: Record<string, string> }): ServerParameters;
  /** Sessions or connections the server holds open right now. */
  open(): number;
  /** Sessions or connections a client has ended. */
  ended(): number;
  stop(): void;
}

function startStdio(): Harness {
  return {
    name: "stdio",
    params: () => new StdioServerParameters({ command: process.execPath, args: [STDIO_SERVER] }),
    // The server is a child process of the client: it is gone when the client closes.
    open: () => 0,
    ended: () => 0,
    stop() {},
  };
}

function startStreamableHttp(): Harness & { server: StreamableHttpMcpServer } {
  const server = new StreamableHttpMcpServer();
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: server.handle });
  return {
    name: "streamable HTTP",
    server,
    params: (options) =>
      new StreamableHttpParameters({ url: `http://127.0.0.1:${http.port}/mcp`, ...options }),
    open: () => server.sessions,
    ended: () => server.closed.length,
    stop: () => http.stop(true),
  };
}

function startSse(): Harness & { server: SseMcpServer } {
  const server = new SseMcpServer();
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: server.handle,
  });
  return {
    name: "SSE",
    server,
    params: (options) =>
      new SseServerParameters({ url: `http://127.0.0.1:${http.port}/sse`, ...options }),
    open: () => server.connections,
    ended: () => server.closed,
    stop: () => http.stop(true),
  };
}

const stoppers: (() => void)[] = [];
const clients: MCPClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const stop of stoppers.splice(0)) stop();
});

function harness<T extends Harness>(h: T): T {
  stoppers.push(h.stop);
  return h;
}

function makeClient(params: ServerParameters, options: Partial<MCPClientOptions> = {}): MCPClient {
  const client = new MCPClient({ serverParams: params, ...options });
  clients.push(client);
  return client;
}

const HARNESSES: [string, () => Harness][] = [
  ["stdio", startStdio],
  ["streamable HTTP", startStreamableHttp],
  ["SSE", startSse],
];

/** Records the text the pipeline produces. */
class Collector extends FrameProcessor {
  texts: string[] = [];

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMTextFrame) this.texts.push(frame.text);
    await this.pushFrame(frame, direction);
  }
}

function makeLlm(provider: ToolLLMProvider, baseUrl: string): LLMService<any> {
  if (provider === "openai") return new OpenAILLMService({ apiKey: "test-key", baseUrl });
  if (provider === "google") {
    return new GoogleLLMService({ apiKey: "test-key", httpOptions: { baseUrl } });
  }
  throw new Error(`no ${provider} in this test`);
}

const mocks: MockToolLLM[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.stop();
});

/** Wait until `condition` holds (the server end of a close is seen a moment after the close). */
async function eventually(condition: () => boolean, seconds = 5): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The text of every message in a request body, whatever the provider's format. */
function bodyText(body: unknown): string {
  return JSON.stringify(body);
}

/**
 * Run a conversation through a pipeline: the context carries the MCP tools, the model follows
 * `script`, and the run ends when the model has made `requests` requests and spoken.
 */
async function runConversation(
  provider: ToolLLMProvider,
  mcp: MCPClient,
  script: ToolLLMScript,
  requests: number,
  userMessage: string,
) {
  const mock = startMockToolLLM(provider, script);
  mocks.push(mock);
  const llm = makeLlm(provider, mock.baseUrl);
  const collector = new Collector();
  const context = new LLMContext({
    messages: [{ role: "user", content: userMessage }],
    tools: await mcp.tools(),
  });
  const aggregators = new LLMContextAggregatorPair(context);
  const pipeline = new Pipeline([aggregators.user(), llm, collector, aggregators.assistant()]);
  const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });

  const started = new Event();
  worker.eventHandler("on_pipeline_started", async () => started.set());
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  const drive = async (): Promise<void> => {
    await waitFor(() => started.wait(), 5);
    await worker.queueFrame(new LLMRunFrame());
    // The last request is the model's final answer; wait for its text.
    const deadline = Date.now() + 15_000;
    while (
      (mock.requests.length < requests || collector.texts.length === 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.queueFrame(new EndFrame());
  };
  await Promise.all([runner.run(), drive()]);
  return { mock, collector, context };
}

const ADD_THEN_ANSWER: ToolLLMScript = [
  { toolCalls: [{ name: "add", arguments: { a: 2, b: 3 } }] },
  { text: "The sum is 5." },
];

describe("tools over each transport", () => {
  for (const [name, start] of HARNESSES) {
    test(`${name}: tools() lists the server's tools as function schemas`, async () => {
      const h = harness(start());
      const mcp = makeClient(h.params());
      const toolsSchema = await mcp.tools();
      expect(toolsSchema.standardTools.map((s) => s.name).sort()).toEqual([
        "add",
        "add_structured",
        "echo",
        "fail",
      ]);
      const add = toolsSchema.standardTools.find((s) => s.name === "add")!;
      expect(add.description).toBe("Add two numbers.");
      expect(Object.keys(add.properties).sort()).toEqual(["a", "b"]);
      expect(add.required.sort()).toEqual(["a", "b"]);
      expect((add.properties.a as { type: string }).type).toBe("number");
      expect(add.handler).not.toBeNull();
      const echo = toolsSchema.standardTools.find((s) => s.name === "echo")!;
      expect(echo.required).toEqual(["text"]);
    });

    test(`${name}: toolsFilter and toolsArguments`, async () => {
      const h = harness(start());
      const mcp = makeClient(h.params(), {
        toolsFilter: ["echo"],
        toolsArguments: { echo: { suffix: "!" } },
      });
      const toolsSchema = await mcp.tools();
      expect(toolsSchema.standardTools.map((s) => s.name)).toEqual(["echo"]);
      // The fixed argument is hidden from the model...
      expect(Object.keys(toolsSchema.standardTools[0]!.properties)).toEqual(["text"]);
      // ...and sent to the server on every call, whatever the model says.
      const results: unknown[] = [];
      await (toolsSchema.standardTools[0]!.handler as (p: unknown) => Promise<void>)({
        functionName: "echo",
        toolCallId: "call-1",
        arguments: { text: "hi", suffix: "?" },
        resultCallback: async (result: unknown) => {
          results.push(result);
        },
      });
      expect(results).toEqual(["hi!"]);
    });

    test(`${name}: a tool's text comes back through the handler, filtered`, async () => {
      const h = harness(start());
      const mcp = makeClient(h.params(), {
        toolsOutputFilters: { add: (text: string) => `sum=${text}` },
      });
      const toolsSchema = await mcp.tools();
      const results: unknown[] = [];
      for (const [fn, args] of [
        ["add", { a: 40, b: 2 }],
        ["echo", { text: "plain" }],
        ["fail", {}],
      ] as const) {
        await (toolsSchema.standardTools.find((s) => s.name === fn)!.handler as any)({
          functionName: fn,
          toolCallId: `call-${fn}`,
          arguments: args,
          resultCallback: async (result: unknown) => {
            results.push(result);
          },
        });
      }
      // A tool that fails on the server returns its error text, as upstream concatenates it.
      expect(results).toEqual(["sum=42", "plain", "boom"]);
    });

    test(`${name}: close() releases the connection, and tools() opens a new one`, async () => {
      const h = harness(start());
      const mcp = makeClient(h.params());
      await mcp.tools();
      await mcp.close();
      await eventually(() => name === "stdio" || h.ended() === 1);
      const again = await mcp.tools();
      expect(again.standardTools.length).toBe(4);
      await mcp.close();
    });

    for (const provider of ["openai", "google"] as const) {
      test(`${name}: a function call reaches the server, with ${provider}`, async () => {
        const h = harness(start());
        const mcp = makeClient(h.params());
        const { mock, collector } = await runConversation(
          provider,
          mcp,
          ADD_THEN_ANSWER,
          2,
          "What is 2 + 3?",
        );

        // The model was offered the MCP tools, registered on the service by the context.
        expect([...mock.requests[0]!.tools].sort()).toEqual([
          "add",
          "add_structured",
          "echo",
          "fail",
        ]);
        // The server's answer is in the conversation the model saw next.
        // (OpenAI-style APIs carry it as a JSON string, Gemini's as a response value.)
        expect(bodyText(mock.requests[1]!.body)).toMatch(/\\"5\\"|"value":"5"/);
        expect(collector.texts.join("")).toBe("The sum is 5.");

        // Pipeline teardown closed the client, with nobody calling close().
        await eventually(() => h.open() === 0);
        expect((mcp as any)._activeSession).toBeNull();
      }, 20_000);
    }
  }
});

describe("streamable HTTP", () => {
  test("sends the configured headers, and ends the session on close", async () => {
    const h = harness(startStreamableHttp());
    const mcp = makeClient(h.params({ headers: { authorization: "Bearer secret" } }));
    await mcp.tools();
    expect(h.server.requests.length).toBeGreaterThan(0);
    for (const request of h.server.requests) {
      expect(request.headers.authorization).toBe("Bearer secret");
    }
    expect(h.server.sessions).toBe(1);
    await mcp.close();
    expect(h.server.closed.length).toBe(1);
    expect(h.server.requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  test("terminateOnClose=false leaves the session to the server", async () => {
    const h = harness(startStreamableHttp());
    const mcp = makeClient(
      new StreamableHttpParameters({
        url: (h.params() as StreamableHttpParameters).url,
        terminateOnClose: false,
      }),
    );
    await mcp.tools();
    await mcp.close();
    expect(h.server.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(h.server.closed.length).toBe(0);
  });

  test("a server that went away: the call reports the error to the model", async () => {
    const h = harness(startStreamableHttp());
    const mcp = makeClient(h.params());
    const toolsSchema = await mcp.tools();
    h.stop();
    const results: unknown[] = [];
    await (toolsSchema.standardTools[0]!.handler as any)({
      functionName: "add",
      toolCallId: "call-1",
      arguments: { a: 1, b: 2 },
      resultCallback: async (result: unknown) => {
        results.push(result);
      },
    });
    expect(String(results[0])).toContain("Error calling mcp tool add:");
  });

  test("an unreachable server fails tools() with the cause", async () => {
    const mcp = makeClient(new StreamableHttpParameters({ url: "http://127.0.0.1:1/mcp" }));
    await expect(mcp.tools()).rejects.toThrow();
    // The client holds no half-open session: it can try again.
    await expect(mcp.tools()).rejects.toThrow();
  });

  test("serves a connection through the `fetch` option, with no port", async () => {
    const server = new StreamableHttpMcpServer();
    const mcp = makeClient(
      new StreamableHttpParameters({
        url: "http://in.process/mcp",
        fetch: inProcessFetch(server.handle),
      }),
    );
    const toolsSchema = await mcp.tools();
    expect(toolsSchema.standardTools.length).toBe(4);
    await mcp.close();
    expect(server.closed.length).toBe(1);
  });
});

describe("SSE", () => {
  test("sends the configured headers on the stream and on every POST", async () => {
    const h = harness(startSse());
    const mcp = makeClient(h.params({ headers: { authorization: "Bearer secret" } }));
    await mcp.tools();
    expect(h.server.requests.map((r) => r.method)).toContain("GET");
    expect(h.server.requests.map((r) => r.method)).toContain("POST");
    for (const request of h.server.requests) {
      expect(request.headers.authorization).toBe("Bearer secret");
    }
  });

  test("serves a connection through the `fetch` option, with no port", async () => {
    const server = new SseMcpServer();
    const mcp = makeClient(
      new SseServerParameters({
        url: "http://in.process/sse",
        fetch: inProcessFetch(server.handle),
      }),
    );
    const toolsSchema = await mcp.tools();
    expect(toolsSchema.standardTools.length).toBe(4);
    await mcp.close();
  });
});

describe("stdio", () => {
  test("a server that cannot start fails tools() with the cause", async () => {
    const mcp = makeClient(new StdioServerParameters({ command: "pipedog-no-such-program" }));
    await expect(mcp.tools()).rejects.toThrow();
  });

  test("a server that exits is dropped, and the next call starts a new process", async () => {
    const mcp = makeClient(
      new StdioServerParameters({ command: process.execPath, args: [STDIO_SERVER] }),
    );
    const toolsSchema = await mcp.tools();
    const results: unknown[] = [];
    const call = async () => {
      await (toolsSchema.standardTools.find((s) => s.name === "add")!.handler as any)({
        functionName: "add",
        toolCallId: "call-1",
        arguments: { a: 1, b: 2 },
        resultCallback: async (result: unknown) => {
          results.push(result);
        },
      });
    };
    await call();
    // Kill the child the way a crash would.
    const pid = Number(
      (await Bun.$`pgrep -f ${STDIO_SERVER}`.nothrow().text()).trim().split("\n")[0],
    );
    expect(pid).toBeGreaterThan(0);
    process.kill(pid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await call(); // finds the connection gone: the model reads the error
    await call(); // connects again
    expect(results[0]).toBe("3");
    expect(String(results[1])).toContain("Error calling mcp tool add:");
    expect(results[2]).toBe("3");
  });
});
