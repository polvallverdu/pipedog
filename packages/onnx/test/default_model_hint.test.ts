// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { CancelledError } from "@pipedog/asyncio";
import { createOnnxBackend, createWebBackend, withDefaultModelHint } from "../src/index.ts";

const info = {
  what: "the Test model",
  specifier: "@pipedog/test/test.onnx",
  usage: "`new Test({ model })`",
};

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory, open '/x/data/test.onnx'"), {
    code: "ENOENT",
  });
}

describe("withDefaultModelHint", () => {
  test("a missing file becomes an error that names the option and the recipe", async () => {
    const error = await withDefaultModelHint(async () => {
      throw enoent();
    }, info).catch((e) => e as Error);
    expect(error.message).toContain("the Test model");
    expect(error.message).toContain("Pass the model yourself");
    expect(error.message).toContain(
      'import modelPath from "@pipedog/test/test.onnx" with { type: "file" }',
    );
    expect(error.message).toContain("new Test({ model })");
    expect((error.cause as Error).message).toContain("ENOENT");
  });

  test("other failures pass through", async () => {
    const cause = new Error("the model is corrupt");
    await expect(
      withDefaultModelHint(async () => {
        throw cause;
      }, info),
    ).rejects.toBe(cause);
  });

  test("cancellation passes through", async () => {
    await expect(
      withDefaultModelHint(async () => {
        throw new CancelledError();
      }, info),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  test("a result passes through", async () => {
    expect(await withDefaultModelHint(async () => 42, info)).toBe(42);
  });
});

describe("web backend options for bundled apps", () => {
  test("wasmPaths are set on the module that was passed in", async () => {
    const env = { wasm: {} as Record<string, unknown> };
    const ort = { env, InferenceSession: {}, Tensor: class {} };
    await createWebBackend({
      ort: ort as never,
      wasmPaths: {
        mjs: new URL("file:///app/ort.mjs"),
        wasm: "file:///app/ort.wasm",
      },
    });
    expect(env.wasm.wasmPaths).toEqual({
      mjs: "file:///app/ort.mjs",
      wasm: "file:///app/ort.wasm",
    });
    expect(env.wasm.numThreads).toBe(1);
  });

  test("createOnnxBackend passes web options to the web backend and skips the shared one", async () => {
    const env = { wasm: {} as Record<string, unknown> };
    const ort = { env, InferenceSession: {}, Tensor: class {} };
    const backend = await createOnnxBackend({ prefer: "web", web: { ort: ort as never } });
    expect(backend.name).toBe("onnxruntime-web");
    expect(await createOnnxBackend({ prefer: "web", web: { ort: ort as never } })).not.toBe(
      backend,
    );
  });
});
