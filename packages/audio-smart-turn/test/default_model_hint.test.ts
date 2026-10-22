// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** A bundled app has no `data/smart-turn-v3.2-cpu.onnx`: the error says how to pass the model. */

import { expect, test } from "bun:test";
import type { OnnxBackend } from "@pipedog/onnx";
import { createLocalSmartTurnAnalyzerV3, onnxSmartTurnSessionFactory } from "../src/index.ts";

function backendWithoutFile(): OnnxBackend {
  return {
    name: "fake",
    async createSession() {
      throw Object.assign(new Error("ENOENT: no such file or directory, open 'data/x.onnx'"), {
        code: "ENOENT",
      });
    },
  };
}

test("the default model's missing file names the model option and the file import", async () => {
  const analyzer = createLocalSmartTurnAnalyzerV3({
    backend: backendWithoutFile(),
    shareSession: false,
  });
  const session = (analyzer as unknown as { _session: Promise<unknown> })._session;
  const error = (await session.then(
    () => null,
    (e: Error) => e,
  )) as Error;
  expect(error.message).toContain("Pass the model yourself");
  expect(error.message).toContain(
    'import modelPath from "@pipedog/audio-smart-turn/smart-turn-v3.2-cpu.onnx" with { type: "file" }',
  );
  expect(error.message).toContain("createLocalSmartTurnAnalyzerV3({ model })");
});

test("a model that was passed keeps the original error", async () => {
  const create = onnxSmartTurnSessionFactory({
    backend: backendWithoutFile(),
    model: "/nowhere/model.onnx",
    shareSession: false,
  });
  await expect(create("x", {})).rejects.toThrow(/^ENOENT/);
});
