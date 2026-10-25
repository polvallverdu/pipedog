// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Audio-quality benchmark: pipedog's resampling and mu-law against upstream Pipecat's (libsoxr
// at its highest quality, and Python's audioop), on the same signals. Telephony audio goes
// through both on every call: text-to-speech audio is resampled to 8 kHz and mu-law encoded.
//
// - resampling: three in-band tones plus three a downsampler must remove; what is left besides
//   the tones (noise, aliasing, distortion) and the largest single artefact, relative to the
//   tones, for pipedog's default engine (WebAssembly) and its pure-TypeScript fallback; and how
//   much resampling in 20 ms chunks, as transports do, changes the output
// - mu-law: every 16-bit value encoded and every code decoded, compared bit for bit
//
//   bun run bench:audio [--write]
//
// --write saves tools/bench/audio/results.json and the table in
// apps/docs/content/docs/performance.mdx.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../compat/packages.ts";
import { OUT_ROOT } from "../compat/runners.ts";
import { writeDocsSection } from "./docs.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { write: { type: "boolean", default: false } },
});

const PY = join(ROOT, "node_modules", ".cache", "pipedog-bench", "py", "bin", "python");
const HERE = join(ROOT, "tools", "bench", "audio");
const DIR = join(OUT_ROOT, "audio");

if (!existsSync(PY)) {
  console.error("The Pipecat venv is missing: run `bun run bench:perf` once to create it.");
  process.exit(1);
}
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

await Bun.$`${PY} -I ${join(HERE, "pipecat_audio.py")} ${DIR}`.quiet();
await Bun.$`${process.execPath} ${join(HERE, "pipedog_audio.ts")} ${DIR}`.cwd(ROOT).quiet();
const report = JSON.parse(await Bun.$`${PY} -I ${join(HERE, "analyze.py")} ${DIR}`.text()) as {
  cases: Array<
    { inRate: number; outRate: number } & Record<
      "pipecat" | "pipedog" | "pipedogts",
      { residualDb: number; worstDb: number; streamVsFileDb: number }
    >
  >;
  ulaw: { encodeValues: number; encodeDiffer: number; decodeCodes: number; decodeDiffer: number };
};

const db = (x: number) => (x <= -200 ? "identical" : `${x.toFixed(0)} dB`);
const khz = (r: number) => `${r / 1000} kHz`;
const cell = (m: { residualDb: number; worstDb: number }) =>
  `${m.residualDb.toFixed(0)} / ${m.worstDb.toFixed(0)} dB`;
const { ulaw } = report;
const table = [
  "| Resampling | Pipecat (libsoxr, VHQ) | pipedog (WebAssembly) | pipedog (TypeScript fallback) | 20 ms chunks vs one go: Pipecat / pipedog |",
  "|---|---:|---:|---:|---:|",
  ...report.cases.map(
    (c) =>
      `| ${khz(c.inRate)} → ${khz(c.outRate)} | ${cell(c.pipecat)} | ${cell(c.pipedog)} | ${cell(c.pipedogts)} | ${db(c.pipecat.streamVsFileDb)} / ${db(c.pipedog.streamVsFileDb)} |`,
  ),
  "",
  "Each cell: everything besides the tones (noise, aliasing, distortion) / the largest single " +
    "artefact, relative to the tones. Lower is cleaner; both are far below what can be heard.",
  "",
  `**μ-law:** all ${ulaw.encodeValues.toLocaleString("en-US")} 16-bit values encoded: ` +
    `${ulaw.encodeDiffer === 0 ? "identical to Pipecat's" : `${ulaw.encodeDiffer} differ`}; ` +
    `all ${ulaw.decodeCodes} codes decoded: ` +
    `${ulaw.decodeDiffer === 0 ? "identical" : `${ulaw.decodeDiffer} differ`}.`,
].join("\n");

console.log(`\n${table}\n`);

if (values.write) {
  const out = join(HERE, "results.json");
  await Bun.write(
    out,
    `${JSON.stringify({ date: new Date().toISOString(), ...report }, null, 2)}\n`,
  );
  await Bun.$`bunx biome format --write ${out}`.cwd(ROOT).quiet();
  await writeDocsSection("audio", table);
  console.log(`wrote ${out} and the performance page`);
}
process.exit(0);
