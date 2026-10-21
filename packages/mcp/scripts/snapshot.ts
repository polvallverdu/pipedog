// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Write the docs snapshot that @pipedog/mcp ships (snapshot/docs.json), from:
//   - the docs build (apps/docs/out): llms.txt and every page's Markdown, exactly as the site
//     serves them, so the code samples and option tables are the rendered ones;
//   - the packages' generated .d.ts (packages/*/dist): every exported declaration, for get_api.
//
// `bun run release` runs it with --build, after the package build, so every release bundles the
// docs of that release. --build rebuilds the docs for the production URL (DOCS_BASE_PATH=/pipedog)
// and the packages' .d.ts first; without it, the existing build outputs are used.
//
//   bun packages/mcp/scripts/snapshot.ts [--build] [--out <file>] [--docs <dir>] [--any-site]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Declaration, extractDeclarations, type ModuleDeclarations } from "../src/api.ts";
import {
  type ApiEntry,
  type ApiKind,
  DEFAULT_SITE_URL,
  type DocPage,
  parseLlmsIndex,
  SNAPSHOT_FORMAT,
  type Snapshot,
  siteUrlOf,
} from "../src/snapshot.ts";

export const ROOT = resolve(import.meta.dir, "../../..");
export const DOCS_OUT = join(ROOT, "apps/docs/out");
export const PACKAGES_DIR = join(ROOT, "packages");
export const SNAPSHOT_PATH = join(import.meta.dir, "../snapshot/docs.json");

export interface GenerateOptions {
  /** The docs build output (apps/docs/out). */
  docsOut?: string;
  /** The packages directory, whose dist/ folders hold the .d.ts. Null: no API index. */
  packagesDir?: string | null;
  /** Fail unless the docs were built for this site. Null: any site. */
  expectedSiteUrl?: string | null;
  /** The release version; defaults to @pipedog/core's. */
  version?: string;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The docs pages, from llms.txt and the per-page Markdown the docs build writes. */
export function readDocsPages(docsOut: string): {
  llmsTxt: string;
  siteUrl: string;
  pages: DocPage[];
} {
  const llmsPath = join(docsOut, "llms.txt");
  if (!existsSync(llmsPath)) {
    throw new Error(`${llmsPath} is missing: build the docs first (bun run docs:build)`);
  }
  const llmsTxt = readFileSync(llmsPath, "utf8");
  const siteUrl = siteUrlOf(llmsTxt);
  if (!siteUrl) throw new Error(`${llmsPath}: no site URL`);
  const pages: DocPage[] = [];
  const missing: string[] = [];
  for (const entry of parseLlmsIndex(llmsTxt, siteUrl)) {
    const file =
      entry.slug === "index" ? join(docsOut, "docs.md") : join(docsOut, "docs", `${entry.slug}.md`);
    if (!existsSync(file)) {
      missing.push(relative(docsOut, file));
      continue;
    }
    pages.push({ ...entry, markdown: readFileSync(file, "utf8").trimEnd() });
  }
  if (missing.length) throw new Error(`pages in llms.txt without Markdown: ${missing.join(", ")}`);
  if (pages.length === 0) throw new Error(`${llmsPath}: no pages`);
  // Every Markdown page should be in the index; a page that isn't would be unreachable.
  const listed = new Set(pages.map((p) => p.slug));
  const unlisted = markdownFiles(join(docsOut, "docs"))
    .map((f) => relative(join(docsOut, "docs"), f).replace(/\.md$/, ""))
    .filter((slug) => !listed.has(slug));
  if (unlisted.length)
    throw new Error(`Markdown pages missing from llms.txt: ${unlisted.join(", ")}`);
  return { llmsTxt, siteUrl, pages };
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? markdownFiles(join(dir, e.name))
      : e.name.endsWith(".md")
        ? [join(dir, e.name)]
        : [],
  );
}

function dtsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? dtsFiles(join(dir, e.name))
      : e.name.endsWith(".d.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** The import specifier of each source file a package exports: `src/stt.ts` -> `@pipedog/deepgram/stt`. */
function exportedModules(name: string, manifest: any, srcFiles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const exportsField =
    typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
  const target = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return target(o.default) ?? target(o.import) ?? target(o.types);
    }
    return null;
  };
  for (const [key, value] of Object.entries(exportsField)) {
    const t = target(value);
    if (!t?.endsWith(".ts") || key.endsWith("package.json")) continue;
    const file = t.replace(/^\.\//, "");
    const spec = key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`;
    if (!key.includes("*")) {
      if (!out.has(file)) out.set(file, spec);
      continue;
    }
    const [tPre, tSuf] = file.split("*") as [string, string];
    const [kPre, kSuf] = spec.split("*") as [string, string];
    for (const src of srcFiles) {
      if (src.startsWith(tPre) && src.endsWith(tSuf) && !out.has(src)) {
        out.set(src, `${kPre}${src.slice(tPre.length, src.length - tSuf.length)}${kSuf}`);
      }
    }
  }
  return out;
}

/** Every exported declaration of the published @pipedog/* packages, from their dist/*.d.ts. */
export function readApi(packagesDir: string): ApiEntry[] {
  const entries: ApiEntry[] = [];
  for (const dirName of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, dirName);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.private || manifest.name === "@pipedog/mcp") continue;
    const dist = join(dir, "dist");
    const files = dtsFiles(dist);
    if (files.length === 0) {
      throw new Error(
        `${manifest.name}: no .d.ts in ${dist}; build the packages first (bun run build)`,
      );
    }
    // src-relative paths: dist/flux/stt.d.ts <-> src/flux/stt.ts
    const modules = new Map<string, ModuleDeclarations>();
    for (const f of files) {
      const src = `src/${relative(dist, f).replace(/\.d\.ts$/, ".ts")}`;
      modules.set(src, extractDeclarations(readFileSync(f, "utf8")));
    }
    const specs = exportedModules(manifest.name, manifest, [...modules.keys()]);

    // Which declarations each exported module makes importable (its own, and re-exports).
    const resolveRel = (from: string, rel: string) => {
      const base = join(dirname(from), rel).replace(/\.(js|ts)$/, "");
      return [`${base}.ts`, `${base}/index.ts`].find((c) => modules.has(c)) ?? null;
    };
    const reachable = (src: string, seen = new Set<string>()): Map<string, [string, string]> => {
      // exported name -> [declaring file, declared name]
      const out = new Map<string, [string, string]>();
      if (seen.has(src)) return out;
      seen.add(src);
      const m = modules.get(src);
      if (!m) return out;
      for (const d of m.declarations) out.set(d.name, [src, d.name]);
      for (const rel of m.starExports) {
        const target = resolveRel(src, rel);
        if (target) for (const [k, v] of reachable(target, seen)) if (!out.has(k)) out.set(k, v);
      }
      for (const [exported, [rel, orig]] of m.namedExports) {
        const target = resolveRel(src, rel);
        const hit = target ? reachable(target, new Set(seen)).get(orig) : undefined;
        if (hit) out.set(exported, hit);
      }
      return out;
    };

    const importable = new Map<string, string[]>(); // "file#name" -> specifiers
    for (const [src, spec] of specs) {
      for (const [, [file, name]] of reachable(src)) {
        const key = `${file}#${name}`;
        const list = importable.get(key) ?? [];
        if (!list.includes(spec)) list.push(spec);
        importable.set(key, list);
      }
    }

    for (const [src, m] of modules) {
      const merged = new Map<string, Declaration[]>();
      for (const d of m.declarations) merged.set(d.name, [...(merged.get(d.name) ?? []), d]);
      for (const [name, decls] of merged) {
        const from = importable.get(`${src}#${name}`);
        if (!from) continue; // internal: not reachable from any export
        const own = specs.get(src);
        const module =
          own && from.includes(own) ? own : (from.sort((a, b) => b.length - a.length)[0] as string);
        entries.push({
          name,
          kinds: [...new Set(decls.map((d) => d.kind))] as ApiKind[],
          package: manifest.name,
          module,
          alsoFrom: from.filter((s) => s !== module).sort(),
          text: decls.map((d) => d.text).join("\n"),
        });
      }
    }
  }
  return entries;
}

export function generateSnapshot(options: GenerateOptions = {}): Snapshot {
  const docsOut = options.docsOut ?? DOCS_OUT;
  const { llmsTxt, siteUrl, pages } = readDocsPages(docsOut);
  const expected =
    options.expectedSiteUrl === undefined ? DEFAULT_SITE_URL : options.expectedSiteUrl;
  if (expected && siteUrl !== expected) {
    throw new Error(
      `the docs in ${docsOut} were built for ${siteUrl}, not ${expected}: rebuild them with DOCS_BASE_PATH=/pipedog (or pass --build)`,
    );
  }
  const packagesDir = options.packagesDir === undefined ? PACKAGES_DIR : options.packagesDir;
  return {
    format: SNAPSHOT_FORMAT,
    version: options.version ?? readJson(join(PACKAGES_DIR, "core/package.json")).version,
    siteUrl,
    llmsTxt,
    pages,
    api: packagesDir ? readApi(packagesDir) : [],
  };
}

export function writeSnapshot(snapshot: Snapshot, path = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
}

function run(cmd: string[], env: Record<string, string> = {}): void {
  console.log(
    `$ ${Object.entries(env)
      .map(([k, v]) => `${k}=${v} `)
      .join("")}${cmd.join(" ")}`,
  );
  const p = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${p.exitCode})`);
}

/** Build the inputs: the packages' .d.ts and the docs for the production URL. */
export function buildInputs(): void {
  const tsconfigs = readdirSync(PACKAGES_DIR)
    .map((d) => join("packages", d, "tsconfig.json"))
    .filter((f) => existsSync(join(ROOT, f)));
  run(["bunx", "tsc", "-b", ...tsconfigs]);
  run(["bun", "run", "docs:build"], { DOCS_BASE_PATH: new URL(DEFAULT_SITE_URL).pathname });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      build: { type: "boolean", default: false },
      out: { type: "string" },
      docs: { type: "string" },
      "any-site": { type: "boolean", default: false },
    },
  });
  if (values.build) buildInputs();
  const snapshot = generateSnapshot({
    docsOut: values.docs ? resolve(values.docs) : DOCS_OUT,
    expectedSiteUrl: values["any-site"] ? null : DEFAULT_SITE_URL,
  });
  const out = values.out ? resolve(values.out) : SNAPSHOT_PATH;
  writeSnapshot(snapshot, out);
  const size = readFileSync(out).length;
  console.log(
    `snapshot: pipedog ${snapshot.version}, ${snapshot.pages.length} pages, ${snapshot.api.length} API declarations, ${(size / 1024).toFixed(0)} KiB -> ${relative(process.cwd(), out)}`,
  );
}
