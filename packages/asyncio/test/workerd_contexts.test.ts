// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// On Cloudflare Workers, one isolate serves many requests and Durable Objects
// at once, and each can only do I/O on its own objects. Loop callbacks must run
// in the I/O context that scheduled them, even when several sessions have
// callbacks ready at the same time. Runs the Worker in
// fixtures/workerd_contexts.ts on a real workerd.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { OUT_ROOT, workerdBin } from "../../../tools/compat/runners.ts";

const MESSAGES = 300;
const bin = workerdBin();

let proc: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

beforeAll(async () => {
  if (!bin) return;
  mkdirSync(OUT_ROOT, { recursive: true });
  const dir = mkdtempSync(join(OUT_ROOT, "asyncio-contexts-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "workerd_contexts.ts")],
    outdir: dir,
    naming: "worker.mjs",
    target: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
  });
  if (!build.success) throw new AggregateError(build.logs, "bundling the Worker failed");

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  port = probe.port;
  probe.stop(true);
  await Bun.write(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);

const worker :Workerd.Worker = (
  modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
  durableObjectNamespaces = [(className = "Session", uniqueKey = "session")],
  durableObjectStorage = (inMemory = void),
  bindings = [(name = "SESSION", durableObjectNamespace = "Session")],
  compatibilityDate = "2026-10-01",
  compatibilityFlags = ["nodejs_compat"],
);
`,
  );
  proc = Bun.spawn([bin, "serve", "config.capnp"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("workerd did not start");
}, 30_000);

afterAll(() => {
  proc?.kill();
});

interface SessionResult {
  echoed: number;
  failures: number;
  firstFailure: string;
}

/** Stream MESSAGES messages to a session, a few at a time, and count the echoes. */
function runSession(query: string): Promise<SessionResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    let echoed = 0;
    ws.onopen = async () => {
      for (let i = 0; i < MESSAGES; i++) {
        ws.send(String(i));
        if (i % 5 === 4) await Bun.sleep(1);
      }
      ws.send("end");
    };
    ws.onmessage = (event) => {
      const data = String(event.data);
      if (data.startsWith("{")) {
        const report = JSON.parse(data) as { failures: number; firstFailure: string };
        resolve({ echoed, ...report });
      } else {
        echoed++;
      }
    };
    ws.onerror = () => reject(new Error(`session ${query} failed`));
  });
}

describe.skipIf(!bin)("workerd", () => {
  test("callbacks of parallel Durable Objects run in their own object", async () => {
    const results = await Promise.all([runSession("?id=a"), runSession("?id=b")]);
    for (const result of results) {
      expect(result).toEqual({ echoed: MESSAGES, failures: 0, firstFailure: "" });
    }
  }, 30_000);

  test("callbacks of parallel requests run in their own request", async () => {
    const results = await Promise.all([runSession(""), runSession("")]);
    for (const result of results) {
      expect(result).toEqual({ echoed: MESSAGES, failures: 0, firstFailure: "" });
    }
  }, 30_000);
});
