// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Default entry (Bun, Node >= 22, Deno, browsers via a bundler).
 *
 * `await initResampler()` once, then everything is synchronous:
 *
 * @example
 * ```ts
 * import { initResampler } from "@pipecat-ts/resampler-wasm";
 * const engine = await initResampler();
 * const out = engine.resample(pcm16, 8000, 16000, { quality: "VHQ" });
 * ```
 *
 * On Cloudflare Workers the package resolves to `workerd.ts` instead (the
 * "workerd" export condition), which imports the .wasm as a module because
 * workerd cannot compile WASM from bytes.
 */

import { engineFromSource, type RubatoEngine } from "./engine.ts";
import { currentEngine, initOnce, setEngine } from "./state.ts";

export * from "./engine.ts";

export type ResamplerSource = WebAssembly.Module | BufferSource | URL | Response;

// Resolved lazily: in a Worker bundle `import.meta.url` is not a valid base, so
// building the URL at module load would crash any import of this entry there.
function defaultWasmUrl(): URL {
  return new URL("../wasm/resampler.wasm", import.meta.url);
}

async function readUrl(url: URL): Promise<BufferSource> {
  if (url.protocol === "file:") {
    // Bun and Deno fetch file: URLs; Node's fetch does not, so fall back to fs.
    try {
      const res = await fetch(url);
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // fall through to node:fs
    }
    // A variable specifier keeps bundlers (and type checkers without @types/node) out of it.
    const specifier = "node:fs/promises";
    const fs = (await import(specifier)) as { readFile(path: URL): Promise<Uint8Array> };
    return (await fs.readFile(url)) as Uint8Array<ArrayBuffer>;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url.href}: ${res.status}`);
  return await res.arrayBuffer();
}

async function load(source: ResamplerSource | undefined): Promise<RubatoEngine> {
  if (source === undefined) return engineFromSource(await readUrl(defaultWasmUrl()));
  if (source instanceof URL) return engineFromSource(await readUrl(source));
  if (typeof Response !== "undefined" && source instanceof Response) {
    return engineFromSource(await source.arrayBuffer());
  }
  return engineFromSource(source as WebAssembly.Module | BufferSource);
}

/**
 * Load and instantiate the WASM resampler (idempotent). With no argument the
 * bundled `wasm/resampler.wasm` is loaded next to this file. Passing a source
 * replaces the shared engine.
 */
export async function initResampler(source?: ResamplerSource): Promise<RubatoEngine> {
  if (source !== undefined) return setEngine(await load(source));
  return initOnce(() => load(undefined));
}

/** The engine set up by `initResampler()`. Throws if it has not been awaited yet. */
export function getResampler(): RubatoEngine {
  const engine = currentEngine();
  if (!engine) throw new Error("call `await initResampler()` before using the resampler");
  return engine;
}
