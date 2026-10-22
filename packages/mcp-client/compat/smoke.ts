// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: MCPClient against real MCP servers built with the official
// SDK, served in process through the `fetch` option, so no port is needed (workerd has none).
//
//   - streamable HTTP and SSE: tools() lists the tools, a function-call handler runs one, and
//     close() releases the connection. On every runtime, Workers included.
//   - stdio: a child process (`node`) speaking JSON-RPC over stdin and stdout. On Bun, Node and
//     Deno. On Workers there are no processes, so the check is that tools() fails with an error
//     rather than hang, and the client stays usable.

import {
  MCPClient,
  SseServerParameters,
  StdioServerParameters,
  StreamableHttpParameters,
} from "@pipedog/mcp-client";
import { inProcessFetch, SseMcpServer, StreamableHttpMcpServer } from "../test/fixtures/servers.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`mcp-client smoke: ${message}`);
}

/** A server with one tool, `add`, in plain JavaScript: it needs nothing but `node`. */
const STDIO_SERVER = `
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  let result;
  if (m.method === "initialize") {
    result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1" } };
  } else if (m.method === "tools/list") {
    result = { tools: [{ name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] };
  } else {
    result = { content: [{ type: "text", text: String(m.params.arguments.a + m.params.arguments.b) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
}
`;

/** Call the `add` tool the way an LLM service does, through the handler on its schema. */
async function callAdd(mcp: MCPClient, label: string, structured = true): Promise<void> {
  const tools = await mcp.tools();
  const add = tools.standardTools.find((s) => s.name === "add");
  check(add, `${label}: no add tool in ${JSON.stringify(tools.standardTools.map((s) => s.name))}`);
  check(add.handler, `${label}: add has no handler`);
  check(
    JSON.stringify([...add.required].sort()) === '["a","b"]',
    `${label}: required ${JSON.stringify(add.required)}`,
  );
  if (structured) {
    // A tool with an output schema: the SDK compiles it when the tools are listed, and again to check
    // a result. Workers forbid the code generation that takes.
    const structured = tools.standardTools.find((s) => s.name === "add_structured");
    check(structured?.handler, `${label}: no add_structured tool`);
    const structuredResults: unknown[] = [];
    await structured.handler({
      functionName: "add_structured",
      toolCallId: "call-2",
      arguments: { a: 4, b: 5 },
      resultCallback: async (result: unknown) => {
        structuredResults.push(result);
      },
    } as never);
    check(
      structuredResults.length === 1 && structuredResults[0] === "9",
      `${label}: structured result ${JSON.stringify(structuredResults)}`,
    );
  }
  const results: unknown[] = [];
  await add.handler({
    functionName: "add",
    toolCallId: "call-1",
    arguments: { a: 2, b: 3 },
    resultCallback: async (result: unknown) => {
      results.push(result);
    },
  } as never);
  check(results.length === 1 && results[0] === "5", `${label}: result ${JSON.stringify(results)}`);
}

const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

export default async function smoke(): Promise<void> {
  // Streamable HTTP
  const http = new StreamableHttpMcpServer();
  const httpClient = new MCPClient({
    serverParams: new StreamableHttpParameters({
      url: "http://in.process/mcp",
      fetch: inProcessFetch(http.handle),
    }),
  });
  try {
    await callAdd(httpClient, "streamable HTTP");
  } finally {
    await httpClient.close();
  }
  check(http.opened.length === 1, `streamable HTTP opened ${http.opened.length} sessions`);
  check(http.closed.length === 1, "streamable HTTP: close() did not end the session");

  // SSE
  const sse = new SseMcpServer();
  const sseClient = new MCPClient({
    serverParams: new SseServerParameters({
      url: "http://in.process/sse",
      fetch: inProcessFetch(sse.handle),
    }),
  });
  try {
    await callAdd(sseClient, "SSE");
  } finally {
    await sseClient.close();
  }
  check(sse.opened === 1, `SSE opened ${sse.opened} streams`);

  // stdio
  const stdioClient = new MCPClient({
    serverParams: new StdioServerParameters({
      command: "node",
      args: ["--input-type=module", "-e", STDIO_SERVER],
    }),
  });
  try {
    if (onWorkers) {
      let failed = false;
      try {
        await stdioClient.tools();
      } catch {
        failed = true;
      }
      check(failed, "stdio: tools() should fail on Workers");
    } else {
      await callAdd(stdioClient, "stdio", false);
    }
  } finally {
    await stdioClient.close();
  }
}
