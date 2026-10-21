// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A snapshot of the real docs for the tests, generated like the release one (from the docs
// build and the packages' .d.ts) into node_modules/.cache. Builds whatever input is missing:
// the docs build takes a minute on a fresh checkout.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DOCS_OUT,
  generateSnapshot,
  PACKAGES_DIR,
  ROOT,
  writeSnapshot,
} from "../scripts/snapshot.ts";
import { Docs } from "../src/docs.ts";
import { readSnapshot } from "../src/snapshot.ts";

export const PACKAGE_DIR = join(import.meta.dir, "..");
export const TEST_SNAPSHOT = join(ROOT, "node_modules/.cache/pipedog-mcp-test/docs.json");
/** For beforeAll: the docs build, on a fresh checkout. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${p.stderr.toString()}\n${p.stdout.toString()}`);
  }
}

let ready: string | null = null;

/** The path of a snapshot of the current docs, made once per test run. */
export function testSnapshotPath(): string {
  if (ready) return ready;
  if (!existsSync(join(DOCS_OUT, "llms.txt"))) run(["bun", "run", "docs:build"]);
  const packages = readdirSync(PACKAGES_DIR).filter((d) =>
    existsSync(join(PACKAGES_DIR, d, "tsconfig.json")),
  );
  if (packages.some((d) => !existsSync(join(PACKAGES_DIR, d, "dist")))) {
    run(["bunx", "tsc", "-b", ...packages.map((d) => join("packages", d, "tsconfig.json"))]);
  }
  writeSnapshot(generateSnapshot({ expectedSiteUrl: null }), TEST_SNAPSHOT);
  ready = TEST_SNAPSHOT;
  return ready;
}

let docs: Docs | null = null;

export function testDocs(): Docs {
  docs ??= new Docs(readSnapshot(testSnapshotPath()));
  return docs;
}

export const BIN = join(PACKAGE_DIR, "src/bin.ts");

/** Spawn the server with `args` and connect a client to it. */
export async function connect(args: string[], env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "pipedog-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as TextResult;
  return { text: result.content.map((c) => c.text).join("\n"), isError: !!result.isError };
}
