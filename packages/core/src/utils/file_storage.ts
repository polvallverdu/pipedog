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

export interface LocalFileStorageOptions {
  /** Directory to store files in. Created on first save if missing. */
  folder: string;
  /**
   * Maximum number of files to retain; oldest files (by mtime) are deleted
   * once this is exceeded. Set to 0 to disable trimming.
   */
  maxFiles?: number;
}

const NOT_PORTED =
  "not ported yet: LocalFileStorage needs filesystem access, which @pipedog/core (runtime-agnostic) does not have";

/**
 * Default storage backend: files on local disk, addressed as `pipecat:<hex>`.
 *
 * Suitable for local development and single-process deployments. The
 * `pipecat:` scheme makes the URLs recognizable in logs and client payloads;
 * the random hex suffix can't be used for path traversal and doesn't leak the
 * original filename.
 *
 * STUB: disk I/O (`save`, `load`, `delete`, trimming) is not ported, since core
 * cannot import `node:fs`. URL validation is.
 */
export class LocalFileStorage extends FileStorage {
  // Every pipecat: URL is an upload this backend owns, so the file is
  // removed once its bytes have been consumed into the LLM context.
  override deleteAfterLoad = true;

  protected static readonly _URL_PREFIX = "pipecat:";
  protected static readonly _URL_SUFFIX_PATTERN = /^[0-9a-f]{32}$/;

  protected _folder: string;
  protected _maxFiles: number;

  constructor(options: LocalFileStorageOptions) {
    super();
    this._folder = options.folder;
    this._maxFiles = options.maxFiles ?? 10;
  }

  /** Write `contents` to a new randomly-named file and return its `pipecat:` URL. */
  async save(_filename: string, _contents: Uint8Array): Promise<string> {
    throw new Error(NOT_PORTED);
  }

  /** Read and return the contents stored under `fileUrl`. */
  async load(fileUrl: string): Promise<Uint8Array> {
    this._resolveSuffix(fileUrl);
    throw new Error(NOT_PORTED);
  }

  /** Delete the file stored under `fileUrl`, if it exists. */
  async delete(fileUrl: string): Promise<void> {
    try {
      this._resolveSuffix(fileUrl);
    } catch (e) {
      if (e instanceof FileNotFoundError) return;
      throw e;
    }
    throw new Error(NOT_PORTED);
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
}
