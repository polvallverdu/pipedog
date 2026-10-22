// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** A bundled app has no `data/silero_vad.onnx`: the error says how to pass the model. */

import { expect, test } from "bun:test";
import type { OnnxBackend } from "@pipedog/onnx";
import { SileroVADAnalyzer } from "../src/silero.ts";

function backendWithoutFile(): OnnxBackend {
  return {
    name: "fake",
    async createSession() {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, open 'data/silero_vad.onnx'"),
        {
          code: "ENOENT",
        },
      );
    },
  };
}

async function loadError(
  options: ConstructorParameters<typeof SileroVADAnalyzer>[0],
): Promise<Error> {
  const analyzer = new SileroVADAnalyzer({ shareSession: false, ...options });
  const model = (analyzer as unknown as { _model: { session: Promise<unknown> } })._model;
  return (await model.session.then(
    () => null,
    (e: Error) => e,
  )) as Error;
}

test("the default model's missing file names the model option and the file import", async () => {
  const error = await loadError({ backend: backendWithoutFile() });
  expect(error.message).toContain("Pass the model yourself");
  expect(error.message).toContain(
    'import modelPath from "@pipedog/audio-silero/silero_vad.onnx" with { type: "file" }',
  );
  expect(error.message).toContain("new SileroVADAnalyzer({ model })");
});

test("a model that was passed keeps the original error", async () => {
  const error = await loadError({ backend: backendWithoutFile(), model: "/nowhere/silero.onnx" });
  expect(error.message).toStartWith("ENOENT");
});
