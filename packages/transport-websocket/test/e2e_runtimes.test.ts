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
  runOriginCheck,
  runPair,
  SERVERS,
  type ServerKind,
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

  for (const s of ORIGIN_SERVERS) {
    test.skipIf(unavailable(s) !== null)(`${s} server rejects a disallowed Origin`, () => {
      const r = results.get(`origin:${s}`);
      if (!r?.ok) console.error(r?.detail);
      expect(r?.ok).toBe(true);
    });
  }
});
