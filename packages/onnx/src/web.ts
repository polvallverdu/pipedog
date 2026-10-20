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

export interface WebBackendOptions {
  /** An already imported `onnxruntime-web` module (else it is imported). */
  ort?: OrtModuleLike;
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
