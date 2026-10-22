// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (d): the RNNoise filter (WASM) with the resampler it uses for
// 16 kHz input. The filter logs and carries on when RNNoise cannot load, so the
// check is that it is ready and that it changes the audio.
//
// `RNNOISE=file` loads the module from a `with { type: "file" }` import.

import { initRnnoise, RNNoiseFilter } from "@pipedog/audio-rnnoise-filter";
import rnnoiseWasm from "../../../packages/audio-rnnoise-filter/wasm/rnnoise.wasm" with {
  type: "file",
};
import { OK_MARKER } from "./common.ts";

if (process.env.RNNOISE === "file") {
  await initRnnoise(new URL(rnnoiseWasm, import.meta.url));
}

const filter = new RNNoiseFilter();
await filter.start(16000);
if (!(filter as any)._rnnoiseReady) throw new Error("RNNoise did not initialize");

// Noise (a deterministic pseudo-random sequence), 1 s at 16 kHz, in 20 ms chunks.
let seed = 1;
const noise = new Int16Array(16000);
for (let i = 0; i < noise.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  noise[i] = (seed % 6000) - 3000;
}
let inEnergy = 0;
let outEnergy = 0;
for (let i = 0; i + 320 <= noise.length; i += 320) {
  const chunk = noise.subarray(i, i + 320);
  for (const s of chunk) inEnergy += s * s;
  const out = await filter.filter(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  const pcm = new Int16Array(out.buffer, out.byteOffset, out.byteLength >> 1);
  for (const s of pcm) outEnergy += s * s;
}
await filter.stop();
console.log(`${OK_MARKER} noise energy in=${inEnergy} out=${outEnergy}`);
if (!(outEnergy < inEnergy / 2)) throw new Error("RNNoise did not suppress the noise");
process.exit(0);
