// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Turn a workspace package into what npm should receive. In the repo,
// packages export their TypeScript sources (no build step for Bun, tests or
// the compat harness). Published packages must export compiled JavaScript:
// Node refuses to strip types inside node_modules, and consumers need .d.ts.
//
// - exports/main/types: ./src/**/*.ts -> ./dist/**/*.js (+ .d.ts for types)
// - "workspace:*" ranges -> the exact version (one fixed version for all)
// - LICENSE and NOTICE copied in (BSD-2-Clause requires the notice in every
//   redistribution); THIRD_PARTY_LICENSES.md kept where present

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");

export type Manifest = Record<string, any>;

export interface Pkg {
  dir: string;
  manifest: Manifest;
}

/** Publishable workspace packages (not private), by name. */
export function publishablePackages(): Map<string, Pkg> {
  const out = new Map<string, Pkg>();
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const dir = join(ROOT, "packages", name);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!manifest.private) out.set(manifest.name, { dir, manifest });
  }
  return out;
}

function toDist(path: string, kind: "js" | "dts"): string {
  if (!path.startsWith("./src/") || !path.endsWith(".ts")) return path;
  const base = path.slice("./src/".length, -".ts".length);
  return `./dist/${base}${kind === "js" ? ".js" : ".d.ts"}`;
}

/** Rewrite one `exports` target (string or condition object) to dist. */
function exportTarget(target: unknown): unknown {
  if (typeof target === "string") {
    if (!target.endsWith(".ts")) return target; // e.g. ./wasm/x.wasm
    return { types: toDist(target, "dts"), default: toDist(target, "js") };
  }
  if (target && typeof target === "object") {
    const out: Record<string, unknown> = {};
    for (const [cond, value] of Object.entries(target)) {
      out[cond] = cond === "types" ? toDist(value as string, "dts") : exportTarget(value);
    }
    // A condition object whose targets became objects: flatten `{types, default}` where it was a string.
    for (const [cond, value] of Object.entries(out)) {
      if (cond !== "types" && value && typeof value === "object" && "default" in value) {
        out[cond] = (value as { default: string }).default;
        if (!("types" in out)) out.types = (value as { types: string }).types;
      }
    }
    // `types` must come first for TypeScript's resolution.
    if ("types" in out) {
      const { types, ...rest } = out;
      return { types, ...rest };
    }
    return out;
  }
  return target;
}

/** The manifest to publish, given the version every @pipedog package releases at. */
export function publishManifest(manifest: Manifest, versions: Map<string, string>): Manifest {
  const m: Manifest = structuredClone(manifest);
  if (m.exports) {
    const exports: Record<string, unknown> = {};
    for (const [key, target] of Object.entries(m.exports)) exports[key] = exportTarget(target);
    m.exports = exports;
    const root = exports["."] as { types?: string; default?: string } | string | undefined;
    if (root && typeof root === "object") {
      if (root.default) m.main = root.default;
      if (root.types) m.types = root.types;
    }
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = m[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) continue;
      const version = versions.get(dep);
      if (!version)
        throw new Error(`${m.name}: ${dep} is ${range} but not a publishable workspace package`);
      deps[dep] = version;
    }
  }
  // A workspace sibling used only by the package's tests has no version to
  // point at and is no use to a consumer, so it is dropped.
  const devDeps = m.devDependencies as Record<string, string> | undefined;
  if (devDeps) {
    for (const [dep, range] of Object.entries(devDeps)) {
      if (range.startsWith("workspace:")) delete devDeps[dep];
    }
  }
  // Published packages run the compiled dist/ only: no TypeScript sources
  // (or the source maps pointing at them). Licenses always go in.
  const files = new Set<string>((m.files ?? ["dist"]).filter((f: string) => f !== "src"));
  for (const f of ["LICENSE", "NOTICE"]) files.add(f);
  if (m.__hasThirdPartyLicenses) files.add("THIRD_PARTY_LICENSES.md");
  delete m.__hasThirdPartyLicenses;
  m.files = [...files];
  return m;
}

/** Write the publish manifest and license files into `dir` (a package dir or a staged copy). */
export function preparePackageDir(dir: string, manifest: Manifest, versions: Map<string, string>) {
  const withNotices = {
    ...manifest,
    __hasThirdPartyLicenses: existsSync(join(dir, "THIRD_PARTY_LICENSES.md")),
  };
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(publishManifest(withNotices, versions), null, 2)}\n`,
  );
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(ROOT, "NOTICE"), join(dir, "NOTICE"));
  removeSourceMaps(join(dir, "dist"));
}

/** Delete *.map files under `dir`: they point at src/, which is not published. */
function removeSourceMaps(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeSourceMaps(path);
    else if (entry.name.endsWith(".map")) rmSync(path);
  }
}

/**
 * Problems with a prepared package directory (empty when fine): every `files` entry must exist,
 * and @pipedog/mcp must bundle a docs snapshot made for this release and the production site
 * (packages/mcp/scripts/snapshot.ts writes it).
 */
export function checkPackageFiles(dir: string, m: Manifest): string[] {
  const problems: string[] = [];
  for (const f of m.files ?? []) {
    if (!existsSync(join(dir, f))) problems.push(`"files" lists ${f}, which is missing`);
  }
  if (m.name === "@pipedog/mcp") {
    const path = join(dir, "snapshot", "docs.json");
    if (!existsSync(path)) {
      problems.push("no docs snapshot: run `bun packages/mcp/scripts/snapshot.ts --build`");
    } else {
      const s = JSON.parse(readFileSync(path, "utf8"));
      if (s.version !== m.version)
        problems.push(`the docs snapshot is for ${s.version}, not ${m.version}`);
      if (s.siteUrl !== "https://polvallverdu.github.io/pipedog")
        problems.push(`the docs snapshot links to ${s.siteUrl}, not the docs site`);
      if (!(s.pages?.length > 0) || !(s.api?.length > 0))
        problems.push("the docs snapshot has no pages or no API");
    }
  }
  return problems;
}

/** Problems with a manifest about to be published (empty when fine). */
export function checkPublishManifest(m: Manifest): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(m);
  if (text.includes("workspace:")) problems.push("still has a workspace: range");
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (/\.ts$/.test(v) && !v.endsWith(".d.ts"))
        problems.push(`${path} points at TypeScript source ${v}`);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(m.exports, "exports");
  walk(m.main, "main");
  if (!m.types) problems.push("no top-level types");
  if (!m.repository?.url?.includes("github.com/polvallverdu/pipedog"))
    problems.push("repository does not match the GitHub repo");
  return problems;
}
