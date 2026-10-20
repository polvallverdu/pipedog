// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Cloudflare Workers entry (the "workerd" export condition).
 *
 * workerd forbids compiling WebAssembly from bytes at runtime, so the module is
 * imported as a pre-compiled `WebAssembly.Module` (wrangler's default rule for
 * `.wasm`) and instantiated synchronously when this module loads.
 * `initSentencex()` accepts only a `WebAssembly.Module` here.
 */

import wasm from "../wasm/sentencex.wasm";
import { createApi } from "./api.ts";

export type { SentencexApi } from "./api.ts";
export { type SentenceBoundary, SentencexEngine } from "./engine.ts";

const api = createApi(() => wasm);
api.getSentencex();

/** Split `text` into sentences (sentencex rules for `language`, e.g. "en"). */
export const segment = api.segment;
/** Detailed sentence boundaries with JavaScript (UTF-16) string indices. */
export const getSentenceBoundaries = api.getSentenceBoundaries;
/** Alias with the `sentencex` npm package's name. */
export const get_sentence_boundaries = api.getSentenceBoundaries;
/** Replace the bundled module (a `WebAssembly.Module`; bytes cannot be compiled on workerd). */
export const initSentencex = api.initSentencex;
/** The shared engine. */
export const getSentencex = api.getSentencex;
