// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare Workers entry (the "workerd" export condition).
 *
 * workerd forbids compiling WebAssembly from bytes at runtime, so the module
 * is imported as a pre-compiled `WebAssembly.Module` (wrangler's default rule
 * for `.wasm`) and instantiated synchronously. `getResampler()` works without
 * calling `initResampler()` first.
 */

import wasm from "../wasm/resampler.wasm";
import { engineFromModule, engineFromSource, type RubatoEngine } from "./engine.ts";
import { currentEngine, setEngine } from "./state.ts";

export * from "./engine.ts";

export type ResamplerSource = WebAssembly.Module | BufferSource | URL;

/** Instantiate the resampler (idempotent). Only a `WebAssembly.Module` source works on workerd. */
export async function initResampler(source?: ResamplerSource): Promise<RubatoEngine> {
  if (source === undefined) return getResampler();
  if (source instanceof URL) throw new Error("initResampler(URL) is not supported on workerd");
  return setEngine(await engineFromSource(source));
}

/** The shared engine, instantiated from the bundled module on first use. */
export function getResampler(): RubatoEngine {
  return currentEngine() ?? setEngine(engineFromModule(wasm));
}
