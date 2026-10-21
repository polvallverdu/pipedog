// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Live mode against a local HTTP server: the docs come from the site, and a slow or broken site
// falls back to the snapshot.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_OUT } from "../scripts/snapshot.ts";
import { loadDocs } from "../src/load.ts";
import { call, connect, SETUP_TIMEOUT_MS, testSnapshotPath } from "./helpers.ts";

const MARKER = "zyxlivemarker";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let snapshotPath: string;
let llmsTxt: string;
let llmsFull: string;

beforeAll(() => {
  snapshotPath = testSnapshotPath();
  llmsTxt = readFileSync(join(DOCS_OUT, "llms.txt"), "utf8");
  // The live docs differ from the snapshot: a word only they have, on the Deepgram STT page.
  llmsFull = readFileSync(join(DOCS_OUT, "llms-full.txt"), "utf8").replace(
    /^(Source: \S+\/docs\/services\/stt\/deepgram\/)$/m,
    `$1\n\nThe ${MARKER} is only on the live site.`,
  );
  expect(llmsFull).toContain(MARKER);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/slow/")) {
        await Bun.sleep(5_000);
        return new Response("too late");
      }
      if (pathname === "/ok/llms.txt") return new Response(llmsTxt);
      if (pathname === "/ok/llms-full.txt") return new Response(llmsFull);
      if (pathname === "/empty/llms.txt" || pathname === "/empty/llms-full.txt")
        return new Response("# nothing here\n");
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  server?.stop(true);
});

describe("loadDocs, live", () => {
  test("reads the docs from the site", async () => {
    const logs: string[] = [];
    const docs = await loadDocs({
      live: true,
      siteUrl: `${base}/ok`,
      snapshotPath,
      log: (m) => logs.push(m),
    });
    expect(docs.source).toBe("live");
    expect(logs.join("\n")).toContain("live docs:");
    const [first] = docs.search(MARKER);
    expect(first?.slug).toBe("services/stt/deepgram");
    expect(docs.page("services/stt/deepgram")?.markdown).toContain(MARKER);
    expect(docs.pages.length).toBe(docs.list().length);
    // The API index still comes from the snapshot.
    expect(docs.api.describe("DeepgramSTTService").found).toBe(true);
  });

  test("a slow site times out and falls back to the snapshot", async () => {
    const logs: string[] = [];
    const started = performance.now();
    const docs = await loadDocs({
      live: true,
      siteUrl: `${base}/slow`,
      timeoutMs: 200,
      snapshotPath,
      log: (m) => logs.push(m),
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(docs.source).toBe("snapshot");
    expect(logs.join("\n")).toContain("timed out after 200 ms");
    expect(docs.search(MARKER)).toEqual([]);
    expect(docs.search("deepgram")[0]?.slug).toBe("services/stt/deepgram");
  });

  test("an HTTP error or an empty site falls back to the snapshot", async () => {
    for (const path of ["missing", "empty"]) {
      const logs: string[] = [];
      const docs = await loadDocs({
        live: true,
        siteUrl: `${base}/${path}`,
        snapshotPath,
        log: (m) => logs.push(m),
      });
      expect(docs.source).toBe("snapshot");
      expect(logs.join("\n")).toContain("using the bundled snapshot");
    }
  });

  test("no snapshot: live docs are used without --live, and both failing is an error", async () => {
    const docs = await loadDocs({ siteUrl: `${base}/ok`, snapshotPath: "/nonexistent/docs.json" });
    expect(docs.source).toBe("live");
    expect(docs.api.entries).toEqual([]);
    await expect(
      loadDocs({ siteUrl: `${base}/missing`, snapshotPath: "/nonexistent/docs.json" }),
    ).rejects.toThrow(/no docs snapshot.*HTTP 404/);
  });
});

describe("CLI, live", () => {
  test("--live --docs-url", async () => {
    const client = await connect([
      "--live",
      "--docs-url",
      `${base}/ok`,
      "--snapshot",
      snapshotPath,
    ]);
    try {
      const { text } = await call(client, "search_docs", { query: MARKER });
      expect(text).toContain("slug: services/stt/deepgram");
      expect((await call(client, "list_pages")).text).toContain(", live)");
    } finally {
      await client.close();
    }
  });

  test("PIPEDOG_MCP_LIVE and PIPEDOG_DOCS_URL, with a timeout fallback", async () => {
    const client = await connect([], {
      PIPEDOG_MCP_LIVE: "1",
      PIPEDOG_DOCS_URL: `${base}/slow`,
      PIPEDOG_MCP_TIMEOUT_MS: "200",
      PIPEDOG_MCP_SNAPSHOT: snapshotPath,
    });
    try {
      const { text } = await call(client, "search_docs", { query: "deepgram", limit: 1 });
      expect(text).toContain("slug: services/stt/deepgram");
      expect((await call(client, "list_pages")).text).toContain(", snapshot)");
    } finally {
      await client.close();
    }
  });
});
