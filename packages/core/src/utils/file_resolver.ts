// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/file_resolver.py

/**
 * Resolution of file URLs in an LLM context into bytes the provider can consume.
 *
 * A file reaches the context as a URL — `pipecat:<id>` from the development
 * runner's upload endpoint, `gs://`/`s3://` from cloud storage, or plain
 * `http(s)`. Whether that URL can be passed to the LLM provider as-is, or must
 * first be fetched by this server and inlined as bytes, depends on the provider
 * (each adapter declares what it can consume) and on who can reach the URL.
 * `FileResolver` is the fetching half of that decision: it downloads the
 * bytes when the provider can't, using the configured `FileStorage` for URLs
 * the storage backend minted and plain HTTP for the rest, guarded by an SSRF
 * reachability policy.
 *
 * The context itself is never modified: everything the resolver produces —
 * downloaded bytes, base64 data URLs, reachability verdicts — is held in
 * in-memory caches on the resolver, keyed by URL, where adapters read it
 * synchronously during context conversion. The caches make resolved files
 * provider-neutral: LLM services that share one resolver instance (e.g. services
 * switched between mid-session) reuse each other's downloads, re-deciding only
 * the per-provider question of whether a URL can be passed through.
 *
 * The resolver is configured on the LLM service (`fileResolver`), which
 * resolves and converts in one step right before each completion — see
 * `BaseLLMAdapter.getLlmInvocationParams`.
 */

import { abortable, currentSignal, rethrowIfCancelled, TimeoutError } from "@pipecat-ts/asyncio";
import { FileNotFoundError, type FileStorage } from "./file_storage.ts";
import {
  classifyUrlReachability,
  defaultAllowedFileUrlNetworks,
  IPNetwork,
  UrlReachability,
} from "./security/ssrf.ts";

const DEFAULT_MAX_FETCH_BYTES = 50 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_SECS = 30;

/** Raised when a file URL in the LLM context cannot be resolved to bytes. */
export class FileResolverError extends Error {
  override name = "FileResolverError";
}

export interface FileResolverOptions {
  /**
   * Storage backend used to resolve URLs it minted (e.g. `pipecat:<id>` from
   * the development runner's upload endpoints — pass `runnerArgs.fileStorage`
   * there). Without it, only `data:` and `http(s)` URLs can be resolved.
   */
  fileStorage?: FileStorage | null;
  /**
   * CIDR ranges (e.g. `["10.0.0.0/8"]`) this server is trusted to fetch from,
   * in addition to the public internet. An `http(s)` URL that resolves outside
   * both is refused. Defaults to the `PIPECAT_ALLOWED_FILE_URL_NETWORKS` env
   * var (comma-separated).
   */
  allowedUrlNetworks?: string[] | null;
  /** Maximum size of a fetched file. */
  maxFetchBytes?: number;
  /** Total timeout for an `http(s)` fetch, in seconds. */
  fetchTimeoutSecs?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isTimeout(e: unknown): boolean {
  return (
    e instanceof TimeoutError ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError")
  );
}

/**
 * Fetches and caches the bytes behind file URLs the LLM provider can't fetch itself.
 *
 * Handles three kinds of URL:
 *
 * - `data:` URLs are decoded directly.
 * - `http(s)` URLs are fetched by this server, but only when the resolved
 *   address is publicly routable or falls within `allowedUrlNetworks` —
 *   a client-supplied URL must not be able to point this server at arbitrary
 *   private address space (SSRF). Redirects are refused rather than followed.
 * - Any other scheme is delegated to `fileStorage`, which resolves the
 *   URLs it minted (`pipecat:<id>` for `LocalFileStorage`; a custom backend
 *   resolves whatever `save()` returned, e.g. `gs://` with the deployment's
 *   own credentials).
 *
 * Each URL is fetched once and served from the cache afterwards: a URL is
 * assumed to identify one immutable piece of content, the same assumption
 * the rest of the web's caches make. Content that changes should live at a
 * new URL (uploads through the development runner mint a fresh URL per
 * upload; a cache-busting query string works for external URLs), or use
 * `forget` when the application knows a URL's content changed. Note the flip
 * side for URLs a provider consumes directly: the provider fetches those
 * itself, on its own schedule, so their freshness is out of this resolver's
 * hands entirely.
 *
 * A stored file whose backend sets `deleteAfterLoad` is deleted only after
 * its bytes are cached, so the cache entry becomes the surviving copy — which
 * is why LLM services that may consume the same files (e.g. services switched
 * between mid-session) should share one resolver instance rather than each
 * constructing their own. Scope a resolver to one session: an instance shared
 * across sessions would hold every session's files in memory and stretch the
 * one-fetch-per-URL assumption across all of them.
 *
 * Subclass and override `fetch` to support additional schemes or
 * credentialed fetches beyond what the storage backend provides.
 */
export class FileResolver {
  protected _fileStorage: FileStorage | null;
  protected _allowedUrlNetworks: IPNetwork[];
  protected _maxFetchBytes: number;
  protected _fetchTimeoutSecs: number;

  // Everything below is keyed by the URL exactly as it appears in the
  // context, including data: URLs.
  protected _bytesCache = new Map<string, Uint8Array>();
  protected _dataUrlCache = new Map<string, string>();
  protected _reachabilityCache = new Map<string, UrlReachability>();

  constructor(options: FileResolverOptions = {}) {
    this._fileStorage = options.fileStorage ?? null;
    const allowedUrlNetworks = options.allowedUrlNetworks ?? defaultAllowedFileUrlNetworks();
    this._allowedUrlNetworks = allowedUrlNetworks.map((net) => new IPNetwork(net));
    this._maxFetchBytes = options.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
    this._fetchTimeoutSecs = options.fetchTimeoutSecs ?? DEFAULT_FETCH_TIMEOUT_SECS;
  }

  /** The storage backend used to resolve URLs it minted, if any. */
  get fileStorage(): FileStorage | null {
    return this._fileStorage;
  }

  /** Return the cached bytes for `url`, or null if it hasn't been fetched. */
  cachedBytes(url: string): Uint8Array | null {
    return this._bytesCache.get(url) ?? null;
  }

  /**
   * Return the cached `data:` form for `url`, or null if not prepared.
   *
   * A `data:` URL is its own data-URL form.
   */
  cachedDataUrl(url: string): string | null {
    if (url.startsWith("data:")) {
      return url;
    }
    return this._dataUrlCache.get(url) ?? null;
  }

  /** Return the cached reachability verdict for `url`, or null if unclassified. */
  cachedReachability(url: string): UrlReachability | null {
    return this._reachabilityCache.get(url) ?? null;
  }

  /**
   * Drop everything cached for `url`, forcing a re-fetch on next use.
   *
   * For applications that know a URL's content has changed. A forgotten
   * `deleteAfterLoad` upload can't be re-fetched — its stored copy was
   * deleted when first cached — so forgetting one makes it unresolvable.
   *
   * @param url The URL whose cached content and reachability to drop.
   */
  forget(url: string): void {
    this._bytesCache.delete(url);
    this._dataUrlCache.delete(url);
    this._reachabilityCache.delete(url);
  }

  /**
   * Classify who can reach an `http(s)` URL, honoring `allowedUrlNetworks`.
   *
   * Classified once per URL; later calls return the cached verdict.
   */
  async classify(url: string): Promise<UrlReachability> {
    let cached = this._reachabilityCache.get(url);
    if (cached === undefined) {
      cached = await classifyUrlReachability(url, this._allowedUrlNetworks);
      this._reachabilityCache.set(url, cached);
    }
    return cached;
  }

  /**
   * Return the bytes behind `url`, fetching and caching them on first use.
   *
   * @param url A `data:` URL, an `http(s)` URL, or a URL minted by the
   *   configured storage backend. A storage-resolved file is deleted after a
   *   successful load when the backend sets `deleteAfterLoad` — the bytes are
   *   cached first, so the cache entry becomes the surviving copy.
   * @throws FileResolverError If the URL is refused by the reachability
   *   policy, exceeds the size limit, fails to download, or has a scheme
   *   nothing is configured to resolve.
   */
  async fetch(url: string): Promise<Uint8Array> {
    const cached = this._bytesCache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const data = await this._fetchUncached(url);
    this._bytesCache.set(url, data);
    return data;
  }

  /**
   * Return the `data:` form of `url`'s bytes, encoding and caching it on first use.
   *
   * For adapters whose provider consumes base64 rather than raw bytes, so
   * the encode happens once rather than on every context conversion.
   *
   * @param url A URL whose bytes are cached or fetchable — see `fetch`.
   * @param mimeType The file's MIME type, used in the data URL.
   * @throws FileResolverError If the bytes can't be fetched.
   */
  async ensureDataUrl(url: string, mimeType: string): Promise<string> {
    if (url.startsWith("data:")) {
      return url;
    }
    let cached = this._dataUrlCache.get(url);
    if (cached === undefined) {
      const data = await this.fetch(url);
      const encoded = bytesToBase64(data);
      cached = `data:${mimeType};base64,${encoded}`;
      this._dataUrlCache.set(url, cached);
    }
    return cached;
  }

  protected async _fetchUncached(url: string): Promise<Uint8Array> {
    if (url.startsWith("data:")) {
      return FileResolver._decodeDataUrl(url);
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return await this._fetchHttp(url);
    }
    if (this._fileStorage !== null) {
      let data: Uint8Array;
      try {
        data = await this._fileStorage.load(url);
      } catch (e) {
        if (
          e instanceof FileNotFoundError ||
          (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT")
        ) {
          throw new FileResolverError(`File not found in storage: '${url}'`, { cause: e });
        }
        throw e;
      }
      // The bytes are about to be cached, so a backend whose URLs are
      // all uploads it owns has no further use for the stored copy.
      if (this._fileStorage.deleteAfterLoad) {
        await this._fileStorage.delete(url);
      }
      return data;
    }
    throw new FileResolverError(
      `No way to resolve file URL '${url}': configure a FileResolver with a ` +
        "fileStorage (or a custom fetch) that understands it.",
    );
  }

  protected static _decodeDataUrl(url: string): Uint8Array {
    const index = url.indexOf("base64,");
    if (index < 0) {
      throw new FileResolverError("Malformed data URL: not enough values to unpack");
    }
    try {
      return base64ToBytes(url.slice(index + "base64,".length));
    } catch (e) {
      throw new FileResolverError(
        `Malformed data URL: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  protected async _fetchHttp(url: string): Promise<Uint8Array> {
    const reachability = await this.classify(url);
    if (reachability === UrlReachability.BLOCKED) {
      throw new FileResolverError(`Refusing to fetch unreachable URL: '${url}'`);
    }
    const timeoutSignal = AbortSignal.timeout(this._fetchTimeoutSecs * 1000);
    const signal = AbortSignal.any([currentSignal(), timeoutSignal]);
    try {
      // Redirects are not followed: re-validating the host on every hop is
      // more machinery than this needs, and a redirect into unreachable
      // address space is exactly what classify() above is meant to rule out.
      const response = await abortable(fetch(url, { redirect: "manual", signal }));
      if (REDIRECT_STATUSES.has(response.status) || response.type === "opaqueredirect") {
        throw new FileResolverError(`Refusing to follow redirect fetching file from URL: '${url}'`);
      }
      if (!response.ok) {
        throw new FileResolverError(
          `Failed to fetch file from URL '${url}': ${response.status}, message='${response.statusText}'`,
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > this._maxFetchBytes) {
        throw new FileResolverError(`File at URL exceeds ${this._maxFetchBytes} byte limit`);
      }
      // Accumulate chunks and enforce the size cap as they arrive.
      const chunks: Uint8Array[] = [];
      let received = 0;
      const body = response.body;
      if (body) {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await abortable(reader.read());
            if (done) break;
            received += value.length;
            if (received > this._maxFetchBytes) {
              throw new FileResolverError(`File at URL exceeds ${this._maxFetchBytes} byte limit`);
            }
            chunks.push(value);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      }
      return concatBytes(chunks, received);
    } catch (e) {
      if (e instanceof FileResolverError) throw e;
      rethrowIfCancelled(e);
      if (isTimeout(e) || timeoutSignal.aborted) {
        throw new FileResolverError(`Timed out fetching file from URL: '${url}'`, { cause: e });
      }
      throw new FileResolverError(
        `Failed to fetch file from URL '${url}': ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
}
