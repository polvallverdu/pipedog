// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// What the benchmarks against Pipecat share (tools/bench/perf.ts,
// tools/bench/concurrency.ts): a bundle per runtime built with the compat
// harness helpers, the Pipecat venv, running a process with its peak memory,
// quantiles, versions, and writing a generated section into a docs page.

import { existsSync, readFileSync, statSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import { ROOT } from "../compat/packages.ts";
import {
  bundle,
  moduleUrlPlugin,
  nodeBuiltinsPlugin,
  provideOptionalPeers,
  wasmModulesPlugin,
} from "../compat/runners.ts";

export { ROOT };
export const VENV = join(ROOT, "node_modules", ".cache", "pipedog-bench", "py");
export const PYTHON = join(VENV, "bin", "python");

export type JsRuntime = "bun" | "node" | "deno" | "workerd";

export interface Build {
  dir: string;
  /** The command that runs the bundle (empty for workerd, which is served). */
  cmd: string[];
  bytes: number;
  /** workerd Wasm/Data modules next to the bundle. */
  wasm: string[];
}

/**
 * Bundles `entry` (module source, written to `<dir>/entry.mjs`) for `rt` into
 * `<dir>/bundle.mjs`, as an app is deployed, with the optional peers it uses
 * (onnxruntime-node) resolvable from `dir`.
 */
export async function buildBundle(rt: JsRuntime, dir: string, entry: string): Promise<Build> {
  await Bun.$`rm -rf ${dir} && mkdir -p ${dir}`.quiet();
  const entryFile = join(dir, "entry.mjs");
  await Bun.write(entryFile, entry);
  const wasm: string[] = [];
  const err = await bundle(
    entryFile,
    dir,
    rt === "workerd"
      ? {
          target: "browser",
          conditions: ["workerd", "worker", "browser"],
          plugins: [wasmModulesPlugin(dir, wasm)],
        }
      : rt === "deno"
        ? {
            target: "browser",
            conditions: ["deno"],
            plugins: [moduleUrlPlugin(), nodeBuiltinsPlugin()],
            banner:
              'import { createRequire as __pdCreateRequire } from "node:module"; var require = __pdCreateRequire(import.meta.url);',
          }
        : { target: rt, plugins: [moduleUrlPlugin()] },
  );
  if (err) throw new Error(`${rt} bundle: ${err}`);
  const out = join(dir, "bundle.mjs");
  if (rt !== "workerd") provideOptionalPeers(dir, []);
  // With optional peers, Deno must read the package.json written next to the bundle.
  const denoConfig = existsSync(join(dir, "package.json")) ? [] : ["--no-config"];
  const cmd =
    rt === "bun"
      ? [process.execPath, out]
      : rt === "node"
        ? ["node", out]
        : rt === "deno"
          ? ["deno", "run", "-A", ...denoConfig, "--no-lock", out]
          : [];
  return { dir, cmd, bytes: statSync(out).size, wasm };
}

/** Creates the Pipecat venv (uv, Python 3.13) from the pinned upstream checkout, if missing. */
export async function ensureVenv(): Promise<void> {
  if (existsSync(PYTHON)) return;
  process.stderr.write("creating the Pipecat venv (uv, Python 3.13)...\n");
  await Bun.$`uv venv -q --python 3.13 ${VENV}`;
  await Bun.$`uv pip install -q --python ${PYTHON} ${`${join(ROOT, ".upstream", "pipecat")}[google]`}`;
}

export interface Measured<T = any> {
  result: T;
  /** Spawn to exit. */
  wallMs: number;
  /** Peak resident memory of the process, from /usr/bin/time. */
  peakRss: number | null;
}

/**
 * Runs `cmd` with `args` as JSON in `PIPEDOG_BENCH_ARGS`, and parses the line
 * of its stdout that starts with `mark`.
 */
export async function runProcess<T = any>(
  cmd: string[],
  args: unknown,
  cwd: string,
  mark: string,
  timeoutMs = 600_000,
): Promise<Measured<T>> {
  const env = { ...process.env, PIPEDOG_BENCH_ARGS: JSON.stringify(args ?? {}) };
  const t0 = performance.now();
  const proc = Bun.spawn(["/usr/bin/time", "-l", ...cmd], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  const wallMs = performance.now() - t0;
  const line = stdout.split("\n").find((l) => l.startsWith(mark));
  if (!line) throw new Error(`${cmd.join(" ")} failed:\n${stderr.slice(-3000)}`);
  const rss = /(\d+)\s+maximum resident set size/.exec(stderr);
  return {
    result: JSON.parse(line.slice(mark.length)),
    wallMs,
    peakRss: rss ? Number(rss[1]) : null,
  };
}

export const quantile = (xs: ArrayLike<number>, q: number): number => {
  const s = Array.from(xs)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!s.length) return Number.NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
};
export const median = (xs: ArrayLike<number>): number => quantile(xs, 0.5);

export function machine() {
  return {
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${process.platform} ${release()}`,
  };
}

export function versions(): Record<string, string> {
  const run = (cmd: string[]) => Bun.spawnSync(cmd).stdout.toString().trim().split("\n")[0]!.trim();
  const pipecatCommit = JSON.parse(readFileSync(join(ROOT, "upstream.json"), "utf8")).commit;
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8"));
  return {
    pipedog: pkg.version,
    pipecat: `${pipecatCommit.slice(0, 10)} (pinned upstream)`,
    python: existsSync(PYTHON)
      ? run([PYTHON, "-c", "import platform;print(platform.python_version())"])
      : "",
    bun: Bun.version,
    node: run(["node", "--version"]).replace(/^v/, ""),
    deno: run(["deno", "--version"]).split(" ")[1] ?? "",
    workerd: JSON.parse(readFileSync(join(ROOT, "node_modules", "workerd", "package.json"), "utf8"))
      .version,
  };
}

/** Writes `report` as formatted JSON to `file` (in the layout the repo's formatter checks). */
export async function writeReport(file: string, report: unknown): Promise<void> {
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  await Bun.$`bunx biome format --write ${file}`.cwd(ROOT).quiet();
  console.log(`wrote ${file}`);
}

/** Replaces what is between `{/* <name>:start *\/}` and `{/* <name>:end *\/}` in `page` with `text`. */
export async function writeSection(page: string, name: string, text: string): Promise<void> {
  const content = await Bun.file(page).text();
  const START = `{/* ${name}:start */}`;
  const END = `{/* ${name}:end */}`;
  const a = content.indexOf(START);
  const b = content.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${page}: no ${START} ... ${END} section`);
  await Bun.write(page, `${content.slice(0, a + START.length)}\n\n${text}\n\n${content.slice(b)}`);
  console.log(`wrote ${page}`);
}
