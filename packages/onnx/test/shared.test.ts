// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterEach, describe, expect, test } from "bun:test";
import type { OnnxBackend, OnnxSession, OnnxTensor } from "../src/backend.ts";
import { disposeSharedSessions, sharedSession } from "../src/shared.ts";

/** A backend that counts sessions, and records how many runs overlap. */
function fakeBackend(name: string) {
  const stats = { created: 0, disposed: 0, active: 0, maxActive: 0, fail: false };
  const backend: OnnxBackend = {
    name,
    async createSession() {
      if (stats.fail) throw new Error("load failed");
      stats.created++;
      const session: OnnxSession = {
        inputNames: ["x"],
        outputNames: ["y"],
        async run(feeds: Record<string, OnnxTensor>) {
          stats.active++;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          stats.active--;
          return { y: feeds.x! };
        },
        async dispose() {
          stats.disposed++;
        },
      };
      return session;
    },
  };
  return { backend, stats };
}

const feed = { x: { type: "float32" as const, data: new Float32Array([1]), dims: [1] } };

afterEach(() => disposeSharedSessions());

describe("sharedSession", () => {
  test("one session per backend, model and options", async () => {
    const { backend, stats } = fakeBackend("onnxruntime-web");
    const a = await sharedSession(backend, "model.onnx", { forceCpu: true });
    const b = await sharedSession(backend, new URL("file:///x/model.onnx"), { forceCpu: true });
    const c = await sharedSession(backend, "model.onnx", { forceCpu: true });
    const d = await sharedSession(backend, "model.onnx", { forceCpu: false });
    expect(c).toBe(a);
    expect(b).not.toBe(a);
    expect(d).not.toBe(a);
    expect(stats.created).toBe(3);
  });

  test("bytes are keyed by the object passed in", async () => {
    const { backend, stats } = fakeBackend("onnxruntime-web");
    const bytes = new Uint8Array(4);
    const a = await sharedSession(backend, bytes);
    expect(await sharedSession(backend, bytes)).toBe(a);
    expect(await sharedSession(backend, new Uint8Array(4))).not.toBe(a);
    expect(stats.created).toBe(2);
  });

  test("option order doesn't matter", async () => {
    const { backend, stats } = fakeBackend("onnxruntime-web");
    await sharedSession(backend, "m", { intraOpNumThreads: 1, forceCpu: true });
    await sharedSession(backend, "m", { forceCpu: true, intraOpNumThreads: 1 });
    expect(stats.created).toBe(1);
  });

  test("runs are serialized on onnxruntime-web, concurrent on onnxruntime-node", async () => {
    const web = fakeBackend("onnxruntime-web");
    const webSession = await sharedSession(web.backend, "m");
    await Promise.all([webSession.run(feed), webSession.run(feed), webSession.run(feed)]);
    expect(web.stats.maxActive).toBe(1);

    const native = fakeBackend("onnxruntime-node");
    const nativeSession = await sharedSession(native.backend, "m");
    await Promise.all([nativeSession.run(feed), nativeSession.run(feed), nativeSession.run(feed)]);
    expect(native.stats.maxActive).toBe(3);
  });

  test("a caller's dispose() keeps the shared session; disposeSharedSessions() releases it", async () => {
    const { backend, stats } = fakeBackend("onnxruntime-web");
    const session = await sharedSession(backend, "m");
    await session.dispose();
    expect(stats.disposed).toBe(0);
    await disposeSharedSessions();
    expect(stats.disposed).toBe(1);
    // A later call loads the model again.
    await sharedSession(backend, "m");
    expect(stats.created).toBe(2);
  });

  test("a failed load isn't cached", async () => {
    const { backend, stats } = fakeBackend("onnxruntime-web");
    stats.fail = true;
    await expect(sharedSession(backend, "m")).rejects.toThrow("load failed");
    stats.fail = false;
    await sharedSession(backend, "m");
    expect(stats.created).toBe(1);
  });
});
