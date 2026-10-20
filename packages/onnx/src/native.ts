// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The native backend: `onnxruntime-node` (an optional peer dependency).
 *
 * Fastest on Bun, Node and Deno. The package is large (it ships native
 * binaries for every platform), so it is never installed for you.
 */

import {
  type OnnxBackend,
  type OnnxSessionOptions,
  type OrtModuleLike,
  type OrtSessionLike,
  ortSessionOptions,
  wrapOrtSession,
} from "./backend.ts";
import { isModelBytes, loadModelBytes, modelUrl } from "./model.ts";

// Held in a variable so bundlers leave the import alone: the native addon must
// be loaded from node_modules at runtime.
const ONNXRUNTIME_NODE = "onnxruntime-node";

export interface NativeBackendOptions {
  /** An already imported `onnxruntime-node` module (else it is imported). */
  ort?: OrtModuleLike;
}

/** Import `onnxruntime-node`, or throw a helpful error if it is not installed. */
export async function importOnnxruntimeNode(): Promise<OrtModuleLike> {
  try {
    const mod = (await import(ONNXRUNTIME_NODE)) as OrtModuleLike & { default?: OrtModuleLike };
    return mod.InferenceSession ? mod : (mod.default as OrtModuleLike);
  } catch (e) {
    throw new Error(
      `onnxruntime-node is not installed (${e instanceof Error ? e.message : String(e)}); ` +
        "add it with `bun add onnxruntime-node` / `npm i onnxruntime-node`, or use the web backend",
    );
  }
}

/** Create the `onnxruntime-node` backend. */
export async function createNativeBackend(
  options: NativeBackendOptions = {},
): Promise<OnnxBackend> {
  const ort = options.ort ?? (await importOnnxruntimeNode());
  return {
    name: "onnxruntime-node",
    async createSession(model, sessionOptions: OnnxSessionOptions = {}) {
      // onnxruntime-node reads paths itself; everything else becomes bytes.
      const url = isModelBytes(model) ? null : modelUrl(model);
      const input = typeof model === "string" && url === null ? model : await loadModelBytes(model);
      const session = (await ort.InferenceSession.create(
        input,
        ortSessionOptions(sessionOptions, "cpu"),
      )) as OrtSessionLike;
      return wrapOrtSession(ort, session);
    },
  };
}
