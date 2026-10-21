// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The docs snapshot: llms.txt, every page's Markdown and the API declarations of the `@pipedog/*`
 * packages, as one JSON file. `scripts/snapshot.ts` writes it at release time from the docs build
 * (apps/docs/out) and the packages' generated `.d.ts`, so the bundled docs match the release.
 */

import { readFileSync } from "node:fs";

/** The docs site the snapshot and live mode read from. */
export const DEFAULT_SITE_URL = "https://polvallverdu.github.io/pipedog";

/** The snapshot bundled with the package (`snapshot/docs.json`, next to `src/` and `dist/`). */
export const BUNDLED_SNAPSHOT_URL = new URL("../snapshot/docs.json", import.meta.url);

export const SNAPSHOT_FORMAT = 1;

export interface DocPage {
  /** The page's path under /docs, e.g. `services/stt/deepgram`. The docs home is `index`. */
  slug: string;
  title: string;
  description: string;
  /** The HTML page. */
  url: string;
  /** The page as Markdown (its URL plus `.md`). */
  markdownUrl: string;
  /** The top-level section of the docs sidebar, e.g. `Services`. */
  section: string;
  /** A folder within the section, e.g. `Speech-to-text`, or null. */
  group: string | null;
  /** Listed under "Coming soon": an upstream feature that is not ported yet. */
  comingSoon: boolean;
  markdown: string;
}

export type ApiKind = "class" | "interface" | "function" | "type" | "const" | "enum" | "namespace";

/** One exported declaration, as it appears in the package's generated `.d.ts`. */
export interface ApiEntry {
  name: string;
  /** Every kind the name is declared as (a `const` and a `type` can share a name). */
  kinds: ApiKind[];
  /** The npm package, e.g. `@pipedog/deepgram`. */
  package: string;
  /** The import path that declares it, e.g. `@pipedog/deepgram/stt`. */
  module: string;
  /** Other import paths that re-export it, e.g. the package root. */
  alsoFrom: string[];
  /** The declaration as TypeScript (from the `.d.ts`, JSDoc included). */
  text: string;
}

export interface Snapshot {
  format: number;
  /** The pipedog release the snapshot was made for. */
  version: string;
  /** The site the page URLs point at. */
  siteUrl: string;
  llmsTxt: string;
  pages: DocPage[];
  api: ApiEntry[];
}

export function readSnapshot(path: string | URL = BUNDLED_SNAPSHOT_URL): Snapshot {
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`unsupported docs snapshot format ${snapshot.format} in ${String(path)}`);
  }
  return snapshot;
}

/** An llms.txt entry: a page without its Markdown. */
export type IndexEntry = Omit<DocPage, "markdown">;

/** The site URL llms.txt was built for, from its "All pages in one file: <site>/llms-full.txt" line. */
export function siteUrlOf(llmsTxt: string): string | null {
  const match = llmsTxt.match(/(\S+)\/llms-full\.txt/);
  return match ? (match[1] as string) : null;
}

/**
 * The slug of a docs URL: `<site>/docs/services/stt/deepgram.md` (or the HTML page,
 * `.../deepgram/`) is `services/stt/deepgram`; `<site>/docs.md` and `<site>/docs/` are `index`.
 */
export function slugFromUrl(url: string, siteUrl: string): string | null {
  const base = siteUrl.replace(/\/$/, "");
  if (!url.startsWith(`${base}/docs`)) return null;
  const rest = url
    .slice(`${base}/docs`.length)
    .replace(/[?#].*$/, "")
    .replace(/\.md$/, "")
    .replace(/^\/|\/$/g, "");
  return rest === "" ? "index" : rest;
}

export function pageUrls(slug: string, siteUrl: string): { url: string; markdownUrl: string } {
  const base = siteUrl.replace(/\/$/, "");
  return slug === "index"
    ? { url: `${base}/docs/`, markdownUrl: `${base}/docs.md` }
    : { url: `${base}/docs/${slug}/`, markdownUrl: `${base}/docs/${slug}.md` };
}

/**
 * Parse the docs' llms.txt into its pages, in order. Sections are the top-level bold items
 * (`- **Services**`), groups the plain items (`- Speech-to-text`), and pages under a
 * `- **Coming soon**` item are upstream features that aren't ported yet.
 */
export function parseLlmsIndex(llmsTxt: string, siteUrl = siteUrlOf(llmsTxt)): IndexEntry[] {
  if (!siteUrl) throw new Error("llms.txt: no site URL (the llms-full.txt link is missing)");
  const entries: IndexEntry[] = [];
  let section = "";
  let group: string | null = null;
  let comingSoonIndent: number | null = null;
  for (const line of llmsTxt.split("\n")) {
    const item = line.match(/^(\s*)- (.*)$/);
    if (!item) continue;
    const indent = (item[1] as string).length;
    const content = (item[2] as string).trim();
    const bold = content.match(/^\*\*(.+)\*\*$/);
    const link = content.match(/^\[((?:\\.|[^\]])+)\]\(((?:\\.|[^)])+)\)(?::\s*(.*))?$/);
    if (bold) {
      const name = bold[1] as string;
      if (name.toLowerCase() === "coming soon") {
        comingSoonIndent = indent;
      } else if (indent === 0) {
        section = name;
        group = null;
        comingSoonIndent = null;
      }
    } else if (link) {
      const markdownUrl = (link[2] as string).replace(/\\([()])/g, "$1");
      const slug = slugFromUrl(markdownUrl, siteUrl);
      if (!slug) continue;
      entries.push({
        slug,
        title: (link[1] as string).replace(/\\([[\]])/g, "$1"),
        description: (link[3] ?? "").trim(),
        ...pageUrls(slug, siteUrl),
        section,
        group: indent > 0 ? group : null,
        comingSoon: comingSoonIndent !== null && indent >= comingSoonIndent,
      });
    } else {
      if (comingSoonIndent !== null && indent < comingSoonIndent) comingSoonIndent = null;
      if (indent === 0) {
        group = content;
        if (comingSoonIndent === 0) comingSoonIndent = null;
      }
    }
  }
  return entries;
}

/**
 * Split llms-full.txt (every page's Markdown, joined) back into pages. Each page starts with
 * `# Title`, its description and a `Source: <page URL>` line.
 */
export function splitLlmsFull(llmsFull: string, siteUrl: string): Map<string, string> {
  const lines = llmsFull.split("\n");
  const starts: { line: number; slug: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const source = (lines[i] as string).match(/^Source: (\S+)$/);
    if (!source) continue;
    const slug = slugFromUrl(source[1] as string, siteUrl);
    if (!slug) continue;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if ((lines[j] as string).startsWith("# ")) {
        starts.push({ line: j, slug });
        break;
      }
    }
  }
  const pages = new Map<string, string>();
  starts.forEach((start, k) => {
    const end = starts[k + 1]?.line ?? lines.length;
    pages.set(start.slug, lines.slice(start.line, end).join("\n").trimEnd());
  });
  return pages;
}
