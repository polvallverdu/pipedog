// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Default WASM loader (Bun, Node >= 22, Deno, bundlers).
 *
 * Reads `wasm/rnnoise.wasm` next to this package (or takes bytes, a URL, a
 * `Response` or a compiled module) and compiles it. On Cloudflare Workers the
 * package resolves to `wasm.workerd.ts` instead (the "workerd" export
 * condition of `@pipedog/audio-rnnoise-filter/wasm`), because workerd refuses
 * to compile WebAssembly from bytes: there the `.wasm` is imported as a module.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { engineFromModule, type RnnoiseEngine } from "./engine.ts";
import { currentEngine, initOnce, setEngine } from "./state.ts";

export type RnnoiseSource = WebAssembly.Module | BufferSource | URL | Response;

// Resolved lazily: in a Worker bundle `import.meta.url` is not a valid base.
function defaultWasmUrl(): URL {
  return new URL("../wasm/rnnoise.wasm", import.meta.url);
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

async function load(source: RnnoiseSource | undefined): Promise<RnnoiseEngine> {
  let module: WebAssembly.Module;
  if (source instanceof WebAssembly.Module) {
    module = source;
  } else {
    let bytes: BufferSource;
    if (source === undefined) {
      try {
        bytes = await readUrl(defaultWasmUrl());
      } catch (e) {
        rethrowIfCancelled(e);
        // A bundler does not copy the file the package reads next to its own source.
        throw new Error(
          `Could not read the RNNoise module that ships with the package (${e instanceof Error ? e.message : String(e)}). ` +
            "That happens when the app is bundled: the bundle does not include the .wasm file. " +
            "Load it yourself before creating the filter. With `bun build` (also `--compile`):\n" +
            '  import wasmPath from "@pipedog/audio-rnnoise-filter/rnnoise.wasm" with { type: "file" };\n' +
            // Not one literal: the compat harness rewrites `import.meta.url` in sources.
            `  await initRnnoise(new URL(wasmPath, ${"import.meta"}.url));\n` +
            "(bytes, a compiled WebAssembly.Module or a Response work too).",
          { cause: e },
        );
      }
    } else if (source instanceof URL) bytes = await readUrl(source);
    else if (typeof Response !== "undefined" && source instanceof Response)
      bytes = await source.arrayBuffer();
    else bytes = source as BufferSource;
    module = await WebAssembly.compile(bytes);
  }
  return engineFromModule(module);
}

/**
 * Load and instantiate RNNoise (idempotent). With no argument the bundled
 * `wasm/rnnoise.wasm` is read. Passing a source replaces the shared engine.
 */
export async function initRnnoise(source?: RnnoiseSource): Promise<RnnoiseEngine> {
  if (source !== undefined) return setEngine(await load(source));
  return initOnce(() => load(undefined));
}

/** The engine set up by `initRnnoise()`. Throws if it has not been awaited yet. */
export function getRnnoise(): RnnoiseEngine {
  const engine = currentEngine();
  if (!engine) throw new Error("call `await initRnnoise()` before using RNNoise");
  return engine;
}
