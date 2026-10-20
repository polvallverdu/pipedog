// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../../tools/compat/packages.ts";
import { runSmoke, workerdBin } from "../../../tools/compat/runners.ts";
import {
  createNativeBackend,
  createOnnxBackend,
  createWebBackend,
  float32Tensor,
  int64Tensor,
  loadModelBytes,
  loadModelBytesWorkerd,
  modelUrl,
  type OnnxBackend,
} from "../src/index.ts";

// y = x + x (float32), k2 = k + k (int64)
const TINY_MODEL = Uint8Array.from(
  atob(
    "CAgSB3BpcGVkb2c6ZgoOCgF4CgF4EgF5IgNBZGQKDwoBawoBaxICazIiA0FkZBIEdGlueVoQCgF4EgsKCQgBEgUKAxIBbloLCgFrEgYKBAgHEgBiEAoBeRILCgkIARIFCgMSAW5iDAoCazISBgoECAcSAEIECgAQDQ==",
  ),
  (c) => c.charCodeAt(0),
);

async function runTiny(backend: OnnxBackend, model: Parameters<OnnxBackend["createSession"]>[0]) {
  const session = await backend.createSession(model, {
    forceCpu: true,
    graphOptimizationLevel: "all",
  });
  expect(session.inputNames).toEqual(["x", "k"]);
  expect(session.outputNames).toEqual(["y", "k2"]);
  const out = await session.run({
    x: float32Tensor(Float32Array.of(1, 2.5, -3), [3]),
    k: int64Tensor(BigInt64Array.of(21n), []),
  });
  expect(out.y!.type).toBe("float32");
  expect(Array.from(out.y!.data as Float32Array)).toEqual([2, 5, -6]);
  expect(out.y!.dims).toEqual([3]);
  expect(out.k2!.type).toBe("int64");
  expect((out.k2!.data as BigInt64Array)[0]).toBe(42n);
  await session.dispose();
}

const dir = mkdtempSync(join(tmpdir(), "pipedog-onnx-"));
const modelPath = join(dir, "tiny.onnx");
writeFileSync(modelPath, TINY_MODEL);

describe("backends", () => {
  for (const [name, create] of [
    ["onnxruntime-node", createNativeBackend],
    ["onnxruntime-web", createWebBackend],
  ] as const) {
    test(`${name}: runs from bytes, ArrayBuffer, path and file: URL`, async () => {
      const backend = await create();
      expect(backend.name).toBe(name);
      await runTiny(backend, TINY_MODEL);
      await runTiny(backend, TINY_MODEL.slice().buffer);
      await runTiny(backend, modelPath);
      await runTiny(backend, pathToFileURL(modelPath));
      await runTiny(backend, pathToFileURL(modelPath).href);
    });
  }

  test("createOnnxBackend prefers onnxruntime-node and is shared", async () => {
    const a = await createOnnxBackend();
    expect(a.name).toBe("onnxruntime-node");
    expect(await createOnnxBackend()).toBe(a);
    expect((await createOnnxBackend({ prefer: "web" })).name).toBe("onnxruntime-web");
  });

  test("a missing model file rejects", async () => {
    const backend = await createWebBackend();
    await expect(backend.createSession(join(dir, "missing.onnx"))).rejects.toThrow();
  });
});

describe("model sources", () => {
  test("modelUrl tells URLs from paths", () => {
    expect(modelUrl("https://example.com/m.onnx")?.protocol).toBe("https:");
    expect(modelUrl("file:///tmp/m.onnx")?.protocol).toBe("file:");
    expect(modelUrl("/tmp/m.onnx")).toBeNull();
    expect(modelUrl("models/m.onnx")).toBeNull();
  });

  test("loadModelBytes reads paths and passes bytes through", async () => {
    expect(await loadModelBytes(TINY_MODEL)).toBe(TINY_MODEL);
    expect(await loadModelBytes(modelPath)).toEqual(TINY_MODEL);
  });

  test("on workerd, paths and file: URLs are refused with a hint", async () => {
    await expect(loadModelBytesWorkerd(modelPath)).rejects.toThrow(/pass the model bytes/);
    await expect(loadModelBytesWorkerd(pathToFileURL(modelPath))).rejects.toThrow(
      /pass the model bytes/,
    );
    expect(await loadModelBytesWorkerd(TINY_MODEL)).toBe(TINY_MODEL);
  });
});

// The workerd variant relies on onnxruntime-web internals (see src/workerd.ts):
// run the compat smoke test on a real workerd.
describe("workerd", () => {
  test.skipIf(!workerdBin())(
    "onnxruntime-web runs on workerd with the imported .wasm module",
    async () => {
      const result = await runSmoke(
        "workerd",
        join(ROOT, "packages/onnx/compat/smoke.ts"),
        "onnx-test",
      );
      expect(result.error).toBe("");
      expect(result.ok).toBe(true);
    },
    120_000,
  );
});
