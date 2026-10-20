// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: sets up tracing with the OTLP/HTTP
// exporter, creates a conversation span and a child turn span through core's
// TurnTraceObserver, flushes, and checks what a fake OTLP collector received.
// The collector is a local HTTP server where the runtime can listen (Bun,
// Deno, Node) and an in-process `fetch` stand-in on Workers, which still
// builds a real `Request` from the exporter's arguments so workerd validates them.

import { TurnTrackingObserver } from "@pipedog/core/observers/turn_tracking_observer";
import { UserBotLatencyObserver } from "@pipedog/core/observers/user_bot_latency_observer";
import { isTracingAvailable } from "@pipedog/core/utils/tracing/setup";
import { TurnTraceObserver } from "@pipedog/core/utils/tracing/turn_trace_observer";
import { forceFlushTracing, OTLPTraceExporter, setupTracing } from "@pipedog/tracing";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`tracing smoke: ${message}`);
}

interface Collector {
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}

/** Read an OTLP/HTTP JSON request body (gzip or not). */
async function readOtlpJson(request: Request): Promise<unknown> {
  let body: ReadableStream<Uint8Array> | null = request.body;
  if (request.headers.get("content-encoding") === "gzip" && body) {
    body = body.pipeThrough(new DecompressionStream("gzip") as any);
  }
  return JSON.parse(await new Response(body).text());
}

async function handle(request: Request, requests: unknown[]): Promise<Response> {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v1/traces")) {
    return new Response("not found", { status: 404 });
  }
  requests.push(await readOtlpJson(request));
  return Response.json({}, { status: 200 });
}

async function startCollector(): Promise<Collector> {
  const requests: unknown[] = [];
  const g = globalThis as any;
  const onWorkers = g.navigator?.userAgent === "Cloudflare-Workers";

  if (g.Bun) {
    const server = g.Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (r: Request) => handle(r, requests),
    });
    return {
      url: `http://127.0.0.1:${server.port}/v1/traces`,
      requests,
      close: async () => server.stop(true),
    };
  }
  if (g.Deno) {
    const server = g.Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (r: Request) =>
      handle(r, requests),
    );
    return {
      url: `http://127.0.0.1:${server.addr.port}/v1/traces`,
      requests,
      close: () => server.shutdown(),
    };
  }
  if (!onWorkers && g.process?.versions?.node) {
    const http = await import("node:http");
    const server = http.createServer(async (req, res) => {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c as Uint8Array);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const response = await handle(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: new Blob(chunks as BlobPart[]),
        }),
        requests,
      );
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/v1/traces`,
      requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  // Workers: no listening sockets. Intercept fetch for the collector's URL.
  const url = "http://otel-collector.invalid/v1/traces";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== url) return original(input, init);
    return handle(request, requests);
  }) as typeof fetch;
  return {
    url,
    requests,
    close: async () => {
      globalThis.fetch = original;
    },
  };
}

type OtlpAttribute = { key: string; value: Record<string, unknown> };
type OtlpSpan = {
  name: string;
  spanId: string;
  parentSpanId?: string;
  attributes: OtlpAttribute[];
};

function attr(attributes: OtlpAttribute[], key: string): unknown {
  const v = attributes.find((a) => a.key === key)?.value;
  return v ? Object.values(v)[0] : undefined;
}

export default async function smoke(): Promise<void> {
  const collector = await startCollector();
  try {
    check(
      setupTracing({
        serviceName: "pipedog-smoke",
        exporter: new OTLPTraceExporter({ url: collector.url }),
      }),
      "setupTracing() returned false",
    );
    check(isTracingAvailable(), "tracing is not available after setupTracing()");

    const observer = new TurnTraceObserver({
      turnTracker: new TurnTrackingObserver(),
      latencyTracker: new UserBotLatencyObserver(),
      conversationId: "conv-smoke",
    });
    const internals = observer as any;
    observer.startConversationTracing("conv-smoke");
    await internals._handleTurnStarted(1);
    await internals._handleTurnEnded(1, 0.5, false);
    observer.endConversationTracing();

    await forceFlushTracing();

    const resourceSpans = collector.requests.flatMap((r: any) => r.resourceSpans ?? []);
    check(resourceSpans.length > 0, "the collector received no spans");
    const resourceAttrs: OtlpAttribute[] = resourceSpans[0].resource.attributes;
    check(
      attr(resourceAttrs, "service.name") === "pipedog-smoke",
      `service.name = ${attr(resourceAttrs, "service.name")}`,
    );
    const spans: OtlpSpan[] = resourceSpans.flatMap((rs: any) =>
      rs.scopeSpans.flatMap((ss: any) => ss.spans),
    );
    const conversation = spans.find((s) => s.name === "conversation");
    const turn = spans.find((s) => s.name === "turn");
    check(conversation, `no conversation span in ${spans.map((s) => s.name).join(", ")}`);
    check(turn, `no turn span in ${spans.map((s) => s.name).join(", ")}`);
    check(attr(conversation.attributes, "conversation.id") === "conv-smoke", "conversation.id");
    check(attr(conversation.attributes, "conversation.type") === "voice", "conversation.type");
    check(String(attr(turn.attributes, "turn.number")) === "1", "turn.number");
    check(attr(turn.attributes, "turn.was_interrupted") === false, "turn.was_interrupted");
    check(turn.parentSpanId === conversation.spanId, "turn is not a child of conversation");
  } finally {
    await collector.close();
  }
}
