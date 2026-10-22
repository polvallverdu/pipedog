// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/mcp_service.py

/**
 * MCP (Model Context Protocol) client for integrating external tools with LLMs.
 *
 * PORTING NOTES:
 * - Python's `mcp` SDK becomes the official `@modelcontextprotocol/sdk` client. Its transports
 *   all run over `fetch` (streamable HTTP, SSE), except stdio, which spawns a child process and is
 *   imported lazily, so a Workers bundle that never opens a stdio server never loads it.
 * - Upstream's `MCPClient` keeps a persistent session owned by one task (`anyio` requires that a
 *   transport be opened and closed in the same task). The SDK has no such rule, but the structure
 *   is kept as is, because it also gives `start()` and `close()` a single place that serializes them
 *   (the lifecycle lock) and a way to stop a connect that is still in flight.
 * - Deprecated upstream APIs are not ported: `register_tools`, `get_tools_schema` and
 *   `register_tools_schema` (use `tools()`, whose schemas carry their handlers). The tests that
 *   only exercise them are skipped.
 * - `async with MCPClient(...)` becomes `await using` (`Symbol.asyncDispose`) or `scoped()`.
 * - `anyio` stream errors do not exist here. "The connection is gone" is read from what the SDK
 *   raises for it: an `McpError` with code `ConnectionClosed`, or `Error("Not connected")` for a
 *   request on a client whose transport closed.
 * - `ExceptionGroup` becomes `AggregateError`.
 * - Upstream's `StdioServerParameters`, `SseServerParameters` and `StreamableHttpParameters` are
 *   classes of the `mcp` package. Here they are small classes with an options constructor, so the
 *   `instanceof` dispatch and the `TypeError` for anything else still work.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  abortable,
  CancelledError,
  createTask,
  currentSignal,
  Event,
  Future,
  Lock,
  rethrowIfCancelled,
  type Task,
} from "@pipedog/asyncio";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import type { FunctionCallHandler, FunctionCallParams } from "@pipedog/core/services/llm_service";
import { BaseObject, type BaseObjectOptions } from "@pipedog/core/utils/base_object";
import { logger } from "@pipedog/core/utils/logger";

// ---------------------------------------------------------------------------
// Server parameters

/** The options of `StdioServerParameters`. */
export interface StdioServerParametersOptions {
  /** The executable to run to start the server. */
  command: string;
  /** Command line arguments to pass to the executable. */
  args?: string[];
  /**
   * The environment to use when spawning the process. It is merged over a default environment of
   * safe variables (`PATH`, `HOME` and so on), not over the whole of `process.env`.
   */
  env?: Record<string, string> | null;
  /** The working directory to use when spawning the process. */
  cwd?: string | null;
}

/** Parameters for a server that is a child process, spoken to over stdin and stdout. */
export class StdioServerParameters {
  command: string;
  args: string[];
  env: Record<string, string> | null;
  cwd: string | null;

  constructor(options: StdioServerParametersOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? null;
    this.cwd = options.cwd ?? null;
  }
}

/** The options of `SseServerParameters`. */
export interface SseServerParametersOptions {
  /** The SSE endpoint of the server. */
  url: string | URL;
  /** Extra HTTP headers, for example `Authorization`. */
  headers?: Record<string, string> | null;
  /** Seconds to wait for the `initialize` handshake. Defaults to 5. */
  timeout?: number;
  /** Seconds to wait for the response headers of a request. Defaults to 300. */
  sseReadTimeout?: number;
  /**
   * The `fetch` to use, instead of the global one.
   *
   * DIVERGENCE: not in upstream (which uses httpx). It lets a test, or a Worker with a service
   * binding, serve the connection in process.
   */
  fetch?: typeof fetch | null;
}

/** Parameters for a server reached over SSE (the older HTTP transport of MCP). */
export class SseServerParameters {
  url: string | URL;
  headers: Record<string, string> | null;
  timeout: number;
  sseReadTimeout: number;
  fetch: typeof fetch | null;

  constructor(options: SseServerParametersOptions) {
    this.url = options.url;
    this.headers = options.headers ?? null;
    this.timeout = options.timeout ?? 5;
    this.sseReadTimeout = options.sseReadTimeout ?? 300;
    this.fetch = options.fetch ?? null;
  }
}

/** The options of `StreamableHttpParameters`. */
export interface StreamableHttpParametersOptions {
  /** The MCP endpoint of the server. */
  url: string | URL;
  /** Extra HTTP headers, for example `Authorization`. */
  headers?: Record<string, string> | null;
  /** Seconds to wait for the `initialize` handshake. Defaults to 30. */
  timeout?: number;
  /** Seconds to wait for the response headers of a request. Defaults to 300. */
  sseReadTimeout?: number;
  /** Whether closing the client also ends the server's session (an HTTP DELETE). Defaults to true. */
  terminateOnClose?: boolean;
  /**
   * The `fetch` to use, instead of the global one.
   *
   * DIVERGENCE: not in upstream (which uses httpx). It lets a test, or a Worker with a service
   * binding, serve the connection in process.
   */
  fetch?: typeof fetch | null;
}

/** Parameters for a server reached over streamable HTTP, the current HTTP transport of MCP. */
export class StreamableHttpParameters {
  url: string | URL;
  headers: Record<string, string> | null;
  timeout: number;
  sseReadTimeout: number;
  terminateOnClose: boolean;
  fetch: typeof fetch | null;

  constructor(options: StreamableHttpParametersOptions) {
    this.url = options.url;
    this.headers = options.headers ?? null;
    this.timeout = options.timeout ?? 30;
    this.sseReadTimeout = options.sseReadTimeout ?? 300;
    this.terminateOnClose = options.terminateOnClose ?? true;
    this.fetch = options.fetch ?? null;
  }
}

export type ServerParameters =
  | StdioServerParameters
  | SseServerParameters
  | StreamableHttpParameters;

// ---------------------------------------------------------------------------
// The session the client talks through

/** What an MCP server advertises for one tool (`tools/list`). */
export interface MCPToolInfo {
  name: string;
  description?: string | null;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** One block of a tool's result. Only `type: "text"` blocks carry text the model can read. */
export interface MCPContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** What a tool call returns (`tools/call`). */
export interface MCPCallToolResult {
  content?: MCPContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * The part of an MCP client session that `MCPClient` uses. The real one wraps the SDK's `Client`;
 * a test can hand in a fake (see `MCPClient._enterSession`).
 */
export interface MCPSession {
  /** Run the `initialize` handshake. */
  initialize(): Promise<void>;
  /** List the server's tools. */
  listTools(): Promise<{ tools: MCPToolInfo[] }>;
  /** Call a tool. */
  callTool(name: string, args?: Record<string, unknown> | null): Promise<MCPCallToolResult>;
}

/**
 * The SDK's request timeout is 60 seconds unless told otherwise. Upstream's session has none, so a
 * slow tool is waited for. `setTimeout` takes at most 2**31 - 1 milliseconds, which is that, to
 * every practical end.
 */
const NO_TIMEOUT_MS = 2_147_483_647;

/** An MCP session over the SDK's `Client`. */
class SdkSession implements MCPSession {
  readonly #client: Client;
  readonly #transport: Transport;
  readonly #initializeTimeoutMs: number;

  readonly #beforeClose: (() => Promise<void>) | null;

  constructor(
    transport: Transport,
    initializeTimeoutSecs: number | null,
    beforeClose: (() => Promise<void>) | null = null,
  ) {
    this.#transport = transport;
    this.#beforeClose = beforeClose;
    this.#initializeTimeoutMs =
      initializeTimeoutSecs === null ? NO_TIMEOUT_MS : initializeTimeoutSecs * 1000;
    // DIVERGENCE: the SDK compiles an output schema with Ajv, which generates code with `new
    // Function`. Workers forbid that, so there the result is not validated against the tool's
    // output schema (upstream validates it). Everywhere else the SDK's default is kept.
    const onWorkers =
      typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
    this.#client = new Client(
      { name: "pipedog", version: "0.1.0" },
      onWorkers ? { capabilities: {}, jsonSchemaValidator: PASS_THROUGH_VALIDATOR } : undefined,
    );
  }

  async initialize(): Promise<void> {
    // The SDK's `connect` starts the transport and runs the handshake. An await on the SDK is not
    // a cancellation point, hence `abortable`.
    await abortable(
      this.#client.connect(this.#transport, {
        timeout: this.#initializeTimeoutMs,
        signal: currentSignal(),
      }),
    );
  }

  async listTools(): Promise<{ tools: MCPToolInfo[] }> {
    // DIVERGENCE: upstream reads the first page of `tools/list` only. This one follows the
    // server's cursor, so a server that pages its tools is not cut short.
    const tools: MCPToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await abortable(
        this.#client.listTools(cursor ? { cursor } : undefined, {
          timeout: NO_TIMEOUT_MS,
          signal: currentSignal(),
        }),
      );
      tools.push(...(page.tools as MCPToolInfo[]));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools };
  }

  async callTool(name: string, args?: Record<string, unknown> | null): Promise<MCPCallToolResult> {
    return (await abortable(
      this.#client.callTool({ name, arguments: args ?? undefined }, undefined, {
        timeout: NO_TIMEOUT_MS,
        signal: currentSignal(),
      }),
    )) as MCPCallToolResult;
  }

  /** Close the session and the transport under it. */
  async close(): Promise<void> {
    await this.#beforeClose?.();
    await this.#client.close();
  }
}

/** The SDK's `jsonSchemaValidator` that accepts everything (see `SdkSession`). */
const PASS_THROUGH_VALIDATOR = {
  getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }),
} as unknown as NonNullable<ConstructorParameters<typeof Client>[1]>["jsonSchemaValidator"];

// ---------------------------------------------------------------------------
// Errors

export const _MAX_ERROR_DETAIL = 200;

/** The client holds no session, and no owner has asked it for one. */
export class _NotConnectedError extends Error {
  override name = "NotConnectedError";
}

/** The client could not connect to the MCP server, and the transport named no cause. */
export class ConnectionError extends Error {
  override name = "ConnectionError";
}

/** The message an `McpError` was built from. The SDK prefixes it with `MCP error <code>: `. */
function rawMessage(error: Error): string {
  if (error instanceof McpError) return error.message.replace(/^MCP error -?\d+: /, "");
  return error.message;
}

/**
 * Tell a dead transport from an error the MCP server itself reported.
 *
 * A transport that fails inside its own tasks reports through an aggregate, which carries the
 * transport's own error among whatever else failed with it.
 */
export function _isConnectionLost(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(_isConnectionLost);
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  // What a request on a client whose transport has closed raises.
  return error instanceof Error && error.message === "Not connected";
}

/**
 * Read the one exception an aggregate of one wraps, at whatever depth.
 *
 * An aggregate carries neither the type nor the message of what went wrong, so an aggregate of one
 * reports as the cause it holds.
 */
export function _soleCause(error: unknown): unknown {
  let cause = error;
  while (cause instanceof AggregateError && cause.errors.length === 1) {
    cause = cause.errors[0];
  }
  return cause;
}

/** Name the cause of a failed tool call, in the one line the model reads. */
export function _errorDetail(error: unknown): string {
  const cause = _soleCause(error);
  const detail = cause instanceof Error ? rawMessage(cause) : String(cause);
  if (!detail) {
    // Some errors carry no message, so name the class instead.
    return cause instanceof Error ? cause.constructor.name : typeof cause;
  }
  if (detail.length > _MAX_ERROR_DETAIL) {
    return `${detail.slice(0, _MAX_ERROR_DETAIL)}...`;
  }
  return detail;
}

/**
 * Find the exception that best explains a failed connect.
 *
 * A failing transport cancels the connecting task from inside its own task group, so the exception
 * raised at the connect site is usually just a `CancelledError`; the real cause (an HTTP error, a
 * refused connection) surfaces separately as the exit stack unwinds. Aggregates wrapping a single
 * cause are unwrapped so callers see that cause directly.
 *
 * @param candidates Exceptions seen while connecting, most informative first.
 * @returns The first candidate that is a regular exception, or `null` if every candidate is a
 *   cancellation.
 */
export function _connectFailureCause(...candidates: unknown[]): unknown | null {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const cause = _soleCause(candidate);
    if (!(cause instanceof CancelledError)) return cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transports

/** `AsyncExitStack`: cleanups that run in reverse order, whatever happens to the ones after them. */
export class AsyncExitStack {
  #callbacks: (() => Promise<void> | void)[] = [];

  push(callback: () => Promise<void> | void): void {
    this.#callbacks.push(callback);
  }

  /**
   * Run every cleanup, last in first out. If some of them raise, the last error raised is the one
   * that propagates, as in Python.
   */
  async aclose(): Promise<void> {
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    let raised: unknown = null;
    let failed = false;
    while (callbacks.length > 0) {
      const callback = callbacks.pop() as () => Promise<void> | void;
      try {
        await callback();
      } catch (e) {
        // Python's exit stack keeps unwinding with the new exception in place of the old.
        raised = e;
        failed = true;
      }
    }
    if (failed) throw raised;
  }
}

/**
 * Wrap `fetch` so a request that gets no response headers within `seconds` is aborted. The body of
 * the response, an SSE stream that stays open, is not limited.
 */
function withHeadersTimeout(base: typeof fetch, seconds: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    // A foreign timer: this wraps `fetch`, outside any task, and is cleared as soon as it answers.
    const timer = setTimeout(
      () => controller.abort(new Error(`The MCP server sent no response within ${seconds}s`)),
      seconds * 1000,
    );
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      return await base(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/** The SDK reports errors of the transport that no request is waiting for through `onerror`. */
function logTransportError(error: Error): void {
  logger.debug(`MCP transport error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// The tool handler

/**
 * Tool call wrapper that carries the cleanup releasing its backing resource.
 *
 * The LLM service registers this wrapper like any other handler and awaits `_pipecatCleanup` when
 * the service is cleaned up, so a resource that outlives individual calls (an MCP server
 * connection) is released at pipeline teardown without the developer wiring teardown manually.
 *
 * @param callTool Invoked for each tool call.
 * @param cleanup Awaited once at LLM service teardown. Expected to be idempotent, and the same
 *   function across wrappers sharing a resource, so the service records it once.
 */
function toolWrapperWithCleanup(
  callTool: FunctionCallHandler,
  cleanup: () => Promise<void>,
): FunctionCallHandler {
  const wrapper = async (params: FunctionCallParams): Promise<void> => {
    await callTool(params);
  };
  return Object.assign(wrapper, { _pipecatCleanup: cleanup });
}

// ---------------------------------------------------------------------------
// MCPClient

export interface MCPClientOptions extends BaseObjectOptions {
  /** Server connection parameters (stdio, SSE, or streamable HTTP). */
  serverParams: ServerParameters;
  /** Optional list of tool names to register. If null, all tools are registered. */
  toolsFilter?: string[] | null;
  /**
   * Optional map from tool names to filter functions that process tool outputs. Each filter
   * receives the tool's text output and returns the processed output.
   */
  toolsOutputFilters?: Record<string, (output: any) => any> | null;
  /**
   * Optional map from tool names to fixed arguments that are merged into every call of that tool
   * (overriding any model-supplied values). The fixed parameter names are removed from the
   * advertised tool schema so the LLM never sees them.
   */
  toolsArguments?: Record<string, Record<string, unknown>> | null;
}

/**
 * Client for Model Context Protocol (MCP) servers.
 *
 * Enables integration with MCP servers to provide external tools and resources to LLMs. Supports
 * stdio, SSE, and streamable HTTP server connections with automatic tool registration and schema
 * conversion.
 *
 * The client maintains a persistent connection to the MCP server, opened on the first call to
 * `tools()` (or ahead of time via `start()`). The tool schemas returned by `tools()` carry their
 * call handlers, so the LLM service registers them automatically when they are advertised through
 * an `LLMContext`, and closes the connection when the pipeline is torn down:
 *
 * ```ts
 * const mcp = new MCPClient({ serverParams: new StreamableHttpParameters({ url }) });
 * const context = new LLMContext({ messages: [...], tools: await mcp.tools() });
 * ```
 *
 * A tool call that finds its connection gone drops that session and returns the error to the
 * model, and the call after it connects again.
 *
 * Call `close()` only to release the connection earlier than pipeline teardown (for example from
 * an `on_client_disconnected` handler). A closed client stays closed until `start()` or `tools()`
 * opens it again, and a tool call on one raises. `start()` and `close()` may be called from
 * different tasks: the session is owned by a dedicated internal task. Scoping the client with
 * `await using` or `scoped()` is also supported.
 *
 * @throws TypeError If `serverParams` is not a supported parameter type.
 */
export class MCPClient extends BaseObject {
  protected _serverParams: ServerParameters;
  protected _toolsFilter: string[] | null;
  protected _toolsOutputFilters: Record<string, (output: any) => any>;
  protected _toolsArguments: Record<string, Record<string, unknown>>;
  protected _exitStack: AsyncExitStack | null = null;
  protected _activeSession: MCPSession | null = null;
  // One wrapper shared by every tool this client advertises, carrying the cleanup that releases
  // the connection.
  protected _toolWrapperWithCleanup: FunctionCallHandler;
  // A dedicated owner task (_runSession) holds the session open and tears it down on signal, so
  // start() and close() can be called from different tasks.
  protected _sessionTask: Task<void> | null = null;
  protected _closing: Event | null = null;
  // One lock serializes the session lifecycle transitions: start, close, drop, and a tool call's
  // reconnect. The owner task clears the session fields as it exits.
  protected _lifecycleLock = new Lock();
  // Whether an owner (start() or tools()) currently holds the client open. With _activeSession it
  // distinguishes the no-session states:
  // no session requested + true = dropped; a tool call may reconnect.
  // no session requested + false = never started or closed; a tool call raises.
  protected _sessionRequested = false;

  constructor(options: MCPClientOptions) {
    super(options);
    this._serverParams = options.serverParams;
    this._toolsFilter = options.toolsFilter ?? null;
    this._toolsOutputFilters = options.toolsOutputFilters ?? {};
    this._toolsArguments = options.toolsArguments ?? {};
    const close = (): Promise<void> => this.close();
    this._toolWrapperWithCleanup = toolWrapperWithCleanup(
      (params) => this._toolWrapper(params),
      close,
    );

    if (
      !(
        options.serverParams instanceof StdioServerParameters ||
        options.serverParams instanceof SseServerParameters ||
        options.serverParams instanceof StreamableHttpParameters
      )
    ) {
      throw new TypeError(
        `${this} invalid argument type: \`serverParams\` must be either ` +
          "StdioServerParameters, SseServerParameters, or StreamableHttpParameters.",
      );
    }
  }

  /**
   * Start a persistent connection to the MCP server.
   *
   * Opens the transport and initializes the MCP session. The session is reused for all subsequent
   * tool calls and schema requests until `close()` is called. Idempotent, and called automatically
   * by `tools()`.
   */
  async start(): Promise<void> {
    await this._openSession({ asOwner: true });
  }

  /**
   * Return the session the caller runs on, opening one if the client holds none.
   *
   * Holds the lifecycle lock across the start and the read, so a close cannot take the session
   * away in between.
   *
   * @param options.asOwner True when the caller owns the connection. A tool call passes false and
   *   uses the session an owner asked for.
   * @throws _NotConnectedError If no owner has asked the client for a session.
   */
  protected async _openSession(options: { asOwner: boolean }): Promise<MCPSession> {
    return await this._lifecycleLock.run(async () => {
      if (options.asOwner) {
        this._sessionRequested = true;
      }
      if (this._sessionRequested) {
        await this._startLocked();
      }
      return this._getActiveSession();
    });
  }

  /** Open the session, with the lifecycle lock held. */
  protected async _startLocked(): Promise<void> {
    if (this._activeSession) return;
    const closing = new Event();
    this._closing = closing;
    const ready = new Future<void>();
    const task = createTask(() => this._runSession(ready, closing), `${this}::session`);
    this._sessionTask = task;
    try {
      await ready; // resolves once connected; re-raises a connect failure
    } catch (e) {
      // This catch is deliberately broad, as Python's `except BaseException`: whatever stopped the
      // wait, the half-open session is released, and the error goes on.
      this._sessionTask = null; // retry cleanly later
      // Cancellation reaches us as a cancelled `ready`. A session that connected releases itself.
      // One still waiting on an unresponsive server holds the transport until this task is
      // cancelled, and nothing else can reach this task once the handle is dropped.
      if (ready.cancelled() && this._activeSession === null) {
        task.cancel();
      }
      throw e;
    }
  }

  /**
   * Open the transport, with its cleanup pushed on `stack`.
   *
   * This and `_enterSession` are the two places a test replaces to put a fake server behind the
   * client.
   *
   * @returns The SDK transport, not yet started: `initialize()` starts it.
   */
  protected async _enterTransport(stack: AsyncExitStack): Promise<Transport> {
    const params = this._serverParams;
    let transport: Transport;
    if (params instanceof StdioServerParameters) {
      // Loaded on use, by package name: the export condition `workerd` swaps the module for one
      // that refuses, so a bundle for Workers never pulls in the SDK's stdio transport (it spawns
      // a process, through `cross-spawn` and `node:child_process`).
      const { createStdioTransport } = await import("@pipedog/mcp-client/stdio_transport");
      transport = createStdioTransport({
        command: params.command,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
      });
    } else if (params instanceof SseServerParameters) {
      transport = new SSEClientTransport(new URL(params.url), {
        requestInit: { headers: params.headers ?? undefined },
        fetch: withHeadersTimeout(params.fetch ?? fetch, params.sseReadTimeout),
      });
    } else {
      // StreamableHttpParameters (validated in the constructor)
      transport = new StreamableHTTPClientTransport(new URL(params.url), {
        requestInit: { headers: params.headers ?? undefined },
        fetch: withHeadersTimeout(params.fetch ?? fetch, params.sseReadTimeout),
      });
    }
    transport.onerror = logTransportError;
    stack.push(async () => {
      await transport.close();
    });
    return transport;
  }

  /** The `initialize` timeout the server parameters ask for, in seconds. */
  protected _initializeTimeout(): number | null {
    const params = this._serverParams;
    return params instanceof StdioServerParameters ? null : params.timeout;
  }

  /**
   * Open the session on `transport`, with its cleanup pushed on `stack`. The handshake runs in
   * `initialize()`.
   */
  protected async _enterSession(stack: AsyncExitStack, transport: Transport): Promise<MCPSession> {
    const params = this._serverParams;
    const endSession =
      params instanceof StreamableHttpParameters &&
      params.terminateOnClose &&
      transport instanceof StreamableHTTPClientTransport
        ? async () => {
            try {
              // An HTTP DELETE that ends the server's session. It goes before the transport
              // closes, as upstream's transport does it on exit.
              await transport.terminateSession();
            } catch (e) {
              rethrowIfCancelled(e);
              // The server may not allow it, or may be gone already.
              logger.debug(`${this} could not end the MCP session: ${_errorDetail(e)}`);
            }
          }
        : null;
    const session = new SdkSession(transport, this._initializeTimeout(), endSession);
    stack.push(() => session.close());
    return session;
  }

  /**
   * Own the MCP session for its whole lifetime, in a single task.
   *
   * Opens the connection, signals `ready`, then holds the session open until `close()` sets the
   * closing event, so open and close happen in the same task, as upstream's anyio-based transports
   * require.
   */
  protected async _runSession(ready: Future<void>, closing: Event): Promise<void> {
    const exitStack = new AsyncExitStack();
    let session: MCPSession;

    try {
      const transport = await this._enterTransport(exitStack);
      session = await this._enterSession(exitStack, transport);
      await session.initialize();
    } catch (raised) {
      // Deliberately broad (Python's `except BaseException`): a failing transport cancels this
      // task from inside its own task group, so `raised` is typically a CancelledError and the
      // cause worth reporting only surfaces as the exit stack unwinds. Settling `ready` either way
      // is what keeps start() from waiting forever.
      let unwound: unknown = null;
      try {
        await exitStack.aclose();
      } catch (e) {
        unwound = e;
      }
      if (!ready.cancelled()) {
        ready.setException(
          _connectFailureCause(unwound, raised) ??
            new ConnectionError(`${this} could not connect to the MCP server`),
        );
      }
      if (raised instanceof CancelledError) throw raised;
      return;
    }

    this._exitStack = exitStack;
    this._activeSession = session;
    try {
      if (ready.cancelled()) {
        // The caller was cancelled mid-connect, so nobody will ever call close() for this
        // session: release it here instead of holding a connection no one owns.
        return;
      }
      ready.setResult();
      await closing.wait();
    } finally {
      this._activeSession = null;
      this._exitStack = null;
      await exitStack.aclose();
    }
  }

  /**
   * Close the persistent MCP connection.
   *
   * Called automatically at pipeline teardown once the client's tools have been registered with an
   * LLM service; call it directly only to release the connection earlier (for example on client
   * disconnect). Safe to call multiple times, without having called `start()`, and from a
   * different task than the one that called `start()`.
   *
   * The client stays closed until `start()` or `tools()` opens it again: a tool call on a closed
   * client raises rather than connect.
   */
  async close(): Promise<void> {
    await this._lifecycleLock.run(async () => {
      this._sessionRequested = false;
      await this._closeLocked();
    });
  }

  /** Release the session, with the lifecycle lock held. */
  protected async _closeLocked(): Promise<void> {
    if (this._sessionTask === null) return;
    const task = this._sessionTask;
    this._sessionTask = null;
    if (this._closing !== null) {
      this._closing.set();
    }
    await task;
  }

  /** `await using mcp = new MCPClient(...)` closes the client when the scope ends. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Run `fn` with the client started, and close it afterwards: `async with MCPClient(...) as mcp`.
   *
   * DIVERGENCE: a function in place of Python's context manager, which JavaScript has no
   * counterpart for besides `await using`.
   */
  async scoped<T>(fn: (client: this) => Promise<T>): Promise<T> {
    await this.start();
    try {
      return await fn(this);
    } finally {
      await this.close();
    }
  }

  /**
   * Get the available MCP tools, ready for LLM auto-registration.
   *
   * Starts the server connection if needed, then returns a `ToolsSchema` whose function schemas
   * carry their call handlers, so the LLM service registers them automatically when the context
   * advertises its tools:
   *
   * ```ts
   * const context = new LLMContext({ messages: [...], tools: await mcp.tools() });
   * ```
   *
   * The connection is closed automatically at pipeline teardown; call `close()` only to release it
   * earlier.
   *
   * @returns A `ToolsSchema` containing the available tools with handlers attached.
   */
  async tools(): Promise<ToolsSchema> {
    const session = await this._openSession({ asOwner: true });
    return await this._listToolsHelper(session, true);
  }

  /** Return the active session or raise if not connected. */
  protected _getActiveSession(): MCPSession {
    if (!this._activeSession) {
      throw new _NotConnectedError(
        "MCPClient is not connected. Use 'await using mcp = new MCPClient(...)' " +
          "or call 'await mcp.start()' before using MCPClient.",
      );
    }
    return this._activeSession;
  }

  /**
   * Convert an MCP tool schema to Pipecat's `FunctionSchema` format.
   *
   * @param toolName The name of the tool.
   * @param toolSchema The MCP tool schema.
   * @param handler Optional call handler to attach for LLM auto-registration.
   * @returns A `FunctionSchema` instance.
   */
  protected _convertMcpSchemaToPipecat(
    toolName: string,
    toolSchema: { description?: string | null; inputSchema: MCPToolInfo["inputSchema"] },
    handler: FunctionCallHandler | null = null,
  ): FunctionSchema {
    logger.debug(`Converting schema for tool '${toolName}'`);
    // JSON.stringify (not pyJsonDumps): trace output for a person, and pyJsonDumps has no indent.
    logger.trace(`Original schema: ${JSON.stringify(toolSchema, null, 2)}`);

    let properties: Record<string, unknown> = toolSchema.inputSchema.properties ?? {};
    let required: string[] = toolSchema.inputSchema.required ?? [];

    const fixed = this._fixedArguments(toolName);
    if (fixed) {
      // Fixed arguments are injected on every call, so hide them from the model.
      properties = Object.fromEntries(
        Object.entries(properties).filter(([k]) => !Object.hasOwn(fixed, k)),
      );
      required = required.filter((r) => !Object.hasOwn(fixed, r));
    }

    const schema = new FunctionSchema({
      name: toolName,
      // DIVERGENCE: a tool with no description gets an empty one (upstream passes None through).
      description: toolSchema.description ?? "",
      properties,
      required,
      handler,
    });

    logger.trace(`Converted schema: ${JSON.stringify(schema.toDefaultDict(), null, 2)}`);

    return schema;
  }

  /** The fixed arguments configured for a tool, or null when it has none (an empty map is none). */
  protected _fixedArguments(toolName: string): Record<string, unknown> | null {
    const fixed = Object.hasOwn(this._toolsArguments, toolName)
      ? this._toolsArguments[toolName]
      : undefined;
    return fixed && Object.keys(fixed).length > 0 ? fixed : null;
  }

  /** Execute an MCP tool call using the persistent session. */
  protected async _toolWrapper(params: FunctionCallParams): Promise<void> {
    logger.debug(`Executing tool '${params.functionName}' with call ID: ${params.toolCallId}`);
    logger.trace(`Tool arguments: ${JSON.stringify(params.arguments, null, 2)}`);
    await this._callTool(params.functionName, params.arguments, params.resultCallback);
  }

  protected async _callTool(
    functionName: string,
    args: Record<string, unknown> | null,
    resultCallback: FunctionCallParams["resultCallback"],
  ): Promise<void> {
    const response = await this._callToolText(functionName, args);
    await resultCallback(response);
  }

  protected async _callToolText(
    functionName: string,
    args: Record<string, unknown> | null,
  ): Promise<string> {
    const fixed = this._fixedArguments(functionName);
    if (fixed) {
      // Fixed arguments win over model-supplied values.
      args = { ...(args ?? {}), ...fixed };
    }

    logger.debug(`Calling mcp tool '${functionName}'`);
    let session: MCPSession | null = null;
    let results: MCPCallToolResult | null = null;
    let errorMsg: string | null = null;
    try {
      session = await this._openSession({ asOwner: false });
      results = await session.callTool(functionName, args);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof _NotConnectedError) {
        // The call reached no session. That is a wiring mistake, so it goes to the caller, not to
        // the model.
        throw e;
      }
      errorMsg = `Error calling mcp tool ${functionName}: ${_errorDetail(e)}`;
      logger.error(errorMsg);
      if (session !== null && _isConnectionLost(e)) {
        logger.warning(`${this} dropping the session that tool '${functionName}' ran on`);
        try {
          await this._dropSession(session);
        } catch (dropError) {
          rethrowIfCancelled(dropError);
          // The model gets the cause of its call. A transport that fails on close goes to the log
          // only.
          logger.error(`${this} error dropping the dead session: ${_errorDetail(dropError)}`);
        }
      }
    }

    let response: unknown = "";
    if (results) {
      if (results.content && results.content.length > 0) {
        results.content.forEach((content, i) => {
          // Only text blocks carry text the model can read.
          if (content.type === "text" && content.text) {
            logger.debug(`Tool response chunk ${i}: ${content.text}`);
            response = (response as string) + content.text;
          } else {
            logger.debug(`Tool response chunk ${i} carries no text: ${content.type}`);
          }
        });
      } else {
        logger.error(`Error getting content from ${functionName} results.`);
      }
    }

    // Apply output filter if configured for this tool
    const outputFilter = Object.hasOwn(this._toolsOutputFilters, functionName)
      ? this._toolsOutputFilters[functionName]
      : undefined;
    if (outputFilter) {
      try {
        response = outputFilter(response);
        logger.debug(`Final response (after filter): ${response}`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error applying output filter for ${functionName}`);
        response = "";
      }
    }

    if (typeof response === "string" && response) {
      logger.info(`Tool '${functionName}' completed successfully`);
      logger.debug(`Final response: ${response}`);
      return response;
    }
    return errorMsg || "Sorry, could not call the mcp tool";
  }

  /**
   * Drop the session a failed call ran on, so a later call connects again.
   *
   * A session outlives its transport, so each later call runs on a dead session until something
   * drops it. Tool calls run concurrently, so a caller whose session another call already replaced
   * drops nothing.
   */
  protected async _dropSession(session: MCPSession): Promise<void> {
    await this._lifecycleLock.run(async () => {
      if (this._activeSession === session) {
        await this._closeLocked();
      }
    });
  }

  protected async _listToolsHelper(
    session: MCPSession,
    attachHandlers = false,
  ): Promise<ToolsSchema> {
    const availableTools = await session.listTools();
    const toolSchemas: FunctionSchema[] = [];

    logger.debug(`Found ${availableTools.tools.length} available tools`);

    const availableNames = new Set(availableTools.tools.map((tool) => tool.name));
    const unknown = Object.keys(this._toolsArguments).filter((name) => !availableNames.has(name));
    if (unknown.length > 0) {
      logger.warning(
        `${this} toolsArguments configured for tool(s) the server does not ` +
          `advertise: ${unknown.join(", ")}`,
      );
    }

    for (const tool of availableTools.tools) {
      const toolName = tool.name;

      // Apply tools filter if configured
      if (
        this._toolsFilter &&
        this._toolsFilter.length > 0 &&
        !this._toolsFilter.includes(toolName)
      ) {
        logger.debug(`Skipping tool '${toolName}' - not in allowed tools list`);
        continue;
      }

      logger.debug(`Processing tool: ${toolName}`);
      logger.debug(`Tool description: ${tool.description}`);

      try {
        const functionSchema = this._convertMcpSchemaToPipecat(
          toolName,
          { description: tool.description, inputSchema: tool.inputSchema },
          attachHandlers ? this._toolWrapperWithCleanup : null,
        );

        // Add to list of schemas
        toolSchemas.push(functionSchema);
        logger.debug(`Successfully read tool '${toolName}'`);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Failed to read tool '${toolName}': ${e}`);
      }
    }

    logger.debug(`Completed reading ${toolSchemas.length} tools`);
    return new ToolsSchema({ standardTools: toolSchemas });
  }
}
