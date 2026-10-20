// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Default entry (Bun, Node >= 22, Deno, and bundlers).
 *
 * Fully synchronous: the WASM bytes are embedded in `wasm_bytes.ts` (base64)
 * and compiled with `new WebAssembly.Module()` on the first call.
 *
 * @example
 * ```ts
 * import { segment } from "@pipedog/sentencex-wasm";
 * segment("en", "Dr. Smith arrived at 5 p.m. He was late.");
 * // ["Dr. Smith arrived at 5 p.m. ", "He was late."]
 * ```
 *
 * On Cloudflare Workers the package resolves to `workerd.ts` instead (the
 * "workerd" export condition), which imports the .wasm as a module because
 * workerd cannot compile WASM from bytes.
 */

import { createApi } from "./api.ts";
import { compileSync } from "./engine.ts";
import { WASM_BASE64 } from "./wasm_bytes.ts";

export type { SentencexApi } from "./api.ts";
export { type SentenceBoundary, SentencexEngine } from "./engine.ts";

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> })
    .fromBase64;
  if (typeof fromBase64 === "function") return fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const api = createApi(() => compileSync(decodeBase64(WASM_BASE64)));

/** Split `text` into sentences (sentencex rules for `language`, e.g. "en"). */
export const segment = api.segment;
/** Detailed sentence boundaries with JavaScript (UTF-16) string indices. */
export const getSentenceBoundaries = api.getSentenceBoundaries;
/** Alias with the `sentencex` npm package's name. */
export const get_sentence_boundaries = api.getSentenceBoundaries;
/**
 * Compile and instantiate now (otherwise done on first use). Passing a
 * `WebAssembly.Module` or bytes replaces the bundled module.
 */
export const initSentencex = api.initSentencex;
/** The shared engine, instantiated on first use. */
export const getSentencex = api.getSentencex;
