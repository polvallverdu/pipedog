// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The WebAssembly backend: `onnxruntime-web` (an optional peer dependency,
 * pinned to the version this package is tested with).
 *
 * Runs single-threaded, which needs no worker threads or SharedArrayBuffer and
 * keeps each inference on the caller's thread, as the models expect.
 */

import {
  type OnnxBackend,
  type OnnxSessionOptions,
  type OrtModuleLike,
  type OrtSessionLike,
  ortSessionOptions,
  wrapOrtSession,
} from "./backend.ts";
import { loadModelBytes } from "./model.ts";

// Held in a variable so bundlers leave the import alone (the package locates
// its .wasm file next to itself at runtime).
const ONNXRUNTIME_WEB = "onnxruntime-web";

/** Where onnxruntime-web finds its WebAssembly module and the `.mjs` loader next to it. */
export interface WebWasmPaths {
  /** The loader, `ort-wasm-simd-threaded.mjs` (a `file:` or `http(s):` URL, or an absolute path). */
  mjs: string | URL;
  /** The module, `ort-wasm-simd-threaded.wasm`. */
  wasm: string | URL;
}

export interface WebBackendOptions {
  /**
   * An already imported `onnxruntime-web` module (else it is imported by name at run time).
   * Import it yourself, with `import * as ort from "onnxruntime-web"`, for a bundler to include
   * it in the bundle.
   */
  ort?: OrtModuleLike;
  /**
   * Where onnxruntime-web loads its `.mjs` loader and `.wasm` module from. By default it looks
   * next to its own script, which does not exist after bundling: import both files with
   * `with { type: "file" }` and pass them here (see the Bundling guide).
   */
  wasmPaths?: WebWasmPaths;
}

/** Import `onnxruntime-web`, or throw a helpful error if it is not installed. */
export async function importOnnxruntimeWeb(): Promise<OrtModuleLike> {
  try {
    const mod = (await import(ONNXRUNTIME_WEB)) as OrtModuleLike & { default?: OrtModuleLike };
    return mod.InferenceSession ? mod : (mod.default as OrtModuleLike);
  } catch (e) {
    throw new Error(
      `onnxruntime-web is not installed (${e instanceof Error ? e.message : String(e)}); ` +
        "add it with `bun add onnxruntime-web@1.30.0` / `npm i onnxruntime-web@1.30.0`",
    );
  }
}

/** Configure onnxruntime-web for single-threaded WASM inference. */
export function configureWebEnv(ort: OrtModuleLike): void {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

/** Create the `onnxruntime-web` backend. */
export async function createWebBackend(options: WebBackendOptions = {}): Promise<OnnxBackend> {
  const ort = options.ort ?? (await importOnnxruntimeWeb());
  configureWebEnv(ort);
  if (options.wasmPaths) {
    ort.env.wasm.wasmPaths = {
      mjs: String(options.wasmPaths.mjs),
      wasm: String(options.wasmPaths.wasm),
    };
  }
  return {
    name: "onnxruntime-web",
    async createSession(model, sessionOptions: OnnxSessionOptions = {}) {
      const bytes = await loadModelBytes(model);
      const session = (await ort.InferenceSession.create(
        bytes,
        ortSessionOptions(sessionOptions, "wasm"),
      )) as OrtSessionLike;
      return wrapOrtSession(ort, session);
    },
  };
}
