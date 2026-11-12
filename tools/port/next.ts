// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Select the next porting work from porting/manifest.json and pack it into
// work units for the port workflow. Prints JSON.
//
//   bun tools/port/next.ts modules [--mvp] [--package @pipedog/x] [--modules a,b] [--max-lines 3500]
//   bun tools/port/next.ts tests   [--package @pipedog/x] [--mvp] [--limit 40]
//
// `modules` returns units of related modules (same directory first) up to
// --max-lines of Python each. `tests` returns upstream test files whose
// imported modules (and their dependencies) are all ported.

import { readFileSync } from "node:fs";

interface Mod {
  module: string;
  upstream: string;
  ts: string;
  lines: number;
  package: string;
  status: string;
  mvp: boolean;
  deps: string[];
  layer: number;
  notes: string;
  portedAt?: string | null;
}
interface TestEntry {
  file: string;
  ts: string;
  lines: number;
  package: string;
  status: string;
  imports: string[];
}

const manifest = JSON.parse(readFileSync("porting/manifest.json", "utf8")) as {
  modules: Mod[];
  tests: TestEntry[];
};
const [kind, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? "true") : undefined;
};
const done = (s: string) => s === "ported" || s === "tested" || s === "skipped";
const byName = new Map(manifest.modules.map((m) => [m.module, m]));

function allDepsPorted(mods: string[]): string[] {
  const missing = new Set<string>();
  const seen = new Set<string>();
  const stack = [...mods];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const m = byName.get(name);
    if (!m) continue;
    if (!done(m.status)) missing.add(name);
    stack.push(...m.deps);
  }
  return [...missing];
}

if (kind === "modules") {
  const maxLines = Number(flag("max-lines") ?? 3500);
  const only = flag("modules")?.split(",");
  let todo = manifest.modules.filter((m) => !done(m.status));
  if (flag("mvp")) todo = todo.filter((m) => m.mvp);
  if (flag("package")) todo = todo.filter((m) => m.package === flag("package"));
  if (only) todo = todo.filter((m) => only.includes(m.module));

  // Group by package + directory, then pack directories into units.
  const dirOf = (m: Mod) => `${m.package}:${m.module.split(".").slice(0, -1).join(".")}`;
  const groups = new Map<string, Mod[]>();
  for (const m of todo.sort((a, b) => a.module.localeCompare(b.module))) {
    if (!groups.has(dirOf(m))) groups.set(dirOf(m), []);
    groups.get(dirOf(m))!.push(m);
  }
  const units: Mod[][] = [];
  let current: Mod[] = [];
  let currentLines = 0;
  let currentPkg = "";
  const flush = () => {
    if (current.length) units.push(current);
    current = [];
    currentLines = 0;
  };
  for (const mods of groups.values()) {
    for (const m of mods) {
      // Big modules get a unit of their own.
      if (m.lines >= maxLines) {
        units.push([m]);
        continue;
      }
      if (currentLines + m.lines > maxLines || (currentPkg && m.package !== currentPkg)) flush();
      current.push(m);
      currentLines += m.lines;
      currentPkg = m.package;
    }
  }
  flush();
  console.log(
    JSON.stringify(
      units.map((mods, i) => ({
        id: `u${String(i + 1).padStart(2, "0")}`,
        package: mods[0]!.package,
        lines: mods.reduce((a, m) => a + m.lines, 0),
        modules: mods.map(({ module, upstream, ts, lines, status, notes, portedAt }) => ({
          module,
          upstream,
          ts,
          lines,
          status,
          notes,
          portedAt,
        })),
      })),
    ),
  );
} else if (kind === "tests") {
  const limit = Number(flag("limit") ?? 1000);
  let todo = manifest.tests.filter((t) => !done(t.status));
  if (flag("package")) todo = todo.filter((t) => t.package === flag("package"));
  const ready = todo
    .map((t) => ({ ...t, missing: allDepsPorted(t.imports) }))
    .filter((t) => t.missing.length === 0)
    .filter((t) => !flag("mvp") || t.imports.every((m) => byName.get(m)?.mvp))
    .sort((a, b) => a.lines - b.lines)
    .slice(0, limit);
  console.log(
    JSON.stringify(
      ready.map(({ file, ts, lines, package: pkg, imports }) => ({
        file,
        ts,
        lines,
        package: pkg,
        imports,
      })),
    ),
  );
} else {
  console.error("usage: next.ts modules|tests [...]");
  process.exit(1);
}
