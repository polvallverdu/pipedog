// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Small MCP servers, built with the official SDK, for the end-to-end tests and the compat smoke
// test. Everything here speaks through web-standard `Request` and `Response`, so a test can serve
// it from `Bun.serve`, and the smoke test can serve it in process, as a `fetch`, on every runtime.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** An MCP server with a few tools: `add`, `add_structured` (with an output schema), `echo` and `fail`. */
export function createToolServer(): McpServer {
  const server = new McpServer({ name: "pipedog-test-server", version: "1.0.0" });
  server.registerTool(
    "add",
    {
      description: "Add two numbers.",
      inputSchema: { a: z.number().describe("The first number."), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text" as const, text: String(a + b) }] }),
  );
  server.registerTool(
    "echo",
    {
      description: "Echo the text back, followed by an optional suffix.",
      inputSchema: { text: z.string(), suffix: z.string().optional() },
    },
    async ({ text, suffix }) => ({
      content: [{ type: "text" as const, text: `${text}${suffix ?? ""}` }],
    }),
  );
  server.registerTool(
    "add_structured",
    {
      description: "Add two numbers, and return the sum as structured content too.",
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { sum: z.number() },
    },
    async ({ a, b }) => ({
      content: [{ type: "text" as const, text: String(a + b) }],
      structuredContent: { sum: a + b },
    }),
  );
  server.registerTool("fail", { description: "Always fails." }, async () => {
    throw new Error("boom");
  });
  return server;
}

/** What a server saw of one HTTP request. */
export interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** An MCP server over streamable HTTP, with a session (and so a server) for each client. */
export class StreamableHttpMcpServer {
  readonly requests: SeenRequest[] = [];
  /** Sessions opened, and the ones a client ended (an HTTP DELETE). */
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly #transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  readonly handle = async (request: Request): Promise<Response> => {
    this.requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
    });
    const sessionId = request.headers.get("mcp-session-id");
    let transport = sessionId ? this.#transports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId) return new Response("Unknown session", { status: 404 });
      const created: WebStandardStreamableHTTPServerTransport =
        new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            this.#transports.set(id, created);
            this.opened.push(id);
          },
          onsessionclosed: (id) => {
            this.#transports.delete(id);
            this.closed.push(id);
          },
        });
      transport = created;
      await createToolServer().connect(transport);
    }
    return await transport.handleRequest(request);
  };

  /** Sessions that are open now. */
  get sessions(): number {
    return this.#transports.size;
  }
}

/** The server end of one SSE connection: the event stream out, and the POSTs in. */
class SseConnectionTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sessionId: string;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #closed = false;
  readonly #encoder = new TextEncoder();
  readonly #endpoint: string;

  constructor(sessionId: string, endpoint: string) {
    this.sessionId = sessionId;
    this.#endpoint = endpoint;
  }

  async start(): Promise<void> {}

  /** The response that carries the event stream. The first event names the POST endpoint. */
  response(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
        this.#write(`event: endpoint\ndata: ${this.#endpoint}\n\n`);
      },
      cancel: () => {
        this.#closed = true;
        this.onclose?.();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  /** A message the client POSTed. */
  async receive(request: Request): Promise<Response> {
    this.onmessage?.((await request.json()) as JSONRPCMessage);
    return new Response("Accepted", { status: 202 });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.#write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#controller?.close();
    } catch {
      // Already closed by the client.
    }
    this.onclose?.();
  }

  #write(text: string): void {
    if (!this.#closed) this.#controller?.enqueue(this.#encoder.encode(text));
  }
}

/**
 * An MCP server over the SSE transport: the client opens `GET <base>/sse`, is told where to POST,
 * and POSTs its messages to `<base>/messages?sessionId=...`.
 */
export class SseMcpServer {
  readonly requests: SeenRequest[] = [];
  /** Event streams opened, and the ones a client has dropped. */
  opened = 0;
  closed = 0;
  readonly #connections = new Map<string, SseConnectionTransport>();

  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
    });
    if (request.method === "GET" && url.pathname.endsWith("/sse")) {
      const sessionId = crypto.randomUUID();
      const base = url.pathname.slice(0, -"/sse".length);
      const transport = new SseConnectionTransport(
        sessionId,
        `${base}/messages?sessionId=${sessionId}`,
      );
      this.#connections.set(sessionId, transport);
      this.opened += 1;
      transport.onclose = () => {
        this.#connections.delete(sessionId);
        this.closed += 1;
      };
      await createToolServer().connect(transport);
      return transport.response();
    }
    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const transport = this.#connections.get(url.searchParams.get("sessionId") ?? "");
      if (!transport) return new Response("Unknown session", { status: 404 });
      return await transport.receive(request);
    }
    return new Response("Not found", { status: 404 });
  };

  /** Connections that are open now. */
  get connections(): number {
    return this.#connections.size;
  }
}

/** A `fetch` that answers from `handler`, in process, with no port. */
export function inProcessFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    await handler(new Request(input, init))) as typeof fetch;
}
