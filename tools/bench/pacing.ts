// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Pacing benchmark: how evenly a telephony bot sends its audio. A bot (tools/bench/pacing/bot.ts
// for pipedog on Bun, Node and Deno; bot_pipecat.py for upstream Pipecat on CPython) plays two
// 6 s utterances through the WebSocket server transport and the Telnyx serializer; a separate
// process standing in for Telnyx (pacing/client.ts) records when each audio message arrives.
//
// From the arrivals: the spread of the gaps between messages, how far ahead of real time the
// bot sends, and a simulated playback buffer of a few sizes: how often it would run dry
// (underruns) and for how long in total, which a caller hears as dropouts.
//
// Each case runs idle and with the bot's event loop 40% busy with other work (standing in for
// VAD, other calls, LLM streaming).
//
//   bun run bench:pacing [--runtime bun,node,deno,python] [--load 0,0.4] [--write]

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../compat/packages.ts";
import {
  bundle,
  freePort,
  moduleUrlPlugin,
  nodeBuiltinsPlugin,
  OUT_ROOT,
  provideOptionalPeers,
} from "../compat/runners.ts";

const RUNTIMES = ["python", "bun", "node", "deno"] as const;
type Rt = (typeof RUNTIMES)[number];

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runtime: { type: "string", multiple: true },
    load: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const runtimes = (values.runtime?.flatMap((r) => r.split(",")) ?? [...RUNTIMES]) as Rt[];
const loads = (values.load ?? "0,0.4").split(",").map(Number);

const DIR = join(OUT_ROOT, "pacing");
const BOT_TS = join(ROOT, "tools", "bench", "pacing", "bot.ts");
const BOT_PY = join(ROOT, "tools", "bench", "pacing", "bot_pipecat.py");
const CLIENT = join(ROOT, "tools", "bench", "pacing", "client.ts");
const VENV_PY = join(ROOT, "node_modules", ".cache", "pipedog-bench", "py", "bin", "python");
const RATE = 8000;
/** Simulated playback buffers, in ms: how much audio the far end waits for before playing. */
const BUFFERS_MS = [20, 40, 80];

async function botCommand(rt: Rt): Promise<{ cmd: string[]; cwd: string }> {
  if (rt === "python") {
    if (!existsSync(VENV_PY)) throw new Error("run `bun run bench:perf` once to create the venv");
    return { cmd: [VENV_PY, BOT_PY], cwd: ROOT };
  }
  const dir = join(DIR, rt);
  await Bun.$`rm -rf ${dir} && mkdir -p ${dir}`.quiet();
  const entry = join(dir, "entry.mjs");
  await Bun.write(entry, `import ${JSON.stringify(BOT_TS)};\n`);
  const err = await bundle(
    entry,
    dir,
    rt === "deno"
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
  provideOptionalPeers(dir, []);
  const out = join(dir, "bundle.mjs");
  const cmd =
    rt === "bun"
      ? [process.execPath, out]
      : rt === "node"
        ? ["node", out]
        : [
            "deno",
            "run",
            "-A",
            "--no-lock",
            ...(existsSync(join(dir, "package.json")) ? [] : ["--no-config"]),
            out,
          ];
  return { cmd, cwd: dir };
}

interface Arrival {
  t: number;
  samples: number;
}

async function runCase(rt: Rt, load: number): Promise<Arrival[]> {
  const { cmd, cwd } = await botCommand(rt);
  const port = freePort();
  const bot = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, PACING_PORT: String(port), PACING_LOAD: String(load) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const errText = new Response(bot.stderr).text();
  // Wait for the bot to say it's listening.
  const reader = bot.stdout.getReader();
  let buf = "";
  const deadline = Date.now() + 30_000;
  while (!buf.includes("__PACING_READY__")) {
    if (Date.now() > deadline) throw new Error(`${rt}: bot didn't start\n${await errText}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`${rt}: bot exited\n${await errText}`);
    buf += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  // The server may need a moment after saying so.
  await Bun.sleep(300);
  const client = Bun.spawn([process.execPath, CLIENT, `ws://127.0.0.1:${port}/`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(client.stdout).text();
  await client.exited;
  bot.kill();
  const line = out.split("\n").find((l) => l.startsWith("__PACING_ARRIVALS__"));
  if (!line) {
    throw new Error(
      `${rt}: no arrivals\n${await new Response(client.stderr).text()}\n${await errText}`,
    );
  }
  return JSON.parse(line.slice("__PACING_ARRIVALS__".length));
}

/** Split into utterances at gaps longer than 1 s. */
function utterances(a: Arrival[]): Arrival[][] {
  const out: Arrival[][] = [];
  for (const x of a) {
    const cur = out[out.length - 1];
    if (!cur || x.t - cur[cur.length - 1]!.t > 1000) out.push([x]);
    else cur.push(x);
  }
  return out;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? Number.NaN;
};

interface Metrics {
  messages: number;
  audioSecs: number;
  /** Gaps between consecutive messages, ms. */
  gapP50: number;
  gapP99: number;
  gapMax: number;
  /** How far ahead of real time sending ran, at most (ms of audio sent before it plays). */
  maxLeadMs: number;
  /** Per simulated buffer: underruns and the total silence they cause, ms. */
  underruns: Record<number, { count: number; silenceMs: number }>;
}

function analyze(arrivals: Arrival[]): Metrics {
  const gaps: number[] = [];
  let maxLead = 0;
  const underruns: Metrics["underruns"] = {};
  for (const b of BUFFERS_MS) underruns[b] = { count: 0, silenceMs: 0 };
  for (const u of utterances(arrivals)) {
    for (let i = 1; i < u.length; i++) gaps.push(u[i]!.t - u[i - 1]!.t);
    // Lead: audio sent so far minus the time since the first message.
    let sent = 0;
    for (const x of u) {
      const elapsed = x.t - u[0]!.t;
      maxLead = Math.max(maxLead, sent - elapsed);
      sent += (x.samples / RATE) * 1000;
    }
    // Playback: starts B ms after the first message; a message that arrives after its audio
    // was due leaves a silence until it arrives, and playback carries on from there.
    for (const b of BUFFERS_MS) {
      let clock = u[0]!.t + b;
      for (const x of u) {
        if (x.t > clock) {
          underruns[b]!.count++;
          underruns[b]!.silenceMs += x.t - clock;
          clock = x.t;
        }
        clock += (x.samples / RATE) * 1000;
      }
    }
  }
  return {
    messages: arrivals.length,
    audioSecs: arrivals.reduce((s, x) => s + x.samples, 0) / RATE,
    gapP50: q(gaps, 0.5),
    gapP99: q(gaps, 0.99),
    gapMax: Math.max(...gaps),
    maxLeadMs: maxLead,
    underruns,
  };
}

const LABEL: Record<Rt, string> = {
  python: "Pipecat · CPython",
  bun: "pipedog · Bun",
  node: "pipedog · Node",
  deno: "pipedog · Deno",
};

const results: Array<{ runtime: Rt; load: number; metrics: Metrics }> = [];
for (const load of loads) {
  for (const rt of runtimes) {
    process.stderr.write(`${rt}, load ${load}...\n`);
    try {
      results.push({ runtime: rt, load, metrics: analyze(await runCase(rt, load)) });
    } catch (e) {
      console.error(`❌ ${rt} load ${load}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const lines = [
  "| | Loop busy | Messages | Audio | Gap p50 | Gap p99 | Gap max | Max lead | " +
    BUFFERS_MS.map((b) => `Underruns @${b} ms`).join(" | ") +
    " |",
  `|---|---:|---:|---:|---:|---:|---:|---:|${BUFFERS_MS.map(() => "---:").join("|")}|`,
  ...results.map(({ runtime, load, metrics: m }) => {
    const u = BUFFERS_MS.map(
      (b) => `${m.underruns[b]!.count} (${f(m.underruns[b]!.silenceMs, 0)} ms)`,
    ).join(" | ");
    return `| ${LABEL[runtime]} | ${Math.round(load * 100)}% | ${m.messages} | ${f(m.audioSecs)} s | ${f(m.gapP50)} ms | ${f(m.gapP99)} ms | ${f(m.gapMax)} ms | ${f(m.maxLeadMs, 0)} ms | ${u} |`;
  }),
];
console.log(`\n${lines.join("\n")}\n`);

if (values.write) {
  const out = join(ROOT, "tools", "bench", "pacing", "results.json");
  await Bun.write(out, `${JSON.stringify({ date: new Date().toISOString(), results }, null, 2)}\n`);
  await Bun.$`bunx biome format --write ${out}`.cwd(ROOT).quiet();
  console.log(`wrote ${out}`);
}
process.exit(0);
