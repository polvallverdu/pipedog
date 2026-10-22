// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (a), everything in the bundle: onnxruntime-web (WebAssembly) instead of
// onnxruntime-node, with its loader and module, and both models, as
// `with { type: "file" }` imports. Nothing is installed next to the bundle, and it also
// works with `bun build --compile`.

import { createOnnxBackend } from "@pipedog/onnx";
import * as ort from "onnxruntime-web";
import ortLoader from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };
import sileroPath from "../../../packages/audio-silero/data/silero_vad.onnx" with { type: "file" };
import smartTurnPath from "../../../packages/audio-smart-turn/data/smart-turn-v3.2-cpu.onnx" with {
  type: "file",
};
import { checkWebsocketBot } from "./ws_check.ts";

const here = (asset: string) => new URL(asset, import.meta.url);

// One backend for both models.
const backend = createOnnxBackend({
  prefer: "web",
  web: { ort: ort as never, wasmPaths: { mjs: here(ortLoader), wasm: here(ortWasm) } },
});

await checkWebsocketBot({
  sileroModel: here(sileroPath),
  smartTurnModel: here(smartTurnPath),
  explicitSmartTurn: true,
  backend,
});
