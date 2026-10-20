// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime compatibility harness. Runs each package's smoke test (its
// `compat/smoke.ts`, or a default that imports every public entry) on Bun,
// Node, Deno and workerd, prints a package x runtime matrix, and with
// --write records the passing runtimes in `pipecat.runtimes`.
//
//   bun tools/compat/run.ts [--package <name>] [--runtime <rt>] [--write] [--with-optional-peers]
//
// --package and --runtime may be repeated (or comma-separated).
//
// By default, optional peer dependencies (peerDependenciesMeta optional, e.g.
// core's @opentelemetry/api) that the package under test does not itself
// require are made unresolvable, as for a consumer who never installed them.
// --with-optional-peers resolves them from the workspace instead.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  discoverPackages,
  optionalPeersToHide,
  type PackageInfo,
  RUNTIMES,
  type Runtime,
  rel,
  writeDefaultSmoke,
  writeRuntimes,
} from "./packages.ts";
import { OUT_ROOT, type RunResult, runSmoke } from "./runners.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    package: { type: "string", multiple: true },
    runtime: { type: "string", multiple: true },
    write: { type: "boolean", default: false },
    "with-optional-peers": { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "usage: bun tools/compat/run.ts [--package <name>] [--runtime <bun|node|deno|workerd>] [--write] [--with-optional-peers] [--verbose]",
  );
  process.exit(0);
}

const split = (xs: string[] | undefined) => (xs ?? []).flatMap((x) => x.split(",")).filter(Boolean);

const wantedRuntimes = split(values.runtime);
for (const rt of wantedRuntimes) {
  if (!(RUNTIMES as readonly string[]).includes(rt)) {
    console.error(`unknown runtime ${rt}; expected one of ${RUNTIMES.join(", ")}`);
    process.exit(2);
  }
}
const runtimes: Runtime[] = wantedRuntimes.length ? (wantedRuntimes as Runtime[]) : [...RUNTIMES];

const all = await discoverPackages();
const wantedPackages = split(values.package);
const packages: PackageInfo[] = wantedPackages.length
  ? wantedPackages.map((name) => {
      const p = all.find((x) => x.name === name || x.name === `@pipedog/${name}`);
      if (!p) {
        console.error(`unknown package ${name}`);
        process.exit(2);
      }
      return p;
    })
  : all;

const slug = (name: string) => name.replace(/^@/, "").replace(/\//g, "__");

type Row = { pkg: PackageInfo; smokeLabel: string; results: Partial<Record<Runtime, RunResult>> };
const rows: Row[] = [];

for (const pkg of packages) {
  const row: Row = { pkg, smokeLabel: "", results: {} };
  rows.push(row);
  let smoke: string;
  try {
    if (pkg.smoke) {
      smoke = pkg.smoke;
      row.smokeLabel = rel(pkg.smoke);
    } else {
      const dir = join(OUT_ROOT, slug(pkg.name));
      mkdirSync(dir, { recursive: true });
      smoke = await writeDefaultSmoke(pkg, dir);
      row.smokeLabel = "default (import all public entries)";
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    for (const rt of runtimes) row.results[rt] = { ok: false, error, detail: error, notes: [] };
    continue;
  }
  const hidden = values["with-optional-peers"] ? [] : optionalPeersToHide(pkg, all);
  if (hidden.length) row.smokeLabel += ` (without optional peers: ${hidden.join(", ")})`;
  for (const rt of runtimes) {
    process.stderr.write(`running ${pkg.name} on ${rt}...\n`);
    row.results[rt] = await runSmoke(rt, smoke, slug(pkg.name), hidden);
  }
}

// ---------------------------------------------------------------------------
// Report

const CELL = 48;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (r: RunResult | undefined) =>
  !r ? "-" : r.ok ? "✅" : `❌ ${clip(r.error.replace(/\s+/g, " "), CELL - 3)}`;
// ✅ and ❌ render two columns wide in terminals.
const width = (s: string) => [...s].reduce((n, ch) => n + (ch === "✅" || ch === "❌" ? 2 : 1), 0);
const nameWidth = Math.max(7, ...rows.map((r) => r.pkg.name.length));
const widths = runtimes.map((rt) =>
  Math.max(rt.length, ...rows.map((r) => width(cell(r.results[rt])))),
);
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));
const line = (cols: string[]) =>
  `| ${pad(cols[0]!, nameWidth)} | ${cols
    .slice(1)
    .map((c, i) => pad(c, widths[i]!))
    .join(" | ")} |`;

console.log();
console.log(line(["package", ...runtimes]));
console.log(`|${"-".repeat(nameWidth + 2)}|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
for (const r of rows) console.log(line([r.pkg.name, ...runtimes.map((rt) => cell(r.results[rt]))]));
console.log();

let failures = 0;
for (const r of rows) {
  const notes = runtimes.flatMap((rt) => (r.results[rt]?.notes ?? []).map((n) => `${rt}: ${n}`));
  const failed = runtimes.filter((rt) => r.results[rt] && !r.results[rt]!.ok);
  failures += failed.length;
  if (!notes.length && !failed.length && !values.verbose) continue;
  console.log(`${r.pkg.name}  [smoke: ${r.smokeLabel}]`);
  for (const n of notes) console.log(`  note  ${n}`);
  for (const rt of failed) {
    const res = r.results[rt]!;
    console.log(`  ❌ ${rt}: ${res.error}`);
    if (values.verbose) {
      const detail = res.detail.trim().split("\n").slice(0, 25).join("\n      ");
      console.log(`      ${detail}`);
    }
  }
}

if (values.write) {
  console.log();
  for (const r of rows) {
    const results: Partial<Record<Runtime, boolean>> = {};
    for (const rt of runtimes) results[rt] = r.results[rt]?.ok ?? false;
    const written = await writeRuntimes(r.pkg, results);
    console.log(`wrote ${rel(r.pkg.pkgJsonPath)}: pipecat.runtimes = ${JSON.stringify(written)}`);
  }
}

process.exit(failures ? 1 : 0);
