# @pipedog/mcp-client

An [MCP](https://modelcontextprotocol.io) client for pipedog: a port of Pipecat's
`pipecat.services.mcp_service` (`MCPClient`). It connects to an MCP server, turns the server's tools
into function-call tools, and hands them to an LLM service, so the bot can call them.

Not to be confused with [`@pipedog/mcp`](../mcp), the MCP *server* that serves the pipedog docs to
coding agents.

```sh
bun add @pipedog/mcp-client
```

```ts
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { MCPClient, StreamableHttpParameters } from "@pipedog/mcp-client";

const mcp = new MCPClient({
  serverParams: new StreamableHttpParameters({
    url: "https://mcp.example.com/mcp",
    headers: { authorization: `Bearer ${process.env.MCP_TOKEN}` },
  }),
});

// The schemas carry their handlers: the LLM service registers them when the context advertises
// the tools, and closes the connection when the pipeline is torn down.
const context = new LLMContext({ messages: [...], tools: await mcp.tools() });
```

## Server parameters

| class | transport | needs |
|---|---|---|
| `StreamableHttpParameters({ url, headers, timeout, sseReadTimeout, terminateOnClose, fetch })` | streamable HTTP | `fetch` |
| `SseServerParameters({ url, headers, timeout, sseReadTimeout, fetch })` | SSE (the older HTTP transport) | `fetch` |
| `StdioServerParameters({ command, args, env, cwd })` | a child process, over stdin and stdout | a process spawner |

## Options

| option | |
|---|---|
| `serverParams` | one of the classes above (anything else throws a `TypeError`) |
| `toolsFilter` | the names of the tools to register. `null` (or empty) registers all of them |
| `toolsOutputFilters` | tool name to a function that processes that tool's text output |
| `toolsArguments` | tool name to fixed arguments, merged into every call (they win over the model's) and removed from the schema the model sees |

## Sessions

The client keeps one persistent session, opened on the first `tools()` (or by `start()`), as
upstream does. A tool call that finds the connection gone returns the error to the model, drops the
session, and the next call connects again. `close()` releases the connection early (for example on
client disconnect); a closed client stays closed until `start()` or `tools()`, and a tool call on it
throws. `await using mcp = new MCPClient(...)` and `mcp.scoped(fn)` stand in for Python's
`async with`.

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|---|---|---|---|
| streamable HTTP, SSE | ✅ | ✅ | ✅ | ✅ |
| stdio | ✅ | ✅ | ✅ | no: Workers cannot start a process |

On Workers a stdio server is refused with an error that says so. The stdio code is a separate module
(`@pipedog/mcp-client/stdio_transport`) that the `workerd` export condition swaps for a stub, so a
Worker bundle never includes the SDK's process spawner.

## Differences from upstream

- `async with MCPClient(...)` is `await using` or `scoped()`. The constructor takes one options object.
- Not ported, because upstream deprecates them: `register_tools`, `get_tools_schema`,
  `register_tools_schema`. Use `tools()`.
- `SseServerParameters` and `StreamableHttpParameters` take a `fetch` option, which upstream has no
  counterpart for (it uses httpx): it serves a connection in process, or through a service binding.
- With `fetch` there is no connect timeout. `timeout` bounds the `initialize` handshake, and
  `sseReadTimeout` the wait for the response headers of a request. An idle SSE stream is not timed out.
- `tools()` follows the server's pagination cursor. Upstream reads the first page.
- A lost connection is read from what the SDK raises (`McpError` with code `ConnectionClosed`, or
  `Not connected`), where upstream reads anyio's stream errors. A request that fails at the network
  level (a refused connection, a reset) is reported to the model, and the session is kept for the
  next call.
- The SDK's `MCP error -32000: ` prefix is left off the line the model reads.
- On Workers the SDK's check of a result against the tool's output schema is off: it needs code
  generation, which Workers forbid.
- A tool with no description is advertised with an empty one.
