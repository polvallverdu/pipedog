// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Runtime-independent smoke checks (no test framework), shared by the runtime smoke scripts. */

import type { RubatoEngine } from "../../src/engine.ts";

function sine(frames: number, rate: number, freq = 440): Int16Array {
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++)
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 10000);
  return out;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`smoke check failed: ${msg}`);
}

/** Returns a short report; throws on failure. */
export function runChecks(engine: RubatoEngine): string {
  const pcm = new Uint8Array(sine(1600, 16000).buffer);
  const same = engine.resample(pcm, 16000, 16000);
  assert(same === pcm, "identity");

  const down = engine.resample(pcm, 16000, 8000);
  assert(down.length === 1600, `16k->8k length ${down.length}`);

  const up = engine.resample(pcm, 16000, 48000, { quality: "HQ" });
  assert(up.length === 9600, `16k->48k length ${up.length}`);

  const stream = engine.createStream(16000, 8000);
  const a = stream.process(pcm.subarray(0, 1000));
  const b = stream.process(pcm.subarray(1000));
  const c = stream.flush();
  assert(a.length + b.length + c.length === 1600, "stream total");
  stream.reset();
  assert(stream.flush().length === 0, "reset");
  stream.destroy();

  const stereo = engine.resampleSamples(new Int16Array(3200), 16000, 24000, { channels: 2 });
  assert(stereo.length === 4800, "stereo length");
  return "ok: identity, one-shot, stream, flush, reset, stereo";
}
