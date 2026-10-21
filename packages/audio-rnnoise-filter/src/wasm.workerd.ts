// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare Workers loader (the "workerd" export condition).
 *
 * workerd forbids compiling WebAssembly from bytes at runtime, so the module
 * is imported as a pre-compiled `WebAssembly.Module` (wrangler's default rule
 * for `.wasm`) and instantiated synchronously. `initRnnoise()` needs no
 * argument; only a `WebAssembly.Module` source is accepted.
 */

import wasm from "../wasm/rnnoise.wasm";
import { engineFromModule, type RnnoiseEngine } from "./engine.ts";
import { currentEngine, setEngine } from "./state.ts";

export type RnnoiseSource = WebAssembly.Module;

/** Instantiate RNNoise (idempotent). Only a `WebAssembly.Module` source works on workerd. */
export async function initRnnoise(source?: RnnoiseSource): Promise<RnnoiseEngine> {
  if (source === undefined) return getRnnoise();
  if (!(source instanceof WebAssembly.Module)) {
    throw new Error("initRnnoise(): on workerd the source must be a WebAssembly.Module");
  }
  return setEngine(engineFromModule(source));
}

/** The shared engine, instantiated from the bundled module on first use. */
export function getRnnoise(): RnnoiseEngine {
  return currentEngine() ?? setEngine(engineFromModule(wasm));
}
