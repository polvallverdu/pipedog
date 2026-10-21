// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// search_docs, read_page, list_pages and get_api against the real docs.

import { beforeAll, describe, expect, test } from "bun:test";
import type { Docs } from "../src/docs.ts";
import { splitSections, tokenize } from "../src/search.ts";
import { SETUP_TIMEOUT_MS, testDocs } from "./helpers.ts";

let docs: Docs;
beforeAll(() => {
  docs = testDocs();
}, SETUP_TIMEOUT_MS);

describe("tokenize", () => {
  test("identifiers whole and by camelCase part, plurals stemmed, stopwords dropped", () => {
    expect(tokenize("the DeepgramSTTService objects")).toEqual([
      "deepgramsttservice",
      "deepgram",
      "stt",
      "service",
      "object",
    ]);
  });
});

describe("search_docs", () => {
  test('"deepgram" ranks the Deepgram STT page first', () => {
    const results = docs.search("deepgram");
    expect(results[0]?.slug).toBe("services/stt/deepgram");
    expect(results.map((r) => r.slug)).toContain("services/tts/deepgram");
  });

  test('"durable objects" finds the Workers page', () => {
    const top = docs.search("durable objects", 3).map((r) => r.slug);
    expect(top[0]).toMatch(/cloudflare-workers$/);
    expect(top).toContain("deployment/cloudflare-workers");
  });

  test("an identifier finds its page", () => {
    expect(docs.search("PipelineWorker", 5).map((r) => r.slug)).toContain("api/pipeline-worker");
    expect(docs.search("DeepgramFluxSTTService", 3)[0]?.slug).toBe("services/stt/deepgram");
  });

  test("results have a title, heading, URL and a snippet with the query", () => {
    const [first] = docs.search("durable objects", 1);
    expect(first?.title).toBeTruthy();
    expect(first?.heading).toBeTruthy();
    expect(first?.url).toStartWith(docs.snapshot.siteUrl);
    expect(first?.snippet.toLowerCase()).toContain("durable object");
    expect(first?.snippet.length).toBeLessThanOrEqual(242);
  });

  test("limit, at most two sections per page, and no results", () => {
    const results = docs.search("frame", 20);
    expect(results.length).toBe(20);
    const perPage = new Map<string, number>();
    for (const r of results) perPage.set(r.slug, (perPage.get(r.slug) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
    expect(docs.search("qwxzvbnm")).toEqual([]);
    expect(docs.search("the of")).toEqual([]);
  });

  test("ported pages rank above coming-soon ones", () => {
    const results = docs.search("speech to text");
    const first = docs.page(results[0]?.slug ?? "");
    expect(first?.comingSoon).toBe(false);
  });
});

describe("read_page", () => {
  test("by slug, URL, .md URL and path", () => {
    const page = docs.page("services/stt/deepgram");
    expect(page?.title).toBe("Deepgram");
    expect(page?.markdown).toStartWith("# Deepgram\n");
    expect(page?.markdown).toContain("DeepgramSTTService");
    for (const alias of [
      page?.url ?? "",
      page?.markdownUrl ?? "",
      "/docs/services/stt/deepgram",
      "docs/services/stt/deepgram.md",
      "services/stt/deepgram/#overview",
      "pipedog://docs/services/stt/deepgram",
    ]) {
      expect(docs.page(alias)?.slug).toBe("services/stt/deepgram");
    }
  });

  test("the home page", () => {
    for (const alias of ["index", "", "/docs", "/docs/", "docs.md"]) {
      expect(docs.page(alias)?.slug).toBe("index");
    }
  });

  test("an unknown page, with suggestions", () => {
    expect(docs.page("services/stt/nope")).toBeNull();
    expect(docs.similar("stt/deepgram")).toContain("services/stt/deepgram");
  });

  test("every page has its Markdown, and sections split at headings", () => {
    for (const page of docs.pages) {
      expect(page.markdown).toStartWith(`# ${page.title}`);
      expect(splitSections(page).length).toBeGreaterThan(0);
    }
    const headings = splitSections(docs.page("services/stt/deepgram")!).map((s) => s.anchor);
    expect(headings[0]).toBeNull();
    expect(headings).toContain("overview");
  });
});

describe("list_pages", () => {
  test("every page, or one section", () => {
    expect(docs.list().length).toBe(docs.pages.length);
    expect(docs.pages.length).toBeGreaterThan(100);
    const services = docs.list("Services");
    expect(services.length).toBeGreaterThan(20);
    expect(services.every((p) => p.section === "Services")).toBe(true);
    const stt = docs.list("services/stt");
    expect(stt.map((p) => p.slug)).toContain("services/stt/deepgram");
    expect(stt.every((p) => p.slug.startsWith("services/stt"))).toBe(true);
    expect(docs.list("speech-to-text").map((p) => p.slug)).toEqual(stt.map((p) => p.slug));
    expect(docs.list("no such section")).toEqual([]);
  });

  test("coming-soon pages are marked", () => {
    expect(docs.list("transports").find((p) => p.slug === "transports/daily")?.comingSoon).toBe(
      true,
    );
    expect(docs.list("transports").find((p) => p.slug === "transports/websocket")?.comingSoon).toBe(
      false,
    );
  });
});

describe("get_api", () => {
  test("a class: import, constructor and its options interface", () => {
    const { found, text } = docs.api.describe("DeepgramSTTService");
    expect(found).toBe(true);
    expect(text).toContain('import { DeepgramSTTService } from "@pipedog/deepgram/stt";');
    expect(text).toContain("constructor(options: DeepgramSTTServiceOptions);");
    expect(text).toContain("export interface DeepgramSTTServiceOptions extends STTServiceOptions");
    expect(text).toContain("apiKey: string;");
    expect(text).toContain("Extends: `STTService`");
    expect(text).toContain("services/stt/deepgram");
  });

  test("a function", () => {
    const { found, text } = docs.api.describe("createTask");
    expect(found).toBe(true);
    expect(text).toContain('from "@pipedog/asyncio"');
    expect(text).toContain("export declare function createTask<T>(");
  });

  test("case-insensitive, scoped, and suggestions", () => {
    expect(docs.api.describe("pipelineworker").found).toBe(true);
    expect(docs.api.find("@pipedog/core:Frame").every((e) => e.package === "@pipedog/core")).toBe(
      true,
    );
    const missing = docs.api.describe("DeepgramSTT");
    expect(missing.found).toBe(false);
    expect(missing.text).toContain("DeepgramSTTService");
  });
});
