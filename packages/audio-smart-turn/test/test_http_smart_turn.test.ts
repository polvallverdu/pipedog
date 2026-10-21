// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** HttpSmartTurnAnalyzer against a local fake server (upstream has no test for it). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SmartTurnParams } from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { HttpSmartTurnAnalyzer, serializeNpy } from "../src/smart_turn/http_smart_turn.ts";

let server: ReturnType<typeof Bun.serve>;
let lastBody: Uint8Array | null = null;
let lastHeaders: Headers | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      lastBody = new Uint8Array(await req.arrayBuffer());
      lastHeaders = req.headers;
      if (path === "/ok") return Response.json({ prediction: 1, probability: 0.9 });
      if (path === "/500") return new Response("boom", { status: 500 });
      if (path === "/404") return new Response("nope", { status: 404 });
      if (path === "/text") return new Response("not json");
      if (path === "/slow") {
        await new Promise((r) => setTimeout(r, 1500));
        return Response.json({ prediction: 1, probability: 1 });
      }
      return new Response("?", { status: 400 });
    },
  });
});
afterAll(() => server.stop(true));

function analyzer(path: string, extra: Record<string, unknown> = {}) {
  return new HttpSmartTurnAnalyzer({
    url: `http://localhost:${server.port}${path}`,
    params: new SmartTurnParams({ stopSecs: 1 }),
    ...extra,
  });
}
const predict = (a: HttpSmartTurnAnalyzer, audio: Float32Array) =>
  (
    a as unknown as { _predictEndpoint(x: Float32Array): Promise<Record<string, unknown>> }
  )._predictEndpoint(audio);

describe("serializeNpy", () => {
  test("matches numpy's .npy v1.0 layout", () => {
    const out = serializeNpy(new Float32Array([1, 2, 3]));
    expect(Array.from(out.slice(0, 8))).toEqual([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
    const headerLen = new DataView(out.buffer).getUint16(8, true);
    expect((10 + headerLen) % 64).toBe(0);
    const header = new TextDecoder().decode(out.slice(10, 10 + headerLen));
    expect(header.startsWith("{'descr': '<f4', 'fortran_order': False, 'shape': (3,), }")).toBe(
      true,
    );
    expect(header.endsWith("\n")).toBe(true);
    const data = new Float32Array(out.slice(10 + headerLen).buffer);
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });
});

describe("HttpSmartTurnAnalyzer", () => {
  test("returns the service's prediction and sends npy with headers", async () => {
    const result = await predict(
      analyzer("/ok", { headers: { Authorization: "Bearer x" } }),
      new Float32Array([0.5, -0.5]),
    );
    expect(result.prediction).toBe(1);
    expect(result.probability).toBe(0.9);
    expect(lastHeaders?.get("content-type")).toBe("application/octet-stream");
    expect(lastHeaders?.get("authorization")).toBe("Bearer x");
    expect(lastBody?.slice(0, 6)).toEqual(new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]));
  });

  test("uses an injected fetch", async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ prediction: 1, probability: 0.5 });
    }) as typeof fetch;
    const result = await predict(
      new HttpSmartTurnAnalyzer({ url: "http://example.invalid/x", fetch: fake }),
      new Float32Array(4),
    );
    expect(calls).toEqual(["http://example.invalid/x"]);
    expect(result.prediction).toBe(1);
  });

  for (const path of ["/500", "/404", "/text"]) {
    test(`failure ${path} gives an incomplete prediction`, async () => {
      const result = await predict(analyzer(path), new Float32Array(4));
      expect(result.prediction).toBe(0);
      expect(result.probability).toBe(0);
    });
  }

  test("timeout after stopSecs gives an incomplete prediction", async () => {
    const result = await predict(analyzer("/slow"), new Float32Array(4));
    expect(result.prediction).toBe(0);
  });

  test("connection failure gives an incomplete prediction", async () => {
    const result = await predict(
      new HttpSmartTurnAnalyzer({ url: "http://127.0.0.1:1/x" }),
      new Float32Array(4),
    );
    expect(result.prediction).toBe(0);
  });
});
