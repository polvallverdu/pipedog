// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for an OTLP/HTTP traces collector and an error webhook, for the
// end-to-end tests. It records what it receives.

export interface MockObservability {
  /** OTLP/HTTP traces endpoint, as OTEL_EXPORTER_OTLP_ENDPOINT. */
  tracesUrl: string;
  /** Error webhook, as ERROR_WEBHOOK_URL. */
  webhookUrl: string;
  /** The body of each traces export. */
  traces: string[];
  /** Each alert posted to the webhook. */
  alerts: Record<string, unknown>[];
  stop(): void;
}

export function startMockObservability(): MockObservability {
  const mock: MockObservability = {
    tracesUrl: "",
    webhookUrl: "",
    traces: [],
    alerts: [],
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/v1/traces") {
        mock.traces.push(await request.text());
        return Response.json({});
      }
      if (request.method === "POST" && pathname === "/alert") {
        mock.alerts.push((await request.json()) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mock.tracesUrl = `http://127.0.0.1:${server.port}/v1/traces`;
  mock.webhookUrl = `http://127.0.0.1:${server.port}/alert`;
  return mock;
}
