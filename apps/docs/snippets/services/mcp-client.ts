// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/mcp-client.mdx. Type-checked on every docs build.

// #region usage
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { MCPClient, StreamableHttpParameters } from "@pipedog/mcp-client";
import { OpenAILLMService } from "@pipedog/openai/llm";

const mcp = new MCPClient({
  serverParams: new StreamableHttpParameters({
    url: "https://mcp.example.com/mcp",
    headers: { authorization: `Bearer ${process.env.MCP_TOKEN ?? ""}` },
  }),
});

const llm = new OpenAILLMService({ apiKey: process.env.OPENAI_API_KEY ?? "" });

// tools() connects, and returns schemas that carry their handlers. The LLM service registers them
// when the context advertises them, and closes the connection when the pipeline is torn down.
const context = new LLMContext({
  messages: [{ role: "system", content: "You are a helpful voice assistant." }],
  tools: await mcp.tools(),
});
const aggregators = new LLMContextAggregatorPair(context);

// #endregion usage

// #region transports
import { SseServerParameters, StdioServerParameters } from "@pipedog/mcp-client";

// A server that is a child process (Bun, Node and Deno).
const stdio = new MCPClient({
  serverParams: new StdioServerParameters({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { LOG_LEVEL: "warn" },
  }),
});

// The older HTTP transport of MCP.
const sse = new MCPClient({
  serverParams: new SseServerParameters({ url: "https://mcp.example.com/sse" }),
});
// #endregion transports

// #region filters
const filtered = new MCPClient({
  serverParams: new StreamableHttpParameters({ url: "https://mcp.example.com/mcp" }),
  // Register only these tools.
  toolsFilter: ["search", "get_page"],
  // Shorten what a tool returns before the model reads it.
  toolsOutputFilters: { get_page: (text: string) => text.slice(0, 2000) },
  // Fixed arguments: removed from the schema the model sees, and sent on every call.
  toolsArguments: { search: { mode: "realtime" } },
});
// #endregion filters

// #region lifecycle
// Open the connection ahead of the first call, so the first user turn does not pay for it.
await mcp.start();

// Release it earlier than pipeline teardown, for example when the client disconnects.
await mcp.close();

// Or scope it: `await using` closes the client at the end of the block.
{
  await using scoped = new MCPClient({
    serverParams: new StreamableHttpParameters({ url: "https://mcp.example.com/mcp" }),
  });
  await scoped.start();
}
// #endregion lifecycle

// #region fetch
// Serve the connection from a function, with no network: a test, or a service binding on Workers.
declare const handler: (request: Request) => Promise<Response>;

const inProcess = new MCPClient({
  serverParams: new StreamableHttpParameters({
    url: "http://in.process/mcp",
    fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
  }),
});

// #endregion fetch

export { aggregators, filtered, inProcess, llm, sse, stdio };
