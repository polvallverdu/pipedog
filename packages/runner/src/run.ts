// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/runner/run.py

/**
 * Pipecat development runner.
 *
 * This development runner executes pipedog bots and provides the supporting
 * infrastructure they need: managing WebRTC connections, and setting up
 * telephony webhook/WebSocket infrastructure. It supports multiple transport
 * types with a unified interface.
 *
 * All bots must export a `bot(runnerArgs)` async function as the entry point.
 * The server discovers and runs this function when connections are
 * established.
 *
 * By default the runner starts a single server that supports WebRTC and
 * telephony transports simultaneously. Clients declare which transport they
 * want via the `transport` field in the `/start` request body (default:
 * `"webrtc"`).
 *
 * The server is a fetch handler (`RunnerApp.fetch`), so the same app runs on
 * Bun, Node and Deno (`serve()`), or mounts into Hono, SvelteKit and other
 * frameworks (`createRunnerApp()`).
 *
 * @example
 * // bot.ts
 * export async function bot(runnerArgs: RunnerArguments) {
 *   const transport = await createTransport(runnerArgs, transportParams);
 *   // Your bot logic here
 *   await runPipeline(transport);
 * }
 *
 * if (import.meta.main) {
 *   const { main } = await import("@pipedog/runner/run");
 *   await main();
 * }
 *
 * To run locally:
 *
 * - All transports (default): `bun bot.ts`
 * - ESP32: `bun bot.ts -t webrtc --esp32 --host 192.168.1.100`
 * - WebRTC with custom STUN/TURN: `bun bot.ts -t webrtc --ice-servers
 *   stun:stun.l.google.com:19302` (or set `PIPECAT_ICE_SERVERS`)
 * - Exotel: `bun bot.ts -t exotel` (no proxy needed, but an ngrok tunnel to
 *   HTTP 7860 is required)
 * - Telephony: `bun bot.ts -t twilio -x your_username.ngrok.io`
 * - WebRTC only: `bun bot.ts -t webrtc`
 *
 * - LiveKit only: `bun bot.ts -t livekit` (needs `@pipedog/transport-livekit`
 *   and `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`)
 *
 * - WhatsApp: `bun bot.ts --whatsapp` (needs `@pipedog/transport-whatsapp` and
 *   `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`,
 *   `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`; webhook at `/whatsapp`)
 *
 * PARTIAL PORT: Daily, MOQ, Vonage (Video Connector) and eval
 * support need transports that are not ported yet. Their CLI choices and
 * `/start` transports are recognized and fail with a clear message.
 */

import { createTask, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { FileStorage, LocalFileStorage } from "@pipedog/core/utils/file_storage";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { isOriginAllowed } from "@pipedog/core/utils/security/allowed_origins";
import { load as yamlSafeLoad } from "@pipedog/core/utils/yaml";
import { type UpgradingServer, upgradeWebSocket } from "@pipedog/transport-websocket/fetch";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

import { ArgumentError, ArgumentParser, HelpRequested, type Namespace } from "./argparse.ts";
import {
  directoryAssetReader,
  PipecatPrebuiltUI,
  type PrebuiltAssetReader,
  prebuiltAvailable,
} from "./prebuilt.ts";
import {
  LiveKitRunnerArguments,
  type RunnerArguments,
  type RunnerWebSocket,
  SmallWebRTCRunnerArguments,
  WebSocketRunnerArguments,
} from "./types.ts";
import { TelephonyCallEndedError } from "./utils.ts";

export { ArgumentParser } from "./argparse.ts";

/** The telephony providers the runner serves on `/ws`. */
export const TELEPHONY_TRANSPORTS = ["twilio", "telnyx", "plivo", "exotel"] as const;

/**
 * The packages each transport's routes need. Daily and MOQ name pipedog
 * packages that don't exist yet (those transports aren't ported), so their
 * routes stay disabled, as upstream's do when an extra isn't installed.
 */
export const TRANSPORT_ROUTE_DEPENDENCIES: Record<string, readonly string[]> = {
  daily: ["@pipedog/transport-daily"],
  livekit: ["@pipedog/transport-livekit"],
  webrtc: ["@pipedog/transport-smallwebrtc"],
  telephony: ["@pipedog/transport-websocket"],
  websocket: ["@pipedog/transport-websocket"],
  moq: ["@pipedog/transport-moq"],
  whatsapp: ["@pipedog/transport-whatsapp", "@pipedog/transport-smallwebrtc"],
};

/** What to do when a transport's routes are disabled. */
export const TRANSPORT_INSTALL_HINTS: Record<string, string> = {
  daily: "not ported to pipedog yet",
  livekit: "install @pipedog/transport-livekit",
  webrtc: "install @pipedog/transport-smallwebrtc",
  telephony: "install @pipedog/transport-websocket",
  websocket: "install @pipedog/transport-websocket",
  moq: "not ported to pipedog yet",
  whatsapp: "install @pipedog/transport-whatsapp",
};

/** Transports the runner recognizes but pipedog has not ported, with their upstream module. */
export const UNPORTED_TRANSPORTS: Record<string, string> = {
  daily: "pipecat.transports.daily",
  moq: "pipecat.transports.moq",
  vonage: "pipecat.transports.vonage.video_connector",
};

let RUNNER_DOWNLOADS_FOLDER: string | null = null;
let RUNNER_HOST = "localhost";
let RUNNER_PORT = 7860;

/**
 * Seams the tests replace (Python patches module attributes; ES modules
 * can't be patched from outside).
 */
export const _deps = {
  /** Whether a module can be resolved, without loading it. */
  isModuleAvailable: (module: string): boolean => _isModuleAvailable(module),
  /** Seconds since the epoch (`time.time()`). */
  time: (): number => Date.now() / 1000,
};

// Per-process HMAC secret for WebSocket token authentication. Auto-generated so
// tokens from one runner instance cannot be replayed against another.
const _WS_AUTH_SECRET = crypto.getRandomValues(new Uint8Array(32));
let _wsAuthKey: Promise<CryptoKey> | null = null;

// ---------------------------------------------------------------------------
// The app: routes over a fetch handler.
// ---------------------------------------------------------------------------

/** An error that becomes an HTTP response, `{"detail": ...}` (FastAPI's `HTTPException`). */
export class HTTPException extends Error {
  override name = "HTTPException";
  readonly statusCode: number;
  readonly detail: unknown;

  constructor(statusCode: number, detail: unknown = null) {
    super(typeof detail === "string" ? detail : `HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.detail = detail ?? (statusCode === 404 ? "Not Found" : `HTTP ${statusCode}`);
  }
}

/** Path parameters of a matched route, e.g. `{ session_id: "..." }`. */
export type PathParams = Record<string, string>;

/**
 * An HTTP route handler. A `Response` is sent as is; anything else is sent as
 * JSON, as FastAPI does.
 */
export type RouteHandler = (request: Request, params: PathParams) => unknown | Promise<unknown>;

/** What a WebSocket route sees of the handshake request. */
export interface RunnerWebSocketRequest {
  /** The handshake's headers. */
  headers: Headers;
  /** The URL's query parameters (Starlette's `query_params`). */
  queryParams: URLSearchParams;
  /** The route's path parameters. */
  pathParams: PathParams;
}

/**
 * A WebSocket route handler. It runs with the accepted connection; closing it
 * with a code before doing anything is how a route rejects a connection
 * (Starlette's `websocket.close(code=4003)`).
 */
export type WebSocketRouteHandler = (
  websocket: WebsocketConnection,
  request: RunnerWebSocketRequest,
) => Promise<void>;

/** A mounted sub-application (Starlette's `app.mount`): `null` for "not mine". */
export type MountHandler = (request: Request) => Promise<Response | null>;

/** A registered route, as in FastAPI's `app.routes`. */
export interface Route {
  path: string;
  methods: Set<string>;
  kind: "http" | "websocket" | "mount";
  /** @internal */
  pattern: RegExp;
  /** @internal */
  names: string[];
  /** @internal */
  handler: RouteHandler | WebSocketRouteHandler | MountHandler;
}

/**
 * Runs on startup; may return a cleanup to run on shutdown. The runner's
 * equivalent of a FastAPI lifespan: warm up clients, open pools, and close
 * them again.
 *
 * @example
 * const lifespan: Lifespan = async () => {
 *   await warmUpClients();
 *   return async () => await closeClients();
 * };
 */
export type Lifespan = (app: RunnerApp) => Promise<void | (() => Promise<void>)>;

/** The bot module's entry points, as upstream finds them on the bot's module. */
export interface BotModule {
  /** Runs one session. */
  bot: (runnerArgs: RunnerArguments) => unknown | Promise<unknown>;
  /**
   * The storage backend for client uploads (synchronous). Wins over
   * `-u/--uploads-folder`; returning `null` disables uploads.
   */
  createFileStorage?: () => FileStorage | null;
}

function compilePath(path: string, prefix = false): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  let source = "";
  let last = 0;
  for (const match of path.matchAll(/\{(\w+)(?::(\w+))?\}/g)) {
    source += path.slice(last, match.index).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    names.push(match[1]!);
    source += match[2] === "path" ? "(.*)" : "([^/]+)";
    last = match.index! + match[0].length;
  }
  source += path.slice(last).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return { pattern: new RegExp(prefix ? `^${source}(?:/.*)?$` : `^${source}$`), names };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(pyJsonDumps(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The runner's application: routes served by a fetch handler, in the spirit
 * of upstream's FastAPI app. Build one, configured from runner options, with
 * `createRunnerApp()`; serve it with `serve()`, or mount `app.fetch` (and
 * `app.matchWebSocket` on servers that upgrade WebSockets themselves) into
 * another framework.
 *
 * Add your own routes with `get`, `post`, `route` and `websocket`, as upstream
 * bots add routes to the runner's FastAPI `app`.
 */
export class RunnerApp {
  /** The registered routes, in matching order. */
  readonly routes: Route[] = [];
  /** Allowed CORS origins; empty allows any (CORSMiddleware with `["*"]`). */
  allowedOrigins: string[] = [];
  /**
   * The uploads storage. `undefined` until resolved from the bot module and
   * the CLI (see `getFileStorage()`); `null` when uploads are disabled.
   */
  fileStorage: FileStorage | null | undefined = undefined;
  /** Upload URLs saved through each session's upload route, deleted when it ends. */
  readonly sessionUploadUrls = new Map<string, string[]>();
  /** The CLI arguments the app was configured with. */
  args: Namespace = {};

  #lifespans: Lifespan[] = [];
  #cleanups: (() => Promise<void>)[] = [];
  #botModule: BotModule | null;
  #botModuleLookup: Promise<BotModule> | null = null;
  #fileStorageLookup: Promise<FileStorage | null> | null = null;
  #sessions = new Set<Task<unknown>>();

  constructor(options: { botModule?: BotModule | null } = {}) {
    this.#botModule = options.botModule ?? null;
  }

  /** Register an HTTP route for `methods` (FastAPI's `api_route`). */
  route(methods: string[], path: string, handler: RouteHandler): this {
    const { pattern, names } = compilePath(path);
    const set = new Set(methods.map((m) => m.toUpperCase()));
    if (set.has("GET")) set.add("HEAD");
    this.routes.push({ path, methods: set, kind: "http", pattern, names, handler });
    return this;
  }

  /** Register a `GET` route. */
  get(path: string, handler: RouteHandler): this {
    return this.route(["GET"], path, handler);
  }

  /** Register a `POST` route. */
  post(path: string, handler: RouteHandler): this {
    return this.route(["POST"], path, handler);
  }

  /** Register a `PATCH` route. */
  patch(path: string, handler: RouteHandler): this {
    return this.route(["PATCH"], path, handler);
  }

  /** Register a WebSocket route. */
  websocket(path: string, handler: WebSocketRouteHandler): this {
    const { pattern, names } = compilePath(path);
    this.routes.push({ path, methods: new Set(), kind: "websocket", pattern, names, handler });
    return this;
  }

  /** Mount a sub-application under `path` (Starlette's `app.mount`). */
  mount(path: string, handler: MountHandler): this {
    const { pattern, names } = compilePath(path, true);
    this.routes.push({ path, methods: new Set(), kind: "mount", pattern, names, handler });
    return this;
  }

  /** Add a lifespan (startup hook with optional cleanup), run by `startup()`. */
  addLifespan(lifespan: Lifespan): this {
    this.#lifespans.push(lifespan);
    return this;
  }

  /** Run the lifespans' startup, in order. `serve()` calls this before listening. */
  async startup(): Promise<void> {
    for (const lifespan of this.#lifespans) {
      const cleanup = await lifespan(this);
      if (typeof cleanup === "function") this.#cleanups.push(cleanup);
    }
  }

  /** Run the lifespans' cleanups, in reverse order. */
  async shutdown(): Promise<void> {
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop()!;
      try {
        await cleanup();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error("Runner shutdown hook failed", e);
      }
    }
  }

  /** Use `botModule` for the app's sessions instead of discovering one. */
  setBotModule(botModule: BotModule): void {
    this.#botModule = botModule;
  }

  /** The bot module: the one given to the app, or the one `_getBotModule()` finds. */
  async getBotModule(): Promise<BotModule> {
    if (this.#botModule) return this.#botModule;
    this.#botModuleLookup ??= _getBotModule();
    try {
      this.#botModule = await this.#botModuleLookup;
    } catch (e) {
      this.#botModuleLookup = null;
      throw e;
    }
    return this.#botModule;
  }

  /** The uploads storage, resolved once (see `_resolveFileStorage`). */
  async getFileStorage(): Promise<FileStorage | null> {
    if (this.fileStorage !== undefined) return this.fileStorage;
    this.#fileStorageLookup ??= _resolveFileStorage(this.args, () => this.getBotModule());
    this.fileStorage = await this.#fileStorageLookup;
    return this.fileStorage;
  }

  /**
   * Run a bot session in the background, holding a reference until it
   * finishes (upstream's `_start_bot_session`).
   */
  startBotSession(run: () => Promise<unknown>, name = "runner::bot-session"): Task<unknown> {
    const task = createTask(async () => {
      try {
        return await run();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error("Bot session failed", e);
        return undefined;
      }
    }, name);
    this.#sessions.add(task);
    task.addDoneCallback(() => this.#sessions.delete(task));
    return task;
  }

  /**
   * Find the WebSocket route for `request`, for servers that upgrade
   * WebSockets themselves (Bun, Node with `ws`, Hono's `upgradeWebSocket`):
   * upgrade the request, then run the returned function with the accepted
   * connection. `null` when no WebSocket route matches.
   */
  matchWebSocket(request: Request): ((websocket: WebsocketConnection) => Promise<void>) | null {
    const url = new URL(request.url);
    for (const route of this.routes) {
      if (route.kind !== "websocket") continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const pathParams = Object.fromEntries(
        route.names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]),
      );
      const info: RunnerWebSocketRequest = {
        headers: new Headers(request.headers),
        queryParams: url.searchParams,
        pathParams,
      };
      const handler = route.handler as WebSocketRouteHandler;
      return async (websocket) => {
        try {
          await handler(websocket, info);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`WebSocket route ${route.path} failed`, e);
        } finally {
          await websocket.close();
        }
      };
    }
    return null;
  }

  /**
   * Serve a request. WebSocket routes are upgraded here: from fetch on Deno and
   * Cloudflare Workers, and with `server` (the upgrading server `Bun.serve` and
   * `serveFetch` pass as the second argument) on Bun and Node. Frameworks that
   * upgrade sockets themselves use `matchWebSocket()` instead.
   */
  fetch = async (request: Request, server: UpgradingServer | null = null): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (
      request.method === "OPTIONS" &&
      origin !== null &&
      request.headers.has("access-control-request-method")
    ) {
      return this.#preflight(request, origin);
    }
    let response: Response;
    try {
      response = await this.#dispatch(request, server);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof HTTPException) {
        response = jsonResponse({ detail: e.detail }, e.statusCode);
      } else {
        logger.error(`Error handling ${request.method} ${new URL(request.url).pathname}`, e);
        response = new Response("Internal Server Error", { status: 500 });
      }
    }
    return this.#withCors(response, origin);
  };

  #originAllowed(origin: string): boolean {
    return this.allowedOrigins.length === 0 || isOriginAllowed(origin, this.allowedOrigins);
  }

  #preflight(request: Request, origin: string): Response {
    if (!this.#originAllowed(origin)) {
      return new Response("Disallowed CORS origin", { status: 400 });
    }
    const headers: Record<string, string> = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "600",
      vary: "Origin",
    };
    const requested = request.headers.get("access-control-request-headers");
    if (requested) headers["access-control-allow-headers"] = requested;
    return new Response("OK", { status: 200, headers });
  }

  #withCors(response: Response, origin: string | null): Response {
    if (origin === null || response.status === 101 || !this.#originAllowed(origin)) {
      return response;
    }
    try {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("access-control-allow-credentials", "true");
      response.headers.append("vary", "Origin");
      return response;
    } catch {
      // Immutable headers (e.g. a redirect from Response.redirect): copy.
      const copy = new Response(response.body, response);
      copy.headers.set("access-control-allow-origin", origin);
      copy.headers.set("access-control-allow-credentials", "true");
      copy.headers.append("vary", "Origin");
      return copy;
    }
  }

  async #dispatch(request: Request, server: UpgradingServer | null): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const run = this.matchWebSocket(request);
      if (run) {
        const headers = new Headers(request.headers);
        let upgraded: ReturnType<typeof upgradeWebSocket>;
        try {
          upgraded = upgradeWebSocket(request, { server });
        } catch (e) {
          rethrowIfCancelled(e);
          return new Response(
            `${(e as Error).message} Serve the runner with serve(), pass the server to ` +
              "app.fetch(request, server), or upgrade yourself and call app.matchWebSocket().",
            { status: 426, headers: { upgrade: "websocket" } },
          );
        }
        const { response, socket } = upgraded;
        const connection = WebsocketConnection.fromWebSocket(socket, {
          headers,
          path: url.pathname,
        });
        this.startBotSession(() => run(connection), `runner::websocket::${url.pathname}`);
        return response;
      }
    }

    let pathMatched = false;
    for (const route of this.routes) {
      if (route.kind === "websocket") continue;
      if (route.kind === "mount") {
        if (!route.pattern.test(url.pathname)) continue;
        const response = await (route.handler as MountHandler)(request);
        if (response) return response;
        continue;
      }
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (!route.methods.has(request.method)) continue;
      const params = Object.fromEntries(
        route.names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]),
      );
      const result = await (route.handler as RouteHandler)(request, params);
      if (result instanceof Response) return result;
      return jsonResponse(result ?? null);
    }
    if (pathMatched) return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return jsonResponse({ detail: "Not Found" }, 404);
  }
}

/**
 * The runner's module-level app, as upstream's FastAPI `app`. Add routes to it
 * before calling `main()`:
 *
 * @example
 * import { app, main } from "@pipedog/runner/run";
 *
 * app.get("/my-route", () => ({ hello: "world" }));
 *
 * if (import.meta.main) await main();
 */
export const app: RunnerApp = new RunnerApp();

// ---------------------------------------------------------------------------
// Bot sessions.
// ---------------------------------------------------------------------------

/** Best-effort deletion of the files uploaded through a session's upload route. */
export async function _deleteSessionUploads(
  runnerApp: RunnerApp,
  sessionId: string,
): Promise<void> {
  const fileUrls = runnerApp.sessionUploadUrls.get(sessionId);
  runnerApp.sessionUploadUrls.delete(sessionId);
  const storage = runnerApp.fileStorage ?? null;
  if (!fileUrls || fileUrls.length === 0 || storage === null) return;
  for (const fileUrl of fileUrls) {
    try {
      await storage.delete(fileUrl);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to delete session upload ${fileUrl}: ${e}`);
    }
  }
}

/**
 * Run a bot session, releasing its session resources when it ends.
 *
 * Removes the session from `activeSessions` (closing the
 * `/sessions/{session_id}/...` routes for it) and deletes any files uploaded
 * through the session's upload route.
 */
export async function _runBotSession(
  runnerApp: RunnerApp,
  run: () => unknown | Promise<unknown>,
  sessionId: string,
  activeSessions: Record<string, unknown> | null,
): Promise<void> {
  try {
    await run();
  } finally {
    if (activeSessions !== null) delete activeSessions[sessionId];
    await _deleteSessionUploads(runnerApp, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Transport availability.
// ---------------------------------------------------------------------------

/**
 * Check whether a module can be resolved without importing it.
 *
 * @param module Package name to check.
 * @returns `true` if the runtime can resolve the module.
 */
export function _isModuleAvailable(module: string): boolean {
  const meta = import.meta as { resolve?: (specifier: string) => string };
  if (typeof meta.resolve !== "function") return false;
  try {
    meta.resolve(module);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return module dependencies required for a transport route.
 *
 * @param transport Transport name from the runner request or CLI.
 */
export function _transportRouteDependencies(transport: string): readonly string[] {
  if ((TELEPHONY_TRANSPORTS as readonly string[]).includes(transport)) {
    return TRANSPORT_ROUTE_DEPENDENCIES.telephony!;
  }
  return TRANSPORT_ROUTE_DEPENDENCIES[transport] ?? [];
}

/**
 * Return whether a transport route can run in this environment.
 *
 * @param transport Transport name from the runner request or CLI.
 */
export function _transportRoutesEnabled(transport: string): boolean {
  return _transportRouteDependencies(transport).every((module) => _deps.isModuleAvailable(module));
}

/** Return the browser URL for the runner prebuilt client. */
export function _runnerUrl(args: Namespace): string {
  return `http://${args.host}:${args.port}`;
}

/** Return enabled and disabled transport labels for the startup banner. */
export function _transportStatusLists(): [string[], string[]] {
  const transports = ["daily", "livekit", "webrtc", "telephony", "websocket", "moq"];
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const label of transports) {
    if (_transportRoutesEnabled(label)) enabled.push(label);
    else disabled.push(`${label} (${TRANSPORT_INSTALL_HINTS[label]})`);
  }
  return [enabled, disabled];
}

/** Format a startup banner transport status list. */
export function _formatTransportStatus(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "none";
}

// ---------------------------------------------------------------------------
// WebSocket session tokens.
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacHex(payload: string): Promise<string> {
  _wsAuthKey ??= crypto.subtle.importKey(
    "raw",
    _WS_AUTH_SECRET,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await _wsAuthKey,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function compareDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Return a signed, self-expiring WebSocket session token.
 *
 * The token is `<base64url-payload>.<hmac-sha256-hex>` where the payload
 * encodes `{"exp": unix_timestamp, "jti": random_nonce}`. Valid for `ttl`
 * seconds (default 5 min). The nonce ensures uniqueness within the same second.
 *
 * DIVERGENCE: async, because WebCrypto's HMAC is.
 */
export async function _generateWsToken(ttl = 300): Promise<string> {
  const jti = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const payload = base64UrlEncode(
    new TextEncoder().encode(pyJsonDumps({ exp: Math.trunc(_deps.time()) + ttl, jti })),
  );
  return `${payload}.${await hmacHex(payload)}`;
}

/**
 * Validate a WebSocket session token and mark it as used (one-time use).
 *
 * @param used Already-consumed tokens (mutated on success).
 * @param token Token string obtained from `_generateWsToken`.
 * @returns `true` if the token has a valid signature, has not expired, and has
 *   not been used before. Adds the token to `used` on success so replay
 *   attempts are rejected.
 */
export async function _verifyAndConsumeWsToken(used: Set<string>, token: string): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(payload);
  if (!compareDigest(expected, sig)) return false;
  let data: unknown;
  try {
    data = pyJsonLoads(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
  const exp = typeof data === "object" && data !== null ? ((data as { exp?: number }).exp ?? 0) : 0;
  if (_deps.time() > exp) return false;
  if (used.has(token)) return false;
  used.add(token);
  return true;
}

/**
 * Extract a WebSocket session token from the connection handshake.
 *
 * Checks, in order: an `Authorization: Bearer <token>` request header, then a
 * `?token=<token>` query parameter. Returns `null` if neither is present.
 */
export function _extractWsToken(websocket: {
  headers: { get(name: string): string | null | undefined };
  queryParams: { get(name: string): string | null | undefined };
}): string | null {
  const auth = websocket.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return websocket.queryParams.get("token") ?? null;
}

// ---------------------------------------------------------------------------
// Startup banner.
// ---------------------------------------------------------------------------

/** Security status lines (auth + origin restriction). */
function _securityStatusLines(args: Namespace): string[] {
  const lines: string[] = [];
  if (args.ws_auth === "token") {
    lines.push("   → WebSocket auth:  token (HMAC, call /start to obtain a token)");
  }
  if (args.allowed_origins?.length) {
    lines.push(`   → Allowed origins: ${args.allowed_origins.join(", ")}`);
  } else {
    lines.push("   → Allowed origins: all (no restriction)");
  }
  return lines;
}

function isTty(): boolean {
  return !!(globalThis as any).process?.stdout?.isTTY;
}

/**
 * Apply the development-runner banner's style (dim cyan) to one line.
 *
 * Returns the text unchanged when stdout is not a TTY or `NO_COLOR` is set,
 * so escape codes never leak into logs.
 */
export function _styleBannerLine(text: string): string {
  if (isTty() && !(globalThis as any).process?.env?.NO_COLOR) {
    return `\x1b[2;36m${text}\x1b[0m`;
  }
  return text;
}

/**
 * Return the number of terminal columns `text` occupies: East Asian wide and
 * fullwidth characters (including emoji) count as two, combining marks and
 * variation selectors as zero.
 */
export function _displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (/\p{Mn}|\p{Me}/u.test(ch) || /[︀-️]/.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** The bordered banner identifying this as the development runner. */
export function _formatDevRunnerBanner(): string {
  const lines = [
    "PIPEDOG DEVELOPMENT RUNNER",
    "",
    "Learn about running bots locally and in production:",
    "https://polvallverdu.github.io/pipedog/docs/runner",
  ];
  const width = Math.max(...lines.map(_displayWidth));
  const out = ["", _styleBannerLine(`╭${"─".repeat(width + 2)}╮`)];
  for (const line of lines) {
    out.push(_styleBannerLine(`│ ${line}${" ".repeat(width - _displayWidth(line))} │`));
  }
  out.push(_styleBannerLine(`╰${"─".repeat(width + 2)}╯`));
  return `${out.join("\n")}\n`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The connection information for the development runner, as upstream prints it. */
export function _formatStartupMessage(args: Namespace): string {
  const lines: string[] = [""];
  const t = args.transport ?? null;
  if (t === null) {
    const [enabled, disabled] = _transportStatusLists();
    lines.push("🚀 Bot ready!");
    lines.push(`   → Open: ${_runnerUrl(args)}`);
    lines.push(`   → Enabled transports: ${_formatTransportStatus(enabled)}`);
    if (disabled.length > 0) {
      lines.push(`   → Disabled transports: ${_formatTransportStatus(disabled)}`);
    }
    lines.push(..._securityStatusLines(args));
  } else if (t === "webrtc") {
    if (args.esp32) lines.push("🚀 Bot ready! (ESP32 mode)");
    else if (args.whatsapp) lines.push("🚀 Bot ready! (WhatsApp)");
    else lines.push("🚀 Bot ready! (WebRTC)");
    if (_transportRoutesEnabled("webrtc")) lines.push(`   → Open: ${_runnerUrl(args)}`);
    else lines.push(`   → WebRTC disabled (${TRANSPORT_INSTALL_HINTS.webrtc})`);
  } else if (t === "daily") {
    lines.push("🚀 Bot ready! (Daily)");
    if (!_transportRoutesEnabled("daily")) {
      lines.push(`   → Daily disabled (${TRANSPORT_INSTALL_HINTS.daily})`);
    } else {
      lines.push(`   → Open: ${_runnerUrl(args)}`);
    }
  } else if (t === "livekit") {
    lines.push("🚀 Bot ready! (LiveKit)");
    if (!_transportRoutesEnabled("livekit")) {
      lines.push(`   → LiveKit disabled (${TRANSPORT_INSTALL_HINTS.livekit})`);
    } else {
      lines.push(`   → Open: ${_runnerUrl(args)}`);
    }
  } else if ((TELEPHONY_TRANSPORTS as readonly string[]).includes(t)) {
    lines.push(`🚀 Bot ready! (${capitalize(t)})`);
    if (!_transportRoutesEnabled(t)) {
      lines.push(`   → Telephony disabled (${TRANSPORT_INSTALL_HINTS.telephony})`);
    } else {
      lines.push(`   → Open: ${_runnerUrl(args)}`);
      if (args.proxy) lines.push(`   → XML webhook: http://${args.host}:${args.port}/`);
      lines.push(`   → WebSocket:   ws://${args.host}:${args.port}/ws`);
      lines.push(..._securityStatusLines(args));
    }
  } else if (t === "websocket") {
    lines.push("🚀 Bot ready! (WebSocket)");
    if (!_transportRoutesEnabled("websocket")) {
      lines.push(`   → WebSocket disabled (${TRANSPORT_INSTALL_HINTS.websocket})`);
    } else {
      lines.push(`   → Open: ${_runnerUrl(args)}`);
      const scheme = args.host !== "localhost" ? "wss" : "ws";
      lines.push(`   → WebSocket:   ${scheme}://${args.host}:${args.port}/ws-client`);
      lines.push(..._securityStatusLines(args));
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Print connection information for the development runner. */
export function _printStartupMessage(args: Namespace): void {
  writeStdout(_formatStartupMessage(args));
}

function writeStdout(text: string): void {
  const stdout = (globalThis as any).process?.stdout;
  if (stdout?.write) stdout.write(text);
  else console.log(text.replace(/\n$/, ""));
}

// ---------------------------------------------------------------------------
// Bot module discovery.
// ---------------------------------------------------------------------------

const BOT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

function hasBot(module: unknown): module is BotModule {
  return typeof (module as { bot?: unknown } | null)?.bot === "function";
}

/** The entry script: Deno's main module, or `process.argv[1]` on Bun and Node. */
async function mainModuleUrl(): Promise<string | null> {
  const g = globalThis as any;
  if (typeof g.Deno?.mainModule === "string") return g.Deno.mainModule;
  const entry = g.process?.argv?.[1];
  if (typeof entry !== "string" || entry === "") return null;
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  return pathToFileURL(resolve(entry)).href;
}

/**
 * Get the bot module: the entry script if it exports `bot`, else `bot.ts` (or
 * `.js`) in the current directory, else the first script in the current
 * directory (other than `server.*`) that exports `bot`.
 *
 * @throws Error (upstream's `ImportError`) If no module exports a `bot` function.
 */
export async function _getBotModule(): Promise<BotModule> {
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const { readdir } = await import("node:fs/promises");
  const cwd = (globalThis as any).process?.cwd?.() ?? ".";

  // The main module (the file that was executed)
  const main = await mainModuleUrl();
  if (main && BOT_EXTENSIONS.some((ext) => new URL(main).pathname.endsWith(ext))) {
    try {
      const module = await import(main);
      if (hasBot(module)) return module;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.debug(`Could not import the main module ${main}: ${e}`);
    }
  }

  // Try a `bot` module in the current directory
  for (const ext of BOT_EXTENSIONS) {
    try {
      const module = await import(pathToFileURL(join(cwd, `bot${ext}`)).href);
      if (hasBot(module)) return module;
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }

  // Look for any script in the current directory that exports `bot`
  // (excluding server.*).
  let files: string[] = [];
  try {
    files = (await readdir(cwd)).sort();
  } catch (e) {
    rethrowIfCancelled(e);
  }
  for (const filename of files) {
    if (!BOT_EXTENSIONS.some((ext) => filename.endsWith(ext))) continue;
    if (filename.startsWith("server.") || filename.endsWith(".d.ts")) continue;
    try {
      const module = await import(pathToFileURL(join(cwd, filename)).href);
      if (hasBot(module)) return module;
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }

  throw new BotNotFoundError(
    "Could not find 'bot' function. Make sure your bot file exports a 'bot' function.",
  );
}

/** Raised when no bot module is found (upstream's `ImportError`). */
export class BotNotFoundError extends Error {
  override name = "ImportError";
}

/**
 * The `--runner-body` file's contents, or `null` when none was given.
 *
 * A WebSocket session has no `/start` request to carry a body, so a bot that
 * needs session data reads it from this file instead.
 */
export async function _runnerBody(args: Namespace): Promise<unknown> {
  if (!args.runner_body) return null;
  const { readFile } = await import("node:fs/promises");
  return yamlSafeLoad(await readFile(args.runner_body, "utf8"));
}

/** Run a bot for telephony transports. */
export async function _runTelephonyBot(
  runnerApp: RunnerApp,
  websocket: RunnerWebSocket,
  args: Namespace,
): Promise<void> {
  const botModule = await runnerApp.getBotModule();

  // Just pass the WebSocket - let the bot handle parsing
  const runnerArgs = new WebSocketRunnerArguments({
    websocket,
    sessionId: crypto.randomUUID(),
    body: await _runnerBody(args),
    fileStorage: await runnerApp.getFileStorage(),
  });
  runnerArgs.cliArgs = args;

  try {
    await botModule.bot(runnerArgs);
  } catch (e) {
    rethrowIfCancelled(e);
    if (e instanceof TelephonyCallEndedError) {
      // pipedog: a caller who hangs up mid-handshake is not an error.
      logger.info(`Call ended before the telephony handshake completed: ${e.message}`);
      return;
    }
    throw e;
  }
}

/** Run a bot for plain WebSocket transport. */
export async function _runWebsocketBot(
  runnerApp: RunnerApp,
  websocket: RunnerWebSocket,
  args: Namespace,
): Promise<void> {
  const botModule = await runnerApp.getBotModule();
  const runnerArgs = new WebSocketRunnerArguments({
    fileStorage: await runnerApp.getFileStorage(),
    websocket,
    transportType: "websocket",
    sessionId: crypto.randomUUID(),
    body: await _runnerBody(args),
  });
  runnerArgs.cliArgs = args;
  await botModule.bot(runnerArgs);
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

/**
 * Set up the plain WebSocket route at `/ws-client`.
 *
 * When `args.ws_auth == "token"`, connections must present a valid HMAC
 * session token obtained via `POST /start`, as an `Authorization: Bearer`
 * header, a `?token=` query parameter, or a path segment (`/ws-client/<token>`).
 * Invalid or missing tokens are rejected with WebSocket close code 4003.
 */
export function _setupWebsocketRoutes(
  runnerApp: RunnerApp,
  args: Namespace,
  wsUsedTokens: Set<string>,
): void {
  if (!_transportRoutesEnabled("websocket")) return;

  const handlePlainWs = async (
    websocket: WebsocketConnection,
    request: RunnerWebSocketRequest,
    pathToken: string | null = null,
  ) => {
    if (args.ws_auth === "token") {
      const token = pathToken ?? _extractWsToken(request);
      if (!token || !(await _verifyAndConsumeWsToken(wsUsedTokens, token))) {
        logger.warning("WebSocket connection rejected: invalid or missing token");
        await websocket.close(4003);
        return;
      }
    }
    const origin = request.headers.get("origin") ?? "";
    if (!isOriginAllowed(origin, args.allowed_origins ?? [])) {
      logger.warning(`WebSocket connection rejected: origin '${origin}' not allowed`);
      await websocket.close(4003);
      return;
    }
    logger.debug("Plain WebSocket connection accepted");
    await _runWebsocketBot(runnerApp, websocket, args);
  };

  runnerApp.websocket("/ws-client", (ws, request) => handlePlainWs(ws, request));
  runnerApp.websocket("/ws-client/{token}", (ws, request) =>
    handlePlainWs(ws, request, request.pathParams.token ?? null),
  );
}

/** Configure `runnerApp` with routes for all transports. */
export async function _configureServerApp(
  runnerApp: RunnerApp,
  args: Namespace,
  options: { prebuilt?: PrebuiltAssetReader | false } = {},
): Promise<void> {
  runnerApp.args = args;
  runnerApp.allowedOrigins = args.allowed_origins ?? [];

  // Shared session store: session_id -> body data. Used by the WebRTC /start
  // flow and the /sessions/{session_id}/... proxy routes.
  const activeSessions: Record<string, unknown> = {};

  // Consumed WebSocket tokens (one-time use). Shared across both WebSocket
  // endpoint families (/ws and /ws-client).
  const wsUsedTokens = new Set<string>();

  if (options.prebuilt !== false) {
    await _setupFrontendRoutes(runnerApp, options.prebuilt ?? directoryAssetReader());
  }
  // Registered before the WebRTC routes so POST /sessions/{session_id}/files
  // wins over the catch-all /sessions/{session_id}/{path:path} proxy (routes
  // match in registration order).
  _setupFileUploadsRoutes(runnerApp, activeSessions);
  await _setupWebrtcRoutes(runnerApp, args, activeSessions);
  _setupDailyRoutes(runnerApp, args);
  _setupTelephonyRoutes(runnerApp, args, wsUsedTokens);
  _setupWebsocketRoutes(runnerApp, args, wsUsedTokens);
  _setupUnifiedStartRoute(runnerApp, args, activeSessions);

  if (args.whatsapp) {
    await _setupWhatsappRoutes(runnerApp, args);
  }
}

/**
 * The uploads route a /start response should advertise, or `null` when
 * uploads are disabled. Returned as a path relative to the /start endpoint so
 * clients resolve it against whatever public origin they reached the runner on.
 */
export function _advertisedFileUploadUrl(
  storage: FileStorage | null,
  sessionId: string | null = null,
): string | null {
  if (storage === null) return null;
  return sessionId ? `/sessions/${sessionId}/files` : "/files";
}

/** All the transports `/start` knows. */
const ALL_TRANSPORTS = ["webrtc", "daily", "livekit", ...TELEPHONY_TRANSPORTS, "websocket", "moq"];

/**
 * Register the unified `POST /start` and `GET /status` endpoints.
 *
 * Handles the WebRTC and telephony transport start flows. Clients specify
 * which transport they want via the `transport` field in the request body.
 * When `-t` was passed on the command line, requests for any other transport
 * are rejected with HTTP 400.
 */
export function _setupUnifiedStartRoute(
  runnerApp: RunnerApp,
  args: Namespace,
  activeSessions: Record<string, unknown>,
): void {
  runnerApp.get("/status", () => {
    const transports = args.transport != null ? [args.transport] : ALL_TRANSPORTS;
    return { status: "ready", transports };
  });

  /**
   * Start a bot session.
   *
   * Accepts `{"transport": "webrtc" | "livekit" | "twilio" | "telnyx" | "plivo" | "exotel" |
   * "websocket", "enableDefaultIceServers": false, "body": {...}}`.
   *
   * For WebRTC, `iceConfig` in the response carries the servers the runner was
   * started with (`--ice-servers` or `PIPECAT_ICE_SERVERS`). When the runner
   * has none, `enableDefaultIceServers` returns a public STUN server instead.
   */
  runnerApp.post("/start", async (request) => {
    let requestData: Record<string, any> = {};
    try {
      const parsed = await request.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        requestData = parsed as Record<string, any>;
      }
      logger.debug(`Received request: ${pyJsonDumps(requestData)}`);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to parse request body: ${e}`);
    }

    // Determine transport: explicit field → legacy Daily hint → CLI default → webrtc
    let transport: string | null = requestData.transport ?? null;
    if (transport === null && requestData.createDailyRoom) transport = "daily";
    if (transport === null) transport = args.transport ?? "webrtc";

    // Enforce restriction when -t was explicitly set on the command line
    if (args.transport != null && transport !== args.transport) {
      throw new HTTPException(
        400,
        `Transport '${transport}' is not allowed. ` +
          `Server is configured for '${args.transport}' only (-t ${args.transport}).`,
      );
    }

    if (!_transportRoutesEnabled(transport!)) {
      throw new HTTPException(
        400,
        `Transport '${transport}' is disabled in this runner environment. ` +
          "Check the startup banner for enabled transports.",
      );
    }

    if (transport === "webrtc") {
      // WebRTC: register the session; the bot starts when the WebRTC offer arrives.
      const sessionId = crypto.randomUUID();
      activeSessions[sessionId] = requestData.body ?? {};

      const result: Record<string, unknown> = { sessionId };
      const uploadUrl = _advertisedFileUploadUrl(await runnerApp.getFileStorage(), sessionId);
      if (uploadUrl) result.fileUploadUrl = uploadUrl;
      // Servers configured on the runner are handed to the client too, so
      // both peers negotiate against the same STUN and TURN servers. They
      // take precedence over the Google STUN fallback.
      if (args.ice_servers?.length) {
        result.iceConfig = { iceServers: args.ice_servers.map((s: object) => ({ ...s })) };
      } else if (requestData.enableDefaultIceServers) {
        result.iceConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
      }
      return result;
    }

    if (transport === "livekit") {
      const { generateSessionTokens, livekitCredentials } = await import("./livekit.ts");

      const [livekitUrl, apiKey, apiSecret] = livekitCredentials();

      const body = requestData.body ?? {};
      const roomName =
        env("LIVEKIT_ROOM_NAME") || `pipecat-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const sessionId = crypto.randomUUID();
      const [agentToken, userToken] = await generateSessionTokens(
        roomName,
        sessionId,
        apiKey,
        apiSecret,
      );

      const botModule = await runnerApp.getBotModule();
      const runnerArgs = new LiveKitRunnerArguments({
        fileStorage: await runnerApp.getFileStorage(),
        roomName,
        url: livekitUrl,
        token: agentToken,
        body,
        sessionId,
      });
      runnerArgs.cliArgs = args;
      activeSessions[sessionId] = body;
      runnerApp.startBotSession(
        () => _runBotSession(runnerApp, () => botModule.bot(runnerArgs), sessionId, activeSessions),
        `runner::livekit::${sessionId}`,
      );

      const result: Record<string, unknown> = { url: livekitUrl, token: userToken, sessionId };
      const uploadUrl = _advertisedFileUploadUrl(await runnerApp.getFileStorage(), sessionId);
      if (uploadUrl) result.fileUploadUrl = uploadUrl;
      return result;
    }

    if ((TELEPHONY_TRANSPORTS as readonly string[]).includes(transport!)) {
      // Telephony: the bot starts when the provider connects to /ws.
      // Return the WebSocket URL so the caller knows where to point their provider.
      const scheme = args.host !== "localhost" ? "wss" : "ws";
      const result: Record<string, unknown> = { wsUrl: `${scheme}://${args.host}:${args.port}/ws` };
      if (args.ws_auth === "token") result.token = await _generateWsToken();
      return result;
    }

    if (transport === "websocket") {
      // Plain WebSocket: the bot starts when the client connects to /ws-client.
      const scheme = args.host !== "localhost" ? "wss" : "ws";
      const sessionId = crypto.randomUUID();
      const token = args.ws_auth === "token" ? await _generateWsToken() : null;
      const result: Record<string, unknown> = {
        wsUrl: `${scheme}://${args.host}:${args.port}/ws-client`,
        sessionId,
        token,
      };
      // The flat route: this session_id is never registered (the bot mints its
      // own at connect time), so the session-scoped uploads route would reject it.
      const uploadUrl = _advertisedFileUploadUrl(await runnerApp.getFileStorage(), null);
      if (uploadUrl) result.fileUploadUrl = uploadUrl;
      return result;
    }

    if (transport! in UNPORTED_TRANSPORTS) {
      // DIVERGENCE: upstream starts Daily and MOQ sessions here.
      throw new HTTPException(
        400,
        `Transport '${transport}' (${UNPORTED_TRANSPORTS[transport!]}) is not ported to pipedog yet.`,
      );
    }

    throw new HTTPException(400, `Unknown transport '${transport}'.`);
  });
}

/**
 * Resolve a download path and ensure it stays within the downloads folder.
 *
 * Symbolic links are resolved first, as `Path.resolve()` does, so a link that
 * points outside the folder is refused too.
 *
 * DIVERGENCE: async, because the filesystem is loaded lazily (the runner's
 * fetch handler imports no `node:*` module up front).
 *
 * @throws HTTPException 403 If the path escapes the folder.
 */
export async function _resolveDownloadPath(folder: string, filename: string): Promise<string> {
  const allowedBase = await resolvePath(folder);
  const path = await import("node:path");
  const filePath = await resolvePath(path.resolve(allowedBase, filename));
  if (filePath !== allowedBase && !filePath.startsWith(allowedBase + path.sep)) {
    throw new HTTPException(403, "Access denied");
  }
  return filePath;
}

/** `Path.resolve()`: absolute, with every existing symlink along the path resolved. */
async function resolvePath(target: string): Promise<string> {
  const path = await import("node:path");
  const { realpath } = await import("node:fs/promises");
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      rethrowIfCancelled(e);
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  json: "application/json",
  js: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/x-wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
};

/** `mimetypes.guess_type(name)[0]`, for the common types. */
function guessType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Mount the prebuilt frontend UI and root redirect for all transports. */
export async function _setupFrontendRoutes(
  runnerApp: RunnerApp,
  reader: PrebuiltAssetReader = directoryAssetReader(),
): Promise<void> {
  if (!(await prebuiltAvailable(reader))) {
    logger.error("Prebuilt frontend not available: the prebuilt client's files were not found");
    return;
  }

  runnerApp.mount("/client", PipecatPrebuiltUI(reader, "/client"));

  // Redirect root requests to client interface.
  runnerApp.get("/", (request) =>
    Response.redirect(new URL("/client/", request.url).toString(), 307),
  );
}

/** Set up WebRTC-specific routes. */
export async function _setupWebrtcRoutes(
  runnerApp: RunnerApp,
  args: Namespace,
  activeSessions: Record<string, unknown>,
): Promise<void> {
  if (!_transportRoutesEnabled("webrtc")) return;

  let modules: [
    typeof import("@pipedog/transport-smallwebrtc/connection"),
    typeof import("@pipedog/transport-smallwebrtc/request_handler"),
    typeof import("@pipedog/transport-smallwebrtc/http"),
  ];
  try {
    modules = await Promise.all([
      import("@pipedog/transport-smallwebrtc/connection"),
      import("@pipedog/transport-smallwebrtc/request_handler"),
      import("@pipedog/transport-smallwebrtc/http"),
    ]);
  } catch (e) {
    rethrowIfCancelled(e);
    logger.warning(`WebRTC routes disabled after dependency check passed: ${e}`);
    return;
  }
  const [{ IceServer }, { SmallWebRTCRequestHandler }, { smallWebRTCOfferHandler }] = modules;

  runnerApp.get("/files/{filename:path}", async (_request, { filename }) => {
    if (!args.downloads_folder) {
      logger.warning(`Attempting to download ${filename}, but downloads folder not setup.`);
      throw new HTTPException(404);
    }
    const filePath = await _resolveDownloadPath(args.downloads_folder, filename!);
    const { readFile, stat } = await import("node:fs/promises");
    try {
      if (!(await stat(filePath)).isFile()) throw new HTTPException(404);
    } catch (e) {
      rethrowIfCancelled(e);
      throw new HTTPException(404);
    }
    const { basename } = await import("node:path");
    const name = basename(filePath);
    const headers: Record<string, string> = {
      "content-disposition": `attachment; filename="${encodeURIComponent(name)}"`,
    };
    const mediaType = guessType(name);
    if (mediaType) headers["content-type"] = mediaType;
    return new Response(new Uint8Array(await readFile(filePath)), { headers });
  });

  // Initialize the SmallWebRTC request handler. The configured ICE servers are
  // what the bot's own peer connection uses to gather server-reflexive and
  // relay candidates; without them it only ever offers host candidates.
  const iceServers = (args.ice_servers ?? []).map(
    (server: { urls: string | string[]; username?: string; credential?: string }) =>
      new IceServer(server),
  );
  const smallWebrtcHandler = new SmallWebRTCRequestHandler({
    iceServers: iceServers.length > 0 ? iceServers : null,
    esp32Mode: !!args.esp32,
    host: args.host ?? null,
  });
  _webrtcHandlers.set(runnerApp, smallWebrtcHandler);

  /** Handle WebRTC offers (POST) and ICE candidates (PATCH). */
  const offer = (request: Request, sessionId: string | null): Promise<Response> => {
    // When called via the /sessions/{session_id}/api/offer proxy the session_id
    // is threaded through; for direct /api/offer calls we mint one so bots see a
    // stable identifier in either path.
    const resolvedSessionId = sessionId ?? crypto.randomUUID();
    return smallWebRTCOfferHandler(smallWebrtcHandler, async (connection, offerRequest) => {
      const botModule = await runnerApp.getBotModule();
      const runnerArgs = new SmallWebRTCRunnerArguments({
        fileStorage: await runnerApp.getFileStorage(),
        webrtcConnection: connection,
        body: offerRequest.requestData,
        sessionId: resolvedSessionId,
      });
      runnerArgs.cliArgs = args;
      runnerApp.startBotSession(
        () =>
          _runBotSession(
            runnerApp,
            () => botModule.bot(runnerArgs),
            resolvedSessionId,
            activeSessions,
          ),
        `runner::webrtc::${resolvedSessionId}`,
      );
    })(request);
  };

  runnerApp.post("/api/offer", (request) =>
    offer(request, new URL(request.url).searchParams.get("session_id")),
  );
  runnerApp.patch("/api/offer", (request) => offer(request, null));

  /** Mimic Pipecat Cloud's proxy. */
  runnerApp.route(
    ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "/sessions/{session_id}/{path:path}",
    async (request, { session_id: sessionId, path }) => {
      if (!(sessionId! in activeSessions)) {
        return new Response("Invalid or not-yet-ready session_id", { status: 404 });
      }
      const activeSession = activeSessions[sessionId!];

      if (path!.endsWith("api/offer")) {
        // Parse the request body and convert it to an offer request
        try {
          const requestData = (await request.json()) as Record<string, any>;
          if (request.method === "POST") {
            if (typeof requestData.sdp !== "string" || typeof requestData.type !== "string") {
              throw new Error("sdp and type are required");
            }
            const body = {
              sdp: requestData.sdp,
              type: requestData.type,
              pc_id: requestData.pc_id ?? null,
              restart_pc: requestData.restart_pc ?? null,
              request_data: pyOr(requestData.request_data, requestData.requestData, activeSession),
            };
            return await offer(
              new Request(request.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: pyJsonDumps(body),
              }),
              sessionId!,
            );
          }
          if (request.method === "PATCH") {
            if (typeof requestData.pc_id !== "string") throw new Error("pc_id is required");
            return await offer(
              new Request(request.url, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: pyJsonDumps({
                  pc_id: requestData.pc_id,
                  candidates: requestData.candidates ?? [],
                }),
              }),
              null,
            );
          }
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error(`Failed to parse WebRTC request: ${e}`);
          return new Response("Invalid WebRTC request", { status: 400 });
        }
      }

      logger.info(`Received request for path: ${path}`);
      return new Response(null, { status: 200 });
    },
  );

  // Close the connections on shutdown (upstream's smallwebrtc_lifespan).
  _addLifespanToApp(runnerApp, async () => async () => {
    await smallWebrtcHandler.close();
  });
}

/** Each app's SmallWebRTC request handler, for tests and diagnostics. */
export const _webrtcHandlers = new WeakMap<RunnerApp, unknown>();

/** Python's `a or b or c`: the first truthy value (empty dicts and lists are falsy), else the last. */
function pyOr(...values: unknown[]): unknown {
  for (const v of values.slice(0, -1)) {
    if (v === null || v === undefined || v === false || v === 0 || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
      continue;
    return v;
  }
  return values.at(-1);
}

/**
 * Add a lifespan to the app, after any it already has (upstream combines
 * FastAPI lifespan context managers).
 */
export function _addLifespanToApp(runnerApp: RunnerApp, lifespan: Lifespan): void {
  runnerApp.addLifespan(lifespan);
}

/**
 * Seams the WhatsApp routes' tests replace: extra `WhatsAppClient` options
 * (a fake Meta API `fetch`, a connection factory).
 */
export const _whatsappDeps: { clientOptions: () => Record<string, unknown> } = {
  clientOptions: () => ({}),
};

/**
 * Set up WhatsApp-specific routes: `GET /whatsapp` (Meta's webhook
 * verification) and `POST /whatsapp` (call events). Calls are answered over
 * SmallWebRTC and the bot runs with a `SmallWebRTCRunnerArguments` whose
 * `body` is the call's metadata.
 *
 * DIVERGENCE: an invalid body is rejected with FastAPI's 422 shape by hand
 * (`parseWebhookRequest`, not pydantic), and `handleWebhookRequest` throws
 * plain errors where upstream raises `ValueError` ("No supported event"), so
 * that one is recognized by its message. The client's `fetch` option replaces
 * upstream's aiohttp session.
 */
export async function _setupWhatsappRoutes(runnerApp: RunnerApp, args: Namespace): Promise<void> {
  const requiredVars = [
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_TOKEN",
    "WHATSAPP_WEBHOOK_VERIFICATION_TOKEN",
  ];
  const env = (name: string): string | undefined => process.env[name] || undefined;
  const missing = requiredVars.filter((v) => !env(v));
  if (missing.length > 0) {
    logger.error(
      `Missing required environment variables for WhatsApp transport:\n    ${missing.join("\n    ")}\n            `,
    );
    return;
  }

  const appSecret = env("WHATSAPP_APP_SECRET")!;
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID")!;
  const token = env("WHATSAPP_TOKEN")!;
  const verificationToken = env("WHATSAPP_WEBHOOK_VERIFICATION_TOKEN")!;

  let api: typeof import("@pipedog/transport-whatsapp/api");
  let clientModule: typeof import("@pipedog/transport-whatsapp/client");
  try {
    if (!_transportRoutesEnabled("whatsapp")) {
      throw new Error(`install ${_transportRouteDependencies("whatsapp").join(" and ")}`);
    }
    [api, clientModule] = await Promise.all([
      import("@pipedog/transport-whatsapp/api"),
      import("@pipedog/transport-whatsapp/client"),
    ]);
  } catch (e) {
    rethrowIfCancelled(e);
    logger.error(`WhatsApp transport dependencies not installed: ${e}`);
    return;
  }

  // Global WhatsApp client instance, created on startup.
  let whatsappClient: InstanceType<typeof clientModule.WhatsAppClient> | null = null;

  runnerApp.get("/whatsapp", async (request) => {
    if (whatsappClient === null) {
      logger.error("WhatsApp client is not initialized");
      throw new HTTPException(503, "Service unavailable");
    }
    const params = Object.fromEntries(new URL(request.url).searchParams);
    logger.debug(`Webhook verification request received with params: ${Object.keys(params)}`);
    try {
      const result = await whatsappClient.handleVerifyWebhookRequest(params, verificationToken);
      logger.info("Webhook verification successful");
      return result;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Webhook verification failed: ${e}`);
      throw new HTTPException(403, "Verification failed");
    }
  });

  runnerApp.post("/whatsapp", async (request) => {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    let body: ReturnType<typeof api.parseWebhookRequest>;
    try {
      body = api.parseWebhookRequest(JSON.parse(new TextDecoder().decode(rawBody)));
    } catch (e) {
      rethrowIfCancelled(e);
      const msg = e instanceof api.WebhookValidationError ? e.message : "JSON decode error";
      throw new HTTPException(422, [{ type: "value_error", loc: ["body"], msg, input: null }]);
    }

    if (whatsappClient === null) {
      logger.error("WhatsApp client is not initialized");
      throw new HTTPException(503, "Service unavailable");
    }

    // Validate webhook object type
    if (body.object !== "whatsapp_business_account") {
      logger.warning(`Invalid webhook object type: ${body.object}`);
      throw new HTTPException(400, "Invalid object type");
    }

    logger.debug(`Processing WhatsApp webhook: ${JSON.stringify(body)}`);

    // Handle new WebRTC connections from WhatsApp calls: spawn a bot instance
    // for the conversation, with the call's metadata as `runnerArgs.body`.
    const connectionCallback = async (
      connection: SmallWebRTCRunnerArguments["webrtcConnection"],
      call: unknown,
    ): Promise<void> => {
      const botModule = await runnerApp.getBotModule();
      const sessionId = crypto.randomUUID();
      const runnerArgs = new SmallWebRTCRunnerArguments({
        fileStorage: await runnerApp.getFileStorage(),
        webrtcConnection: connection,
        sessionId,
        body: call,
      });
      runnerArgs.cliArgs = args;
      runnerApp.startBotSession(
        () => _runBotSession(runnerApp, () => botModule.bot(runnerArgs), sessionId, null),
        `runner::whatsapp::${sessionId}`,
      );
    };

    try {
      const result = await whatsappClient.handleWebhookRequest(body, {
        connectionCallback,
        rawBody,
        sha256Signature: request.headers.get("x-hub-signature-256"),
      });
      logger.debug(`Webhook processed successfully: ${result}`);
      return { status: "success", message: "Webhook processed successfully" };
    } catch (e) {
      rethrowIfCancelled(e);
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("No supported event found")) {
        logger.warning(`Invalid webhook request format: ${message}`);
        throw new HTTPException(400, `Invalid request: ${message}`);
      }
      logger.error(`Internal error processing webhook: ${e}`);
      throw new HTTPException(500, "Internal server error processing webhook");
    }
  });

  // Manage the WhatsApp client's lifecycle and clean up its calls.
  _addLifespanToApp(runnerApp, async () => {
    whatsappClient = new clientModule.WhatsAppClient({
      whatsappToken: token,
      whatsappSecret: appSecret,
      phoneNumberId,
      ...(_whatsappDeps.clientOptions() as object),
    });
    logger.info("WhatsApp client initialized successfully");
    return async () => {
      // Cleanup all active calls on shutdown
      logger.info("Cleaning up WhatsApp client resources...");
      if (whatsappClient) await whatsappClient.terminateAllCalls();
      logger.info("WhatsApp cleanup completed");
    };
  });
}

/**
 * Set up Daily-specific routes.
 *
 * DIVERGENCE: upstream mounts `/daily` and `/daily-dialin-webhook` when the
 * Daily SDK is installed. The Daily transport is not ported, so its routes are
 * never enabled.
 */
export function _setupDailyRoutes(_runnerApp: RunnerApp, _args: Namespace): void {
  if (!_transportRoutesEnabled("daily")) return;
  logger.warning(
    "Daily routes are not available: the Daily transport is not ported to pipedog yet.",
  );
}

/** Telephony webhook responses (Exotel doesn't use XML webhooks). */
export function _telephonyXmlTemplates(proxy: string): Record<string, string> {
  return {
    twilio: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${proxy}/ws"></Stream>
  </Connect>
</Response>`,
    telnyx: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${proxy}/ws" bidirectionalMode="rtp"></Stream>
  </Connect>
</Response>`,
    plivo: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">wss://${proxy}/ws</Stream>
</Response>`,
  };
}

/**
 * Set up telephony-specific routes.
 *
 * The WebSocket endpoint (`/ws`) is always registered so providers can connect
 * directly. The XML webhook (`POST /`) is only registered when a specific
 * telephony transport is chosen via `-t`, because the XML template is
 * provider-specific and requires a proxy hostname (`--proxy`).
 *
 * When `args.ws_auth == "token"`, connections must present a valid HMAC
 * session token obtained via `POST /start`: an `Authorization: Bearer` header,
 * a `?token=` query parameter, or a path segment (`/ws/<token>`, recommended
 * for telephony providers). Invalid or missing tokens are rejected with
 * WebSocket close code 4003.
 */
export function _setupTelephonyRoutes(
  runnerApp: RunnerApp,
  args: Namespace,
  wsUsedTokens: Set<string>,
): void {
  if (!_transportRoutesEnabled("telephony")) return;

  if ((TELEPHONY_TRANSPORTS as readonly string[]).includes(args.transport)) {
    const xmlTemplates = _telephonyXmlTemplates(args.proxy);

    // Handle telephony webhook and return XML response.
    runnerApp.post("/", () => {
      if (args.transport === "exotel") {
        // Exotel doesn't use POST webhooks - redirect to proper documentation
        logger.debug("POST Exotel endpoint - not used");
        return {
          error: "Exotel doesn't use POST webhooks",
          websocket_url: `wss://${args.proxy}/ws`,
          note: "Configure the WebSocket URL above in your Exotel App Bazaar Voicebot Applet",
        };
      }
      logger.debug(`POST ${String(args.transport).toUpperCase()} XML`);
      const xmlContent = xmlTemplates[args.transport] ?? "<Response></Response>";
      return new Response(xmlContent, { headers: { "content-type": "application/xml" } });
    });
  }

  const handleTelephonyWs = async (
    websocket: WebsocketConnection,
    request: RunnerWebSocketRequest,
    pathToken: string | null = null,
  ) => {
    if (args.ws_auth === "token") {
      const token = pathToken ?? _extractWsToken(request);
      if (!token || !(await _verifyAndConsumeWsToken(wsUsedTokens, token))) {
        logger.warning("WebSocket connection rejected: invalid or missing token");
        await websocket.close(4003);
        return;
      }
    }
    const origin = request.headers.get("origin") ?? "";
    if (!isOriginAllowed(origin, args.allowed_origins ?? [])) {
      logger.warning(`WebSocket connection rejected: origin '${origin}' not allowed`);
      await websocket.close(4003);
      return;
    }
    logger.debug("WebSocket connection accepted");
    await _runTelephonyBot(runnerApp, websocket, args);
  };

  runnerApp.websocket("/ws", (ws, request) => handleTelephonyWs(ws, request));
  runnerApp.websocket("/ws/{token}", (ws, request) =>
    handleTelephonyWs(ws, request, request.pathParams.token ?? null),
  );
}

const _MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Register `POST /sessions/{session_id}/files` and `POST /files`. */
export function _setupFileUploadsRoutes(
  runnerApp: RunnerApp,
  activeSessions: Record<string, unknown>,
): void {
  const handleUpload = async (request: Request, sessionId: string | null) => {
    const storage = await runnerApp.getFileStorage();
    if (storage === null) {
      throw new HTTPException(
        503,
        "File upload is disabled: start the runner with -u/--uploads-folder to set the uploads directory.",
      );
    }
    let file: File | null = null;
    try {
      const value = (await request.formData()).get("file");
      if (value !== null && typeof value !== "string") file = value as File;
    } catch (e) {
      rethrowIfCancelled(e);
    }
    if (file === null) {
      throw new HTTPException(422, [
        { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
      ]);
    }
    if (file.size > _MAX_UPLOAD_BYTES) {
      throw new HTTPException(413, `File exceeds ${_MAX_UPLOAD_BYTES} byte limit`);
    }
    const contents = new Uint8Array(await file.arrayBuffer());
    let fileUrl: string;
    try {
      fileUrl = await storage.save(file.name ?? "", contents);
    } catch (e) {
      rethrowIfCancelled(e);
      // Custom storage backends raise backend-specific errors, so catch
      // everything: the client gets a clean 500 either way.
      logger.error(`Failed to save upload: ${e}`);
      throw new HTTPException(500, "Failed to save file");
    }
    if (sessionId !== null) {
      const urls = runnerApp.sessionUploadUrls.get(sessionId) ?? [];
      urls.push(fileUrl);
      runnerApp.sessionUploadUrls.set(sessionId, urls);
    }
    // Use original filename only for format/mime in response
    const originalName = (file.name ?? "").split(/[\\/]/).pop() ?? "";
    const mediaType = guessType(originalName) ?? (file.type || "application/octet-stream");
    // Matches the RTVI File format, so the client can pass it straight back in
    // a send-file message.
    return {
      name: originalName,
      source: { type: "url", url: fileUrl },
      format: mediaType,
    };
  };

  /**
   * Handle file uploads scoped to a session, mirroring Pipecat Cloud's routes.
   * Files uploaded here are deleted when the session ends.
   */
  runnerApp.post("/sessions/{session_id}/files", async (request, { session_id: sessionId }) => {
    if (!(sessionId! in activeSessions)) {
      throw new HTTPException(404, "Invalid or not-yet-ready session_id");
    }
    return await handleUpload(request, sessionId!);
  });

  /**
   * Handle file uploads without a session, for transports whose clients never
   * learn one. Files uploaded here are only removed by the storage backend's
   * own retention.
   */
  runnerApp.post("/files", (request) => handleUpload(request, null));
}

/**
 * Validate and clean the proxy hostname, removing the protocol if present.
 */
export function _validateAndCleanProxy(proxy: string): string {
  if (!proxy) return proxy;
  const originalProxy = proxy;
  let cleaned = proxy;
  // Strip common protocols
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    cleaned = cleaned.split("://", 2)[1]!;
    logger.warning(
      `Removed protocol from proxy URL. Using '${cleaned}' instead of '${originalProxy}'. ` +
        "The --proxy argument expects only the hostname (e.g., 'mybot.ngrok.io').",
    );
  }
  // Remove trailing slashes
  return cleaned.replace(/\/+$/, "");
}

/** An ICE server as a plain object. */
export interface IceServerDict {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Python's `repr()` of a parsed JSON value, for error messages. */
function pyRepr(value: unknown): string {
  return pyJsonDumps(value);
}

/**
 * Parse ICE server configuration into a list of plain objects.
 *
 * Accepts either the raw `PIPECAT_ICE_SERVERS` environment value (a string)
 * or the tokens collected by `--ice-servers` (a list of strings). Each entry
 * is either a bare STUN or TURN URL, or a JSON object with `urls` and, for
 * TURN, `username` and `credential`. A string value is read as a whole JSON
 * array when it starts with `[` and as a single JSON object when it starts
 * with `{`; anything else is split on commas into bare URLs.
 *
 * @throws IceServerConfigError (upstream's `ValueError`) If an entry is
 *   malformed, is missing `urls`, or carries a key other than `urls`,
 *   `username`, or `credential`.
 */
export function _parseIceServers(value: string | string[] | null | undefined): IceServerDict[] {
  if (!value || value.length === 0) return [];

  let entries: unknown[];
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = pyJsonLoads(text);
      } catch (e) {
        throw new IceServerConfigError(`could not parse '${text}' as a JSON array: ${e}`);
      }
      if (!Array.isArray(parsed)) {
        throw new IceServerConfigError(`expected a JSON array of ICE servers, got '${text}'`);
      }
      entries = parsed;
    } else if (text.startsWith("{")) {
      entries = [text];
    } else {
      entries = text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item);
    }
  } else {
    entries = [...value];
  }

  const allowedKeys = new Set(["urls", "username", "credential"]);
  const iceServers: IceServerDict[] = [];

  for (let entry of entries) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (!text) continue;
      if (!text.startsWith("{")) {
        iceServers.push({ urls: text });
        continue;
      }
      try {
        entry = pyJsonLoads(text);
      } catch (e) {
        throw new IceServerConfigError(`could not parse '${text}' as a JSON object: ${e}`);
      }
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new IceServerConfigError(`expected a URL or a JSON object, got ${pyRepr(entry)}`);
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record)
      .filter((k) => !allowedKeys.has(k))
      .sort();
    if (unknown.length > 0) {
      throw new IceServerConfigError(
        `unsupported key(s) [${unknown.map((k) => `'${k}'`).join(", ")}] in ${pyRepr(record)}; ` +
          "supported keys are ['credential', 'urls', 'username']",
      );
    }
    const urls = record.urls;
    if (!urls || (Array.isArray(urls) && urls.length === 0)) {
      throw new IceServerConfigError(`missing 'urls' in ${pyRepr(record)}`);
    }
    const server: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (record[key] !== null && record[key] !== undefined) server[key] = record[key];
    }
    iceServers.push(server as unknown as IceServerDict);
  }

  return iceServers;
}

/** Raised for an invalid ICE server configuration (upstream's `ValueError`). */
export class IceServerConfigError extends Error {
  override name = "ValueError";
}

/** Returns the folder where files are stored for later download. */
export function runnerDownloadsFolder(): string | null {
  return RUNNER_DOWNLOADS_FOLDER;
}

/** Returns the host name of this runner. */
export function runnerHost(): string {
  return RUNNER_HOST;
}

/** Returns the port of this runner. */
export function runnerPort(): number {
  return RUNNER_PORT;
}

/**
 * Determine the storage backend for client uploads, or `null` to disable them.
 *
 * A `createFileStorage(): FileStorage | null` function exported by the bot
 * module (alongside `bot()`) takes precedence. The factory must be
 * synchronous. Without one, `-u/--uploads-folder` backs uploads with local
 * disk; with neither, uploads are disabled.
 *
 * @throws TypeError If `createFileStorage()` returns a promise.
 */
export async function _resolveFileStorage(
  args: Namespace,
  getBotModule: () => Promise<BotModule> = _getBotModule,
): Promise<FileStorage | null> {
  let botModule: BotModule | null;
  try {
    botModule = await getBotModule();
  } catch (e) {
    rethrowIfCancelled(e);
    // No bot module yet: per-session discovery will surface the error with
    // its usual message. Uploads just fall back to the flag.
    botModule = null;
  }
  const factory = botModule?.createFileStorage;
  if (typeof factory === "function") {
    const fileStorage = factory() as unknown;
    if (fileStorage !== null && typeof (fileStorage as PromiseLike<unknown>)?.then === "function") {
      throw new TypeError("createFileStorage() must be synchronous (got a promise)");
    }
    if (fileStorage !== null && !(fileStorage instanceof FileStorage)) {
      logger.debug("createFileStorage() returned an object that is not a FileStorage");
    }
    return fileStorage as FileStorage | null;
  }
  if (args.uploads_folder) {
    const fs = await import("node:fs/promises");
    return new LocalFileStorage({
      folder: args.uploads_folder,
      maxFiles: args.uploads_folder_max_files ?? 10,
      fs,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// The command line and main().
// ---------------------------------------------------------------------------

function env(name: string): string | undefined {
  return (globalThis as any).process?.env?.[name];
}

/**
 * Add the runner's flags to `parser` (upstream's `main()` adds them to the
 * parser it is given). Flags that only configure unported transports (MOQ's,
 * `--folder`) are not added.
 */
export function _addRunnerArguments(parser: ArgumentParser): ArgumentParser {
  parser.addArgument("--host", { default: RUNNER_HOST, help: "Host address" });
  parser.addArgument("--port", { type: "int", default: RUNNER_PORT, help: "Port number" });
  parser.addArgument("-t", "--transport", {
    choices: ["daily", "livekit", "moq", "vonage", "webrtc", "websocket", ...TELEPHONY_TRANSPORTS],
    default: null,
    help:
      "Restrict the server to a single transport and set it as the default for /start. " +
      "Omit to support all transports simultaneously (default behaviour).",
  });
  parser.addArgument("-x", "--proxy", { help: "Public proxy host name" });
  parser.addArgument("-d", "--direct", {
    action: "store_true",
    help: "Connect directly to Daily room (automatically sets transport to daily)",
  });
  parser.addArgument("-f", "--downloads-folder", {
    dest: "downloads_folder",
    help: "Path to folder for files available for download",
  });
  parser.addArgument("-u", "--uploads-folder", {
    dest: "uploads_folder",
    default: env("PIPECAT_UPLOADS_FOLDER") ?? null,
    help:
      "Path to folder for client uploads (short-lived; max files enforced). " +
      "Defaults to the PIPECAT_UPLOADS_FOLDER environment variable.",
  });
  parser.addArgument("--uploads-folder-max-files", {
    type: "int",
    default: 10,
    dest: "uploads_folder_max_files",
    help: "Max files to keep in uploads folder; oldest removed (default: 10)",
  });
  parser.addArgument("--runner-body", {
    default: null,
    help: "Path to a YAML or JSON file with the runner args body for WebSocket sessions",
  });
  parser.addArgument("-v", "--verbose", {
    action: "count",
    default: 0,
    help: "Increase logging verbosity",
  });
  parser.addArgument("--dialin", {
    action: "boolean_optional",
    default: true,
    help: "Mount the Daily PSTN dial-in webhook for -t daily (Daily is not ported yet)",
  });
  parser.addArgument("--esp32", {
    action: "store_true",
    help: "Enable SDP munging for ESP32 compatibility (requires --host with IP address)",
  });
  parser.addArgument("--whatsapp", {
    action: "store_true",
    help: "Ensure required WhatsApp environment variables are present",
  });
  parser.addArgument("--ws-auth", {
    dest: "ws_auth",
    choices: ["none", "token"],
    default: env("PIPECAT_WEBSOCKET_AUTH") ?? "none",
    help:
      "WebSocket authentication mode. 'token' requires clients to call /start and obtain a " +
      "signed HMAC session token before connecting to /ws or /ws-client.",
  });
  parser.addArgument("--ice-servers", {
    dest: "ice_servers",
    nargs: "*",
    default: env("PIPECAT_ICE_SERVERS") ?? null,
    metavar: "SERVER",
    help:
      "STUN and TURN servers the WebRTC transport should use, as bare URLs or JSON objects " +
      "(default: the PIPECAT_ICE_SERVERS environment variable).",
  });
  parser.addArgument("--allowed-origins", {
    dest: "allowed_origins",
    nargs: "*",
    default: (env("PIPECAT_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o),
    help:
      "Allowed origins for HTTP and WebSocket connections (e.g. https://example.com). " +
      "Omit or leave empty to allow all origins.",
  });
  return parser;
}

/** Load `.env` from the current directory into the environment, overriding it (`load_dotenv(override=True)`). */
async function loadDotenv(): Promise<void> {
  const proc = (globalThis as any).process;
  if (!proc?.env) return;
  let text: string;
  try {
    const { readFile } = await import("node:fs/promises");
    text = await readFile(".env", "utf8");
  } catch (e) {
    rethrowIfCancelled(e);
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replaceAll("\\n", "\n");
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    proc.env[match[1]!] = value;
  }
}

/** Options for `createRunnerApp()`: the runner's CLI flags, as camelCase options. */
export interface RunnerAppOptions {
  /** The bot to run for each session. Defaults to the bot module `_getBotModule()` finds. */
  bot?: BotModule["bot"];
  /** Restrict the runner to one transport (`-t`). */
  transport?: string | null;
  /** The host clients reach the runner on (`--host`); used in URLs it hands out. */
  host?: string;
  /** The port clients reach the runner on (`--port`). */
  port?: number;
  /** Public proxy host name for telephony webhooks (`-x/--proxy`). */
  proxy?: string | null;
  /** SDP munging for ESP32 clients (`--esp32`). */
  esp32?: boolean;
  /** STUN/TURN servers (`--ice-servers`): URLs, JSON strings or objects. */
  iceServers?: string | (string | IceServerDict)[] | null;
  /** Allowed origins for HTTP and WebSocket connections (`--allowed-origins`). */
  allowedOrigins?: string[];
  /** WebSocket authentication (`--ws-auth`). */
  wsAuth?: "none" | "token";
  /** Folder served at `/files/{name}` (`-f/--downloads-folder`). */
  downloadsFolder?: string | null;
  /** Local folder for client uploads (`-u/--uploads-folder`). */
  uploadsFolder?: string | null;
  /** Max files kept in the uploads folder. */
  uploadsFolderMaxFiles?: number;
  /** YAML or JSON file read as each WebSocket session's body (`--runner-body`). */
  runnerBody?: string | null;
  /** Uploads storage; wins over `uploadsFolder` and the bot module's `createFileStorage()`. */
  fileStorage?: FileStorage | null;
  /**
   * The prebuilt client served at `/client`: the vendored build by default, a
   * directory, your own reader (e.g. Workers static assets), or `false` for none.
   */
  prebuilt?: false | string | URL | PrebuiltAssetReader;
  /** Startup hook with optional cleanup (FastAPI lifespan). */
  lifespan?: Lifespan;
  /** Extra values for `runnerArgs.cliArgs`. */
  cliArgs?: Namespace;
}

function prebuiltReader(option: RunnerAppOptions["prebuilt"]): PrebuiltAssetReader | false {
  if (option === false) return false;
  if (option === undefined) return directoryAssetReader();
  if (typeof option === "function") return option;
  return directoryAssetReader(option);
}

/**
 * Build a runner app (the dev runner's routes) without parsing a command line
 * or listening, to serve it yourself or mount it in another framework.
 *
 * @example
 * // Hono
 * const runner = await createRunnerApp({ bot, transport: "webrtc" });
 * await runner.startup();
 * honoApp.all("*", (c) => runner.fetch(c.req.raw));
 */
export async function createRunnerApp(options: RunnerAppOptions = {}): Promise<RunnerApp> {
  const iceServers = Array.isArray(options.iceServers)
    ? _parseIceServers(options.iceServers.map((s) => (typeof s === "string" ? s : pyJsonDumps(s))))
    : _parseIceServers(options.iceServers ?? null);
  const args: Namespace = {
    ...(options.cliArgs ?? {}),
    host: options.host ?? "localhost",
    port: options.port ?? 7860,
    transport: options.transport ?? null,
    proxy: options.proxy ? _validateAndCleanProxy(options.proxy) : null,
    direct: false,
    downloads_folder: options.downloadsFolder ?? null,
    uploads_folder: options.uploadsFolder ?? null,
    uploads_folder_max_files: options.uploadsFolderMaxFiles ?? 10,
    runner_body: options.runnerBody ?? null,
    verbose: 0,
    dialin: false,
    esp32: options.esp32 ?? false,
    whatsapp: false,
    ws_auth: options.wsAuth ?? "none",
    ice_servers: iceServers,
    allowed_origins: options.allowedOrigins ?? [],
  };
  const runnerApp = new RunnerApp({ botModule: options.bot ? { bot: options.bot } : null });
  if (options.fileStorage !== undefined) runnerApp.fileStorage = options.fileStorage;
  if (options.lifespan) runnerApp.addLifespan(options.lifespan);
  await _configureServerApp(runnerApp, args, { prebuilt: prebuiltReader(options.prebuilt) });
  return runnerApp;
}

/** Options for `main()`. */
export interface MainOptions {
  /**
   * A parser with the bot's own flags. The runner's flags are added to it;
   * the bot's values reach it as `runnerArgs.cliArgs`.
   */
  parser?: ArgumentParser;
  /** The command line, without the runtime and script. Defaults to `process.argv.slice(2)`. */
  argv?: readonly string[];
  /** The bot to run. Defaults to the bot module `_getBotModule()` finds. */
  bot?: BotModule["bot"];
  /** Startup hook with optional cleanup (FastAPI lifespan). */
  lifespan?: Lifespan;
  /**
   * Stop the server on SIGINT/SIGTERM. Defaults to true; tests that start
   * several runners turn it off.
   */
  handleSignals?: boolean;
  /** The app to configure and serve. Defaults to the module-level `app`. */
  app?: RunnerApp;
}

/**
 * Start the development runner.
 *
 * Parses command-line arguments and starts a server that supports WebRTC and
 * telephony transports simultaneously. Clients declare which transport to use
 * via the `transport` field in the `/start` body. When `-t` is provided, the
 * server restricts `/start` to that transport only and displays
 * transport-specific startup information.
 *
 * The runner discovers and runs the `bot(runnerArgs)` function exported by
 * the entry script (or by `bot.ts` in the current directory).
 *
 * Command-line arguments:
 * - `--host`: Server host address (default: localhost)
 * - `--port`: Server port (default: 7860)
 * - `-t/--transport`: Restrict to a single transport and set as default for
 *   `/start` (webrtc, livekit, websocket, twilio, telnyx, plivo, exotel; daily,
 *   moq and vonage are recognized but not ported)
 * - `-x/--proxy`: Public proxy hostname for telephony webhooks
 * - `-f/--downloads-folder`: Path to folder for files available for download
 * - `-u/--uploads-folder`: Path to folder for client uploads
 * - `--uploads-folder-max-files`: Max files in uploads folder (default: 10)
 * - `--runner-body`: YAML or JSON file read as the body of each WebSocket session
 * - `--esp32`: Enable SDP munging for ESP32 compatibility (requires --host with an IP)
 * - `--ice-servers`: STUN and TURN servers for the WebRTC transport
 * - `--ws-auth`: `none` or `token`
 * - `--allowed-origins`: Allowed origins for HTTP and WebSocket connections
 * - `-v/--verbose`: Increase logging verbosity
 *
 * @returns The running server, or `null` when the command line was invalid
 *   (the error is logged and the exit code set) or asked for `--help`.
 */
export async function main(
  options: MainOptions = {},
): Promise<import("./serve.ts").RunnerServer | null> {
  const proc = (globalThis as any).process;
  await loadDotenv();
  if (proc?.env) proc.env.ENV = "local";

  const parser = _addRunnerArguments(
    options.parser ?? new ArgumentParser({ description: "Pipedog Development Runner" }),
  );
  let args: Namespace;
  try {
    args = parser.parseArgs(options.argv ?? proc?.argv?.slice(2) ?? []);
  } catch (e) {
    if (e instanceof HelpRequested) {
      writeStdout(e.message);
      return null;
    }
    if (e instanceof ArgumentError) {
      console.error(`${parser.formatHelp().split("\n")[0]}\nerror: ${e.message}`);
      if (proc) proc.exitCode = 2;
      return null;
    }
    throw e;
  }

  const fail = (message: string): null => {
    logger.error(message);
    if (proc) proc.exitCode = 1;
    return null;
  };

  // Validate and clean proxy hostname
  if (args.proxy) args.proxy = _validateAndCleanProxy(args.proxy);

  // Normalize ICE servers from either the CLI tokens or PIPECAT_ICE_SERVERS
  try {
    args.ice_servers = _parseIceServers(args.ice_servers);
  } catch (e) {
    rethrowIfCancelled(e);
    return fail(`Invalid ICE server configuration: ${(e as Error).message}`);
  }

  // --direct implies Daily transport
  if (args.direct) {
    if (args.transport == null || args.transport === "daily") args.transport = "daily";
    else return fail("--direct flag only works with Daily transport (-t daily)");
  }

  // DIVERGENCE: upstream runs Daily (and --direct), MOQ and the Vonage Video
  // Connector here; those transports are not ported.
  if (args.transport != null && args.transport in UNPORTED_TRANSPORTS) {
    return fail(
      `The ${args.transport} transport (${UNPORTED_TRANSPORTS[args.transport]}) is not ported to ` +
        "pipedog yet. Use -t webrtc, -t websocket or a telephony transport " +
        "(twilio, telnyx, plivo, exotel).",
    );
  }

  // Validate ESP32 requirements
  if (args.esp32 && args.host === "localhost") {
    return fail("For ESP32, you need to specify `--host IP` so we can do SDP munging.");
  }

  // Log level
  logger.setLevel(args.verbose ? "TRACE" : "DEBUG");

  // Print overall dev runner banner
  writeStdout(_formatDevRunnerBanner());

  // Print startup message
  _printStartupMessage(args);

  RUNNER_DOWNLOADS_FOLDER = args.downloads_folder ?? null;
  RUNNER_HOST = args.host;
  RUNNER_PORT = args.port;

  // Configure the app with transport-specific routes. The uploads storage is
  // resolved on first use, so a bot module that awaits main() at its top
  // level can still be found.
  const runnerApp = options.app ?? app;
  if (options.bot) runnerApp.setBotModule({ bot: options.bot });
  if (options.lifespan) runnerApp.addLifespan(options.lifespan);
  await _configureServerApp(runnerApp, args);

  // Run the server
  const { serve } = await import("./serve.ts");
  const server = await serve(runnerApp, { host: args.host, port: args.port });
  if (options.handleSignals ?? true) {
    const stop = async () => {
      await server.close();
      proc?.exit?.(0);
    };
    proc?.once?.("SIGINT", stop);
    proc?.once?.("SIGTERM", stop);
  }
  return server;
}
