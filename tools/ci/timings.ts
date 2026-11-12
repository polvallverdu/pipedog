// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Refresh .github/test-timings.json from a CI run: each test shard measures its own files and
// uploads them as the `test-timings-<shard>` artifact; this merges the four into the committed
// file that balances the shards. Measured on CI's runners, so the balance fits them, unlike
// `bun run test:timings` on a laptop.
//
//   bun tools/ci/timings.ts            the latest CI run of the current branch
//   bun tools/ci/timings.ts <run id>   a given run

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const TIMINGS = join(ROOT, ".github", "test-timings.json");

interface Timings {
  version: number;
  files: Record<string, unknown>;
}

function gh(args: string[]): string {
  const p = Bun.spawnSync(["gh", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed:\n${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function latestRun(): string {
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: ROOT })
    .stdout.toString()
    .trim();
  return gh([
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "databaseId",
    "-q",
    ".[0].databaseId",
  ]);
}

const runId = process.argv[2] ?? latestRun();
if (!runId) throw new Error("no CI run found; pass a run id");

const dir = mkdtempSync(join(tmpdir(), "pipedog-timings-"));
try {
  gh(["run", "download", runId, "--pattern", "test-timings-*", "--dir", dir]);
  const shards = readdirSync(dir).filter((name) => name.startsWith("test-timings-"));
  if (shards.length === 0) throw new Error(`run ${runId} has no test-timings artifacts`);

  const merged: Timings = { version: 1, files: {} };
  for (const shard of shards) {
    const timings = JSON.parse(readFileSync(join(dir, shard, "timings.json"), "utf8")) as Timings;
    merged.version = timings.version;
    Object.assign(merged.files, timings.files);
  }
  const files = Object.fromEntries(
    Object.entries(merged.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(TIMINGS, `${JSON.stringify({ ...merged, files }, null, 2)}\n`);
  console.log(`${Object.keys(files).length} files from ${shards.length} shards of run ${runId}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
