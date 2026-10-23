// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Performance benchmark: pipedog on Bun, Node, Deno and workerd against
// upstream Pipecat on CPython, with the same scenarios on both sides
// (tools/bench/perf/pipedog.ts and pipecat_bench.py):
//
// - startup: process start to a pipeline that has run (cold start), and peak memory
// - throughput: frames per second through 10 pass-through processors
// - hop: the time one frame takes through those 10 processors
// - llm, tts (with GOOGLE_API_KEY): Gemini time to first token / audio, through a
//   pipeline and with the SDK alone, so the framework's share can be told apart
//   from the network's
//
// Runtimes take turns within each round, so a slow minute on the network or the
// machine falls on all of them. Pipecat runs from the pinned upstream checkout in
// a venv made with uv (node_modules/.cache/pipedog-bench/py).
//
//   bun run bench:perf [--runtime bun,python] [--scenario hop] [--rounds 3] [--write]
//
// --write saves tools/bench/perf/results.json and the tables in
// apps/docs/content/docs/performance.mdx.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { freePort, OUT_ROOT, workerdBin, workerdConfig } from "../compat/runners.ts";
import {
  type Build,
  buildBundle,
  ensureVenv,
  type Measured,
  machine,
  median,
  PYTHON,
  quantile,
  ROOT,
  runProcess as runMarked,
  versions,
  writeReport,
  writeSection,
} from "./common.ts";
import type { PerfArgs } from "./perf/pipedog.ts";

const RUNTIMES = ["python", "bun", "node", "deno", "workerd"] as const;
type Rt = (typeof RUNTIMES)[number];
const SCENARIOS = ["startup", "throughput", "hop", "llm", "tts"] as const;
type Scenario = (typeof SCENARIOS)[number];

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runtime: { type: "string", multiple: true },
    scenario: { type: "string", multiple: true },
    rounds: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const split = (v?: string[]) => v?.flatMap((s) => s.split(","));
const runtimes = (split(values.runtime) ?? [...RUNTIMES]) as Rt[];
const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
const scenarios = (split(values.scenario) ??
  SCENARIOS.filter((s) => apiKey || (s !== "llm" && s !== "tts"))) as Scenario[];
const ROUNDS = Number(values.rounds ?? 3);

/** How many times each scenario runs per runtime per round, and its arguments. */
const PLAN: Record<Scenario, { runs: number; args: PerfArgs }> = {
  startup: { runs: 5, args: { scenario: "startup", processors: 10 } },
  throughput: { runs: 2, args: { scenario: "throughput", processors: 10, frames: 20_000 } },
  hop: { runs: 1, args: { scenario: "hop", processors: 10, frames: 2000 } },
  llm: { runs: 1, args: { scenario: "llm", requests: 6, llmModel: "gemini-3.5-flash-lite" } },
  tts: {
    runs: 1,
    args: { scenario: "tts", requests: 4, ttsModel: "gemini-3.8-flash-tts" },
  },
};

const DIR = join(OUT_ROOT, "perf");
const SCRIPT_TS = join(ROOT, "tools", "bench", "perf", "pipedog.ts");
const SCRIPT_PY = join(ROOT, "tools", "bench", "perf", "pipecat_bench.py");
const RESULT_MARK = "__PERF_RESULT__";

// ---------------------------------------------------------------------------
// Builds: one bundle per runtime, run many times.

/** Process entry: reads the arguments from the environment and prints the result. */
function processEntry(empty: boolean): string {
  return [
    empty ? "" : `import perf from ${JSON.stringify(SCRIPT_TS)};`,
    "const g = globalThis;",
    'const raw = g.Deno ? g.Deno.env.get("PIPEDOG_BENCH_ARGS") : g.process.env.PIPEDOG_BENCH_ARGS;',
    empty ? "const result = { empty: true };" : "const result = await perf(JSON.parse(raw));",
    `console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result));`,
    "g.Deno ? g.Deno.exit(0) : g.process.exit(0);",
    "",
  ].join("\n");
}

/** Worker entry: each POST runs one scenario with the JSON body as its arguments. */
function workerEntry(empty: boolean): string {
  return [
    empty ? "" : `import perf from ${JSON.stringify(SCRIPT_TS)};`,
    "export default {",
    "  async fetch(request) {",
    empty ? "    return Response.json({ ok: true, result: { empty: true } });" : "",
    "    try {",
    "      return Response.json({ ok: true, result: await perf(await request.json()) });",
    "    } catch (e) {",
    "      return Response.json({ ok: false, error: e && e.stack ? e.stack : String(e) });",
    "    }",
    "  },",
    "};",
    "",
  ].join("\n");
}

async function build(rt: Exclude<Rt, "python">, empty: boolean): Promise<Build> {
  const dir = join(DIR, `${rt}${empty ? "-empty" : ""}`);
  return buildBundle(rt, dir, rt === "workerd" ? workerEntry(empty) : processEntry(empty));
}

function pythonCmd(): string[] {
  return [PYTHON, SCRIPT_PY];
}

// ---------------------------------------------------------------------------
// Running

function runProcess(cmd: string[], args: PerfArgs | null, cwd: string): Promise<Measured> {
  return runMarked(cmd, args, cwd, RESULT_MARK);
}

/** A workerd process serving the bundle in `b.dir`. */
class Workerd {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private port = 0;

  constructor(private b: Build) {}

  /** Starts workerd and sends `args`; the wall time includes workerd's own start. */
  async start(args: PerfArgs): Promise<Measured> {
    const bin = workerdBin();
    if (!bin) throw new Error("workerd not installed (bun install at the repo root)");
    this.port = freePort();
    await Bun.write(join(this.b.dir, "config.capnp"), workerdConfig(this.port, this.b.wasm));
    const t0 = performance.now();
    this.proc = Bun.spawn([bin, "serve", "config.capnp"], {
      cwd: this.b.dir,
      stdout: "ignore",
      stderr: "ignore",
    });
    for (;;) {
      try {
        const result = await this.send(args);
        return { result, wallMs: performance.now() - t0, peakRss: null };
      } catch (e) {
        if (!(e instanceof TypeError) || performance.now() - t0 > 30_000) throw e;
        await Bun.sleep(2);
      }
    }
  }

  async send(args: PerfArgs): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.port}/`, {
      method: "POST",
      body: JSON.stringify(args),
    });
    const body = (await res.json()) as { ok: boolean; result?: any; error?: string };
    if (!body.ok) throw new Error(`workerd: ${body.error}`);
    return body.result;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

async function main() {
  if (runtimes.includes("python")) await ensureVenv();
  const builds: Partial<Record<Rt, Build>> = {};
  const empties: Partial<Record<Rt, Build>> = {};
  for (const rt of runtimes) {
    if (rt === "python") continue;
    process.stderr.write(`building for ${rt}...\n`);
    builds[rt] = await build(rt, false);
    empties[rt] = await build(rt, true);
  }
  // Python compiles its bytecode on the first import; that is not a cold start.
  if (runtimes.includes("python")) await runProcess(pythonCmd(), PLAN.startup.args, ROOT);

  const samples: Array<{ runtime: Rt; scenario: Scenario | "empty"; round: number } & Measured> =
    [];
  const errors: string[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (const scenario of scenarios) {
      const { runs, args: base } = PLAN[scenario];
      const args = scenario === "llm" || scenario === "tts" ? { ...base, apiKey } : base;
      for (let i = 0; i < runs; i++) {
        for (const rt of runtimes) {
          process.stderr.write(
            `round ${round + 1}/${ROUNDS} ${scenario} ${rt} (${i + 1}/${runs})\n`,
          );
          try {
            if (rt === "workerd") {
              const w = new Workerd(builds.workerd!);
              try {
                const m = await w.start(args);
                samples.push({ runtime: rt, scenario, round, ...m });
              } finally {
                w.stop();
              }
              if (scenario === "startup") {
                const e = new Workerd(empties.workerd!);
                try {
                  const m = await e.start({ scenario: "startup" });
                  samples.push({ runtime: rt, scenario: "empty", round, ...m });
                } finally {
                  e.stop();
                }
              }
            } else if (rt === "python") {
              const m = await runProcess(pythonCmd(), args, ROOT);
              samples.push({ runtime: rt, scenario, round, ...m });
              if (scenario === "startup") {
                const e = await runProcess([PYTHON, "-c", `print("${RESULT_MARK}{}")`], null, ROOT);
                samples.push({ runtime: rt, scenario: "empty", round, ...e });
              }
            } else {
              const b = builds[rt]!;
              const m = await runProcess(b.cmd, args, b.dir);
              samples.push({ runtime: rt, scenario, round, ...m });
              if (scenario === "startup") {
                const e = empties[rt]!;
                const em = await runProcess(e.cmd, null, e.dir);
                samples.push({ runtime: rt, scenario: "empty", round, ...em });
              }
            }
          } catch (e) {
            const msg = `${rt} ${scenario}: ${e instanceof Error ? e.message : String(e)}`;
            errors.push(msg);
            process.stderr.write(`  ❌ ${msg.slice(0, 500)}\n`);
          }
        }
      }
    }
  }

  const summary = summarize(samples);
  const report = {
    date: new Date().toISOString().slice(0, 10),
    machine: machine(),
    versions: versions(),
    plan: PLAN,
    rounds: ROUNDS,
    bundleBytes: Object.fromEntries(Object.entries(builds).map(([rt, b]) => [rt, b!.bytes])),
    summary,
    errors,
    samples: samples.map(({ result, ...s }) => ({ ...s, result })),
  };
  const tables = renderTables(report);
  console.log(`\n${tables}\n`);
  for (const e of errors) console.error(`❌ ${e.slice(0, 300)}`);

  if (values.write) {
    await writeReport(join(ROOT, "tools", "bench", "perf", "results.json"), report);
    const page = join(ROOT, "apps", "docs", "content", "docs", "performance.mdx");
    await writeSection(page, "perf", tables);
  }
}

type Sample = { runtime: Rt; scenario: Scenario | "empty"; round: number } & Measured;

function summarize(samples: Sample[]) {
  const by = (rt: Rt, s: Sample["scenario"]) =>
    samples.filter((x) => x.runtime === rt && x.scenario === s);
  const out: Record<string, any> = {};
  for (const rt of RUNTIMES) {
    const startup = by(rt, "startup");
    const empty = by(rt, "empty");
    const tp = by(rt, "throughput");
    const hop = by(rt, "hop");
    const llm = by(rt, "llm").map((s) => s.result.rows as any[]);
    const tts = by(rt, "tts").map((s) => s.result.rows as any[]);
    if (!startup.length && !tp.length && !hop.length && !llm.length && !tts.length) continue;
    /** Each sample's rows come in pairs, a pipeline request and an SDK one made next to it. */
    const online = (samples: any[][]) => {
      const rows = samples.flat();
      if (!rows.length) return null;
      const p = rows.filter((r) => r.via === "pipeline");
      const s = rows.filter((r) => r.via === "sdk");
      const diffs = samples.flatMap((rs) =>
        Array.from({ length: rs.length >> 1 }, (_, k) => {
          const pair = rs.slice(2 * k, 2 * k + 2);
          const pipe = pair.find((r) => r.via === "pipeline");
          const sdk = pair.find((r) => r.via === "sdk");
          return (pipe?.ttfbMs ?? Number.NaN) - (sdk?.ttfbMs ?? Number.NaN);
        }),
      );
      return {
        n: p.length,
        failed: p.filter((r) => !Number.isFinite(r.ttfbMs)).length,
        pairedDiffMs: median(diffs),
        pairedDiffP25Ms: quantile(diffs, 0.25),
        pairedDiffP75Ms: quantile(diffs, 0.75),
        pipelineTtfbMs: median(p.map((r) => r.ttfbMs)),
        sdkTtfbMs: median(s.map((r) => r.ttfbMs)),
        pipelineTtfbP90Ms: quantile(
          p.map((r) => r.ttfbMs),
          0.9,
        ),
        sdkTtfbP90Ms: quantile(
          s.map((r) => r.ttfbMs),
          0.9,
        ),
      };
    };
    out[rt] = {
      startupMs: startup.length ? median(startup.map((s) => s.wallMs)) : null,
      emptyStartupMs: empty.length ? median(empty.map((s) => s.wallMs)) : null,
      pipelineStartMs: startup.length ? median(startup.map((s) => s.result.pipelineMs)) : null,
      startupPeakRss: startup.length ? median(startup.map((s) => s.peakRss ?? Number.NaN)) : null,
      emptyPeakRss: empty.length ? median(empty.map((s) => s.peakRss ?? Number.NaN)) : null,
      framesPerSec: tp.length ? median(tp.map((s) => s.result.framesPerSec)) : null,
      throughputPeakRss: tp.length ? median(tp.map((s) => s.peakRss ?? Number.NaN)) : null,
      hopUs: hop.length ? median(hop.flatMap((s) => s.result.perFrameUs)) : null,
      hopP90Us: hop.length
        ? quantile(
            hop.flatMap((s) => s.result.perFrameUs),
            0.9,
          )
        : null,
      llm: online(llm),
      tts: online(tts),
    };
  }
  return out;
}

const LABEL: Record<Rt, string> = {
  python: "Pipecat · CPython",
  bun: "pipedog · Bun",
  node: "pipedog · Node",
  deno: "pipedog · Deno",
  workerd: "pipedog · workerd",
};

function renderTables(report: any): string {
  const s = report.summary as Record<Rt, any>;
  const v = report.versions as Record<string, string>;
  const rows = RUNTIMES.filter((rt) => s[rt]);
  const ver = (rt: Rt) => (rt === "python" ? v.python : v[rt]);
  const fmt = (x: number | null | undefined, digits = 0) =>
    x == null || !Number.isFinite(x)
      ? "–"
      : x.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const mb = (x: number | null | undefined) =>
    x == null || !Number.isFinite(x) ? "–" : `${fmt(x / 2 ** 20)} MB`;
  const rel = (x: number | null, base: number | null, higherIsBetter: boolean) => {
    if (x == null || base == null || !Number.isFinite(x) || !Number.isFinite(base)) return "";
    const r = higherIsBetter ? x / base : base / x;
    return ` (${r >= 1 ? fmt(r, 1) : fmt(r, 2)}×)`;
  };
  const py = s.python;
  const lines: string[] = [];

  lines.push(
    "### Frame processing",
    "",
    "10 pass-through processors in a `PipelineWorker`. **Throughput**: 20,000 `TextFrame`s queued at once.",
    "**Latency**: one frame at a time, queued to arrival at the end of the pipeline. In brackets: compared with Pipecat (higher is better).",
    "",
    "| | Throughput (frames/s) | Latency per frame (median) | p90 | Peak memory |",
    "|---|---:|---:|---:|---:|",
    ...rows.map((rt) => {
      const r = s[rt];
      return `| ${LABEL[rt]} ${ver(rt)} | ${fmt(r.framesPerSec)}${rel(r.framesPerSec, py?.framesPerSec ?? null, true)} | ${fmt(r.hopUs)} µs${rel(r.hopUs, py?.hopUs ?? null, false)} | ${fmt(r.hopP90Us)} µs | ${rt === "workerd" ? "–" : mb(r.throughputPeakRss)} |`;
    }),
    "",
  );

  lines.push(
    "### Cold start",
    "",
    "From starting the process to a pipeline that has started and ended, with the Google services loaded",
    "(for workerd: from starting `workerd serve` to the response). *Runtime alone* is the same for an",
    "empty program, so the difference is what loading the framework and running the pipeline cost.",
    "",
    "| | Cold start | Runtime alone | Framework | Peak memory | Bundle |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows.map((rt) => {
      const r = s[rt];
      const bytes = report.bundleBytes?.[rt];
      return `| ${LABEL[rt]} | ${fmt(r.startupMs)} ms | ${fmt(r.emptyStartupMs)} ms | ${fmt((r.startupMs ?? Number.NaN) - (r.emptyStartupMs ?? Number.NaN))} ms | ${rt === "workerd" ? "–" : mb(r.startupPeakRss)} | ${bytes ? `${fmt(bytes / 2 ** 20, 1)} MB` : "–"} |`;
    }),
    "",
  );

  const online = (key: "llm" | "tts", title: string, what: string) => {
    if (!rows.some((rt) => s[rt][key])) return;
    lines.push(
      `### ${title}`,
      "",
      what,
      "",
      "| | Through the pipeline (median) | SDK alone (median) | Difference, paired (median) | Middle half of differences | Requests |",
      "|---|---:|---:|---:|---:|---:|",
      ...rows
        .filter((rt) => s[rt][key])
        .map((rt) => {
          const r = s[rt][key];
          return `| ${LABEL[rt]} | ${fmt(r.pipelineTtfbMs)} ms | ${fmt(r.sdkTtfbMs)} ms | ${fmt(r.pairedDiffMs)} ms | ${fmt(r.pairedDiffP25Ms)} to ${fmt(r.pairedDiffP75Ms)} ms | ${r.n}${r.failed ? ` (${r.failed} failed)` : ""} |`;
        }),
      "",
    );
  };
  online(
    "llm",
    "Gemini LLM: time to first token",
    `\`GoogleLLMService\` with \`${report.plan.llm.args.llmModel}\` (thinking at its minimum, as the service sends by default), from queueing an \`LLMContextFrame\` to the first \`LLMTextFrame\` at the end of the pipeline. *SDK alone* is the same request made with the Google GenAI SDK of the same language, in the same process, alternating with the pipeline.`,
  );
  online(
    "tts",
    "Gemini TTS: time to first audio",
    `\`GeminiTTSService\` with \`${report.plan.tts.args.ttsModel}\`, from queueing a \`TTSSpeakFrame\` to the first \`TTSAudioRawFrame\` at the end of the pipeline, and the same request made with the SDK.`,
  );

  lines.push(
    `Measured ${report.date} on ${report.machine.cpu} (${report.machine.cores} cores, ${report.machine.memoryGb} GB), ${report.machine.os}: pipedog ${v.pipedog}, Pipecat ${v.pipecat} on CPython ${v.python}, Bun ${v.bun}, Node ${v.node}, Deno ${v.deno}, workerd ${v.workerd}. ${report.rounds} rounds, runtimes taking turns.`,
  );
  return lines.join("\n");
}

await main();
process.exit(0);
