// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Cloudflare Workers backend: `onnxruntime-web` with its WebAssembly
 * imported as a module.
 *
 * workerd refuses to compile WebAssembly from bytes at runtime, and
 * onnxruntime-web always instantiates its .wasm from bytes (or a fetch). So:
 *
 * - `env.wasm.numThreads = 1` (no worker threads on Workers);
 * - `env.wasm.wasmBinary` is set to a placeholder, which makes onnxruntime-web
 *   skip fetching the .wasm and hand "the bytes" to `WebAssembly.instantiate`;
 * - during the first `InferenceSession.create`, `WebAssembly.instantiate` is
 *   replaced by a function that instantiates the module imported below
 *   (wrangler compiles `.wasm` imports ahead of time), then restored.
 *
 * This relies on onnxruntime-web internals, so the peer dependency is pinned
 * to the exact version the workerd smoke test runs against.
 *
 * Models are never bundled: pass their bytes (from R2, KV, static assets or a
 * `fetch`) or an `http(s):` URL.
 */

import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm";
import * as ortWeb from "onnxruntime-web/wasm";
import {
  type OnnxBackend,
  type OnnxSessionOptions,
  type OrtModuleLike,
  type OrtSessionLike,
  ortSessionOptions,
  wrapOrtSession,
} from "./backend.ts";
import { loadModelBytesWorkerd } from "./model.ts";
import { configureWebEnv } from "./web.ts";

export interface WorkerdBackendOptions {
  /** An already imported `onnxruntime-web` module (default: `onnxruntime-web/wasm`). */
  ort?: OrtModuleLike;
  /** The compiled `ort-wasm-simd-threaded.wasm` module matching `ort`. */
  wasmModule?: WebAssembly.Module;
}

/** Wasm placeholder that makes onnxruntime-web skip fetching its .wasm file. */
const WASM_PLACEHOLDER = new Uint8Array(8);

/** Create the onnxruntime-web backend for Cloudflare Workers. */
export async function createWorkerdBackend(
  options: WorkerdBackendOptions = {},
): Promise<OnnxBackend> {
  const ort = options.ort ?? (ortWeb as unknown as OrtModuleLike);
  const wasmModule = options.wasmModule ?? (ortWasm as WebAssembly.Module);
  configureWebEnv(ort);
  let initialized = false;

  const create = async (bytes: Uint8Array, opts: Record<string, unknown>) => {
    if (initialized) return ort.InferenceSession.create(bytes, opts);
    ort.env.wasm.wasmBinary = WASM_PLACEHOLDER;
    const original = WebAssembly.instantiate;
    const patched = (async (source: unknown, imports?: WebAssembly.Imports) => {
      if (source instanceof WebAssembly.Module) return original(source, imports);
      const instance = await original(wasmModule, imports);
      return { instance, module: wasmModule };
    }) as typeof WebAssembly.instantiate;
    WebAssembly.instantiate = patched;
    try {
      const session = await ort.InferenceSession.create(bytes, opts);
      initialized = true;
      return session;
    } finally {
      WebAssembly.instantiate = original;
    }
  };

  // Sessions are created one at a time, so only the first one sees the patch.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: "onnxruntime-web (workerd)",
    async createSession(model, sessionOptions: OnnxSessionOptions = {}) {
      const bytes = await loadModelBytesWorkerd(model);
      const opts = ortSessionOptions(sessionOptions, "wasm");
      const result = queue.then(() => create(bytes, opts));
      queue = result.catch(() => {});
      return wrapOrtSession(ort, (await result) as OrtSessionLike);
    },
  };
}
