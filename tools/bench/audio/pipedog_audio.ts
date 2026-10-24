// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pipedog side of the audio-quality benchmark (tools/bench/audio.ts): runs pipedog's stream
// resampler (in 20 ms chunks) and file resampler, with the default engine (WebAssembly) and with
// the pure-TypeScript fallback, and its mu-law encoder and decoder, on the inputs
// pipecat_audio.py wrote.
//
//   bun pipedog_audio.ts <dir>

import { readFileSync, writeFileSync } from "node:fs";
import { setResamplerEngine } from "@pipedog/core/audio/resamplers/engine";
import { createSincResamplerEngine } from "@pipedog/core/audio/resamplers/sinc_engine";
import {
  createFileResampler,
  createStreamResampler,
  pcmToUlaw,
  ulawToPcm,
} from "@pipedog/core/audio/utils";

const DIR = process.argv[2]!;
const CASES: Array<[number, number]> = [
  [24000, 8000],
  [24000, 16000],
  [16000, 8000],
  [8000, 16000],
  [24000, 48000],
  [48000, 16000],
];

async function run(label: string): Promise<void> {
  for (const [inRate, outRate] of CASES) {
    const name = `${inRate}_${outRate}`;
    const x = new Uint8Array(readFileSync(`${DIR}/in_${name}.raw`));
    const stream = createStreamResampler();
    const chunkBytes = (inRate / 50) * 2; // 20 ms of 16-bit mono
    const parts: Uint8Array[] = [];
    for (let i = 0; i < x.length; i += chunkBytes) {
      parts.push(await stream.resample(x.subarray(i, i + chunkBytes), inRate, outRate));
    }
    writeFileSync(`${DIR}/${label}_stream_${name}.raw`, Buffer.concat(parts));
    const file = createFileResampler();
    writeFileSync(`${DIR}/${label}_file_${name}.raw`, await file.resample(x, inRate, outRate));
  }
}

await run("pipedog");
setResamplerEngine(createSincResamplerEngine());
await run("pipedogts");
setResamplerEngine(null);

const all = new Uint8Array(readFileSync(`${DIR}/all_int16.raw`));
const resampler = createFileResampler();
writeFileSync(`${DIR}/pipedog_ulaw_enc.raw`, await pcmToUlaw(all, 8000, 8000, resampler));
const codes = new Uint8Array(256).map((_, i) => i);
writeFileSync(`${DIR}/pipedog_ulaw_dec.raw`, await ulawToPcm(codes, 8000, 8000, resampler));
process.exit(0);
