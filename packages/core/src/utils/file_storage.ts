// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/file_storage.py

/**
 * Pluggable storage for files uploaded by clients and referenced by URL later.
 *
 * `FileStorage` is the shared interface between the development runner's
 * `POST /files` upload endpoint, which saves uploads and hands the resulting
 * URL back to the client, and the LLM service's `FileResolver`, which loads
 * the bytes back when the client references that URL in a send-file message.
 * Passing the same storage instance to both means they agree on where uploads
 * live without each needing its own copy of the configuration, and lets a
 * deployment swap in a backend other than local disk by implementing this
 * interface.
 *
 * The URL is the contract: `FileStorage.save` returns one, callers pass it
 * back unmodified, and each implementation mints whatever form it can later
 * resolve — `pipecat:<id>` for `LocalFileStorage`, or e.g. `gs://` / `s3://`
 * for a custom cloud backend (which the LLM provider may then even fetch
 * itself, without `FileStorage.load` being involved at all).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "./logger.ts";

/**
 * Thrown by `FileStorage.load` when a URL is invalid or no longer stored
 * (Python's built-in `FileNotFoundError`).
 */
export class FileNotFoundError extends Error {
  override name = "FileNotFoundError";
  readonly code = "ENOENT";
}

/** Storage backend for files uploaded by clients and referenced by URL later. */
export abstract class FileStorage {
  /**
   * Whether a file should be deleted once its bytes have been consumed
   * (loaded and inlined into the LLM context by a FileResolver, which then
   * has no further use for the stored copy). Safe only when every URL this
   * backend resolves is an upload it owns; leave false for backends whose
   * URLs may point at shared data (e.g. arbitrary objects in a cloud
   * bucket), where "read into a conversation" must not mean "destroy".
   */
  deleteAfterLoad = false;

  /**
   * Store a file and return the URL later passed to `load` or `delete`.
   *
   * @param filename The original filename, for backends that want to keep it
   *   (e.g. for content-type sniffing). Storage implementations should not use
   *   it to derive the returned URL.
   * @param contents The raw file contents.
   * @returns A URL identifying the stored file, in whatever form this backend
   *   can later resolve. Callers must pass it back unmodified to `load` or `delete`.
   */
  abstract save(filename: string, contents: Uint8Array): Promise<string>;

  /**
   * Return the stored contents for `fileUrl`.
   *
   * @param fileUrl A URL previously returned by `save`.
   * @throws FileNotFoundError If `fileUrl` is invalid or no longer stored.
   */
  abstract load(fileUrl: string): Promise<Uint8Array>;

  /**
   * Remove the stored file for `fileUrl`, if present.
   *
   * @param fileUrl A URL previously returned by `save`.
   */
  abstract delete(fileUrl: string): Promise<void>;
}

/**
 * The file operations `LocalFileStorage` needs: a subset of
 * `node:fs/promises`, which satisfies it as is
 * (`import * as fs from "node:fs/promises"`; Deno and Bun provide it too).
 * Core has no filesystem access of its own, so the storage takes one.
 */
export interface LocalFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  unlink(path: string): Promise<void>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string; isFile(): boolean }>>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}

export interface LocalFileStorageOptions {
  /** Directory to store files in. Created on first save if missing. */
  folder: string;
  /**
   * Maximum number of files to retain; oldest files (by mtime) are deleted
   * once this is exceeded. Set to 0 to disable trimming.
   */
  maxFiles?: number;
  /**
   * The filesystem to store files on, e.g. `node:fs/promises`. Required for
   * `save`, `load` and `delete`; URL validation works without it.
   */
  fs?: LocalFileSystem;
}

/** Whether `e` is a filesystem "no such file" error (`ENOENT`). */
function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

/** `uuid.uuid4().hex`. */
function uuid4Hex(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Default storage backend: files on local disk, addressed as `pipecat:<hex>`.
 *
 * Suitable for local development and single-process deployments. The
 * `pipecat:` scheme makes the URLs recognizable in logs and client payloads;
 * the random hex suffix can't be used for path traversal and doesn't leak the
 * original filename.
 *
 * Porting note: upstream writes with `aiofiles` and `pathlib`. Core cannot
 * import `node:fs`, so the disk is reached through the `fs` option (see
 * `LocalFileSystem`).
 */
export class LocalFileStorage extends FileStorage {
  // Every pipecat: URL is an upload this backend owns, so the file is
  // removed once its bytes have been consumed into the LLM context.
  override deleteAfterLoad = true;

  protected static readonly _URL_PREFIX = "pipecat:";
  protected static readonly _URL_SUFFIX_PATTERN = /^[0-9a-f]{32}$/;

  protected _folder: string;
  protected _maxFiles: number;
  protected _fsImpl: LocalFileSystem | null;

  constructor(options: LocalFileStorageOptions) {
    super();
    this._folder = options.folder;
    this._maxFiles = options.maxFiles ?? 10;
    this._fsImpl = options.fs ?? null;
  }

  /** Write `contents` to a new randomly-named file and return its `pipecat:` URL. */
  async save(_filename: string, contents: Uint8Array): Promise<string> {
    const fs = this._fs();
    await fs.mkdir(this._folder, { recursive: true });
    const suffix = uuid4Hex();
    await fs.writeFile(this._path(suffix), contents);
    await this._trim();
    return `${LocalFileStorage._URL_PREFIX}${suffix}`;
  }

  /** Read and return the contents stored under `fileUrl`. */
  async load(fileUrl: string): Promise<Uint8Array> {
    const suffix = this._resolveSuffix(fileUrl);
    try {
      return await this._fs().readFile(this._path(suffix));
    } catch (e) {
      rethrowIfCancelled(e);
      if (isNotFound(e)) throw new FileNotFoundError(fileUrl);
      throw e;
    }
  }

  /** Delete the file stored under `fileUrl`, if it exists. */
  async delete(fileUrl: string): Promise<void> {
    let suffix: string;
    try {
      suffix = this._resolveSuffix(fileUrl);
    } catch (e) {
      if (e instanceof FileNotFoundError) return;
      throw e;
    }
    try {
      // Missing is fine: a consumed upload (deleteAfterLoad) may be deleted
      // again by session-end cleanup.
      await this._fs().unlink(this._path(suffix));
    } catch (e) {
      rethrowIfCancelled(e);
      if (isNotFound(e)) return;
      logger.warning(`Failed to remove uploaded file ${fileUrl}: ${e}`);
    }
  }

  /** Validate `fileUrl` and return the on-disk filename it maps to. */
  protected _resolveSuffix(fileUrl: string): string {
    const prefix = LocalFileStorage._URL_PREFIX;
    const suffix = fileUrl.startsWith(prefix) ? fileUrl.slice(prefix.length) : fileUrl;
    if (!LocalFileStorage._URL_SUFFIX_PATTERN.test(suffix)) {
      throw new FileNotFoundError(fileUrl);
    }
    return suffix;
  }

  /** Keep only the most recent `maxFiles` files; delete oldest by mtime. */
  protected async _trim(): Promise<void> {
    if (this._maxFiles <= 0) {
      return;
    }
    const fs = this._fs();
    try {
      const entries = await fs.readdir(this._folder, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile()).map((e) => e.name);
      if (files.length <= this._maxFiles) {
        return;
      }
      const mtimes = new Map<string, number>();
      for (const name of files) {
        mtimes.set(name, (await fs.stat(this._path(name))).mtimeMs);
      }
      const byMtime = [...files].sort((a, b) => mtimes.get(a)! - mtimes.get(b)!);
      for (const name of byMtime.slice(0, files.length - this._maxFiles)) {
        try {
          await fs.unlink(this._path(name));
          logger.debug(`Trimmed upload ${name} from ${this._folder}`);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Failed to trim upload ${this._path(name)}: ${e}`);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`Failed to list uploads folder ${this._folder}: ${e}`);
    }
  }

  protected _path(name: string): string {
    return /[\\/]$/.test(this._folder) ? `${this._folder}${name}` : `${this._folder}/${name}`;
  }

  protected _fs(): LocalFileSystem {
    if (this._fsImpl === null) {
      throw new Error(
        'LocalFileStorage needs a filesystem: pass `fs` (e.g. `import * as fs from "node:fs/promises"`)',
      );
    }
    return this._fsImpl;
  }
}
