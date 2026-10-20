// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Reading model bytes from any `OnnxModelSource`. */

import type { OnnxModelSource } from "./backend.ts";

// Held in a variable so bundlers leave the import alone; it only runs where
// there is a filesystem (Bun, Node, Deno).
const NODE_FS = "node:fs/promises";

/** Whether `source` is in memory already. */
export function isModelBytes(source: OnnxModelSource): source is Uint8Array | ArrayBuffer {
  return source instanceof Uint8Array || source instanceof ArrayBuffer;
}

/** Turn a string source into a URL when it is one (`file:`, `http:`, `https:`, ...). */
export function modelUrl(source: string | URL): URL | null {
  if (source instanceof URL) return source;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith("file:")) {
    try {
      return new URL(source);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The bytes of a model.
 *
 * Bytes are returned as is; `http(s):` URLs are fetched; filesystem paths and
 * `file:` URLs are read with `node:fs` (Bun, Node and Deno).
 */
export async function loadModelBytes(source: OnnxModelSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const url = modelUrl(source);
  if (url && url.protocol !== "file:") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ONNX model ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const fs = (await import(NODE_FS)) as { readFile(p: string | URL): Promise<Uint8Array> };
  const data = await fs.readFile(url ?? (source as string));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Bytes for workerd: only in-memory bytes and `http(s):` URLs are possible. */
export async function loadModelBytesWorkerd(model: OnnxModelSource): Promise<Uint8Array> {
  if (!isModelBytes(model)) {
    const url = modelUrl(model);
    if (!url || url.protocol === "file:") {
      throw new Error(
        `Cannot read ONNX model "${String(model)}" on Cloudflare Workers (no filesystem): ` +
          "pass the model bytes (from R2, KV, static assets or fetch) or an https URL",
      );
    }
  }
  return loadModelBytes(model);
}
