// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Cross-runtime end-to-end runs of the WebSocket transports (see e2e/run.ts):
// each server (Bun.serve, Node `ws`, Deno.serve, Hono on each of them, a
// workerd Worker and Durable Object, upstream Pipecat) against each client
// (WebsocketClientTransport on Bun, Node and Deno, upstream Pipecat), with
// the protobuf serializer; and the server's Origin check on each runtime. Runtimes whose binary is missing are skipped;
// upstream runs when PIPEDOG_UPSTREAM_PYTHON names a Python with pipecat.

import { beforeAll, describe, expect, test } from "bun:test";

import {
  CLIENTS,
  type ClientKind,
  type E2EResult,
  freePort,
  type RunningServer,
  runOriginCheck,
  runPair,
  SERVERS,
  type ServerKind,
  startServer,
  unavailable,
} from "./e2e/run.ts";

const pairs: [ServerKind, ClientKind][] = [];
for (const s of SERVERS) {
  for (const c of CLIENTS) {
    if (!(s === "upstream" && c === "upstream")) pairs.push([s, c]);
  }
}

const results = new Map<string, E2EResult>();
const ORIGIN_SERVERS = ["bun", "node", "deno"] as const;
const TAKEN_PORT_SERVERS = ["bun", "node", "deno", "workerd"] as const;

describe("websocket transports end to end", () => {
  // All pairs at once: each is a pair of processes on its own port.
  beforeAll(async () => {
    await Promise.all([
      ...pairs.map(async ([s, c]) => {
        if (unavailable(s) ?? unavailable(c)) return;
        results.set(`${s}<-${c}`, await runPair(s, c));
      }),
      ...ORIGIN_SERVERS.map(async (s) => {
        if (unavailable(s)) return;
        results.set(`origin:${s}`, await runOriginCheck(s));
      }),
    ]);
  }, 60_000);

  for (const [s, c] of pairs) {
    const skip = unavailable(s) ?? unavailable(c);
    test.skipIf(skip !== null)(`${s} server <- ${c} client`, () => {
      const r = results.get(`${s}<-${c}`);
      if (!r?.ok) console.error(r?.detail);
      expect(r?.ok).toBe(true);
    });
  }

  // A port freePort() found free can be taken before the server binds it (by
  // another listener or an outgoing connection's source port). Startup must
  // notice and move to another port instead of failing the pair.
  for (const s of TAKEN_PORT_SERVERS) {
    test.skipIf(unavailable(s) !== null)(
      `${s} server moves to another port when its port was taken`,
      async () => {
        const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const ports = [holder.port];
        let srv: RunningServer | null = null;
        try {
          srv = await startServer(s, 20_000, {}, () => ports.shift() ?? freePort());
          expect(srv.uri).not.toContain(`:${holder.port}/`);
          expect(srv.proc.exited).toBe(false);
        } finally {
          srv?.proc.kill();
          holder.stop(true);
        }
      },
      30_000,
    );
  }

  for (const s of ORIGIN_SERVERS) {
    test.skipIf(unavailable(s) !== null)(`${s} server rejects a disallowed Origin`, () => {
      const r = results.get(`origin:${s}`);
      if (!r?.ok) console.error(r?.detail);
      expect(r?.ok).toBe(true);
    });
  }
});
