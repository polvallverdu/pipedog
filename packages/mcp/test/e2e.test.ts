// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The server end to end: spawn the CLI, talk to it over stdio with the MCP SDK's client, and
// call every tool and the resources.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BIN, call, connect, SETUP_TIMEOUT_MS, testSnapshotPath } from "./helpers.ts";

describe("stdio server", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(["--snapshot", testSnapshotPath()]);
  }, SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await client?.close();
  });

  test("identifies itself and lists the tools", async () => {
    expect(client.getServerVersion()?.name).toBe("pipedog-docs");
    expect(client.getInstructions()).toContain("search_docs");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_api",
      "list_pages",
      "read_page",
      "search_docs",
    ]);
    const search = tools.find((t) => t.name === "search_docs");
    expect(search?.inputSchema.required).toEqual(["query"]);
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });

  test("list_pages", async () => {
    const all = await call(client, "list_pages");
    expect(all.isError).toBe(false);
    expect(all.text).toContain("`services/stt/deepgram`: Deepgram");
    expect(all.text).toContain("## Services / Speech-to-text");
    const workers = await call(client, "list_pages", { section: "Deployment" });
    expect(workers.text).toContain("`deployment/cloudflare-workers`");
    expect(workers.text).not.toContain("services/stt");
    const none = await call(client, "list_pages", { section: "nope" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Sections:");
  });

  test("search_docs", async () => {
    const { text, isError } = await call(client, "search_docs", { query: "deepgram", limit: 3 });
    expect(isError).toBe(false);
    expect(text).toStartWith("1. Deepgram");
    expect(text).toContain("slug: services/stt/deepgram");
    expect(text.match(/^\d+\. /gm)?.length).toBe(3);
    const bad = await call(client, "search_docs", { query: "x", limit: 0 });
    expect(bad.isError).toBe(true);
  });

  test("read_page", async () => {
    const page = await call(client, "read_page", { slug: "deployment/cloudflare-workers" });
    expect(page.isError).toBe(false);
    expect(page.text).toStartWith("# ");
    expect(page.text).toContain("Durable Object");
    const missing = await call(client, "read_page", { slug: "services/stt/deepgramm" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("services/stt/deepgram");
  });

  test("get_api", async () => {
    const found = await call(client, "get_api", { symbol: "DeepgramSTTService" });
    expect(found.isError).toBe(false);
    expect(found.text).toContain("constructor(options: DeepgramSTTServiceOptions);");
    const missing = await call(client, "get_api", { symbol: "NoSuchThing" });
    expect(missing.isError).toBe(true);
  });

  test("resources: one per page, and llms.txt", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThan(100);
    expect(resources.map((r) => r.uri)).toContain("pipedog://docs/services/stt/deepgram");
    expect(resources.map((r) => r.uri)).toContain("pipedog://llms.txt");
    const { contents } = await client.readResource({ uri: "pipedog://docs/services/stt/deepgram" });
    expect(contents[0]?.mimeType).toBe("text/markdown");
    expect(String(contents[0]?.text)).toStartWith("# Deepgram");
    const llms = await client.readResource({ uri: "pipedog://llms.txt" });
    expect(String(llms.contents[0]?.text)).toStartWith("# pipedog");
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0]?.uriTemplate).toBe("pipedog://docs/{+slug}");
  });
});

describe("CLI", () => {
  test("--version and --help", () => {
    const version = Bun.spawnSync([process.execPath, BIN, "--version"]);
    expect(version.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = Bun.spawnSync([process.execPath, BIN, "--help"]);
    expect(help.stdout.toString()).toContain("claude mcp add pipedog -- npx -y @pipedog/mcp");
  });
});
