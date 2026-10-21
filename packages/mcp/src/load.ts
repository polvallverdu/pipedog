// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Pick the docs: the bundled snapshot, or in live mode the site, falling back to the snapshot. */

import { existsSync } from "node:fs";
import { Docs } from "./docs.ts";
import { loadLiveSnapshot } from "./live.ts";
import { BUNDLED_SNAPSHOT_URL, readSnapshot, type Snapshot } from "./snapshot.ts";

export interface LoadOptions {
  /** Fetch the current docs from the site instead of using the bundled snapshot. */
  live?: boolean;
  /** The docs site for live mode. */
  siteUrl?: string;
  /** Live mode's timeout, in milliseconds. */
  timeoutMs?: number;
  /** A snapshot file other than the bundled one. */
  snapshotPath?: string | URL;
  fetch?: typeof fetch;
  /** Diagnostics (stderr in the CLI: stdout is the MCP channel). */
  log?: (message: string) => void;
}

/** A function that loads the docs once, on first call, and then returns the same `Docs`. */
export function docsLoader(options: LoadOptions = {}): () => Promise<Docs> {
  let promise: Promise<Docs> | null = null;
  return () => {
    promise ??= loadDocs(options);
    return promise;
  };
}

export async function loadDocs(options: LoadOptions = {}): Promise<Docs> {
  const log = options.log ?? (() => {});
  const path = options.snapshotPath ?? BUNDLED_SNAPSHOT_URL;
  let snapshot: Snapshot | null = null;
  let snapshotError: unknown = null;
  if (existsSync(path)) {
    try {
      snapshot = readSnapshot(path);
    } catch (e) {
      snapshotError = e;
    }
  } else {
    snapshotError = new Error(`no docs snapshot at ${String(path)}`);
  }

  if (options.live || !snapshot) {
    try {
      const live = await loadLiveSnapshot({
        siteUrl: options.siteUrl,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
        fallback: snapshot,
      });
      log(`live docs: ${live.pages.length} pages from ${live.siteUrl}`);
      return new Docs(live, "live");
    } catch (e) {
      if (!snapshot) {
        throw new Error(
          `pipedog docs unavailable: ${(snapshotError as Error)?.message ?? snapshotError}, and live docs failed: ${(e as Error).message}`,
        );
      }
      log(`live docs failed (${(e as Error).message}); using the bundled snapshot`);
    }
  }
  log(`docs snapshot: pipedog ${snapshot.version}, ${snapshot.pages.length} pages`);
  return new Docs(snapshot, "snapshot");
}
