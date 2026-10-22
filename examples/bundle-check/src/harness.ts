// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Bundle a sample bot with `bun build` (or `bun build --compile`) and run the
// output from a fresh temp directory that has no node_modules, as a deployed
// single-file app would run. Used by test/bundle.test.ts and, to reproduce a
// failure by hand, by
//
//   bun examples/bundle-check/src/harness.ts <bot.ts> [bun|compile] [--external=pkg ...] [KEY=value ...]
//
// `--external=pkg` is passed to `bun build` and the package is linked into the
// run directory's node_modules, as a host installs its externals. `KEY=value`
// sets an environment variable of the run. Set VERBOSE=1 for the whole log.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export type BuildMode = "bun" | "compile";

export interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
  buildOutput: string;
}

export interface BundleOptions {
  /** Added to a minimal environment (PATH, HOME, TMPDIR only). */
  env?: Record<string, string>;
  /** What a working run prints (default `BUNDLE_CHECK_OK`). */
  marker?: string;
  timeoutMs?: number;
  /** Keep the temp directory (its path is printed). */
  keep?: boolean;
  /** Packages left out of the bundle (`bun build --external`). */
  externals?: string[];
  /** Packages linked into the run directory's node_modules: the host's installed externals. */
  nodeModules?: string[];
  /** Extra arguments for `bun build`. */
  buildArgs?: string[];
}

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..", "..");

/** The real directory of an installed package: bun links dependencies per workspace package. */
function findPackage(name: string): string {
  const own = join(HERE, "..", "node_modules", name);
  if (existsSync(own)) return realpathSync(own);
  for (const group of ["packages", "examples"]) {
    for (const dir of readdirSync(join(REPO, group))) {
      const path = join(REPO, group, dir, "node_modules", name);
      if (existsSync(path)) return realpathSync(path);
    }
  }
  throw new Error(`${name} is not installed in any workspace package`);
}
const KEEP_ENV = ["PATH", "HOME", "TMPDIR", "SystemRoot"];

/**
 * Build `bot` (a file in src/) and run it in a clean directory. Resolves with the combined
 * output; `ok` is true when the process exited 0 and printed the marker.
 */
export async function bundleAndRun(
  bot: string,
  mode: BuildMode,
  options: BundleOptions = {},
): Promise<RunResult> {
  const work = mkdtempSync(join(tmpdir(), "pipedog-bundle-"));
  const outdir = join(work, "build");
  const run = join(work, "run");
  mkdirSync(run);
  try {
    const entry = join(HERE, bot);
    // Bun refuses `--outfile` when the bundle has assets (`with { type: "file" }`), so an outdir.
    const args =
      mode === "compile"
        ? ["build", "--compile", "--outfile", join(outdir, "bot"), entry]
        : ["build", "--target=bun", "--outdir", outdir, entry];
    for (const e of options.externals ?? []) args.push("--external", e);
    const build = Bun.spawn([process.execPath, ...args, ...(options.buildArgs ?? [])], {
      cwd: HERE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildOutput = `${await new Response(build.stdout).text()}${await new Response(build.stderr).text()}`;
    if ((await build.exited) !== 0) return { ok: false, code: null, output: "", buildOutput };

    // Everything the build wrote (the bundle and the files it imports) goes to the run directory.
    cpSync(outdir, run, { recursive: true });
    for (const name of options.nodeModules ?? []) {
      const target = join(run, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(findPackage(name), target);
    }
    const files = readdirSync(run);
    const cmd =
      mode === "compile"
        ? [join(run, "bot")]
        : // --no-install: without node_modules Bun would fetch missing packages from npm at run
          // time, which hides exactly the failures this checks for.
          [
            process.execPath,
            "--no-install",
            join(run, files.find((f) => f.endsWith(".js")) ?? basename(bot)),
          ];

    const env: Record<string, string> = {};
    for (const k of KEEP_ENV) if (process.env[k]) env[k] = process.env[k] as string;
    Object.assign(env, options.env);
    // Not the run directory: a service manager starts the bot from anywhere, so a path that is
    // only right relative to the working directory must fail here.
    const cwd = join(work, "cwd");
    mkdirSync(cwd);
    const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 60000);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    const output = out + err;
    return {
      ok: code === 0 && output.includes(options.marker ?? "BUNDLE_CHECK_OK"),
      code,
      output,
      buildOutput,
    };
  } finally {
    if (options.keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const externals = argv.filter((a) => a.startsWith("--external=")).map((a) => a.slice(11));
  const [bot, mode = "bun", ...envPairs] = argv.filter((a) => !a.startsWith("--external="));
  if (!bot)
    throw new Error("usage: harness.ts <bot.ts> [bun|compile] [--external=pkg] [KEY=value]");
  const env = Object.fromEntries(envPairs.map((p) => p.split(/=(.*)/s).slice(0, 2)));
  const result = await bundleAndRun(bot, mode as BuildMode, {
    env,
    externals,
    nodeModules: externals,
  });
  // Only the lines that matter, unless VERBOSE is set: the pipeline's debug log is long.
  const keep = (l: string) =>
    process.env.VERBOSE || /ERROR|WARNING|error|Error|BUNDLE_CHECK/.test(l);
  const seen = new Set<string>();
  const lines = result.output
    .split("\n")
    .filter(keep)
    .filter((l) => {
      const key = l.slice(26).replace(/#\d+/g, "#");
      return !seen.has(key) && seen.add(key);
    });
  console.log(`--- build\n${result.buildOutput}--- run (exit ${result.code})`);
  console.log(lines.map((l) => l.slice(0, 600)).join("\n"));
  process.exit(result.ok ? 0 : 1);
}
