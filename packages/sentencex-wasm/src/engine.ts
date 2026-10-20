// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Hand-written wrapper over the sentencex WebAssembly exports.
 *
 * The module has no imports and a tiny C ABI (see `rust/src/lib.rs`), so there
 * is no generated glue: we copy the UTF-8 language code and text into linear
 * memory, call `sx_segment` / `sx_boundaries`, and read back u32 records of
 * UTF-16 offsets that index the caller's original string. Everything here is
 * synchronous.
 */

/** One sentence boundary, as in the `sentencex` npm package's typings. */
export interface SentenceBoundary {
  /** UTF-16 index (JavaScript string index) where the sentence starts. */
  start_index: number;
  /** UTF-16 index (JavaScript string index) where the sentence ends (exclusive). */
  end_index: number;
  /** The sentence text. */
  text: string;
  /** Punctuation mark that ended the sentence, or null if none. */
  boundary_symbol: string | null;
  /** Whether this boundary represents a paragraph break ("\n\n"). */
  is_paragraph_break: boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  sx_alloc(len: number): number;
  sx_free(ptr: number, len: number): void;
  sx_out(): number;
  sx_segment(lang: number, langLen: number, text: number, textLen: number): number;
  sx_boundaries(lang: number, langLen: number, text: number, textLen: number): number;
}

const BOUNDARY_FIELDS = 7;
const NONE = 0xffffffff;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function instantiate(module: WebAssembly.Module): Exports {
  const x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  if (typeof x.sx_segment !== "function") {
    throw new Error("not the @pipedog/sentencex-wasm module");
  }
  return x;
}

/**
 * One instantiated sentencex module. All methods are synchronous.
 *
 * If the WASM code traps (a Rust panic), the instance is discarded and a fresh
 * one is created from the same module on the next call.
 */
export class SentencexEngine {
  readonly module: WebAssembly.Module;
  #x: Exports;

  constructor(module: WebAssembly.Module) {
    this.module = module;
    this.#x = instantiate(module);
  }

  /** Current size of the instance's linear memory, in bytes (it grows, never shrinks). */
  get memoryBytes(): number {
    return this.#x.memory.buffer.byteLength;
  }

  /** Split `text` into sentences. Concatenating the result gives back `text`. */
  segment(language: string, text: string): string[] {
    return this.#call(language, text, false, (x, n) => {
      const rec = new Uint32Array(x.memory.buffer, x.sx_out(), n * 2);
      const out = new Array<string>(n);
      for (let i = 0; i < n; i++) out[i] = text.slice(rec[2 * i], rec[2 * i + 1]);
      return out;
    });
  }

  /** Detailed sentence boundaries, with JavaScript (UTF-16) string indices. */
  getSentenceBoundaries(language: string, text: string): SentenceBoundary[] {
    return this.#call(language, text, true, (x, n) => {
      const rec = new Uint32Array(x.memory.buffer, x.sx_out(), n * BOUNDARY_FIELDS);
      const bytes = new Uint8Array(x.memory.buffer);
      const out = new Array<SentenceBoundary>(n);
      for (let i = 0; i < n; i++) {
        const r = i * BOUNDARY_FIELDS;
        const symLen = rec[r + 5]!;
        out[i] = {
          start_index: rec[r]!,
          end_index: rec[r + 1]!,
          text: text.slice(rec[r + 2], rec[r + 3]),
          boundary_symbol:
            symLen === NONE
              ? null
              : decoder.decode(bytes.subarray(rec[r + 4], rec[r + 4]! + symLen)),
          is_paragraph_break: rec[r + 6] !== 0,
        };
      }
      return out;
    });
  }

  #call<T>(
    language: string,
    text: string,
    boundaries: boolean,
    read: (x: Exports, n: number) => T,
  ): T {
    if (typeof language !== "string" || typeof text !== "string") {
      throw new TypeError("language and text must be strings");
    }
    const x = this.#x;
    // UTF-8 needs at most 3 bytes per UTF-16 code unit.
    const langCap = language.length * 3;
    const cap = langCap + text.length * 3;
    let ptr = 0;
    try {
      ptr = x.sx_alloc(cap);
      // Views are created after the alloc: a memory.grow detaches the old buffer.
      const mem = new Uint8Array(x.memory.buffer);
      const lang = encoder.encodeInto(language, mem.subarray(ptr, ptr + langCap)).written;
      const textPtr = ptr + langCap;
      const textLen = encoder.encodeInto(text, mem.subarray(textPtr, ptr + cap)).written;
      const n = boundaries
        ? x.sx_boundaries(ptr, lang, textPtr, textLen)
        : x.sx_segment(ptr, lang, textPtr, textLen);
      if (n < 0) throw new Error(`sentencex failed (code ${n})`);
      // Read before freeing: boundary symbols point into the input buffer.
      const result = read(x, n);
      x.sx_free(ptr, cap);
      return result;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        // A trap leaves the instance in an unknown state; start over next time.
        this.#x = instantiate(this.module);
      } else if (ptr !== 0) {
        x.sx_free(ptr, cap);
      }
      throw e;
    }
  }
}

/** Compile WASM bytes synchronously (not allowed on Cloudflare Workers). */
export function compileSync(source: WebAssembly.Module | BufferSource): WebAssembly.Module {
  return source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
}
