// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * ONNX inference for pipedog on Cloudflare Workers (the "workerd" export
 * condition). Same API as the default entry; every backend is the workerd
 * variant of onnxruntime-web (see `workerd.ts`), and models must be passed in
 * as bytes or an `http(s):` URL.
 */

import { logger } from "@pipedog/core/utils/logger";
import type { OnnxBackend } from "./backend.ts";
import { createWorkerdBackend, type WorkerdBackendOptions } from "./workerd.ts";

export * from "./backend.ts";
export * from "./model.ts";
export type { NativeBackendOptions } from "./native.ts";
export { configureWebEnv, type WebBackendOptions } from "./web.ts";
export { createWorkerdBackend, type WorkerdBackendOptions } from "./workerd.ts";

export interface CreateOnnxBackendOptions {
  /** Ignored on workerd: only the WebAssembly backend exists there. */
  prefer?: "native" | "web";
}

let defaultBackend: Promise<OnnxBackend> | null = null;

/** Create the ONNX backend: on Workers, always onnxruntime-web (workerd variant). */
export function createOnnxBackend(_options: CreateOnnxBackendOptions = {}): Promise<OnnxBackend> {
  if (!defaultBackend) {
    defaultBackend = createWorkerdBackend().then((backend) => {
      logger.info("ONNX backend: onnxruntime-web (workerd)");
      return backend;
    });
    defaultBackend.catch(() => {
      defaultBackend = null;
    });
  }
  return defaultBackend;
}

/** onnxruntime-node cannot run on Cloudflare Workers. */
export async function createNativeBackend(): Promise<OnnxBackend> {
  throw new Error("onnxruntime-node is not available on Cloudflare Workers; use the web backend");
}

/** The onnxruntime-web backend; on Workers this is the workerd variant. */
export function createWebBackend(options: WorkerdBackendOptions = {}): Promise<OnnxBackend> {
  return createWorkerdBackend(options);
}
