// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The docs the server answers from: a snapshot's pages, its search index and its API index. */

import { ApiIndex } from "./api.ts";
import { SearchIndex, type SearchResult } from "./search.ts";
import { type DocPage, type Snapshot, slugFromUrl } from "./snapshot.ts";

export type DocsSource = "snapshot" | "live";

export interface PageSummary {
  slug: string;
  title: string;
  description: string;
  section: string;
  group: string | null;
  comingSoon: boolean;
  url: string;
}

export class Docs {
  readonly #pages = new Map<string, DocPage>();
  #search: SearchIndex | null = null;
  #api: ApiIndex | null = null;

  readonly snapshot: Snapshot;
  readonly source: DocsSource;

  constructor(snapshot: Snapshot, source: DocsSource = "snapshot") {
    this.snapshot = snapshot;
    this.source = source;
    for (const page of snapshot.pages) this.#pages.set(page.slug, page);
  }

  get pages(): DocPage[] {
    return this.snapshot.pages;
  }

  get version(): string {
    return this.snapshot.version;
  }

  get searchIndex(): SearchIndex {
    this.#search ??= new SearchIndex(this.snapshot.pages);
    return this.#search;
  }

  get api(): ApiIndex {
    this.#api ??= new ApiIndex(this.snapshot.api, this.snapshot.pages);
    return this.#api;
  }

  /**
   * Pages, optionally only those in a section. `section` matches a sidebar section or group
   * ("Services", "Speech-to-text") or a slug prefix ("services/stt"), case-insensitively.
   */
  list(section?: string): PageSummary[] {
    const filter = section
      ?.trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "");
    return this.snapshot.pages
      .filter(
        (p) =>
          !filter ||
          p.section.toLowerCase() === filter ||
          p.group?.toLowerCase() === filter ||
          p.slug === filter ||
          p.slug.startsWith(`${filter}/`),
      )
      .map(({ slug, title, description, section, group, comingSoon, url }) => ({
        slug,
        title,
        description,
        section,
        group,
        comingSoon,
        url,
      }));
  }

  sections(): string[] {
    return [...new Set(this.snapshot.pages.map((p) => p.section))];
  }

  /**
   * A page by slug. Also accepts a page URL, its Markdown URL, `/docs/...` paths, a trailing
   * `.md` or `#anchor`, and `""` or `/docs` for the home page.
   */
  page(slugOrUrl: string): DocPage | null {
    let key = slugOrUrl.trim();
    if (/^https?:\/\//.test(key)) {
      key = slugFromUrl(key, this.snapshot.siteUrl) ?? key.replace(/^https?:\/\/[^/]+/, "");
    }
    key = key
      .replace(/[?#].*$/, "")
      .replace(/^pipedog:\/\/docs\/?/, "")
      .replace(/^\/+/, "")
      .replace(/^docs(?=\/|$|\.md$)/, "")
      .replace(/\.mdx?$/, "")
      .replace(/^\/+|\/+$/g, "");
    if (key === "" || key === "index") return this.#pages.get("index") ?? null;
    return this.#pages.get(key) ?? this.#pages.get(key.replace(/\/index$/, "")) ?? null;
  }

  /** Slugs that look like `slug`, for "did you mean". */
  similar(slug: string, limit = 5): string[] {
    const words = slug
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return this.snapshot.pages
      .map((p) => ({ slug: p.slug, hits: words.filter((w) => p.slug.includes(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.slug.length - b.slug.length)
      .slice(0, limit)
      .map((x) => x.slug);
  }

  search(query: string, limit?: number): SearchResult[] {
    return this.searchIndex.search(query, limit);
  }
}
