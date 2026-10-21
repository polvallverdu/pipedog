// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Keyword search over the docs: BM25 over page sections (split at `##`–`####` headings), with
 * the page title and the section heading weighted up. No embeddings and no dependencies.
 * Identifiers are indexed whole and by camelCase part, so `deepgram` finds `DeepgramSTTService`.
 */

import type { DocPage } from "./snapshot.ts";

export interface Section {
  slug: string;
  pageTitle: string;
  /** The section heading; the page title for the text before the first heading. */
  heading: string;
  /** The heading's anchor on the page, or null for the page's intro. */
  anchor: string | null;
  text: string;
  comingSoon: boolean;
}

export interface SearchResult {
  slug: string;
  title: string;
  heading: string;
  anchor: string | null;
  /** The section's URL on the site. */
  url: string;
  score: number;
  snippet: string;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from has have how i if in into is it its of on or " +
    "so than that the their then there these this to use used uses using was what when where " +
    "which while who why will with you your"
  ).split(" "),
);

/** A crude stemmer: plurals only, so "objects" matches "object". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Lowercased, stemmed terms; identifiers also contribute their camelCase parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    const lower = word.toLowerCase();
    if (!STOPWORDS.has(lower)) out.push(stem(lower));
    const parts = word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
    if (parts.length > 1) {
      for (const part of parts) {
        const p = part.toLowerCase();
        if (p.length > 1 && !STOPWORDS.has(p)) out.push(stem(p));
      }
    }
  }
  return out;
}

/** Split a page's Markdown into sections at `##`, `###` and `####` headings, outside code. */
export function splitSections(page: DocPage): Section[] {
  const sections: Section[] = [];
  let heading = page.title;
  let anchor: string | null = null;
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text || anchor === null) {
      sections.push({
        slug: page.slug,
        pageTitle: page.title,
        heading,
        anchor,
        text,
        comingSoon: page.comingSoon,
      });
    }
    buffer = [];
  };
  for (const line of page.markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string).slice(0, 3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
    }
    const h = fence === null ? line.match(/^#{2,4} (.+?)(?: \[#([^\]]+)\])?\s*$/) : null;
    if (h) {
      flush();
      heading = h[1] as string;
      anchor = h[2] ?? slugify(heading);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

interface Doc {
  terms: Map<string, number>;
  length: number;
}

interface IndexedSection extends Doc {
  section: Section;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 2;
const SLUG_WEIGHT = 2;

/** Document frequencies and the average length of a set of documents, for BM25. */
class Corpus {
  readonly df = new Map<string, number>();
  size = 0;
  #totalLength = 0;

  add(doc: Doc): void {
    this.size++;
    this.#totalLength += doc.length;
    for (const term of doc.terms.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  /** BM25, times the squared share of the query terms the document has. */
  score(doc: Doc, terms: string[]): number {
    const avg = this.#totalLength / Math.max(1, this.size);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const tf = doc.terms.get(term);
      if (!tf) continue;
      matched++;
      const df = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avg));
    }
    return score * (matched / terms.length) ** 2;
  }
}

function makeDoc(parts: string[][]): Doc {
  const terms = new Map<string, number>();
  let length = 0;
  for (const part of parts) {
    for (const t of part) {
      terms.set(t, (terms.get(t) ?? 0) + 1);
      length++;
    }
  }
  return { terms, length };
}

/**
 * A section's score is its own BM25 (heading weighted up, page title and slug included) plus
 * its page's BM25 over the whole page, so a section of the page about the query ranks above an
 * equally good section of a page that only mentions it.
 */
export class SearchIndex {
  readonly sections: IndexedSection[] = [];
  readonly #pages = new Map<string, Doc>();
  readonly #sectionCorpus = new Corpus();
  readonly #pageCorpus = new Corpus();
  readonly #pageUrls: Map<string, string>;

  constructor(pages: DocPage[]) {
    this.#pageUrls = new Map(pages.map((p) => [p.slug, p.url]));
    for (const page of pages) {
      const pageTerms = [
        ...repeat(tokenize(page.title), TITLE_WEIGHT),
        ...repeat(tokenize(page.slug.replace(/[/-]/g, " ")), SLUG_WEIGHT),
      ];
      const pageDoc = makeDoc([pageTerms, tokenize(page.description), tokenize(page.markdown)]);
      this.#pages.set(page.slug, pageDoc);
      this.#pageCorpus.add(pageDoc);
      for (const section of splitSections(page)) {
        const doc = makeDoc([
          pageTerms,
          section.anchor !== null
            ? repeat(tokenize(section.heading), HEADING_WEIGHT)
            : tokenize(page.description),
          tokenize(section.text),
        ]);
        const indexed = { section, ...doc };
        this.sections.push(indexed);
        this.#sectionCorpus.add(indexed);
      }
    }
  }

  search(query: string, limit = 8): SearchResult[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const pageScores = new Map<string, number>();
    const scored: { s: IndexedSection; score: number }[] = [];
    for (const s of this.sections) {
      const own = this.#sectionCorpus.score(s, terms);
      if (own === 0) continue;
      let page = pageScores.get(s.section.slug);
      if (page === undefined) {
        page = this.#pageCorpus.score(this.#pages.get(s.section.slug) as Doc, terms);
        pageScores.set(s.section.slug, page);
      }
      // Prefer pages for what is ported over "coming soon" ones.
      const score = (own + page) * (s.section.comingSoon ? 0.5 : 1);
      scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // At most two sections per page, so one long page doesn't fill the results.
    const perPage = new Map<string, number>();
    const results: SearchResult[] = [];
    for (const { s, score } of scored) {
      const count = perPage.get(s.section.slug) ?? 0;
      if (count >= 2) continue;
      perPage.set(s.section.slug, count + 1);
      const pageUrl = this.#pageUrls.get(s.section.slug) ?? "";
      results.push({
        slug: s.section.slug,
        title: s.section.pageTitle,
        heading: s.section.heading,
        anchor: s.section.anchor,
        url: s.section.anchor ? `${pageUrl}#${s.section.anchor}` : pageUrl,
        score: Math.round(score * 1000) / 1000,
        snippet: snippet(s.section.text, query),
      });
      if (results.length >= limit) break;
    }
    return results;
  }
}

function repeat<T>(items: T[], times: number): T[] {
  return Array.from({ length: times }, () => items).flat();
}

/** About `width` characters of the section around the first query word it contains. */
export function snippet(text: string, query: string, width = 240): string {
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (query.match(/[A-Za-z0-9]+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !STOPWORDS.has(w));
  const lower = plain.toLowerCase();
  let at = -1;
  for (const word of words) {
    for (const form of [word, stem(word)]) {
      const i = lower.indexOf(form);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
  }
  if (plain.length <= width) return plain;
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 3));
  const end = Math.min(plain.length, start + width);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}`;
}
