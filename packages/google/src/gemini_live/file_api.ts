// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/gemini_live/file_api.py

/**
 * Gemini File API client for uploading and managing files.
 *
 * This module provides a client for Google's Gemini File API, enabling file
 * uploads, metadata retrieval, listing, and deletion. Files uploaded through
 * this API can be referenced in Gemini generative model calls.
 *
 * Porting notes:
 * - `aiohttp` → the global `fetch` (injectable with the `fetch` option).
 *   Requests are cancelled with the current task (`currentSignal()`).
 * - `aiofiles` → `uploadFile` takes the file's contents directly (bytes, an
 *   `ArrayBuffer`, a `Blob` or a `ReadableStream`), which works on every
 *   runtime. A path, as upstream takes, is read with an injected reader
 *   (`fs`, `{ readFile(path) }`; `node:fs/promises` satisfies it), or else
 *   with `node:fs/promises` imported on first use (Bun, Node, Deno); on a
 *   runtime without it, such as Cloudflare Workers, a path throws.
 * - `mimetypes.guess_type` → a table of the common extensions
 *   (`guessMimeType`); unknown extensions fall back to
 *   `application/octet-stream`, as upstream does.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import type { LocalFileSystem } from "@pipedog/core/utils/file_storage";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

/** The part of a filesystem `GeminiFileAPI.uploadFile` uses. */
export type GeminiFileAPIFileSystem = Pick<LocalFileSystem, "readFile">;

/**
 * What `GeminiFileAPI.uploadFile` uploads: a path to read, or the file's
 * contents.
 */
export type GeminiFileAPIUploadSource =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>;

/** Options for `GeminiFileAPI.uploadFile`. */
export interface GeminiFileAPIUploadOptions {
  /**
   * The file's MIME type. Defaults to the one guessed from the path, else
   * a `Blob`'s own type, else the one guessed from `displayName`, else
   * `application/octet-stream`.
   */
  mimeType?: string | null;
}

export interface GeminiFileAPIOptions {
  /** Google AI API key. */
  apiKey: string;
  /** Base URL for the Gemini File API (default is the v1beta endpoint). */
  baseUrl?: string | null;
  /**
   * Reads paths given to `uploadFile` (`node:fs/promises` satisfies it).
   * Not needed when uploading contents.
   */
  fs?: GeminiFileAPIFileSystem | null;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  fetch?: typeof fetch | null;
}

/** MIME types by extension, the common subset of Python's `mimetypes` table. */
const MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  aif: "audio/x-aiff",
  aiff: "audio/x-aiff",
  avi: "video/x-msvideo",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  flac: "audio/flac",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  htm: "text/html",
  html: "text/html",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  py: "text/x-python",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  txt: "text/plain",
  wav: "audio/x-wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  zip: "application/zip",
};

/**
 * Guess a file's MIME type from its extension, like Python's
 * `mimetypes.guess_type(path)[0]`.
 *
 * @param filePath The file path.
 * @returns The MIME type, or null when the extension is unknown.
 */
export function guessMimeType(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return MIME_TYPES[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Python `dict(response.headers)`-like rendering of the headers, for logs. */
function headersToString(headers: Headers): string {
  const entries: string[] = [];
  headers.forEach((value, key) => {
    entries.push(`'${key}': '${value}'`);
  });
  return `{${entries.join(", ")}}`;
}

/**
 * Client for the Gemini File API.
 *
 * This class provides methods for uploading, fetching, listing, and deleting
 * files through Google's Gemini File API.
 *
 * Files uploaded through this API remain available for 48 hours and can be
 * referenced in calls to the Gemini generative models. Maximum file size is
 * 2GB, with total project storage limited to 20GB.
 */
export class GeminiFileAPI {
  /** Upload URL (uses the /upload/ path). */
  uploadBaseUrl: string;

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fs: GeminiFileAPIFileSystem | null;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Gemini File API client.
   *
   * @param options.apiKey Google AI API key.
   * @param options.baseUrl Base URL for the Gemini File API (default is the
   *   v1beta endpoint).
   * @param options.fs Reads files for `uploadFile`.
   * @param options.fetch The `fetch` implementation to use.
   */
  constructor(options: GeminiFileAPIOptions) {
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/files";
    // Upload URL uses the /upload/ path
    this.uploadBaseUrl = "https://generativelanguage.googleapis.com/upload/v1beta/files";
    this._fs = options.fs ?? null;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Import `node:fs/promises`, the default reader for paths. */
  protected async _importFs(): Promise<GeminiFileAPIFileSystem> {
    // Lazy, so importing this module works on runtimes without node:fs.
    const specifier = "node:fs/promises";
    return (await abortable(import(specifier))) as GeminiFileAPIFileSystem;
  }

  protected async _readFile(filePath: string): Promise<Uint8Array> {
    if (this._fs === null) {
      let fs: GeminiFileAPIFileSystem;
      try {
        fs = await this._importFs();
      } catch (e) {
        rethrowIfCancelled(e);
        throw new Error(
          `GeminiFileAPI.uploadFile: cannot read the path ${filePath}, because this runtime has no node:fs. Pass the file's contents (a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream) instead, or give GeminiFileAPI an \`fs\`.`,
          { cause: e },
        );
      }
      this._fs = fs;
    }
    const data = await abortable(this._fs.readFile(filePath));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Read an upload source into bytes. */
  protected async _readSource(file: GeminiFileAPIUploadSource): Promise<Uint8Array> {
    if (typeof file === "string") {
      return await this._readFile(file);
    }
    if (file instanceof Uint8Array) {
      return file;
    }
    if (file instanceof ArrayBuffer) {
      return new Uint8Array(file);
    }
    if (typeof Blob !== "undefined" && file instanceof Blob) {
      return new Uint8Array(await abortable(file.arrayBuffer()));
    }
    // A ReadableStream: the upload needs its length up front, so read it all.
    return new Uint8Array(await abortable(new Response(file).arrayBuffer()));
  }

  /**
   * Upload a file to the Gemini File API using the correct resumable upload
   * protocol.
   *
   * DIVERGENCE: upstream takes only a path. This also takes the file's
   * contents, which needs no filesystem, so it works on every runtime.
   *
   * @param file Path to the file to upload, or the file's contents.
   * @param displayName Optional display name for the file.
   * @param options.mimeType The file's MIME type (see
   *   `GeminiFileAPIUploadOptions`).
   * @returns File metadata including uri, name, and display_name.
   */
  async uploadFile(
    file: GeminiFileAPIUploadSource,
    displayName: string | null = null,
    options: GeminiFileAPIUploadOptions = {},
  ): Promise<Record<string, unknown>> {
    const isPath = typeof file === "string";
    logger.info(
      `Uploading file: ${isPath ? file : (displayName ?? `<${file.constructor?.name ?? "data"}>`)}`,
    );

    const signal = currentSignal();

    // Determine the file's MIME type
    let mimeType =
      options.mimeType ||
      (isPath ? guessMimeType(file) : null) ||
      (typeof Blob !== "undefined" && file instanceof Blob ? file.type : null) ||
      (!isPath && displayName ? guessMimeType(displayName) : null);
    if (!mimeType) {
      mimeType = "application/octet-stream";
    }

    // Read the file
    const fileData = await this._readSource(file);

    // Create the metadata payload
    let metadata: Record<string, unknown> = {};
    if (displayName) {
      metadata = { file: { display_name: displayName } };
    }

    // Step 1: Initial resumable request to get upload URL
    const headers = {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileData.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    };

    logger.debug(`Step 1: Getting upload URL from ${this.uploadBaseUrl}`);
    let uploadUrl: string | null;
    {
      const response = await abortable(
        this._fetch(`${this.uploadBaseUrl}?key=${this._apiKey}`, {
          method: "POST",
          headers,
          body: pyJsonDumps(metadata),
          signal,
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        logger.error(`Error initiating file upload: ${errorText}`);
        throw new Error(`Failed to initiate upload: ${response.status} - ${errorText}`);
      }

      // Get the upload URL from the response header
      uploadUrl = response.headers.get("X-Goog-Upload-URL");
      if (!uploadUrl) {
        logger.error(`Response headers: ${headersToString(response.headers)}`);
        throw new Error("No upload URL in response headers");
      }

      logger.debug(`Got upload URL: ${uploadUrl}`);
      // Release the connection, as `async with` does upstream.
      await abortable(response.body?.cancel() ?? Promise.resolve());
    }

    // Step 2: Upload the actual file data
    const uploadHeaders = {
      "Content-Length": String(fileData.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    };

    logger.debug(`Step 2: Uploading file data to ${uploadUrl}`);
    const response = await abortable(
      this._fetch(uploadUrl, {
        method: "POST",
        headers: uploadHeaders,
        body: fileData as BodyInit,
        signal,
      }),
    );
    if (response.status !== 200) {
      const errorText = await abortable(response.text());
      logger.error(`Error uploading file data: ${errorText}`);
      throw new Error(`Failed to upload file: ${response.status} - ${errorText}`);
    }

    const fileInfo = (await abortable(response.json())) as Record<string, unknown>;
    const uploaded = (fileInfo.file ?? {}) as Record<string, unknown>;
    logger.info(`File uploaded successfully: ${uploaded.name ?? "None"}`);
    return fileInfo;
  }

  /**
   * Get metadata for a file.
   *
   * @param name File name (or full path).
   * @returns File metadata.
   */
  async getFile(name: string): Promise<Record<string, unknown>> {
    // Extract just the name part if a full path is provided
    if (name.includes("/")) {
      name = name.split("/").pop() as string;
    }

    const response = await abortable(
      this._fetch(`${this._baseUrl}/${name}?key=${this._apiKey}`, { signal: currentSignal() }),
    );
    if (response.status !== 200) {
      const errorText = await abortable(response.text());
      logger.error(`Error getting file metadata: ${errorText}`);
      throw new Error(`Failed to get file metadata: ${response.status}`);
    }

    const fileInfo = (await abortable(response.json())) as Record<string, unknown>;
    return fileInfo;
  }

  /**
   * List uploaded files.
   *
   * @param pageSize Number of files to return per page.
   * @param pageToken Token for pagination.
   * @returns List of files and next page token if available.
   */
  async listFiles(
    pageSize = 10,
    pageToken: string | null = null,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ key: this._apiKey, pageSize: String(pageSize) });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await abortable(
      this._fetch(`${this._baseUrl}?${params.toString()}`, { signal: currentSignal() }),
    );
    if (response.status !== 200) {
      const errorText = await abortable(response.text());
      logger.error(`Error listing files: ${errorText}`);
      throw new Error(`Failed to list files: ${response.status}`);
    }

    const result = (await abortable(response.json())) as Record<string, unknown>;
    return result;
  }

  /**
   * Delete a file.
   *
   * @param name File name (or full path).
   * @returns True if deleted successfully.
   */
  async deleteFile(name: string): Promise<boolean> {
    // Extract just the name part if a full path is provided
    if (name.includes("/")) {
      name = name.split("/").pop() as string;
    }

    const response = await abortable(
      this._fetch(`${this._baseUrl}/${name}?key=${this._apiKey}`, {
        method: "DELETE",
        signal: currentSignal(),
      }),
    );
    if (response.status !== 200) {
      const errorText = await abortable(response.text());
      logger.error(`Error deleting file: ${errorText}`);
      throw new Error(`Failed to delete file: ${response.status}`);
    }

    await abortable(response.body?.cancel() ?? Promise.resolve());
    return true;
  }
}
