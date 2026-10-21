// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs RNNoise (WebAssembly) through the
// filter at 16 kHz (so it resamples both ways) and checks that it suppresses
// white noise. On workerd the .wasm is imported as a module by the "workerd"
// entry; on the other runtimes it is read from wasm/.

import { RNNoiseFilter } from "@pipedog/audio-rnnoise-filter";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-rnnoise-filter smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  const filter = new RNNoiseFilter();
  await filter.start(16000);

  let seed = 1;
  const noise = new Int16Array(16000); // 1 s of white noise
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = Math.trunc((seed / 4294967296 - 0.5) * 8000);
  }
  const chunks: Int16Array[] = [];
  for (let i = 0; i < noise.length; i += 320) {
    const out = await filter.filter(new Uint8Array(noise.buffer, i * 2, 640));
    const copy = new Uint8Array(out);
    chunks.push(new Int16Array(copy.buffer, 0, copy.length >> 1));
  }
  await filter.stop();

  const total = chunks.reduce((n, c) => n + c.length, 0);
  check(total > 12000, `got ${total} samples back`);
  const rms = (s: Int16Array) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);
  const tail = chunks.slice(-20);
  const outRms = Math.sqrt(tail.reduce((a, c) => a + rms(c) ** 2, 0) / tail.length);
  check(outRms < rms(noise) / 4, `noise not suppressed: ${outRms} vs ${rms(noise)}`);
}
