// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Reading model bytes from any `OnnxModelSource`. */

import { rethrowIfCancelled } from "@pipedog/asyncio";
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

/** What `defaultModelHint` needs to explain how to pass a model. */
export interface DefaultModelInfo {
  /** The model's name for the message, e.g. `the Silero VAD model`. */
  what: string;
  /** The package's export of the file, e.g. `@pipedog/audio-silero/silero_vad.onnx`. */
  specifier: string;
  /** The code that passes the model, given the name of the imported file, e.g. `new SileroVADAnalyzer({ model })`. */
  usage: string;
}

/**
 * Run `load`, which reads a package's default model file. When it fails, throw an
 * error that says why and how to pass the model instead.
 *
 * The default files are found next to the package's source, with `new URL(..., import.meta.url)`.
 * A bundler (`bun build`, `bun build --compile`) does not copy them, so the read fails with a
 * bare "file not found" that names a path nobody recognizes.
 */
export async function withDefaultModelHint<T>(
  load: () => Promise<T>,
  info: DefaultModelInfo,
): Promise<T> {
  try {
    return await load();
  } catch (e) {
    rethrowIfCancelled(e);
    const reason = e instanceof Error ? e.message : String(e);
    // Only a file that is not there: any other failure (a corrupt model, no runtime) is its own.
    const code = (e as { code?: unknown } | null)?.code;
    if (code !== "ENOENT" && code !== "EISDIR" && !/ENOENT|no such file/i.test(reason)) throw e;
    throw new Error(
      `Could not read ${info.what} that ships with the package (${reason}). ` +
        "That happens when the app is bundled: the bundle does not include the package's data " +
        "files. Pass the model yourself. With `bun build` (also `--compile`), import the file " +
        "as an asset and pass its URL:\n" +
        `  import modelPath from "${info.specifier}" with { type: "file" };\n` +
        // Not one literal: the compat harness rewrites `import.meta.url` in sources.
        `  const model = new URL(modelPath, ${"import.meta"}.url); // then ${info.usage}\n` +
        "(a path, a URL or the file's bytes all work).",
      { cause: e },
    );
  }
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
