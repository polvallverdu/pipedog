// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Process entry for the Hono end-to-end runs on Bun, Node and Deno: the echo
// bot behind FastAPIWebsocketTransport, on a socket accepted by a Hono app
// through `honoWebsocket()` and the runtime's Hono WebSocket adapter.
//
//   E2E_PORT=<port> -> prints E2E_READY once listening, exits when the client leaves

import { Hono } from "hono";
import { honoWebsocket } from "../../src/hono.ts";
import { env, exit, quietLogs, runEchoBotOnSocket } from "./apps.ts";

quietLogs();

const port = Number(env("E2E_PORT"));
const g = globalThis as { Bun?: unknown; Deno?: unknown };

try {
  const app = new Hono();
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const events = (headers: Headers) =>
    honoWebsocket(
      async (websocket) => {
        await runEchoBotOnSocket(websocket);
        done();
      },
      { headers },
    );

  let stop: () => Promise<void> | void;
  if (g.Bun) {
    const { upgradeWebSocket, websocket } = await import("hono/bun");
    app.get(
      "/ws",
      upgradeWebSocket((c) => events(c.req.raw.headers)),
    );
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket });
    stop = () => server.stop(true);
  } else if (g.Deno) {
    const { upgradeWebSocket } = await import("hono/deno");
    app.get(
      "/ws",
      upgradeWebSocket((c) => events(c.req.raw.headers)),
    );
    const Deno = g.Deno as {
      serve(
        o: object,
        h: (r: Request) => Response | Promise<Response>,
      ): { shutdown(): Promise<void> };
    };
    const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, app.fetch);
    stop = () => server.shutdown();
  } else {
    const { serve } = await import("@hono/node-server");
    const { createNodeWebSocket } = await import("@hono/node-ws");
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.get(
      "/ws",
      upgradeWebSocket((c) => events(c.req.raw.headers)),
    );
    const server = serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
    injectWebSocket(server);
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    }
    stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("E2E_READY");
  await finished;
  await Promise.race([stop(), new Promise((r) => setTimeout(r, 1000))]);
  exit(0);
} catch (e) {
  console.error("E2E_ERROR", e);
  exit(2);
}
