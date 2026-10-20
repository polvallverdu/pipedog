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
import { createNativeBackend } from "./native.ts";
import { createWebBackend } from "./web.ts";

export * from "./backend.ts";
export * from "./model.ts";
export * from "./native.ts";
export * from "./web.ts";

export interface CreateOnnxBackendOptions {
  /** `native` (onnxruntime-node) or `web` (onnxruntime-web). Default: native if installed. */
  prefer?: "native" | "web";
}

let defaultBackend: Promise<OnnxBackend> | null = null;

async function pickBackend(prefer: "native" | "web" | undefined): Promise<OnnxBackend> {
  if (prefer === "web") return createWebBackend();
  if (prefer === "native") return createNativeBackend();
  let nativeError: unknown;
  try {
    const backend = await createNativeBackend();
    logger.info("ONNX backend: onnxruntime-node");
    return backend;
  } catch (e) {
    nativeError = e;
  }
  try {
    const backend = await createWebBackend();
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
 */
export function createOnnxBackend(options: CreateOnnxBackendOptions = {}): Promise<OnnxBackend> {
  if (options.prefer) return pickBackend(options.prefer);
  if (!defaultBackend) {
    defaultBackend = pickBackend(undefined);
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
