// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_mcp_service.py

/**
 * Tests for the MCP client service.
 *
 * PORTING NOTES:
 * - Upstream patches two module attributes (`_streamable_http_transport` and `ClientSession`) to put
 *   a fake server behind the client. Here `FakeMCPClient` overrides the two protected seams that
 *   correspond to them, `_enterTransport` and `_enterSession`.
 * - The anyio stream errors (`ClosedResourceError` and the rest) have no JavaScript counterpart.
 *   What the SDK raises for a transport that is gone stands in: an `McpError` with code
 *   `ConnectionClosed`, and `Error("Not connected")`. `ExceptionGroup` becomes `AggregateError`.
 * - `TestSDKConnectionErrors` and `TestRealSession` use the SDK's in-memory transport and a real
 *   `McpServer` where upstream uses memory streams and a hand-written server.
 * - The tests of the deprecated API (`register_tools`, `get_tools_schema`,
 *   `register_tools_schema`) are skipped: those methods are not ported.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CancelledError,
  createTask,
  currentTask,
  Event,
  Future,
  gather,
  sleep,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import type { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { type FunctionCallRegistryItem, LLMService } from "@pipedog/core/services/llm_service";
import { LLMSettings } from "@pipedog/core/services/settings";
import {
  _errorDetail,
  _isConnectionLost,
  _MAX_ERROR_DETAIL,
  _NotConnectedError,
  AsyncExitStack,
  ConnectionError,
  type MCPCallToolResult,
  MCPClient,
  type MCPClientOptions,
  type MCPSession,
  type MCPToolInfo,
  StreamableHttpParameters,
} from "../src/mcp_service.ts";

/** Python's RuntimeError, so that the tests can tell it from other errors by class. */
class RuntimeError extends Error {
  override name = "RuntimeError";
}

/** Python's ValueError. */
class ValueError extends Error {
  override name = "ValueError";
}

/** An error whose message is empty (anyio's `ClosedResourceError`, `str()` of which is empty). */
class ClosedResourceError extends Error {
  override name = "ClosedResourceError";
}

/** An error whose message is empty, like `ClosedResourceError`. */
class BrokenResourceError extends Error {
  override name = "BrokenResourceError";
}

/** Build a fake MCP server tool as returned by `session.listTools()`. */
function _tool(
  name: string,
  {
    properties,
    required,
    description = "A tool.",
  }: { properties?: Record<string, unknown>; required?: string[]; description?: string } = {},
): MCPToolInfo {
  return {
    name,
    description,
    inputSchema: { properties: properties ?? {}, required: required ?? [] },
  };
}

/**
 * Fake MCP server, minting one transport and one session per connect.
 *
 * It outlives every session it mints, so what the test scripts and what the client did both
 * survive a dropped session. Tests set its attributes to script a failure; `onConnect`,
 * `onCallOnce` and `onExitOnce` run inside a connect, inside a tool call and inside a disconnect,
 * to drive what those race with. The two once hooks run for one call and one disconnect, so a hook
 * that closes the client does not meet itself on the way out.
 */
class FakeServer {
  tools: MCPToolInfo[];
  failInitializes = 0;
  cancelInitialize = false;
  transportExitError: unknown = null;
  connectDelay = 0;
  callErrors: unknown[] = [];
  emptyResults = false;
  nonTextResults = false;
  onConnect: (() => Promise<void>) | null = null;
  onCallOnce: (() => Promise<void>) | null = null;
  onExitOnce: (() => Promise<void>) | null = null;
  sessions: FakeSession[] = [];
  calls: [string, Record<string, unknown> | null | undefined][] = [];
  enters = 0;
  exits = 0;
  initializes = 0;
  enterTask: Task<unknown> | undefined;
  exitTask: Task<unknown> | undefined;

  constructor(tools: MCPToolInfo[]) {
    this.tools = tools;
  }

  /** Mint the session for one connection, as `ClientSession(...)` does. */
  connect(): FakeSession {
    const session = new FakeSession(this);
    this.sessions.push(session);
    return session;
  }
}

/** Fake MCP session, serving what its server holds. */
class FakeSession implements MCPSession {
  #server: FakeServer;

  constructor(server: FakeServer) {
    this.#server = server;
  }

  async initialize(): Promise<void> {
    const server = this.#server;
    if (server.cancelInitialize) {
      // An anyio transport cancels the connecting task when its own request fails, so
      // initialize() ends in cancellation.
      throw new CancelledError("Cancelled via cancel scope");
    }
    if (server.failInitializes > 0) {
      server.failInitializes -= 1;
      throw new RuntimeError("connect failed");
    }
    server.initializes += 1;
  }

  async listTools(): Promise<{ tools: MCPToolInfo[] }> {
    return { tools: this.#server.tools };
  }

  async callTool(name: string, args?: Record<string, unknown> | null): Promise<MCPCallToolResult> {
    const server = this.#server;
    server.calls.push([name, args]);
    if (server.onCallOnce) {
      const hook = server.onCallOnce;
      server.onCallOnce = null;
      await hook();
    }
    if (server.callErrors.length > 0) {
      throw server.callErrors.shift();
    }
    if (server.emptyResults) {
      return { content: [] };
    }
    if (server.nonTextResults) {
      // A block of another content type, carrying a text field the tool response must still
      // leave alone.
      return { content: [{ type: "image", text: `${name}-IMAGE` }] };
    }
    return { content: [{ type: "text", text: `${name}-RESULT` }] };
  }
}

/** The error an SDK raises for a request its transport could not serve. */
function _connectionClosedError(): McpError {
  return new McpError(ErrorCode.ConnectionClosed, "Connection closed");
}

/**
 * The errors an SDK raises once the transport behind a session is gone.
 *
 * A transport that fails inside its own tasks reports through an aggregate of one, so the same
 * causes arrive wrapped as well as bare.
 */
function _connectionLostErrors(): unknown[] {
  return [
    _connectionClosedError(),
    new Error("Not connected"),
    new AggregateError([_connectionClosedError()], "unhandled errors in a TaskGroup"),
    new AggregateError([new Error("Not connected")], "unhandled errors in a TaskGroup"),
  ];
}

/** A client whose transport and session are the fake server's. */
class FakeMCPClient extends MCPClient {
  readonly server: FakeServer;

  constructor(server: FakeServer, options: Partial<MCPClientOptions> = {}) {
    super({
      serverParams: new StreamableHttpParameters({ url: "http://test/mcp" }),
      ...options,
    });
    this.server = server;
  }

  protected override async _enterTransport(stack: AsyncExitStack): Promise<Transport> {
    const server = this.server;
    server.enters += 1;
    server.enterTask = currentTask();
    if (server.onConnect) {
      await server.onConnect();
    }
    if (server.connectDelay) {
      // A connect window wide enough to cancel the caller inside it.
      await sleep(server.connectDelay);
    }
    // Entered: from here on, the exit runs, as a context manager's `__aexit__` does.
    stack.push(async () => {
      server.exits += 1;
      server.exitTask = currentTask();
      if (server.onExitOnce) {
        const hook = server.onExitOnce;
        server.onExitOnce = null;
        await hook();
      }
      if (server.transportExitError !== null) {
        // A real transport reports a failed connection as its tasks unwind, rather than at the
        // connect site.
        throw server.transportExitError;
      }
    });
    return {} as Transport;
  }

  protected override async _enterSession(
    _stack: AsyncExitStack,
    _transport: Transport,
  ): Promise<MCPSession> {
    return this.server.connect();
  }

  // Test access to protected members (Python reads them directly).
  get activeSession(): MCPSession | null {
    return this._activeSession;
  }

  get sessionTask(): Task<void> | null {
    return this._sessionTask;
  }

  runSession(ready: Future<void>, closing: Event): Promise<void> {
    return this._runSession(ready, closing);
  }

  dropSession(session: MCPSession): Promise<void> {
    return this._dropSession(session);
  }

  toolWrapper(params: unknown): Promise<void> {
    return this._toolWrapper(params as never);
  }
}

// Clients made by a test, closed when it ends (`addAsyncCleanup(client.close)`).
const clients: MCPClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** Builds MCPClients against a fake MCP server. */
function makeClient(
  tools: MCPToolInfo[],
  options: Partial<MCPClientOptions> = {},
): [FakeMCPClient, FakeServer] {
  const server = new FakeServer(tools);
  const client = new FakeMCPClient(server, options);
  clients.push(client);
  return [client, server];
}

/** The `resultCallback` mock and the params a handler is called with. */
function handlerParams(
  name: string,
  args: Record<string, unknown> | null,
): { params: any; resultCallback: ReturnType<typeof mock> } {
  const resultCallback = mock(async (_result: unknown) => {});
  return {
    params: { functionName: name, toolCallId: "call-1", arguments: args, resultCallback },
    resultCallback,
  };
}

function standardTool(toolsSchema: ToolsSchema, name: string) {
  const schema = toolsSchema.standardTools.find((s) => s.name === name);
  if (!schema) throw new Error(`no tool ${name}`);
  return schema;
}

/**
 * Invoke a tool the way the LLM service does, through its handler.
 *
 * @returns The result callback, so callers can assert on what was delivered.
 */
async function callViaHandler(
  toolsSchema: ToolsSchema,
  name: string,
  args: Record<string, unknown> | null = null,
) {
  const schema = standardTool(toolsSchema, name);
  const { params, resultCallback } = handlerParams(name, args);
  await (schema.handler as (p: unknown) => Promise<void>)(params);
  return resultCallback;
}

/** `assert_awaited_once_with`. */
function assertAwaitedOnceWith(resultCallback: ReturnType<typeof mock>, value: unknown): void {
  expect(resultCallback).toHaveBeenCalledTimes(1);
  expect(resultCallback).toHaveBeenCalledWith(value);
}

/** The error `fn` raises, as `with self.assertRaises(...) as ctx`. */
async function raised(fn: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error, got none");
}

const names = (toolsSchema: ToolsSchema) => new Set(toolsSchema.standardTools.map((s) => s.name));

describe("TestTools", () => {
  // tools(): JIT start, handler attachment, filtering.

  test("test_tools_starts_connection_and_attaches_handlers", async () => {
    const [client, server] = makeClient([_tool("tool_a"), _tool("tool_b")]);
    const toolsSchema = await client.tools();
    expect(server.initializes).toBe(1);
    expect(names(toolsSchema)).toEqual(new Set(["tool_a", "tool_b"]));
    for (const schema of toolsSchema.standardTools) {
      expect(schema.handler).not.toBeNull();
    }
    await client.close();
  });

  test("test_tools_reads_the_schema", async () => {
    const [client] = makeClient([
      _tool("tool_a", { properties: { x: { type: "string" } }, required: ["x"] }),
    ]);
    const toolsSchema = await client.tools();
    const schema = toolsSchema.standardTools[0]!;
    expect(schema.properties).toEqual({ x: { type: "string" } });
    expect(schema.required).toEqual(["x"]);
    await client.close();
  });

  test("test_tools_is_idempotent_on_connection", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.tools();
    await client.tools();
    expect(server.enters).toBe(1);
    expect(server.initializes).toBe(1);
    await client.close();
  });

  test("test_tools_respects_tools_filter", async () => {
    const [client] = makeClient([_tool("tool_a"), _tool("tool_b")], { toolsFilter: ["tool_b"] });
    const toolsSchema = await client.tools();
    expect(names(toolsSchema)).toEqual(new Set(["tool_b"]));
    await client.close();
  });

  test("test_handler_calls_tool_and_delivers_result", async () => {
    const [client, server] = makeClient([
      _tool("tool_a", { properties: { x: { type: "string" } } }),
    ]);
    const toolsSchema = await client.tools();
    const schema = toolsSchema.standardTools[0]!;
    const { params, resultCallback } = handlerParams("tool_a", { x: "hello" });
    await (schema.handler as (p: unknown) => Promise<void>)(params);
    expect(server.calls).toEqual([["tool_a", { x: "hello" }]]);
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    await client.close();
  });

  test("test_handler_applies_output_filter", async () => {
    const [client] = makeClient([_tool("tool_a")], {
      toolsOutputFilters: { tool_a: (text: string) => text.toUpperCase() },
    });
    const toolsSchema = await client.tools();
    const resultCallback = await callViaHandler(toolsSchema, "tool_a", { x: "y" });
    assertAwaitedOnceWith(resultCallback, "TOOL_A-RESULT");
    await client.close();
  });
});

describe("TestToolsArguments", () => {
  // tools_arguments: schema stripping and call-time injection.

  const searchTools = () => [
    _tool("search", {
      properties: { query: { type: "string" }, mode: { type: "string" } },
      required: ["query", "mode"],
    }),
    _tool("other", { properties: { x: { type: "string" } }, required: ["x"] }),
  ];

  test("test_fixed_arguments_hidden_from_advertised_schema", async () => {
    const [client] = makeClient(searchTools(), {
      toolsArguments: { search: { mode: "realtime" } },
    });
    const toolsSchema = await client.tools();
    const byName = Object.fromEntries(toolsSchema.standardTools.map((s) => [s.name, s]));
    expect(new Set(Object.keys(byName.search!.properties))).toEqual(new Set(["query"]));
    expect(byName.search!.required).toEqual(["query"]);
    // Other tools are untouched.
    expect(new Set(Object.keys(byName.other!.properties))).toEqual(new Set(["x"]));
    expect(byName.other!.required).toEqual(["x"]);
    await client.close();
  });

  test("test_fixed_arguments_injected_and_win_over_model_arguments", async () => {
    const [client, server] = makeClient(searchTools(), {
      toolsArguments: { search: { mode: "realtime" } },
    });
    const toolsSchema = await client.tools();
    await callViaHandler(toolsSchema, "search", { query: "news", mode: "model-supplied" });
    expect(server.calls).toEqual([["search", { query: "news", mode: "realtime" }]]);
    await client.close();
  });

  test("test_fixed_arguments_injected_when_no_model_arguments", async () => {
    const [client, server] = makeClient(searchTools(), {
      toolsArguments: { search: { mode: "realtime" } },
    });
    const toolsSchema = await client.tools();
    await callViaHandler(toolsSchema, "search");
    expect(server.calls).toEqual([["search", { mode: "realtime" }]]);
    await client.close();
  });

  test("test_fixed_argument_absent_from_server_schema_still_injected", async () => {
    const [client, server] = makeClient(searchTools(), {
      toolsArguments: { other: { hidden: 1 } },
    });
    const toolsSchema = await client.tools();
    const byName = Object.fromEntries(toolsSchema.standardTools.map((s) => [s.name, s]));
    // Stripping a name the schema doesn't have is a no-op...
    expect(new Set(Object.keys(byName.other!.properties))).toEqual(new Set(["x"]));
    // ...but the argument is still injected at call time.
    await callViaHandler(toolsSchema, "other", { x: "y" });
    expect(server.calls).toEqual([["other", { x: "y", hidden: 1 }]]);
    await client.close();
  });
});

describe("TestCallErrors", () => {
  // Failed tool calls: the error reaches the model, a dead session is dropped.

  test("test_a_lost_connection_drops_the_session_and_runs_the_tool_once", async () => {
    for (const error of _connectionLostErrors()) {
      const [client, server] = makeClient([_tool("tool_a")]);
      const toolsSchema = await client.tools();
      server.callErrors.push(error);
      await callViaHandler(toolsSchema, "tool_a");
      // The client does not run the call again: the SDK reports a request that never left and a
      // lost answer as one error.
      expect(server.calls.length).toBe(1);
      expect(server.enters).toBe(1);
      expect(client.activeSession).toBeNull();
      await client.close();
    }
  });

  test("test_a_failed_call_returns_the_error_to_the_model", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(new RuntimeError("upstream unavailable"));
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: upstream unavailable");
    await client.close();
  });

  test("test_a_lost_connection_returns_the_error_to_the_model", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(_connectionClosedError());
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    // The SDK's "MCP error -32000: " prefix is left off, as upstream's error carries the bare message.
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: Connection closed");
    await client.close();
  });

  test("test_an_error_with_no_message_gives_its_class_name", async () => {
    // The message of ClosedResourceError is empty, so the model would otherwise read a line that
    // ends at the colon.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(new ClosedResourceError());
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: ClosedResourceError");
    await client.close();
  });

  test("test_a_group_of_one_gives_the_cause_it_wraps", async () => {
    // The group itself says only that a task group failed.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(
      new AggregateError([new BrokenResourceError()], "unhandled errors in a TaskGroup"),
    );
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: BrokenResourceError");
    await client.close();
  });

  test("test_a_call_after_a_lost_connection_connects_again", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(_connectionClosedError());
    await callViaHandler(toolsSchema, "tool_a");

    // The model decides to call again, and that call opens its own transport.
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    expect(server.enters).toBe(2);
    expect(server.calls.length).toBe(2);
    await client.close();
  });

  test("test_other_errors_return_the_error_and_keep_the_session", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(new ValueError("upstream unavailable"));
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: upstream unavailable");
    expect(server.enters).toBe(1);
    expect(client.activeSession).toBe(server.sessions[server.sessions.length - 1]!);
    await client.close();
  });

  test("test_dropping_a_session_another_call_replaced_closes_nothing", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    const replaced = server.sessions[0]!;
    server.callErrors.push(_connectionClosedError());
    await callViaHandler(toolsSchema, "tool_a");
    await callViaHandler(toolsSchema, "tool_a");
    expect(server.enters).toBe(2);

    // Tool calls run concurrently, so a second call can still hold the dead session the first one
    // dropped.
    await client.dropSession(replaced);
    expect(client.activeSession).toBe(server.sessions[server.sessions.length - 1]!);
    expect(server.exits).toBe(1);
    await client.close();
  });

  test("test_a_closed_client_reports_the_lost_connection", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();

    server.onCallOnce = async () => {
      await client.close();
    };
    server.callErrors.push(_connectionClosedError());
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    // The client stays closed. The call reports the connection it lost, which differs from the
    // setup error of a client that never started.
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: Connection closed");
    expect(server.enters).toBe(1);
  });

  test("test_a_teardown_meeting_a_drop_leaves_nothing_open", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    let teardown: Task<void> | null = null;

    server.onExitOnce = async () => {
      teardown = createTask(() => client.close());
      await sleep(0); // let the teardown reach the lock it waits on
    };
    server.callErrors.push(_connectionClosedError());
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    await teardown!;
    // The teardown waits out the drop and finds the session already released.
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: Connection closed");
    expect(server.exits).toBe(server.enters);
    expect(client.activeSession).toBeNull();
    expect(client.sessionTask).toBeNull();
  });

  test("test_a_group_of_two_causes_still_drops_the_session", async () => {
    // The group names no single cause, so the model reads the group itself. The transport under
    // it is gone either way.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(
      new AggregateError(
        [_connectionClosedError(), new ValueError("and one more")],
        "unhandled errors in a TaskGroup",
      ),
    );
    await callViaHandler(toolsSchema, "tool_a");
    expect(client.activeSession).toBeNull();
    expect(server.enters).toBe(1);
    await client.close();
  });

  test("test_a_drop_whose_transport_fails_keeps_the_cause_of_the_call", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.transportExitError = new RuntimeError("transport exit failed");
    server.callErrors.push(_connectionClosedError());
    let resultCallback = await callViaHandler(toolsSchema, "tool_a");

    // The model reads the cause of its own call. The transport failure on close goes to the log.
    // The client holds no session, so the next call connects.
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: Connection closed");
    expect(client.activeSession).toBeNull();
    expect(client.sessionTask).toBeNull();
    server.transportExitError = null;
    resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    await client.close();
  });

  test("test_a_failed_connect_after_a_drop_reports_its_error_and_heals", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(_connectionClosedError());
    await callViaHandler(toolsSchema, "tool_a");

    // The connect the next call runs fails, and reports why.
    server.failInitializes = 1;
    let resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Error calling mcp tool tool_a: connect failed");

    // The call after it connects and runs.
    resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    await client.close();
  });

  test("test_an_empty_result_still_reads_as_the_stock_line", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    server.emptyResults = true;
    const toolsSchema = await client.tools();
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Sorry, could not call the mcp tool");
    await client.close();
  });

  test("test_a_long_error_is_cut_to_size", async () => {
    // The line goes into the LLM context, so it is cut to a fixed length.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    server.callErrors.push(new ValueError("x".repeat(_MAX_ERROR_DETAIL * 2)));
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(
      resultCallback,
      `Error calling mcp tool tool_a: ${"x".repeat(_MAX_ERROR_DETAIL)}...`,
    );
    await client.close();
  });

  test("test_a_result_of_another_content_type_reads_as_the_stock_line", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    server.nonTextResults = true;
    const toolsSchema = await client.tools();
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "Sorry, could not call the mcp tool");
    await client.close();
  });
});

/** An MCP server over the SDK's in-memory transport, with one tool. */
function sdkServer(): McpServer {
  const server = new McpServer({ name: "test-server", version: "1" });
  server.registerTool("tool_a", { description: "A tool." }, async () => ({
    content: [{ type: "text" as const, text: "tool_a-RESULT" }],
  }));
  return server;
}

describe("TestSDKConnectionErrors", () => {
  // What a real SDK session raises once the transport under it is gone.

  test("test_a_call_on_a_closed_transport_reads_as_a_lost_connection", async () => {
    // The SDK exposes no liveness on its session, so a lost connection is read from the error a
    // call raises.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await sdkServer().connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    await serverTransport.close();
    await clientTransport.close();
    await sleep(0);
    const error = await raised(() => client.callTool({ name: "tool_a", arguments: {} }));
    expect(error).toBeInstanceOf(Error);
    expect(_isConnectionLost(error)).toBe(true);
  });

  test("test_an_error_the_server_reports_is_not_a_lost_connection", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await sdkServer().connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    // The SDK returns an isError result or raises an McpError, according to its version. Either
    // way it is not a transport that is gone.
    const outcome = await client.callTool({ name: "no_such_tool", arguments: {} }).catch((e) => e);
    if (outcome instanceof Error) {
      expect(_isConnectionLost(outcome)).toBe(false);
    } else {
      expect(outcome.isError).toBe(true);
    }
    await client.close();
  });

  test("test_error_detail_drops_the_sdk_prefix", () => {
    expect(_errorDetail(_connectionClosedError())).toBe("Connection closed");
    expect(_errorDetail(new AggregateError([_connectionClosedError()], "group"))).toBe(
      "Connection closed",
    );
  });
});

/** The server ends of the connections a `RealClient` opened. */
class RealClient extends MCPClient {
  readonly connections: InMemoryTransport[] = [];

  constructor() {
    super({ serverParams: new StreamableHttpParameters({ url: "http://test/mcp" }) });
  }

  /** Each connect mints a transport pair of its own, with a real server behind it. */
  protected override async _enterTransport(stack: AsyncExitStack): Promise<Transport> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = sdkServer();
    await server.connect(serverTransport);
    this.connections.push(serverTransport);
    stack.push(async () => {
      await server.close();
    });
    return clientTransport;
  }

  get activeSession(): MCPSession | null {
    return this._activeSession;
  }
}

describe("TestRealSession", () => {
  // The client over a real SDK session, with a real server behind it.

  test("test_a_real_transport_that_dies_drops_its_session_and_reconnects", async () => {
    const client = new RealClient();
    clients.push(client);
    const toolsSchema = await client.tools();
    let resultCallback = await callViaHandler(toolsSchema, "tool_a", {});
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");

    // Kill the server end of the live connection, as a dropped connection does.
    await client.connections[client.connections.length - 1]!.close();

    resultCallback = await callViaHandler(toolsSchema, "tool_a", {});
    const delivered = resultCallback.mock.calls[0]![0] as string;
    expect(delivered).toContain("Error calling mcp tool tool_a:");
    expect(client.activeSession).toBeNull();

    // The call after it connects again, on a transport of its own.
    resultCallback = await callViaHandler(toolsSchema, "tool_a", {});
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    expect(client.connections.length).toBe(2);
    await client.close();
  });
});

describe("TestLifecycle", () => {
  // start/close: task safety, retry, idempotency.

  test("test_close_from_other_task_exits_transport_in_owner_task", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.tools();
    // Close from a different task than the one that started the client (as an
    // on_client_disconnected handler would).
    await createTask(() => client.close());
    expect(server.exits).toBe(1);
    // The anyio-based transport requires enter/exit in the same task.
    expect(server.enterTask).toBe(server.exitTask!);
    expect(server.enterTask).not.toBe(currentTask());
  });

  test("test_failed_start_raises_and_allows_retry", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    server.failInitializes = 1;
    expect(await raised(() => client.start())).toBeInstanceOf(RuntimeError);
    // The partially opened transport was cleaned up.
    expect(server.exits).toBe(1);
    // A later call retries cleanly.
    await client.start();
    expect(server.initializes).toBe(1);
    await client.close();
  });

  test("test_cancelling_transport_raises_its_underlying_cause", async () => {
    // A transport whose request fails cancels the connecting task and reports the cause only as it
    // unwinds; tools() must raise that cause rather than wait on a connection that will never
    // arrive.
    const cause = new RuntimeError("Client error '401 Unauthorized'");
    const [client, server] = makeClient([_tool("tool_a")]);
    server.cancelInitialize = true;
    server.transportExitError = new AggregateError([cause], "unhandled errors in a TaskGroup");
    const error = await raised(() => waitFor(() => client.tools(), 5));
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toBe(cause);
    expect(server.exits).toBe(1);
  });

  test("test_cancelling_transport_without_a_cause_still_raises", async () => {
    // Nothing surfaced on unwind, so there's no cause to report, but the caller still gets an
    // error instead of waiting forever.
    const [client, server] = makeClient([_tool("tool_a")]);
    server.cancelInitialize = true;
    expect(await raised(() => waitFor(() => client.tools(), 5))).toBeInstanceOf(ConnectionError);
  });

  test("test_cancelling_the_caller_stops_a_connect_in_flight", async () => {
    // Cancelling the task awaiting start() cancels the future it waits on. A session still inside
    // the connect can't see that, so start() stops it: an unresponsive server would otherwise hold
    // the transport (a spawned server process) with nothing left able to reach it.
    const [client, server] = makeClient([_tool("tool_a")]);
    server.connectDelay = 3600;
    const caller = createTask(() => client.tools());
    await sleep(0.05); // inside the connect window
    const sessionTask = client.sessionTask!;
    caller.cancel();
    expect(await raised(() => caller)).toBeInstanceOf(CancelledError);

    expect(await raised(() => waitFor(() => sessionTask, 5))).toBeInstanceOf(CancelledError);
    expect(client.activeSession).toBeNull();
    expect(client.sessionTask).toBeNull();
    // Nothing is left for close() to do, and it says so quietly.
    await client.close();
  });

  test("test_connection_nobody_awaits_is_released", async () => {
    // The connect can still land in the window between the caller's cancellation and start()
    // reacting to it, leaving a session with no one to hand it to. It has to release itself rather
    // than sit open.
    const [client, server] = makeClient([_tool("tool_a")]);
    const ready = new Future<void>();
    ready.cancel();

    await client.runSession(ready, new Event());

    expect(server.exits).toBe(1);
    expect(client.activeSession).toBeNull();
  });

  test("test_failed_connect_nobody_awaits_settles_quietly", async () => {
    // Same window, but the connect fails: with no one waiting, the failure has nowhere to go and
    // must not become an error of its own.
    const [client, server] = makeClient([_tool("tool_a")]);
    server.failInitializes = 1;
    const ready = new Future<void>();
    ready.cancel();

    await client.runSession(ready, new Event());

    expect(server.exits).toBe(1);
    expect(client.activeSession).toBeNull();
  });

  test("test_close_before_start_and_double_close_are_safe", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.close();
    await client.start();
    await client.close();
    await client.close();
    expect(server.exits).toBe(1);
  });

  test("test_calling_a_tool_after_close_raises", async () => {
    // A closed client stays closed. A transport opened here has no owner to close it.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    await client.close();
    expect(await raised(() => callViaHandler(toolsSchema, "tool_a", {}))).toBeInstanceOf(
      _NotConnectedError,
    );
    expect(server.enters).toBe(1);
  });

  test("test_calling_a_tool_before_start_raises", async () => {
    // No owner has asked for a session, so the call opens no transport. The owner must start the
    // client.
    const [client, server] = makeClient([_tool("tool_a")]);
    const { params, resultCallback } = handlerParams("tool_a", {});
    expect(await raised(() => client.toolWrapper(params))).toBeInstanceOf(_NotConnectedError);
    expect(server.enters).toBe(0);
    expect(resultCallback).not.toHaveBeenCalled();
  });

  test("test_tools_after_close_reconnects", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.tools();
    await client.close();
    const toolsSchema = await client.tools();
    expect(server.enters).toBe(2);
    expect(names(toolsSchema)).toEqual(new Set(["tool_a"]));
    await client.close();
  });

  test("test_a_start_behind_a_close_leaves_a_live_session", async () => {
    // The lock serialises the two, so the one that reaches it last decides. A start that lands
    // behind a close has a session to hand the next call.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    await gather(
      () => client.close(),
      () => client.start(),
    );
    expect(server.enters).toBe(2);
    expect(server.exits).toBe(1);
    const resultCallback = await callViaHandler(toolsSchema, "tool_a");
    assertAwaitedOnceWith(resultCallback, "tool_a-RESULT");
    await client.close();
  });

  test("test_a_close_behind_a_start_leaves_nothing_open", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    await gather(
      () => client.start(),
      () => client.close(),
    );
    expect(server.exits).toBe(server.enters);
    expect(client.activeSession).toBeNull();
    expect(client.sessionTask).toBeNull();
    // The client is closed, so the call raises and opens no transport.
    expect(await raised(() => callViaHandler(toolsSchema, "tool_a"))).toBeInstanceOf(
      _NotConnectedError,
    );
    expect(server.enters).toBe(1);
  });

  test("test_concurrent_starts_open_one_connection", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await gather(
      () => client.start(),
      () => client.start(),
      () => client.start(),
    );
    expect(server.enters).toBe(1);
    await client.close();
  });

  // `async with MCPClient(...) as mcp` becomes `await using`, and `scoped()`.
  test("test_async_with_still_works", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.scoped(async (mcp) => {
      const toolsSchema = await mcp.tools();
      expect(names(toolsSchema)).toEqual(new Set(["tool_a"]));
    });
    expect(server.exits).toBe(1);
  });

  test("test_await_using_closes_the_client", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    {
      await using mcp = client;
      await mcp.tools();
    }
    expect(server.exits).toBe(1);
  });

  test("test_server_params_of_another_type_are_rejected", () => {
    expect(() => new MCPClient({ serverParams: { url: "http://test/mcp" } as never })).toThrow(
      TypeError,
    );
  });
});

describe("TestDeprecatedRegistrationApi", () => {
  // register_tools/register_tools_schema/get_tools_schema are deprecated, so they are not ported.

  test.skip("test_get_tools_schema_warns_and_returns_handlerless_schemas", () => {
    // Skipped: MCPClient.get_tools_schema is deprecated upstream and not ported (use tools()).
  });

  test.skip("test_register_tools_warns_and_registers", () => {
    // Skipped: MCPClient.register_tools is deprecated upstream and not ported (use tools()).
  });

  test.skip("test_register_tools_schema_warns_and_registers", () => {
    // Skipped: MCPClient.register_tools_schema is deprecated upstream and not ported (use tools()).
  });
});

/** Minimal LLM service for testing auto-registration and cleanup. */
class TestLLMService extends LLMService {
  constructor() {
    super({
      settings: new LLMSettings({
        model: "test-model",
        systemInstruction: null,
        temperature: null,
        maxTokens: null,
        topP: null,
        topK: null,
        frequencyPenalty: null,
        presencePenalty: null,
        seed: null,
        filterIncompleteUserTurns: null,
        userTurnCompletionConfig: null,
      }),
    });
  }

  syncRegisteredToolHandlers(tools: unknown): void {
    this._syncRegisteredToolHandlers(tools as never);
  }

  get functions(): Map<string | null, FunctionCallRegistryItem> {
    return this._functions;
  }
}

describe("TestAutoCloseOnCleanup", () => {
  // LLMService.cleanup() closes clients whose handlers were registered.

  test("test_cleanup_closes_registered_client", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    const service = new TestLLMService();
    service.syncRegisteredToolHandlers(toolsSchema);
    await service.cleanup();
    expect(server.exits).toBe(1);
  });

  test("test_cleanup_twice_is_safe", async () => {
    const [client, server] = makeClient([_tool("tool_a")]);
    const service = new TestLLMService();
    service.syncRegisteredToolHandlers(await client.tools());
    await service.cleanup();
    await service.cleanup();
    expect(server.exits).toBe(1);
  });

  test("test_two_services_sharing_client_close_idempotently", async () => {
    // e.g. two LLMs behind a switcher advertising the same context tools.
    const [client, server] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    const serviceA = new TestLLMService();
    const serviceB = new TestLLMService();
    serviceA.syncRegisteredToolHandlers(toolsSchema);
    serviceB.syncRegisteredToolHandlers(toolsSchema);
    await serviceA.cleanup();
    await serviceB.cleanup();
    expect(server.exits).toBe(1);
  });

  test("test_no_close_when_handlers_never_registered", async () => {
    // Known gap: a connected client the LLM service never learned about (no inference ran) is not
    // auto-closed.
    const [client, server] = makeClient([_tool("tool_a")]);
    await client.tools();
    const service = new TestLLMService();
    await service.cleanup();
    expect(server.exits).toBe(0);
    await client.close();
    expect(server.exits).toBe(1);
  });

  test.skip("test_deprecated_register_tools_path_also_auto_closes", () => {
    // Skipped: MCPClient.register_tools is deprecated upstream and not ported (use tools()).
  });

  test("test_client_survives_tool_pruning_until_cleanup", async () => {
    // De-advertising a tool prunes its handler but must not close the session mid-conversation;
    // the close happens at teardown.
    const [client, server] = makeClient([_tool("tool_a")]);
    const service = new TestLLMService();
    service.syncRegisteredToolHandlers(await client.tools());
    service.syncRegisteredToolHandlers([]); // tool set replaced
    expect(server.exits).toBe(0);
    await service.cleanup();
    expect(server.exits).toBe(1);
  });
});

describe("TestLLMAutoRegistration", () => {
  // End-to-end with a real LLMService: tools() auto-registers.

  test("test_tools_auto_register_with_llm_service", async () => {
    const [client] = makeClient([_tool("tool_a")]);
    const toolsSchema = await client.tools();
    const service = new TestLLMService();
    service.syncRegisteredToolHandlers(toolsSchema);
    expect(service.hasFunction("tool_a")).toBe(true);
    expect(service.functions.get("tool_a")!.autoRegistered).toBe(true);
    await client.close();
  });

  test.skip("test_deprecated_register_tools_path_does_not_warn_redundant", () => {
    // Skipped: MCPClient.register_tools is deprecated upstream and not ported (use tools()).
  });
});

describe("TestAsyncExitStack", () => {
  // Python's AsyncExitStack, which the session task uses to unwind a half-open connection.

  test("test_cleanups_run_last_in_first_out_and_the_last_error_propagates", async () => {
    const stack = new AsyncExitStack();
    const order: number[] = [];
    stack.push(async () => {
      order.push(1);
      throw new RuntimeError("first");
    });
    stack.push(async () => {
      order.push(2);
      throw new RuntimeError("second");
    });
    stack.push(async () => {
      order.push(3);
    });
    const error = await raised(() => stack.aclose());
    expect(order).toEqual([3, 2, 1]);
    expect((error as Error).message).toBe("first");
    // Closing again does nothing.
    await stack.aclose();
    expect(order).toEqual([3, 2, 1]);
  });
});
