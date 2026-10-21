#!/usr/bin/env node
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `pipedog-mcp`: the pipedog docs MCP server over stdio.
 *
 *   npx -y @pipedog/mcp                 the docs bundled with this release (offline)
 *   npx -y @pipedog/mcp --live          the current docs from the site, falling back to the bundle
 *
 * Options (or environment variables):
 *   --live                PIPEDOG_MCP_LIVE=1        fetch the docs from the site
 *   --docs-url <url>      PIPEDOG_DOCS_URL          the site (default https://polvallverdu.github.io/pipedog)
 *   --timeout <ms>        PIPEDOG_MCP_TIMEOUT_MS    live mode's timeout (default 10000)
 *   --snapshot <file>     PIPEDOG_MCP_SNAPSHOT      a docs snapshot other than the bundled one
 */

import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_LIVE_TIMEOUT_MS } from "./live.ts";
import { docsLoader } from "./load.ts";
import { createServer } from "./server.ts";
import { DEFAULT_SITE_URL } from "./snapshot.ts";
import { VERSION } from "./version.ts";

const USAGE = `pipedog-mcp ${VERSION}: the pipedog docs as a local MCP server (stdio)

Usage: pipedog-mcp [--live] [--docs-url <url>] [--timeout <ms>] [--snapshot <file>]

  --live             fetch the current docs from the site; falls back to the bundled docs
                     (env PIPEDOG_MCP_LIVE=1)
  --docs-url <url>   the docs site (env PIPEDOG_DOCS_URL, default ${DEFAULT_SITE_URL})
  --timeout <ms>     live mode's timeout (env PIPEDOG_MCP_TIMEOUT_MS, default ${DEFAULT_LIVE_TIMEOUT_MS})
  --snapshot <file>  a docs snapshot other than the bundled one (env PIPEDOG_MCP_SNAPSHOT)
  --version, --help

Claude Code: claude mcp add pipedog -- npx -y @pipedog/mcp`;

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    "docs-url": { type: "string" },
    timeout: { type: "string" },
    snapshot: { type: "string" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

const env = process.env;
const truthy = (v: string | undefined) =>
  !!v && !["0", "false", "no", "off", ""].includes(v.toLowerCase());
const timeout = Number(values.timeout ?? env.PIPEDOG_MCP_TIMEOUT_MS ?? DEFAULT_LIVE_TIMEOUT_MS);
const log = (message: string) => process.stderr.write(`pipedog-mcp: ${message}\n`);

const docs = docsLoader({
  live: values.live ?? truthy(env.PIPEDOG_MCP_LIVE),
  siteUrl: values["docs-url"] ?? env.PIPEDOG_DOCS_URL ?? DEFAULT_SITE_URL,
  timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_LIVE_TIMEOUT_MS,
  snapshotPath: values.snapshot ?? env.PIPEDOG_MCP_SNAPSHOT,
  log,
});

const server = createServer({ docs });
await server.connect(new StdioServerTransport());
// Load (or fetch) the docs in the background, so the first tool call doesn't wait as long.
docs().catch((e: unknown) => log((e as Error).message));
