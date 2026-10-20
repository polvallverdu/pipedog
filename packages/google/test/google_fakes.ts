// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Local fakes of the Google APIs, so the real SDKs (`@google-cloud/speech`,
// `@google-cloud/text-to-speech`, `@google/genai`) can be exercised without
// network access or credentials:
//
// - a gRPC server (`@grpc/grpc-js` + `@grpc/proto-loader`) serving
//   `google.cloud.speech.v2.Speech` and `google.cloud.texttospeech.v1.TextToSpeech`
//   from the .proto files shipped inside the SDK packages;
// - SDK client options that point a gapic client at it over an insecure
//   channel, built with the SDK's own copy of grpc-js (credentials objects
//   are checked with `instanceof`).
//
// Requests are recorded as plain objects with the proto field names
// (snake_case), enums as strings and bytes as base64, which is also what
// tools comparing against upstream Python print.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/** Directory holding the `.proto` files shipped with an SDK package (its `build/protos`). */
function sdkProtosDir(pkg: string): string {
  // `<pkg>/build/src/index.js` → `<pkg>/build/protos`
  const entry = fileURLToPath(import.meta.resolve(pkg));
  return join(dirname(dirname(entry)), "protos");
}

/** google-gax's `build/protos` (google/api, google/rpc, ... imported by the SDK protos). */
function gaxProtosDir(pkg: string): string {
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve(pkg)));
  return join(dirname(sdkRequire.resolve("google-gax")), "..", "protos");
}

/** The grpc-js the SDK's google-gax uses (credentials must come from the same copy). */
function sdkGrpc(pkg: string): typeof grpc {
  const sdkRequire = createRequire(fileURLToPath(import.meta.resolve(pkg)));
  return sdkRequire("google-gax").grpc as typeof grpc;
}

function loadService(pkg: string, protoFile: string, servicePath: string[]) {
  const protos = sdkProtosDir(pkg);
  const definition = protoLoader.loadSync(join(protos, protoFile), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: false,
    includeDirs: [protos, gaxProtosDir(pkg)],
  });
  let node: any = grpc.loadPackageDefinition(definition);
  for (const part of servicePath) node = node[part];
  return { service: node.service as grpc.ServiceDefinition };
}

/** One recorded bidi or unary call. */
export interface RecordedCall {
  method: string;
  metadata: Record<string, unknown>;
  requests: Record<string, unknown>[];
  /** True once the client half-closed its request stream. */
  ended: boolean;
  /** True once the client cancelled the call. */
  cancelled: boolean;
}

export type BidiHandler = (
  call: grpc.ServerDuplexStream<any, any>,
  record: RecordedCall,
  index: number,
) => void;

export type UnaryHandler = (
  request: Record<string, unknown>,
  record: RecordedCall,
) => Record<string, unknown> | grpc.ServiceError;

export interface FakeGrpcServer {
  port: number;
  calls: RecordedCall[];
  /** Resolves once `n` calls have been recorded. */
  waitForCalls(n: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

function metadataObject(md: grpc.Metadata): Record<string, unknown> {
  return md.getMap();
}

/** Convert a decoded request (Buffers for bytes) into its recorded form. */
function toRecord(value: unknown): any {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toRecord);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      out[k] = toRecord(v);
    }
    return out;
  }
  return value;
}

async function startServer(
  addServices: (server: grpc.Server, calls: RecordedCall[], notify: () => void) => void,
): Promise<FakeGrpcServer> {
  const server = new grpc.Server();
  const calls: RecordedCall[] = [];
  const waiters: (() => void)[] = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  addServices(server, calls, notify);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    );
  });
  return {
    port,
    calls,
    async waitForCalls(n, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (calls.length < n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} calls`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
        setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 500);
      }),
  };
}

function bidiImpl(method: string, calls: RecordedCall[], notify: () => void, handler: BidiHandler) {
  return (call: grpc.ServerDuplexStream<any, any>) => {
    const record: RecordedCall = {
      method,
      metadata: metadataObject(call.metadata),
      requests: [],
      ended: false,
      cancelled: false,
    };
    const index = calls.length;
    calls.push(record);
    call.on("data", (req) => {
      record.requests.push(toRecord(req));
      notify();
    });
    call.on("end", () => {
      record.ended = true;
      notify();
    });
    call.on("cancelled", () => {
      record.cancelled = true;
      notify();
    });
    call.on("error", () => {});
    notify();
    handler(call, record, index);
  };
}

function unaryImpl(
  method: string,
  calls: RecordedCall[],
  notify: () => void,
  handler: UnaryHandler,
) {
  return (
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<Record<string, unknown>>,
  ) => {
    const request = toRecord(call.request);
    const record: RecordedCall = {
      method,
      metadata: metadataObject(call.metadata),
      requests: [request],
      ended: true,
      cancelled: false,
    };
    calls.push(record);
    notify();
    const result = handler(request, record);
    if (result instanceof Error) callback(result as grpc.ServiceError);
    else callback(null, result);
  };
}

/**
 * Start a fake `google.cloud.speech.v2.Speech` server. Only
 * `StreamingRecognize` is implemented; `handler` drives each call.
 */
export async function startFakeSpeechServer(handler: BidiHandler): Promise<FakeGrpcServer> {
  const { service } = loadService(
    "@google-cloud/speech",
    "google/cloud/speech/v2/cloud_speech.proto",
    ["google", "cloud", "speech", "v2", "Speech"],
  );
  return startServer((server, calls, notify) => {
    server.addService(service, {
      StreamingRecognize: bidiImpl("StreamingRecognize", calls, notify, handler),
    } as grpc.UntypedServiceImplementation);
  });
}

/**
 * Start a fake `google.cloud.texttospeech.v1.TextToSpeech` server with
 * `SynthesizeSpeech` and `StreamingSynthesize`.
 */
export async function startFakeTextToSpeechServer(handlers: {
  synthesizeSpeech?: UnaryHandler;
  streamingSynthesize?: BidiHandler;
}): Promise<FakeGrpcServer> {
  const { service } = loadService(
    "@google-cloud/text-to-speech",
    "google/cloud/texttospeech/v1/cloud_tts.proto",
    ["google", "cloud", "texttospeech", "v1", "TextToSpeech"],
  );
  return startServer((server, calls, notify) => {
    server.addService(service, {
      SynthesizeSpeech: unaryImpl(
        "SynthesizeSpeech",
        calls,
        notify,
        handlers.synthesizeSpeech ?? (() => ({ audio_content: Buffer.alloc(0) })),
      ),
      StreamingSynthesize: bidiImpl(
        "StreamingSynthesize",
        calls,
        notify,
        handlers.streamingSynthesize ?? ((call) => call.end()),
      ),
    } as grpc.UntypedServiceImplementation);
  });
}

/**
 * gapic client options that point an SDK client at a fake server: plain-text
 * gRPC on 127.0.0.1, so no credentials are fetched for the calls.
 */
export function insecureClientOptions(
  pkg: "@google-cloud/speech" | "@google-cloud/text-to-speech",
  port: number,
): Record<string, unknown> {
  return {
    apiEndpoint: "127.0.0.1",
    port,
    sslCreds: sdkGrpc(pkg).credentials.createInsecure(),
  };
}

/** A grpc `ServiceError` with the given status code. */
export function grpcError(code: grpc.status, details: string): grpc.ServiceError {
  const err = new Error(`${code} ${grpc.status[code]}: ${details}`) as grpc.ServiceError;
  err.code = code;
  err.details = details;
  err.metadata = new grpc.Metadata();
  return err;
}

export { grpc };

// ---------------------------------------------------------------------------
// Gemini API (generativelanguage) over HTTP + WebSocket, with Bun.serve
// ---------------------------------------------------------------------------

/** One recorded HTTP request to the fake Gemini API. */
export interface RecordedHttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

/** One recorded Live (BidiGenerateContent) WebSocket session. */
export interface RecordedLiveSession {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Client messages, parsed from JSON. */
  messages: Record<string, any>[];
  closed: boolean;
}

/** The server side of a Live session, for handlers to answer with. */
export interface LiveSocket {
  send(message: unknown): void;
  close(code?: number, reason?: string): void;
}

export interface FakeGenaiServerOptions {
  /**
   * Answer a `streamGenerateContent` request with these SSE chunks (each a
   * `GenerateContentResponse` object).
   */
  streamGenerateContent?: (request: RecordedHttpRequest) => unknown[] | Response;
  /**
   * Called for each client message on a Live session after the setup has
   * been answered with `setupComplete` (unless `autoSetupComplete` is false).
   */
  onLiveMessage?: (
    message: Record<string, any>,
    socket: LiveSocket,
    session: RecordedLiveSession,
  ) => void;
  /** Called when a Live session opens, before any message. */
  onLiveOpen?: (socket: LiveSocket, session: RecordedLiveSession) => void;
  /** Answer `setup` with `setupComplete` (default true). */
  autoSetupComplete?: boolean;
  /** Serve HTTPS / WSS with this certificate (PEM strings). */
  tls?: { cert: string; key: string };
}

export interface FakeGenaiServer {
  url: string;
  port: number;
  requests: RecordedHttpRequest[];
  sessions: RecordedLiveSession[];
  stop(): Promise<void>;
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Start a fake Gemini API server on 127.0.0.1 (HTTP SSE + Live WebSocket). */
export function startFakeGenaiServer(options: FakeGenaiServerOptions = {}): FakeGenaiServer {
  const requests: RecordedHttpRequest[] = [];
  const sessions: RecordedLiveSession[] = [];
  const autoSetupComplete = options.autoSetupComplete ?? true;

  const server = Bun.serve<{ session: RecordedLiveSession }, never>({
    hostname: "127.0.0.1",
    port: 0,
    ...(options.tls ? { tls: options.tls } : {}),
    async fetch(req, srv) {
      const url = new URL(req.url);
      const query = Object.fromEntries(url.searchParams.entries());
      // The JS SDK builds `<base>/` + `/ws/...` (a double slash); Google accepts it.
      if (url.pathname.replace(/^\/+/, "/").startsWith("/ws/")) {
        const session: RecordedLiveSession = {
          path: url.pathname,
          query,
          headers: headersObject(req.headers),
          messages: [],
          closed: false,
        };
        sessions.push(session);
        if (srv.upgrade(req, { data: { session } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const text = await req.text();
      const record: RecordedHttpRequest = {
        method: req.method,
        path: url.pathname,
        query,
        headers: headersObject(req.headers),
        body: text ? JSON.parse(text) : null,
      };
      requests.push(record);
      if (url.pathname.endsWith(":streamGenerateContent")) {
        const chunks = options.streamGenerateContent?.(record) ?? [];
        if (chunks instanceof Response) return chunks;
        const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
    websocket: {
      open(ws) {
        const socket: LiveSocket = {
          send: (m) => ws.send(JSON.stringify(m)),
          close: (code, reason) => ws.close(code, reason),
        };
        (ws.data as any).socket = socket;
        options.onLiveOpen?.(socket, ws.data.session);
      },
      message(ws, raw) {
        const session = ws.data.session;
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const message = JSON.parse(text) as Record<string, any>;
        session.messages.push(message);
        const socket = (ws.data as any).socket as LiveSocket;
        if ("setup" in message && autoSetupComplete) {
          socket.send({ setupComplete: {} });
          return;
        }
        options.onLiveMessage?.(message, socket, session);
      },
      close(ws) {
        ws.data.session.closed = true;
      },
    },
  });

  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${server.port}`,
    port: server.port as number,
    requests,
    sessions,
    async stop() {
      await server.stop(true);
    },
  };
}
