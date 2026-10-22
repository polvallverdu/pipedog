// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Downloaded model files: a per-user cache directory and a download-once helper.
 *
 * Local speech models (Kokoro, Piper, Moonshine, Whisper, SenseVoice) are too
 * large to ship in a package, so they are fetched on first use and kept in
 * `~/.cache/pipedog/<name>` (or `$PIPEDOG_CACHE_DIR/<name>`, or
 * `$XDG_CACHE_HOME/pipedog/<name>`). Every service also takes an explicit model
 * path or cache directory, so nothing is downloaded when the files are already
 * where you put them.
 *
 * Only Bun, Node and Deno have a filesystem; on Cloudflare Workers these
 * helpers throw.
 */

// Held in variables so bundlers leave the imports alone; they only run where
// there is a filesystem (Bun, Node, Deno).
const NODE_FS = "node:fs/promises";
const NODE_OS = "node:os";
const NODE_PATH = "node:path";

interface NodeFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  stat(path: string): Promise<{ size: number; isFile(): boolean }>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
  open(
    path: string,
    flags: string,
  ): Promise<{ write(data: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

async function nodeFs(): Promise<NodeFs> {
  return (await import(NODE_FS)) as NodeFs;
}
async function nodePath(): Promise<NodePath> {
  return (await import(NODE_PATH)) as NodePath;
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

/**
 * The cache directory for one model family: `$PIPEDOG_CACHE_DIR/<name>`, else
 * `$XDG_CACHE_HOME/pipedog/<name>`, else `~/.cache/pipedog/<name>`.
 */
export async function modelCacheDir(name: string): Promise<string> {
  const path = await nodePath();
  const root = env("PIPEDOG_CACHE_DIR");
  if (root) return path.join(root, name);
  const xdg = env("XDG_CACHE_HOME");
  if (xdg) return path.join(xdg, "pipedog", name);
  const os = (await import(NODE_OS)) as { homedir(): string };
  return path.join(os.homedir(), ".cache", "pipedog", name);
}

/** Whether `path` is an existing, non-empty file. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await (await nodeFs()).stat(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export interface DownloadModelFileOptions {
  /** Download again even if the file exists. */
  force?: boolean;
  /** `fetch` to download with (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** Abort the download. */
  signal?: AbortSignal;
  /** Progress callback: bytes received so far and the total (0 when unknown). */
  onProgress?: (received: number, total: number) => void;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Download `url` to `dest` unless `dest` already exists, and return `dest`.
 *
 * The file is written to `<dest>.part` and renamed when complete, so an
 * interrupted download is never mistaken for a model. Concurrent calls for the
 * same `dest` share one download.
 */
export function downloadModelFile(
  url: string | URL,
  dest: string,
  options: DownloadModelFileOptions = {},
): Promise<string> {
  const running = inFlight.get(dest);
  if (running) return running;
  const task = (async () => {
    if (!options.force && (await fileExists(dest))) return dest;
    const fs = await nodeFs();
    const path = await nodePath();
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const doFetch = options.fetch ?? fetch;
    const res = await doFetch(url, { signal: options.signal, redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${String(url)}: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length") ?? 0) || 0;
    const part = `${dest}.part`;
    const file = await fs.open(part, "w");
    let received = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
        received += value.byteLength;
        options.onProgress?.(received, total);
      }
    } catch (e) {
      await file.close();
      await fs.rm(part, { force: true });
      throw e;
    }
    await file.close();
    if (total && received !== total) {
      await fs.rm(part, { force: true });
      throw new Error(`Incomplete download of ${String(url)}: ${received} of ${total} bytes`);
    }
    await fs.rename(part, dest);
    return dest;
  })();
  inFlight.set(dest, task);
  const clear = () => {
    if (inFlight.get(dest) === task) inFlight.delete(dest);
  };
  task.then(clear, clear);
  return task;
}
