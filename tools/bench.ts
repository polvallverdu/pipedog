// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// ONNX benchmark: Silero ms/chunk and Smart Turn ms/inference per backend on
// Bun, Node, Deno and workerd. Each runtime runs tools/bench/onnx.ts through
// the compat harness (bundled like a user's app; the "workerd" export
// condition on workerd). Prints a markdown table; with --write, puts it in
// the READMEs of @pipedog/onnx, @pipedog/audio-silero and @pipedog/audio-smart-turn.
//
//   bun run bench [--runtime <rt>] [--write]

import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { BenchRow } from "./bench/onnx.ts";
import { ROOT, RUNTIMES, type Runtime } from "./compat/packages.ts";
import { runSmoke } from "./compat/runners.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runtime: { type: "string", multiple: true },
    write: { type: "boolean", default: false },
  },
});
const runtimes = (values.runtime?.flatMap((r) => r.split(",")) ?? [...RUNTIMES]) as Runtime[];

const rows: BenchRow[] = [];
let failed = false;
for (const rt of runtimes) {
  process.stderr.write(`benchmarking on ${rt}...\n`);
  const r = await runSmoke(rt, join(ROOT, "tools", "bench", "onnx.ts"), "bench");
  if (!r.ok) {
    failed = true;
    console.error(`❌ ${rt}: ${r.error}`);
    continue;
  }
  for (const row of r.result as BenchRow[]) {
    rows.push(rt === "workerd" ? { ...row, runtime: `workerd ${workerdVersion()}` } : row);
  }
}

function workerdVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "node_modules", "workerd", "package.json"), "utf8"),
  );
  return pkg.version as string;
}

const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
const date = new Date().toISOString().slice(0, 10);
const table = [
  "| runtime | backend | Silero ms / 32 ms chunk | Smart Turn ms / inference | Smart Turn ms / prediction |",
  "|---|---|---:|---:|---:|",
  ...rows.map(
    (r) =>
      `| ${r.runtime} | ${r.backend} | ${fmt(r.sileroMs)} | ${fmt(r.turnMs)} | ${fmt(r.turnPredictMs)} |`,
  ),
  "",
  `Measured ${date} on ${cpus()[0]?.model ?? "unknown CPU"}, one thread, by \`bun run bench\`.`,
  "Silero: one 512-sample window at 16 kHz through `SileroOnnxModel`. Smart Turn: the model on",
  "8 s of features (inference), and `_predictEndpoint` on 8 s of 16 kHz audio (log-mel features +",
  "inference). Medians of batch means.",
].join("\n");

console.log(`\n${table}\n`);

if (values.write && !failed) {
  const START = "<!-- bench:start -->";
  const END = "<!-- bench:end -->";
  for (const pkg of ["onnx", "audio-silero", "audio-smart-turn"]) {
    const path = join(ROOT, "packages", pkg, "README.md");
    const text = await Bun.file(path).text();
    const a = text.indexOf(START);
    const b = text.indexOf(END);
    if (a < 0 || b < a) {
      console.error(`${path}: no ${START} ... ${END} section`);
      failed = true;
      continue;
    }
    await Bun.write(path, `${text.slice(0, a + START.length)}\n${table}\n${text.slice(b)}`);
    console.log(`wrote ${path}`);
  }
}

process.exit(failed ? 1 : 0);
