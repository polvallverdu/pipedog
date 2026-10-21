// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Live mode: read the current docs from the site (llms.txt and llms-full.txt) instead of the
 * bundled snapshot. The API index still comes from the snapshot: the site doesn't serve it.
 */

import {
  DEFAULT_SITE_URL,
  type DocPage,
  parseLlmsIndex,
  SNAPSHOT_FORMAT,
  type Snapshot,
  siteUrlOf,
  splitLlmsFull,
} from "./snapshot.ts";

export const DEFAULT_LIVE_TIMEOUT_MS = 10_000;

export interface LiveOptions {
  /** The docs site, e.g. `https://polvallverdu.github.io/pipedog`. */
  siteUrl?: string;
  /** For both requests together. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Where the API index comes from (the bundled snapshot), if any. */
  fallback?: Snapshot | null;
}

async function getText(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, { signal, headers: { accept: "text/plain, */*" } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.text();
}

/** Fetch and parse the live docs. Throws on a network error, a timeout or an unexpected format. */
export async function loadLiveSnapshot(options: LiveOptions = {}): Promise<Snapshot> {
  const siteUrl = (options.siteUrl ?? DEFAULT_SITE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  let llmsTxt: string;
  let llmsFull: string;
  try {
    [llmsTxt, llmsFull] = await Promise.all([
      getText(`${siteUrl}/llms.txt`, signal, fetchImpl),
      getText(`${siteUrl}/llms-full.txt`, signal, fetchImpl),
    ]);
  } catch (e) {
    if (signal.aborted) throw new Error(`timed out after ${timeoutMs} ms fetching ${siteUrl}`);
    throw e;
  }
  // Links in the files point at the site they were built for; that is normally `siteUrl`.
  const builtFor = siteUrlOf(llmsTxt) ?? siteUrl;
  const index = parseLlmsIndex(llmsTxt, builtFor);
  const markdown = splitLlmsFull(llmsFull, builtFor);
  const pages: DocPage[] = index.map((entry) => ({
    ...entry,
    markdown: markdown.get(entry.slug) ?? "",
  }));
  if (pages.length === 0 || pages.every((p) => !p.markdown)) {
    throw new Error(`${siteUrl}: llms.txt or llms-full.txt has no pages`);
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: options.fallback?.version ?? "live",
    siteUrl: builtFor,
    llmsTxt,
    pages: pages.filter((p) => p.markdown),
    api: options.fallback?.api ?? [],
  };
}
