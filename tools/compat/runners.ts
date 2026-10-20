// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One runner per target runtime. Each takes a smoke module (default export:
// async function that throws on failure) and reports pass/fail plus the first
// error line. Non-Bun runtimes run a bundle built with Bun.build, so TS and
// workspace resolution never get in the way of what we want to measure: does
// the code itself run there.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";
import { ROOT, type Runtime } from "./packages.ts";

export interface RunResult {
  ok: boolean;
  /** First meaningful error line (empty on success). */
  error: string;
  /** Full diagnostic output on failure. */
  detail: string;
  /** Extra observations (e.g. whether node type stripping works without a bundle). */
  notes: string[];
  /** What the smoke function returned (JSON), if anything; used by tools/bench.ts. */
  result?: unknown;
}

const OK_MARK = "__COMPAT_OK__";
const FAIL_MARK = "__COMPAT_FAIL__";
const RESULT_MARK = "__COMPAT_RESULT__";
const TIMEOUT_MS = 60_000;
/** A compatibility date workerd 1.20261005.1 supports. */
const COMPATIBILITY_DATE = "2026-10-01";

/** Scratch directory for bundles; node_modules is gitignored and excluded from biome. */
export const OUT_ROOT = join(ROOT, "node_modules", ".cache", "pipedog-compat");

/**
 * What the smoke test can read about this run: `globalThis.__PIPEDOG_COMPAT__.hiddenModules`
 * lists the optional peers made unresolvable (see `hideModulesPlugin`).
 */
function compatGlobal(hidden: string[]): string {
  return `globalThis.__PIPEDOG_COMPAT__ = ${JSON.stringify({ hiddenModules: hidden })};`;
}

/** Process entry for bun/node/deno: runs the smoke test and prints a marker. */
function processEntry(smoke: string, hidden: string[]): string {
  return [
    `import smoke from ${JSON.stringify(smoke)};`,
    compatGlobal(hidden),
    "const exit = (c) => (globalThis.Deno ? globalThis.Deno.exit(c) : globalThis.process.exit(c));",
    "try {",
    "  const result = await smoke();",
    `  if (result !== undefined) console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result));`,
    `  console.log(${JSON.stringify(OK_MARK)});`,
    "  exit(0);",
    "} catch (e) {",
    `  console.error(${JSON.stringify(FAIL_MARK)} + " " + (e && e.stack ? e.stack : String(e)));`,
    "  exit(1);",
    "}",
    "",
  ].join("\n");
}

/** Worker module entry for workerd: the fetch handler runs the smoke test. */
function workerEntry(smoke: string, hidden: string[]): string {
  return [
    `import smoke from ${JSON.stringify(smoke)};`,
    compatGlobal(hidden),
    "export default {",
    "  async fetch() {",
    "    try {",
    "      const result = await smoke();",
    "      return Response.json({ ok: true, result });",
    "    } catch (e) {",
    "      return Response.json({ ok: false, error: e && e.stack ? e.stack : String(e) });",
    "    }",
    "  },",
    "};",
    "",
  ].join("\n");
}

const ERROR_LINE = /(\b[A-Z]\w*Error\b|\berror\b|Uncaught|Cannot|not found|not supported)/i;

function firstErrorLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const failAt = lines.findIndex((l) => l.startsWith(FAIL_MARK));
  if (failAt >= 0) return lines[failAt]!.slice(FAIL_MARK.length).trim();
  return lines.find((l) => ERROR_LINE.test(l) && !l.startsWith("at ")) ?? lines[0] ?? "";
}

function fail(error: string, detail = error, notes: string[] = []): RunResult {
  return { ok: false, error: error || "unknown failure", detail, notes };
}

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function exec(cmd: string[], cwd = ROOT): Promise<Exec> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

function judge(r: Exec, notes: string[] = []): RunResult {
  const all = `${r.stderr}\n${r.stdout}`;
  if (r.timedOut) return fail(`timed out after ${TIMEOUT_MS / 1000}s`, all, notes);
  if (r.code === 0 && r.stdout.includes(OK_MARK)) {
    const line = r.stdout.split("\n").find((l) => l.startsWith(RESULT_MARK));
    const result = line ? JSON.parse(line.slice(RESULT_MARK.length)) : undefined;
    return { ok: true, error: "", detail: "", notes, result };
  }
  return fail(firstErrorLine(all) || `exit code ${r.code}`, all, notes);
}

function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface BundleOptions {
  target: "node" | "browser" | "bun";
  conditions?: string[];
  plugins?: BunPlugin[];
  /** Bare specifiers to make unresolvable (optional peers a consumer did not install). */
  hidden?: string[];
  /** Code prepended to the bundle. */
  banner?: string;
}

/**
 * Resolves each hidden specifier (and its subpaths) to a module that throws
 * "Cannot find module" when evaluated, so a static import fails and a dynamic
 * `import()` rejects, as when the package is not installed. Resolving it to a
 * virtual module (rather than leaving it external) keeps the runtime from
 * finding the workspace copy in node_modules.
 */
function hideModulesPlugin(hidden: string[]): BunPlugin {
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const filter = new RegExp(`^(${hidden.map(escapeRegExp).join("|")})(/.*)?$`);
  return {
    name: "compat-hidden-modules",
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "compat-hidden" }));
      build.onLoad({ filter: /.*/, namespace: "compat-hidden" }, (args) => ({
        contents: `throw new Error(${JSON.stringify(`Cannot find module '${args.path}' (hidden by tools/compat: optional peer not installed)`)});`,
        loader: "js",
      }));
    },
  };
}

/**
 * Keeps each workspace module's own `import.meta.url` in a bundle, as an
 * installed (unbundled) package has, so files shipped next to the sources
 * (models, wasm) are found where they would be.
 */
function moduleUrlPlugin(): BunPlugin {
  return {
    name: "keep-import-meta-url",
    setup(build) {
      build.onLoad({ filter: /\/packages\/[^/]+\/src\/.*\.ts$/ }, (args) => {
        const text = readFileSync(args.path, "utf8");
        if (!text.includes("import.meta.url")) return undefined;
        const url = JSON.stringify(pathToFileURL(args.path).href);
        return { contents: text.replaceAll("import.meta.url", url), loader: "ts" };
      });
    },
  };
}

/**
 * Optional peer dependencies of workspace packages (e.g. onnxruntime-node),
 * which packages import at runtime. Make them resolvable from the bundle in
 * `dir`, as they are for a user who installed them: symlinks in
 * `<dir>/node_modules` and a package.json listing them (Deno resolves bare
 * specifiers through it). Only peers the bundle mentions are provided, and
 * never a hidden one: a computed `import(name)` that the bundler cannot see
 * must fail to resolve too.
 */
function provideOptionalPeers(dir: string, hidden: string[]): void {
  const code = readFileSync(join(dir, "bundle.mjs"), "utf8");
  const deps: Record<string, string> = {};
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const pkgDir = join(ROOT, "packages", name);
    const file = join(pkgDir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const [peer, meta] of Object.entries(pkg.peerDependenciesMeta ?? {})) {
      if (!(meta as { optional?: boolean }).optional || peer in deps || hidden.includes(peer))
        continue;
      if (!code.includes(JSON.stringify(peer))) continue;
      const installed = join(pkgDir, "node_modules", peer);
      if (!existsSync(installed)) continue;
      const target = realpathSync(installed);
      const link = join(dir, "node_modules", peer);
      mkdirSync(dirname(link), { recursive: true });
      rmSync(link, { force: true, recursive: true });
      symlinkSync(target, link, "dir");
      deps[peer] = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
    }
  }
  if (Object.keys(deps).length === 0) return;
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: deps }, null, 2)}\n`,
  );
}

/** Bundle `entry` to `<dir>/bundle.mjs`. Returns null on success, else the error text. */
async function bundle(entry: string, dir: string, opts: BundleOptions): Promise<string | null> {
  try {
    const out = await Bun.build({
      entrypoints: [entry],
      outdir: dir,
      naming: "bundle.mjs",
      target: opts.target,
      format: "esm",
      conditions: opts.conditions,
      ...(opts.banner ? { banner: opts.banner } : {}),
      external: ["node:*", "cloudflare:*"],
      plugins: [
        ...(opts.hidden?.length ? [hideModulesPlugin(opts.hidden)] : []),
        ...(opts.plugins ?? []),
      ],
    });
    if (!out.success) return out.logs.map(formatBuildLog).join("\n") || "bundle failed";
    return null;
  } catch (e) {
    const err = e as AggregateError;
    const logs = err.errors?.map(formatBuildLog).join("\n");
    return logs || String(e);
  }
}

/** A build log line with the importing file, so resolve errors say where they come from. */
function formatBuildLog(log: unknown): string {
  const l = log as { message?: string; position?: { file?: string; line?: number } | null };
  const file = l.position?.file;
  const where = file ? ` (in ${file.replace(`${ROOT}/`, "")}:${l.position?.line ?? "?"})` : "";
  return `${l.message ?? String(log)}${where}`;
}

// ---------------------------------------------------------------------------
// bun

async function runBun(smoke: string, dir: string, hidden: string[]): Promise<RunResult> {
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke, hidden));
  if (!hidden.length) return judge(await exec([process.execPath, "run", entry]));
  // Hiding modules needs the bundler's resolver; run the bundle instead of the sources.
  const err = await bundle(entry, dir, { target: "bun", hidden, plugins: [moduleUrlPlugin()] });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err);
  // Optional peers the package may use (not hidden) must resolve from the bundle's dir.
  provideOptionalPeers(dir, hidden);
  return judge(await exec([process.execPath, "run", join(dir, "bundle.mjs")]));
}

// ---------------------------------------------------------------------------
// node

function nodeMajor(): number | null {
  const r = Bun.spawnSync(["node", "--version"]);
  const m = /^v(\d+)/.exec(r.stdout.toString().trim());
  return m ? Number(m[1]) : null;
}

async function runNode(smoke: string, dir: string, hidden: string[]): Promise<RunResult> {
  const major = nodeMajor();
  if (major == null) return fail("node not found on PATH");
  if (major < 22) return fail(`node ${major} < 22`);

  // Also report whether node can run the TypeScript sources directly (it
  // resolves from node_modules, so hidden modules are not hidden there).
  const notes: string[] = [];
  const stripEntry = join(dir, "entry-strip.mjs");
  await Bun.write(stripEntry, processEntry(smoke, []));
  const strip = judge(
    await exec(["node", "--experimental-strip-types", "--no-warnings", stripEntry]),
  );
  notes.push(strip.ok ? "type-stripping: ok" : `type-stripping: fails (${strip.error})`);

  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke, hidden));
  const err = await bundle(entry, dir, { target: "node", hidden, plugins: [moduleUrlPlugin()] });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err, notes);
  provideOptionalPeers(dir, hidden);
  return judge(await exec(["node", join(dir, "bundle.mjs")]), notes);
}

// ---------------------------------------------------------------------------
// deno

/**
 * Bare Node builtin specifiers (`"dgram"`, `"crypto"`), which a browser-target
 * build rejects, become external `node:` imports, which Deno provides.
 */
function nodeBuiltinsPlugin(): BunPlugin {
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const names = builtinModules.filter((m) => !m.startsWith("_") && !m.startsWith("node:"));
  const filter = new RegExp(`^(${names.map(escapeRegExp).join("|")})$`);
  return {
    name: "deno-node-builtins",
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: `node:${args.path}`, external: true }));
    },
  };
}

async function runDeno(smoke: string, dir: string, hidden: string[]): Promise<RunResult> {
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke, hidden));
  const err = await bundle(entry, dir, {
    target: "browser",
    conditions: ["deno"],
    hidden,
    plugins: [moduleUrlPlugin(), nodeBuiltinsPlugin()],
    // CommonJS dependencies `require()` Node builtins; give them Deno's require.
    banner:
      'import { createRequire as __pdCreateRequire } from "node:module"; var require = __pdCreateRequire(import.meta.url);',
  });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err);
  provideOptionalPeers(dir, hidden);
  // With optional peers, Deno must read the package.json written next to the bundle.
  const configFlags = existsSync(join(dir, "package.json")) ? [] : ["--no-config"];
  return judge(
    await exec(["deno", "run", "-A", ...configFlags, "--no-lock", join(dir, "bundle.mjs")], dir),
  );
}

// ---------------------------------------------------------------------------
// workerd

/**
 * Turns `.wasm` imports into external workerd Wasm modules copied next to the
 * bundle, and `.onnx` imports into Data modules (an ArrayBuffer), the way a
 * Worker can be handed model bytes (wrangler's `Data` rule).
 */
function wasmModulesPlugin(dir: string, modules: string[]): BunPlugin {
  return {
    name: "workerd-wasm-modules",
    setup(build) {
      build.onResolve({ filter: /\.(wasm|onnx)(\?module)?$/ }, (args) => {
        const spec = args.path.replace(/\?module$/, "");
        const abs = Bun.resolveSync(spec, dirname(args.importer));
        const name = `wasm/${modules.length}-${basename(abs)}`;
        mkdirSync(join(dir, "wasm"), { recursive: true });
        copyFileSync(abs, join(dir, name));
        modules.push(name);
        return { path: `./${name}`, external: true };
      });
    },
  };
}

function workerdConfig(port: number, wasm: string[]): string {
  const modules = [
    '(name = "bundle.mjs", esModule = embed "bundle.mjs")',
    ...wasm.map(
      (w) =>
        `(name = ${JSON.stringify(w)}, ${w.endsWith(".wasm") ? "wasm" : "data"} = embed ${JSON.stringify(w)})`,
    ),
  ];
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .smokeWorker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);

const smokeWorker :Workerd.Worker = (
  modules = [
    ${modules.join(",\n    ")}
  ],
  compatibilityDate = "${COMPATIBILITY_DATE}",
  compatibilityFlags = ["nodejs_compat"],
);
`;
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export function workerdBin(): string | null {
  const bin = join(ROOT, "node_modules", ".bin", "workerd");
  return existsSync(bin) ? bin : null;
}

async function runWorkerd(smoke: string, dir: string, hidden: string[]): Promise<RunResult> {
  const bin = workerdBin();
  if (!bin) return fail("workerd not installed (bun install at the repo root)");
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, workerEntry(smoke, hidden));
  const wasm: string[] = [];
  const err = await bundle(entry, dir, {
    target: "browser",
    conditions: ["workerd", "worker", "browser"],
    plugins: [wasmModulesPlugin(dir, wasm)],
    hidden,
  });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err);

  const port = freePort();
  await Bun.write(join(dir, "config.capnp"), workerdConfig(port, wasm));
  const proc = Bun.spawn([bin, "serve", "config.capnp"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([o, e]) => `${e}\n${o}`);
  let exited = false;
  proc.exited.then(() => {
    exited = true;
  });

  try {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !exited) {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        await Bun.sleep(100);
        continue;
      }
      const body = await res.text();
      let parsed: { ok?: boolean; error?: string; result?: unknown } | null = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      proc.kill();
      const logs = await output;
      if (parsed?.ok) return { ok: true, error: "", detail: "", notes: [], result: parsed.result };
      if (parsed?.error) return fail(firstErrorLine(parsed.error), `${parsed.error}\n${logs}`);
      // The worker failed to load: workerd answers with an error page and logs why.
      return fail(firstErrorLine(logs) || `HTTP ${res.status}`, `${body}\n${logs}`);
    }
    proc.kill();
    const logs = await output;
    return fail(exited ? firstErrorLine(logs) || "workerd exited" : "timed out", logs);
  } finally {
    proc.kill();
  }
}

// ---------------------------------------------------------------------------

const RUNNERS: Record<
  Runtime,
  (smoke: string, dir: string, hidden: string[]) => Promise<RunResult>
> = {
  bun: runBun,
  node: runNode,
  deno: runDeno,
  workerd: runWorkerd,
};

/**
 * Run `smoke` on `runtime`. `hidden` lists bare specifiers (optional peers)
 * that must not resolve, as for a consumer who did not install them.
 */
export async function runSmoke(
  runtime: Runtime,
  smoke: string,
  pkgSlug: string,
  hidden: string[] = [],
): Promise<RunResult> {
  const dir = freshDir(join(OUT_ROOT, pkgSlug, runtime));
  try {
    return await RUNNERS[runtime](smoke, dir, hidden);
  } catch (e) {
    return fail(`harness error: ${e instanceof Error ? e.message : String(e)}`, String(e));
  }
}
