// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs inference with a tiny model (y = x + x,
// k2 = k + k) on every backend the runtime has. On workerd the "workerd" export
// condition selects the onnxruntime-web variant that instantiates the imported
// .wasm module.

import {
  createNativeBackend,
  createOnnxBackend,
  createWebBackend,
  float32Tensor,
  int64Tensor,
  type OnnxBackend,
} from "@pipedog/onnx";

const TINY_MODEL =
  "CAgSB3BpcGVkb2c6ZgoOCgF4CgF4EgF5IgNBZGQKDwoBawoBaxICazIiA0FkZBIEdGlueVoQCgF4EgsKCQgBEgUKAxIBbloLCgFrEgYKBAgHEgBiEAoBeRILCgkIARIFCgMSAW5iDAoCazISBgoECAcSAEIECgAQDQ==";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`onnx smoke: ${message}`);
}

async function infer(backend: OnnxBackend): Promise<void> {
  const model = Uint8Array.from(atob(TINY_MODEL), (c) => c.charCodeAt(0));
  const session = await backend.createSession(model, { forceCpu: true, intraOpNumThreads: 1 });
  check(session.inputNames.join() === "x,k", `${backend.name} inputs ${session.inputNames}`);
  const out = await session.run({
    x: float32Tensor(Float32Array.of(1, 2.5, -3), [3]),
    k: int64Tensor(BigInt64Array.of(21n), []),
  });
  check(Array.from(out.y!.data as Float32Array).join() === "2,5,-6", `${backend.name} y`);
  check((out.k2!.data as BigInt64Array)[0] === 42n, `${backend.name} k2`);
  await session.dispose();
}

export default async function smoke(): Promise<void> {
  const isWorkerd = globalThis.navigator?.userAgent === "Cloudflare-Workers";
  await infer(await createOnnxBackend());
  if (isWorkerd) {
    // The second session must not need the instantiate patch any more.
    await infer(await createWebBackend());
    return;
  }
  await infer(await createNativeBackend());
  await infer(await createWebBackend());
}
