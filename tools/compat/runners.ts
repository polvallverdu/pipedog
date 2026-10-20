// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One runner per target runtime. Each takes a smoke module (default export:
// async function that throws on failure) and reports pass/fail plus the first
// error line. Non-Bun runtimes run a bundle built with Bun.build, so TS and
// workspace resolution never get in the way of what we want to measure: does
// the code itself run there.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
}

const OK_MARK = "__COMPAT_OK__";
const FAIL_MARK = "__COMPAT_FAIL__";
const TIMEOUT_MS = 60_000;
/** A compatibility date workerd 1.20261005.1 supports. */
const COMPATIBILITY_DATE = "2026-10-01";

/** Scratch directory for bundles; node_modules is gitignored and excluded from biome. */
export const OUT_ROOT = join(ROOT, "node_modules", ".cache", "pipecat-compat");

/** Process entry for bun/node/deno: runs the smoke test and prints a marker. */
function processEntry(smoke: string): string {
  return [
    `import smoke from ${JSON.stringify(smoke)};`,
    "const exit = (c) => (globalThis.Deno ? globalThis.Deno.exit(c) : globalThis.process.exit(c));",
    "try {",
    "  await smoke();",
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
function workerEntry(smoke: string): string {
  return [
    `import smoke from ${JSON.stringify(smoke)};`,
    "export default {",
    "  async fetch() {",
    "    try {",
    "      await smoke();",
    "      return Response.json({ ok: true });",
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
  if (r.code === 0 && r.stdout.includes(OK_MARK)) return { ok: true, error: "", detail: "", notes };
  return fail(firstErrorLine(all) || `exit code ${r.code}`, all, notes);
}

function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface BundleOptions {
  target: "node" | "browser";
  conditions?: string[];
  plugins?: BunPlugin[];
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
      external: ["node:*", "cloudflare:*"],
      plugins: opts.plugins,
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

async function runBun(smoke: string, dir: string): Promise<RunResult> {
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke));
  return judge(await exec([process.execPath, "run", entry]));
}

// ---------------------------------------------------------------------------
// node

function nodeMajor(): number | null {
  const r = Bun.spawnSync(["node", "--version"]);
  const m = /^v(\d+)/.exec(r.stdout.toString().trim());
  return m ? Number(m[1]) : null;
}

async function runNode(smoke: string, dir: string): Promise<RunResult> {
  const major = nodeMajor();
  if (major == null) return fail("node not found on PATH");
  if (major < 22) return fail(`node ${major} < 22`);

  // Also report whether node can run the TypeScript sources directly.
  const notes: string[] = [];
  const stripEntry = join(dir, "entry-strip.mjs");
  await Bun.write(stripEntry, processEntry(smoke));
  const strip = judge(
    await exec(["node", "--experimental-strip-types", "--no-warnings", stripEntry]),
  );
  notes.push(strip.ok ? "type-stripping: ok" : `type-stripping: fails (${strip.error})`);

  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke));
  const err = await bundle(entry, dir, { target: "node" });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err, notes);
  return judge(await exec(["node", join(dir, "bundle.mjs")]), notes);
}

// ---------------------------------------------------------------------------
// deno

async function runDeno(smoke: string, dir: string): Promise<RunResult> {
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, processEntry(smoke));
  const err = await bundle(entry, dir, { target: "browser", conditions: ["deno"] });
  if (err) return fail(`bundle: ${firstErrorLine(err)}`, err);
  return judge(
    await exec(["deno", "run", "-A", "--no-config", "--no-lock", join(dir, "bundle.mjs")], dir),
  );
}

// ---------------------------------------------------------------------------
// workerd

/** Turns `.wasm` imports into external workerd Wasm modules copied next to the bundle. */
function wasmModulesPlugin(dir: string, modules: string[]): BunPlugin {
  return {
    name: "workerd-wasm-modules",
    setup(build) {
      build.onResolve({ filter: /\.wasm(\?module)?$/ }, (args) => {
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
    ...wasm.map((w) => `(name = ${JSON.stringify(w)}, wasm = embed ${JSON.stringify(w)})`),
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

async function runWorkerd(smoke: string, dir: string): Promise<RunResult> {
  const bin = workerdBin();
  if (!bin) return fail("workerd not installed (bun install at the repo root)");
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, workerEntry(smoke));
  const wasm: string[] = [];
  const err = await bundle(entry, dir, {
    target: "browser",
    conditions: ["workerd", "worker", "browser"],
    plugins: [wasmModulesPlugin(dir, wasm)],
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
      let parsed: { ok?: boolean; error?: string } | null = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      proc.kill();
      const logs = await output;
      if (parsed?.ok) return { ok: true, error: "", detail: "", notes: [] };
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

const RUNNERS: Record<Runtime, (smoke: string, dir: string) => Promise<RunResult>> = {
  bun: runBun,
  node: runNode,
  deno: runDeno,
  workerd: runWorkerd,
};

export async function runSmoke(
  runtime: Runtime,
  smoke: string,
  pkgSlug: string,
): Promise<RunResult> {
  const dir = freshDir(join(OUT_ROOT, pkgSlug, runtime));
  try {
    return await RUNNERS[runtime](smoke, dir);
  } catch (e) {
    return fail(`harness error: ${e instanceof Error ? e.message : String(e)}`, String(e));
  }
}
