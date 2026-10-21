// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// serveFetch and websocketFetchHandler upgrading WebSockets on each runtime's
// own server: Bun (server.upgrade + bunWebSocket), Node (http + ws) and Deno
// (Deno.upgradeWebSocket). Each runs test/fixtures/serve_fetch_echo.ts in a
// child process; Node and Deno are skipped when not installed.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ServerWebSocketBridge, upgradeWebSocket } from "../src/fetch.ts";

const PKG = join(import.meta.dir, "..");
const FIXTURE = "test/fixtures/serve_fetch_echo.ts";

const RUNTIMES: [string, string[] | null][] = [
  ["bun", [process.execPath, FIXTURE]],
  ["node", Bun.which("node") ? [Bun.which("node")!, FIXTURE] : null],
  ["deno", Bun.which("deno") ? [Bun.which("deno")!, "run", "-A", FIXTURE] : null],
];

async function start(cmd: string[]): Promise<{ port: number; proc: ReturnType<typeof Bun.spawn> }> {
  const proc = Bun.spawn(cmd, { cwd: PKG, stdout: "pipe", stderr: "inherit" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  const deadline = Date.now() + 30_000;
  while (!/listening \d+/.test(out) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const match = /listening (\d+)/.exec(out);
  if (!match) {
    proc.kill();
    throw new Error(`server did not start: ${out}`);
  }
  return { port: Number(match[1]), proc };
}

for (const [runtime, cmd] of RUNTIMES) {
  describe.skipIf(!cmd)(`serveFetch on ${runtime}`, () => {
    test("serves HTTP and upgrades a WebSocket through websocketFetchHandler", async () => {
      const { port, proc } = await start(cmd!);
      try {
        const http = await fetch(`http://127.0.0.1:${port}/hello`, { method: "POST", body: "x" });
        expect(await http.text()).toBe("hello POST");

        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.binaryType = "arraybuffer";
        const received: unknown[] = [];
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => {
            ws.send("ping");
            ws.send(new Uint8Array([1, 2, 3]));
          });
          ws.addEventListener("message", (event) => {
            received.push(event.data);
            if (received.length === 2) resolve();
          });
          ws.addEventListener("error", () => reject(new Error("websocket error")));
        });
        expect(received[0]).toBe("echo:ping");
        expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
        const closed = new Promise<number>((resolve) =>
          ws.addEventListener("close", (event) => resolve(event.code)),
        );
        ws.close(1000);
        expect(await closed).toBe(1000);
      } finally {
        proc.kill();
      }
    }, 60_000);
  });
}

describe("upgradeWebSocket with a server", () => {
  test("upgrades with the server and bridges its events to a standard socket", () => {
    let data: unknown = null;
    const server = {
      upgrade(_request: Request, options?: { data?: unknown }) {
        data = options?.data;
        return true;
      },
    };
    const { response, socket } = upgradeWebSocket(new Request("http://x/ws"), { server });
    expect(response.status).toBe(101);
    expect(socket).toBeInstanceOf(ServerWebSocketBridge);
    expect(socket.readyState).toBe(0);
    expect(data).not.toBeNull();

    const bridge = socket as ServerWebSocketBridge;
    const events: string[] = [];
    bridge.addEventListener("open", () => events.push("open"));
    bridge.addEventListener("message", (e) => events.push(`message:${e.data}`));
    bridge.addEventListener("close", (e) => events.push(`close:${e.code}`));
    const sent: unknown[] = [];
    bridge._open({ send: (d) => sent.push(d), close: () => {} });
    bridge.send("hi");
    bridge._message("yo");
    bridge._close(1000, "");
    expect(events).toEqual(["open", "message:yo", "close:1000"]);
    expect(sent).toEqual(["hi"]);
  });

  test("throws when the server refuses the upgrade", () => {
    expect(() =>
      upgradeWebSocket(new Request("http://x/ws"), { server: { upgrade: () => false } }),
    ).toThrow("refused");
  });
});
