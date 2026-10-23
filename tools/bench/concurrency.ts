// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Concurrency benchmark: how many simultaneous calls one process serves in
// real time, with every call on one event loop ("single") or spread over one
// worker thread per core ("workers"), on Bun, Node and Deno, against upstream
// Pipecat in one asyncio process (and in one process per core). The calls are
// in tools/bench/concurrency/pipedog.ts and pipecat_concurrency.py, written
// the same way: a voice bot without the network, in two profiles,
// "io" (cloud services: timers only) and "local" (Silero VAD and Smart Turn).
//
// Each run is a fresh process with N calls; levels go up until a series
// breaks, and the series take turns at each level.
//
//   bun run bench:concurrency [--profile io,local] [--runtime python,bun,node,deno]
//     [--mode single,workers,pool] [--levels 1,10,25,50,100,200,400,800] [--duration 6]
//     [--warmup 2] [--write]
//
// Shorter: `--levels 1,25,100 --duration 4`. `--render --write` re-renders the
// tables from the saved results. --write saves
// tools/bench/perf/concurrency.json and the tables in
// apps/docs/content/docs/deployment/threads.mdx.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { OUT_ROOT } from "../compat/runners.ts";
import {
  type Build,
  buildBundle,
  ensureVenv,
  machine,
  PYTHON,
  ROOT,
  runProcess,
  versions,
  writeReport,
  writeSection,
} from "./common.ts";
import type { ConcurrencyArgs } from "./concurrency/pipedog.ts";

const RUNTIMES = ["python", "bun", "node", "deno"] as const;
type Rt = (typeof RUNTIMES)[number];
const PROFILES = ["io", "local"] as const;
type Profile = (typeof PROFILES)[number];
/**
 * "workers" is one process per core for Python (multiprocessing). "pool"
 * (pipedog, local profile): calls on one thread, Smart Turn on worker threads.
 */
const MODES = ["single", "workers", "pool"] as const;
type Mode = (typeof MODES)[number];

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runtime: { type: "string", multiple: true },
    profile: { type: "string", multiple: true },
    mode: { type: "string", multiple: true },
    levels: { type: "string" },
    duration: { type: "string" },
    warmup: { type: "string" },
    write: { type: "boolean", default: false },
    render: { type: "boolean", default: false },
  },
});
const split = (v?: string[]) => v?.flatMap((s) => s.split(","));
const runtimes = (split(values.runtime) ?? [...RUNTIMES]) as Rt[];
const profiles = (split(values.profile) ?? [...PROFILES]) as Profile[];
const modes = (split(values.mode) ?? [...MODES]) as Mode[];
const LEVELS = (values.levels ?? "1,10,25,50,100,200,400,800").split(",").map(Number);
const DURATION_S = Number(values.duration ?? 6);
const WARMUP_S = Number(values.warmup ?? 2);

/**
 * The real-time budget for an input frame's p99 latency: one frame (20 ms).
 * A frame that waits longer than the frame after it is due means audio queues
 * up behind a busy loop: VAD, turn detection and interruptions react late,
 * and the bot's own audio leaves late.
 */
const BUDGET_MS = 20;
/** A series stops after a level this far over budget, or one that drops frames. */
const BROKEN_MS = 10 * BUDGET_MS;

/**
 * Pipecat loads a Silero and a Smart Turn session per call (about 35 MB), so
 * its local-model runs stop here before the machine runs out of memory.
 */
const MAX_PYTHON_LOCAL_CALLS = 400;

const DIR = join(OUT_ROOT, "concurrency");
const REPORT = join(ROOT, "tools", "bench", "perf", "concurrency.json");
const PAGE = join(ROOT, "apps", "docs", "content", "docs", "deployment", "threads.mdx");
const SCRIPT_TS = join(ROOT, "tools", "bench", "concurrency", "pipedog.ts");
const SCRIPT_PY = join(ROOT, "tools", "bench", "concurrency", "pipecat_concurrency.py");
const WAV = join(ROOT, "packages", "audio-silero", "test", "assets", "continuous_speech_16k.wav");
const RESULT_MARK = "__CONCURRENCY_RESULT__";

const entry = () =>
  `import { main } from ${JSON.stringify(SCRIPT_TS)};\nawait main(${JSON.stringify(RESULT_MARK)});\n`;

interface Run {
  runtime: Rt;
  profile: Profile;
  mode: Mode;
  calls: number;
  ok: boolean;
  error?: string;
  wallMs?: number;
  peakRss?: number | null;
  result?: any;
}

function command(rt: Rt, builds: Partial<Record<Rt, Build>>): { cmd: string[]; cwd: string } {
  if (rt === "python") return { cmd: [PYTHON, SCRIPT_PY], cwd: ROOT };
  const b = builds[rt]!;
  return { cmd: b.cmd, cwd: b.dir };
}

const realTime = (r: Run) =>
  r.ok &&
  r.result.latency.p99 != null &&
  r.result.latency.p99 <= BUDGET_MS &&
  r.result.inputFrames >= 0.98 * r.result.expectedInputFrames;

const broken = (r: Run) =>
  !r.ok ||
  r.result.latency.p99 == null ||
  r.result.latency.p99 > BROKEN_MS ||
  r.result.inputFrames < 0.9 * r.result.expectedInputFrames;

async function main() {
  if (values.render) {
    // Re-render the tables from the saved results.
    const report = await Bun.file(REPORT).json();
    report.runs = report.runs.filter(
      (r: Run) =>
        !(r.runtime === "python" && r.profile === "local" && r.calls > MAX_PYTHON_LOCAL_CALLS),
    );
    const tables = renderTables(report);
    console.log(tables);
    if (values.write) await writeSection(PAGE, "concurrency", tables);
    return;
  }
  if (runtimes.includes("python")) await ensureVenv();
  const builds: Partial<Record<Rt, Build>> = {};
  for (const rt of runtimes) {
    if (rt === "python") continue;
    process.stderr.write(`building for ${rt}...\n`);
    builds[rt] = await buildBundle(rt, join(DIR, rt), entry());
  }

  const runs: Run[] = [];
  const t0 = performance.now();
  for (const profile of profiles) {
    const series = runtimes
      .flatMap((runtime) => modes.map((mode) => ({ runtime, mode })))
      .filter(
        ({ runtime, mode }) => mode !== "pool" || (runtime !== "python" && profile === "local"),
      );
    const stopped = new Set<string>();
    for (const calls of LEVELS) {
      for (const { runtime, mode } of series) {
        const key = `${runtime}/${mode}`;
        if (stopped.has(key)) continue;
        if (runtime === "python" && profile === "local" && calls > MAX_PYTHON_LOCAL_CALLS) continue;
        const args: ConcurrencyArgs = {
          profile,
          mode,
          calls,
          warmupS: WARMUP_S,
          durationS: DURATION_S,
          wav: WAV,
        };
        const { cmd, cwd } = command(runtime, builds);
        const label = `${profile} ${runtime} ${mode} ${calls} calls`;
        let run: Run;
        try {
          const m = await runProcess(cmd, args, cwd, RESULT_MARK, 180_000);
          // Python's "workers" are processes: their peak memory adds up.
          const peakRss = Math.max(m.peakRss ?? 0, m.result.peakRssSum ?? 0) || null;
          run = { runtime, profile, mode, calls, ok: true, ...m, peakRss };
          const r = m.result;
          process.stderr.write(
            `${label}: p50 ${r.latency.p50?.toFixed(1)} p99 ${r.latency.p99?.toFixed(1)} ms, lag p99 ${r.lag.p99?.toFixed(1)} ms, cpu ${r.cpuPct?.toFixed(0)}%, rss ${((peakRss ?? 0) / 2 ** 20).toFixed(0)} MB, frames ${r.inputFrames}/${r.expectedInputFrames}, turns ${r.turnPredictions}${r.errors.length ? `, errors: ${r.errors[0]}` : ""}  [${((performance.now() - t0) / 1000).toFixed(0)} s]\n`,
          );
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).slice(-1500);
          run = { runtime, profile, mode, calls, ok: false, error };
          process.stderr.write(`${label}: ❌ ${error.slice(-400)}\n`);
        }
        runs.push(run);
        if (broken(run)) stopped.add(key);
      }
    }
  }

  const report = {
    date: new Date().toISOString().slice(0, 10),
    machine: machine(),
    versions: versions(),
    budgetMs: BUDGET_MS,
    warmupS: WARMUP_S,
    durationS: DURATION_S,
    levels: LEVELS,
    runs,
  };
  const tables = renderTables(report);
  console.log(`\n${tables}\n`);
  if (values.write) {
    await writeReport(REPORT, report);
    await writeSection(PAGE, "concurrency", tables);
  }
}

const LABEL: Record<Rt, string> = {
  python: "Pipecat · CPython",
  bun: "pipedog · Bun",
  node: "pipedog · Node",
  deno: "pipedog · Deno",
};
const JS_MODES = {
  single: "one thread",
  workers: "worker per core",
  pool: "one thread, Smart Turn on workers",
};
const MODE_LABEL: Record<Rt, Record<Mode, string>> = {
  python: { single: "one process", workers: "process per core", pool: "" },
  bun: JS_MODES,
  node: JS_MODES,
  deno: JS_MODES,
};

function renderTables(report: { runs: Run[]; [k: string]: any }): string {
  const fmt = (x: number | null | undefined, digits = 0) =>
    x == null || !Number.isFinite(x)
      ? "–"
      : x.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const v = report.versions as Record<string, string>;
  const lines: string[] = [];
  const PROFILE_SHORT: Record<Profile, string> = {
    io: "cloud-service bot",
    local: "local-model bot",
  };
  const PROFILE_TITLE: Record<Profile, string> = {
    io: "Cloud-service bot (I/O-bound)",
    local: "Local-model bot (Silero VAD + Smart Turn)",
  };
  for (const profile of PROFILES) {
    const runs = report.runs.filter((r) => r.profile === profile);
    if (!runs.length) continue;
    const series = RUNTIMES.flatMap((rt) => MODES.map((mode) => ({ rt, mode }))).filter(
      ({ rt, mode }) => runs.some((r) => r.runtime === rt && r.mode === mode),
    );
    const levels = [...new Set(runs.map((r) => r.calls))].sort((a, b) => a - b);
    lines.push(
      `### ${PROFILE_TITLE[profile]}`,
      "",
      "**Max real-time calls**: the most calls (of the levels run) with p99 input latency within",
      `${report.budgetMs} ms. Each cell: p99 input latency · CPU (100% = one core) · peak memory.`,
      "",
      `| | Max real-time calls | ${levels.map((n) => `${n} call${n === 1 ? "" : "s"}`).join(" | ")} |`,
      `|---|---:|${levels.map(() => "---:").join("|")}|`,
    );
    for (const { rt, mode } of series) {
      const mine = runs.filter((r) => r.runtime === rt && r.mode === mode);
      const ok = mine.filter(realTime).map((r) => r.calls);
      // The largest level in budget. One run per level: an isolated miss below it is a one-off
      // stall, and stays visible in its cell.
      const max = Math.max(0, ...ok);
      const top = Math.max(...mine.map((r) => r.calls));
      const maxLabel = max === top ? `≥ ${max}` : `${max}`;
      const cells = levels.map((n) => {
        const r = mine.find((x) => x.calls === n);
        if (!r) return "";
        if (!r.ok) return "failed";
        const res = r.result;
        const lat =
          res.latency.p99 > 1000
            ? `${fmt(res.latency.p99 / 1000, 1)} s`
            : `${fmt(res.latency.p99, 1)} ms`;
        const mark = realTime(r) ? "" : " ✗";
        return `${lat}${mark} · ${fmt(res.cpuPct)}% · ${fmt((r.peakRss ?? Number.NaN) / 2 ** 20)} MB`;
      });
      lines.push(`| ${LABEL[rt]}, ${MODE_LABEL[rt][mode]} | ${maxLabel} | ${cells.join(" | ")} |`);
    }
    lines.push("");
    // Event-loop lag, the other half of the picture.
    lines.push(
      "<details>",
      `<summary>Event-loop lag (p99 timer drift) and median input latency, ${PROFILE_SHORT[profile]}, in ms</summary>`,
      "",
      `| | ${levels.map((n) => `${n} call${n === 1 ? "" : "s"}`).join(" | ")} |`,
      `|---|${levels.map(() => "---:").join("|")}|`,
    );
    for (const { rt, mode } of series) {
      const mine = runs.filter((r) => r.runtime === rt && r.mode === mode);
      const cells = levels.map((n) => {
        const r = mine.find((x) => x.calls === n);
        if (!r?.ok) return r ? "failed" : "";
        return `lag ${fmt(r.result.lag.p99, 1)} · p50 ${fmt(r.result.latency.p50, 1)}`;
      });
      lines.push(`| ${LABEL[rt]}, ${MODE_LABEL[rt][mode]} | ${cells.join(" | ")} |`);
    }
    lines.push("", "</details>", "");
  }
  const failures = report.runs.filter((r) => !r.ok);
  if (failures.length) {
    lines.push(
      "Failed runs: " +
        failures
          .map(
            (r) =>
              `${LABEL[r.runtime]} ${MODE_LABEL[r.runtime][r.mode]}, ${r.profile}, ${r.calls} calls: ${firstLine(r.error ?? "")}`,
          )
          .join("; ") +
        ".",
      "",
    );
  }
  lines.push(
    `Measured ${report.date} on ${report.machine.cpu} (${report.machine.cores} cores, ${report.machine.memoryGb} GB), ${report.machine.os}: pipedog ${v.pipedog}, Pipecat ${v.pipecat} on CPython ${v.python}, Bun ${v.bun}, Node ${v.node}, Deno ${v.deno}. ${report.warmupS} s warm-up and ${report.durationS} s measured per run; ✗ = over budget.`,
  );
  return lines.join("\n");
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => /error/i.test(l)) ?? s.split("\n")[0] ?? "";
  return line.trim().slice(0, 160);
}

await main();
process.exit(0);
