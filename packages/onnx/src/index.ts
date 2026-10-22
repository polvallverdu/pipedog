// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * ONNX inference for pipedog (Bun, Node, Deno).
 *
 * `createOnnxBackend()` uses `onnxruntime-node` when it can be imported, else
 * `onnxruntime-web` (WASM). Both are optional peer dependencies: importing this
 * module never needs them, creating a backend needs one. On Cloudflare Workers
 * the "workerd" export condition selects `index.workerd.ts` instead.
 */

import { logger } from "@pipedog/core/utils/logger";
import type { OnnxBackend } from "./backend.ts";
import { createNativeBackend, type NativeBackendOptions } from "./native.ts";
import { createWebBackend, type WebBackendOptions } from "./web.ts";

export * from "./backend.ts";
export * from "./cache.ts";
export * from "./model.ts";
export * from "./native.ts";
export * from "./shared.ts";
export * from "./web.ts";

export interface CreateOnnxBackendOptions {
  /** `native` (onnxruntime-node) or `web` (onnxruntime-web). Default: native if installed. */
  prefer?: "native" | "web";
  /**
   * Options of the native backend, e.g. `{ ort }` with `onnxruntime-node` imported by you.
   * Giving options skips the shared default backend.
   */
  native?: NativeBackendOptions;
  /**
   * Options of the web backend: `{ ort, wasmPaths }` with `onnxruntime-web` and its files
   * imported by you, which is what a bundled app needs. Giving options skips the shared
   * default backend: create the backend once and pass it to every model.
   */
  web?: WebBackendOptions;
}

let defaultBackend: Promise<OnnxBackend> | null = null;

async function pickBackend(options: CreateOnnxBackendOptions): Promise<OnnxBackend> {
  const { prefer } = options;
  if (prefer === "web") return createWebBackend(options.web);
  if (prefer === "native") return createNativeBackend(options.native);
  let nativeError: unknown;
  try {
    const backend = await createNativeBackend(options.native);
    logger.info("ONNX backend: onnxruntime-node");
    return backend;
  } catch (e) {
    nativeError = e;
  }
  try {
    const backend = await createWebBackend(options.web);
    logger.info("ONNX backend: onnxruntime-web (onnxruntime-node is not installed)");
    return backend;
  } catch (e) {
    throw new Error(
      "No ONNX runtime available: install onnxruntime-node (fastest) or onnxruntime-web@1.30.0. " +
        `(${nativeError instanceof Error ? nativeError.message : String(nativeError)}; ` +
        `${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/**
 * Create an ONNX backend: `onnxruntime-node` if it can be imported, else
 * `onnxruntime-web`. Without options the result is shared by every caller.
 *
 * In a bundled app `onnxruntime-node` (a native addon) cannot be part of the bundle, and both
 * runtimes are imported by name at run time. Import `onnxruntime-web` yourself and pass it:
 * `createOnnxBackend({ prefer: "web", web: { ort, wasmPaths } })`.
 */
export function createOnnxBackend(options: CreateOnnxBackendOptions = {}): Promise<OnnxBackend> {
  if (options.prefer || options.native || options.web) return pickBackend(options);
  if (!defaultBackend) {
    defaultBackend = pickBackend({});
    // A failed pick (nothing installed yet) is retried on the next call.
    defaultBackend.catch(() => {
      defaultBackend = null;
    });
  }
  return defaultBackend;
}

/** The runtime-specific backend for Cloudflare Workers; only available on workerd. */
export async function createWorkerdBackend(): Promise<OnnxBackend> {
  throw new Error(
    "createWorkerdBackend() is only available with the workerd export condition (Cloudflare Workers)",
  );
}
