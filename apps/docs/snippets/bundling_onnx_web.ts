// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Sample for content/docs/deployment/bundling.mdx. Type-checked on every docs build; the same
// recipe runs, bundled, in examples/bundle-check.

// #region onnx-web
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import sileroPath from "@pipedog/audio-silero/silero_vad.onnx" with { type: "file" };
import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import smartTurnPath from "@pipedog/audio-smart-turn/smart-turn-v3.2-cpu.onnx" with {
  type: "file",
};
import { createOnnxBackend } from "@pipedog/onnx";
import * as ort from "onnxruntime-web";
import ortLoaderPath from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };
import ortWasmPath from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };

const here = (asset: string) => new URL(asset, import.meta.url);

// One WebAssembly backend for every model, with everything it loads inside the bundle.
const backend = createOnnxBackend({
  prefer: "web",
  web: { ort, wasmPaths: { mjs: here(ortLoaderPath), wasm: here(ortWasmPath) } },
});

export const vad = new SileroVADAnalyzer({ model: here(sileroPath), backend });
export const turnAnalyzer = createLocalSmartTurnAnalyzerV3({ model: here(smartTurnPath), backend });
// #endregion
