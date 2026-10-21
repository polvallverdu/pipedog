// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The prebuilt Pipecat client the development runner serves at `/client`.
 *
 * Upstream mounts `PipecatPrebuiltUI` from the `pipecat-ai-prebuilt` Python
 * package: a Starlette `StaticFiles(html=True)` over the package's built
 * client (React, from github.com/pipecat-ai/pipecat-prebuilt). That build is
 * only published inside the Python wheel; there is no npm package or CDN build
 * of it. pipedog ships the same build, unmodified, in this package's
 * `prebuilt/dist` (with its license in `prebuilt/LICENSE`; refresh it with
 * `bun tools/runner/sync-prebuilt.ts`), so it works offline once installed.
 *
 * The client speaks to the runner's `/start` and `/sessions/{id}/api/offer`
 * routes, as it does upstream.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";

/** The `pipecat-ai-prebuilt` release vendored in `prebuilt/dist`. */
export const PREBUILT_VERSION = "1.3.0";

/**
 * Reads one file of the prebuilt client, by its path relative to the build's
 * root (`index.html`, `assets/index-....js`); `null` when there is no such file.
 */
export type PrebuiltAssetReader = (path: string) => Promise<Uint8Array | Response | null>;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
  png: "image/png",
  ico: "image/x-icon",
  wasm: "application/wasm",
  map: "application/json",
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Read files from a directory with `node:fs` (Bun, Node, Deno). The default
 * directory is this package's `prebuilt/dist`.
 */
export function directoryAssetReader(
  dir: string | URL = new URL("../prebuilt/dist/", import.meta.url),
): PrebuiltAssetReader {
  const base = typeof dir === "string" ? dir : decodeURIComponent(dir.pathname);
  return async (path) => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    try {
      return new Uint8Array(await readFile(join(base, path)));
    } catch (e) {
      rethrowIfCancelled(e);
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw e;
    }
  };
}

/**
 * Whether the prebuilt client can be served: its `index.html` is readable.
 */
export async function prebuiltAvailable(reader: PrebuiltAssetReader): Promise<boolean> {
  try {
    return (await reader("index.html")) !== null;
  } catch (e) {
    rethrowIfCancelled(e);
    logger.debug(`Prebuilt client not readable: ${e}`);
    return false;
  }
}

/**
 * Serve the prebuilt client under `mount` (Starlette's `StaticFiles(html=True)`
 * mounted at `/client`): `/client` redirects to `/client/`, a directory serves
 * its `index.html`, a missing file is a 404.
 *
 * @param reader Where the files come from (`directoryAssetReader()` by default).
 * @param mount The URL prefix, without a trailing slash.
 * @returns A handler taking the request; `null` for URLs outside `mount`.
 */
export function PipecatPrebuiltUI(
  reader: PrebuiltAssetReader = directoryAssetReader(),
  mount = "/client",
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ detail: "Method Not Allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === mount) {
      return Response.redirect(new URL(`${mount}/${url.search}`, url).toString(), 307);
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(mount.length + 1));
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    const segments = path.split("/");
    if (segments.some((s) => s === ".." || s.includes("\\") || s.includes("\0"))) {
      return new Response("Not Found", { status: 404 });
    }
    if (path === "" || path.endsWith("/")) path += "index.html";
    const body = await reader(path);
    if (body === null) return new Response("Not Found", { status: 404 });
    if (body instanceof Response) return body;
    const headers = {
      "content-type": contentType(path),
      "content-length": String(body.byteLength),
      // Hashed assets never change; the HTML is re-read on each load.
      "cache-control": path.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    return new Response(request.method === "HEAD" ? null : (body as Uint8Array<ArrayBuffer>), {
      headers,
    });
  };
}
