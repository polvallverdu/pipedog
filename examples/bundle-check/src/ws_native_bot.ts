// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (a), bundled with onnxruntime-node left external: the models are
// `with { type: "file" }` imports, and Smart Turn is passed to the turn strategy so the
// bundler sees it. `onnxruntime-node` is a native addon: it stays out of the bundle
// (`--external onnxruntime-node`) and is installed next to it. Does not work with
// `bun build --compile`, which cannot load an external from node_modules.

import sileroPath from "../../../packages/audio-silero/data/silero_vad.onnx" with { type: "file" };
import smartTurnPath from "../../../packages/audio-smart-turn/data/smart-turn-v3.2-cpu.onnx" with {
  type: "file",
};
import { checkWebsocketBot } from "./ws_check.ts";

await checkWebsocketBot({
  sileroModel: new URL(sileroPath, import.meta.url),
  smartTurnModel: new URL(smartTurnPath, import.meta.url),
  explicitSmartTurn: true,
});
