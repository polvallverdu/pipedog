// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createSoxrCompatibleEngine,
  getResampler,
  initResampler,
  QUALITIES,
  type RubatoEngine,
} from "../src/index.ts";

let engine: RubatoEngine;

beforeAll(async () => {
  engine = await initResampler();
});

const RATES = [8000, 16000, 24000, 44100, 48000];

function sine(
  frames: number,
  rate: number,
  freq = 440,
  amp = 10000,
  channels = 1,
  phase = 0,
): Int16Array {
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      // A different frequency per channel so a channel swap would show.
      const f = freq * (1 + c * 0.5);
      out[i * channels + c] = Math.round(Math.sin((2 * Math.PI * f * i) / rate + phase) * amp);
    }
  }
  return out;
}

function channel(samples: Int16Array, channels: number, c: number): Int16Array {
  const out = new Int16Array(samples.length / channels);
  for (let i = 0; i < out.length; i++) out[i] = samples[i * channels + c] as number;
  return out;
}

/** Frequency estimate from zero crossings (linear interpolation between samples). */
function zeroCrossingFreq(x: Int16Array, rate: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1] as number;
    const b = x[i] as number;
    if (a < 0 && b >= 0) crossings.push(i - 1 + -a / (b - a));
  }
  const first = crossings[0] as number;
  const last = crossings[crossings.length - 1] as number;
  return ((crossings.length - 1) * rate) / (last - first);
}

function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / x.length);
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("init", () => {
  test("initResampler is idempotent and getResampler returns the engine", async () => {
    expect(await initResampler()).toBe(engine);
    expect(getResampler()).toBe(engine);
  });

  test("initResampler accepts raw bytes", async () => {
    const bytes = await Bun.file(new URL("../wasm/resampler.wasm", import.meta.url)).arrayBuffer();
    const e = await initResampler(bytes);
    expect(e).not.toBe(engine);
    expect(e.resample(new Uint8Array(sine(160, 16000).buffer), 16000, 8000).length).toBe(160);
    const fromModule = await initResampler(new WebAssembly.Module(bytes));
    expect(getResampler()).toBe(fromModule);
  });
});

describe("one-shot", () => {
  test("identity when rates are equal", () => {
    const audio = new Uint8Array(sine(320, 16000).buffer);
    expect(engine.resample(audio, 16000, 16000)).toBe(audio);
    const samples = sine(320, 16000);
    expect(engine.resampleSamples(samples, 16000, 16000)).toBe(samples);
  });

  test("output length is in_len * out/in", () => {
    for (const inRate of RATES) {
      for (const outRate of RATES) {
        if (inRate === outRate) continue;
        const frames = Math.round(inRate * 0.37);
        const out = engine.resampleSamples(sine(frames, inRate), inRate, outRate);
        expect(Math.abs(out.length - (frames * outRate) / inRate)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("returns int16 little-endian bytes", () => {
    const audio = new Uint8Array(sine(1600, 16000).buffer);
    const out = engine.resample(audio, 16000, 8000);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(1600);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const samples = engine.resampleSamples(sine(1600, 16000), 16000, 8000);
    expect(view.getInt16(200, true)).toBe(samples[100] as number);
  });

  test("handles odd byte offsets", () => {
    const backing = new Uint8Array(3201);
    backing.set(new Uint8Array(sine(1600, 16000).buffer), 1);
    const out = engine.resample(backing.subarray(1), 16000, 8000);
    expect(out.length).toBe(1600);
  });

  test("a 440 Hz sine stays a 440 Hz sine", () => {
    for (const inRate of RATES) {
      for (const outRate of RATES) {
        if (inRate === outRate) continue;
        const out = engine.resampleSamples(sine(inRate, inRate), inRate, outRate);
        const f = zeroCrossingFreq(out, outRate);
        expect(Math.abs(f - 440)).toBeLessThan(0.05);
        // Amplitude preserved (away from the edges).
        const mid = out.subarray(outRate * 0.1, outRate * 0.9);
        expect(Math.abs(rms(mid) - 10000 / Math.SQRT2)).toBeLessThan(10000 * 0.01);
      }
    }
  });

  test("output is time-aligned with the input", () => {
    for (const [inRate, outRate] of [
      [16000, 48000],
      [48000, 16000],
      [44100, 48000],
      [24000, 8000],
    ] as const) {
      const out = engine.resampleSamples(sine(inRate, inRate), inRate, outRate);
      const ref = sine(outRate, outRate);
      const lo = Math.floor(outRate * 0.1);
      const hi = Math.floor(outRate * 0.9);
      const diff = new Float64Array(hi - lo);
      for (let i = lo; i < hi; i++) diff[i - lo] = (out[i] as number) - (ref[i] as number);
      // A one-sample misalignment would leave an error of several hundred.
      expect(rms(diff)).toBeLessThan(80);
    }
  });

  test("downsampling removes content above the new Nyquist", () => {
    // 6 kHz tone at 48 kHz -> 8 kHz (Nyquist 4 kHz): should be filtered out.
    const out = engine.resampleSamples(sine(48000, 48000, 6000), 48000, 8000);
    expect(rms(out.subarray(800, 7200))).toBeLessThan(10000 * 0.001);
  });

  test("float32 input and output", () => {
    const f = new Float32Array(16000);
    for (let i = 0; i < f.length; i++) f[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5;
    const out = engine.resampleFloat32(f, 16000, 24000);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(24000);
    expect(Math.abs(rms(out.subarray(2400, 21600)) - 0.5 / Math.SQRT2)).toBeLessThan(0.005);
  });

  test("rejects invalid parameters", () => {
    expect(() => engine.createStream(0, 16000)).toThrow();
    expect(() => engine.createStream(16000, 8000, { channels: 0 })).toThrow();
    expect(() => engine.createStream(16000, 8000, { quality: "XQ" as never })).toThrow();
  });
});

describe("stream", () => {
  test("random chunk sizes match the one-shot result", () => {
    const rand = rng(42);
    for (const [inRate, outRate] of [
      [16000, 48000],
      [48000, 16000],
      [44100, 16000],
      [8000, 24000],
    ] as const) {
      const input = sine(inRate * 2, inRate);
      const oneShot = engine.resampleSamples(input, inRate, outRate);
      const stream = engine.createStream(inRate, outRate);
      const parts: Int16Array[] = [];
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, 1 + Math.floor(rand() * 3000));
        parts.push(stream.processSamples(input.subarray(i, i + n)));
        i += n;
      }
      parts.push(stream.flushSamples());
      stream.destroy();
      const streamed = concat(parts);
      expect(streamed.length).toBe(oneShot.length);
      const diff = new Float64Array(streamed.length);
      for (let k = 0; k < diff.length; k++)
        diff[k] = (streamed[k] as number) - (oneShot[k] as number);
      // Same filter, same history: only float rounding differs.
      expect(rms(diff)).toBeLessThan(1);
    }
  });

  test("tiny chunks (1 sample) keep continuity", () => {
    const input = sine(1600, 16000);
    const stream = engine.createStream(16000, 24000, { quality: "HQ" });
    const parts: Int16Array[] = [];
    for (let i = 0; i < input.length; i++)
      parts.push(stream.processSamples(input.subarray(i, i + 1)));
    parts.push(stream.flushSamples());
    const streamed = concat(parts);
    const oneShot = engine.resampleSamples(input, 16000, 24000, { quality: "HQ" });
    expect(streamed.length).toBe(oneShot.length);
    let maxDiff = 0;
    for (let k = 0; k < streamed.length; k++) {
      maxDiff = Math.max(maxDiff, Math.abs((streamed[k] as number) - (oneShot[k] as number)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  test("flush returns the held audio (like soxr)", () => {
    // Mirrors upstream test_soxr_stream_audio_resampler_flush_returns_the_held_audio.
    const stream = engine.createStream(16000, 8000);
    const audio = new Uint8Array(sine(640, 16000, 300).buffer);
    const resampled = stream.process(audio);
    const flushed = stream.flush();
    expect(resampled.length).toBeLessThan(640);
    expect(flushed.length).toBeGreaterThan(0);
    expect((resampled.length + flushed.length) / 2).toBe(320);
  });

  test("is reusable after flush", () => {
    const stream = engine.createStream(16000, 8000);
    const audio = sine(640, 16000, 300);
    const first = concat([stream.processSamples(audio), stream.flushSamples()]);
    const resampled = stream.process(new Uint8Array(audio.buffer));
    const flushed = stream.flush();
    expect((resampled.length + flushed.length) / 2).toBe(320);
    // A flushed stream starts clean: the second pass equals the first.
    const second = concat([stream.processSamples(audio), stream.flushSamples()]);
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  test("reset clears state", () => {
    const stream = engine.createStream(16000, 8000);
    stream.processSamples(sine(640, 16000, 300));
    stream.reset();
    expect(stream.flush().length).toBe(0);
    // After a reset the output does not depend on what came before.
    const fresh = engine.createStream(16000, 8000);
    const a = concat([fresh.processSamples(sine(800, 16000, 1000)), fresh.flushSamples()]);
    stream.processSamples(sine(800, 16000, 3000));
    stream.reset();
    const b = concat([stream.processSamples(sine(800, 16000, 1000)), stream.flushSamples()]);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  test("flush and reset before any audio", () => {
    const stream = engine.createStream(16000, 8000);
    expect(stream.flush().length).toBe(0);
    stream.reset();
    expect(stream.process(new Uint8Array(0)).length).toBe(0);
  });

  test("destroyed streams throw", () => {
    const stream = engine.createStream(16000, 8000);
    stream.destroy();
    stream.destroy();
    expect(() => stream.processSamples(new Int16Array(10))).toThrow("destroyed");
  });
});

describe("stereo", () => {
  test("channels are resampled independently and stay in place", () => {
    const input = sine(16000, 16000, 440, 10000, 2);
    const out = engine.resampleSamples(input, 16000, 48000, { channels: 2 });
    expect(out.length).toBe(48000 * 2);
    expect(Math.abs(zeroCrossingFreq(channel(out, 2, 0), 48000) - 440)).toBeLessThan(0.05);
    expect(Math.abs(zeroCrossingFreq(channel(out, 2, 1), 48000) - 660)).toBeLessThan(0.05);
    const mono = engine.resampleSamples(channel(input, 2, 0), 16000, 48000);
    expect(Array.from(channel(out, 2, 0))).toEqual(Array.from(mono));
  });

  test("streams with odd-sized chunks keep frames intact", () => {
    const input = sine(4800, 48000, 440, 10000, 2);
    const stream = engine.createStream(48000, 16000, { channels: 2 });
    const parts: Int16Array[] = [];
    for (let i = 0; i < input.length; i += 333)
      parts.push(stream.processSamples(input.subarray(i, i + 333)));
    parts.push(stream.flushSamples());
    const streamed = concat(parts);
    const oneShot = engine.resampleSamples(input, 48000, 16000, { channels: 2 });
    expect(streamed.length).toBe(oneShot.length);
    let maxDiff = 0;
    for (let k = 0; k < streamed.length; k++) {
      maxDiff = Math.max(maxDiff, Math.abs((streamed[k] as number) - (oneShot[k] as number)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });
});

describe("quality presets", () => {
  test("ordered by increasing filter length", () => {
    const lens = QUALITIES.map((q) => engine.qualityInfo(q).sincLen);
    for (let i = 1; i < lens.length; i++)
      expect(lens[i] as number).toBeGreaterThan(lens[i - 1] as number);
    const delays = QUALITIES.map(
      (q) => engine.createStream(16000, 48000, { quality: q }).delayFrames,
    );
    for (let i = 1; i < delays.length; i++)
      expect(delays[i] as number).toBeGreaterThan(delays[i - 1] as number);
  });

  test("higher quality has a higher cutoff and less aliasing", () => {
    const cutoffs = QUALITIES.map((q) => engine.createStream(48000, 16000, { quality: q }).cutoff);
    for (let i = 1; i < cutoffs.length; i++)
      expect(cutoffs[i] as number).toBeGreaterThan(cutoffs[i - 1] as number);
    // 9 kHz at 48 kHz -> 16 kHz aliases to 7 kHz unless filtered.
    const leak = QUALITIES.map((q) =>
      rms(
        engine
          .resampleSamples(sine(48000, 48000, 9000), 48000, 16000, { quality: q })
          .subarray(1600, 14400),
      ),
    );
    expect(leak[4] as number).toBeLessThan(leak[0] as number);
    expect(leak[4] as number).toBeLessThan(5);
  });

  test("every preset keeps a 440 Hz sine", () => {
    for (const quality of QUALITIES) {
      const out = engine.resampleSamples(sine(16000, 16000), 16000, 24000, { quality });
      expect(Math.abs(zeroCrossingFreq(out, 24000) - 440)).toBeLessThan(0.05);
    }
  });
});

describe("soxr-compatible engine", () => {
  test("resample matches soxr.resample's shape (int16 and float32)", () => {
    const soxr = createSoxrCompatibleEngine(engine);
    const i16 = soxr.resample(sine(1600, 16000), 16000, 8000, "HQ");
    expect(i16).toBeInstanceOf(Int16Array);
    expect(i16.length).toBe(800);
    const f32 = soxr.resample(new Float32Array(1600), 16000, 8000, "HQ");
    expect(f32).toBeInstanceOf(Float32Array);
    expect(f32.length).toBe(800);
  });

  test("stream resampleChunk / last=true / clear", () => {
    const soxr = createSoxrCompatibleEngine(engine);
    const stream = soxr.createStream({
      inRate: 16000,
      outRate: 8000,
      numChannels: 1,
      quality: "VHQ",
    });
    const head = stream.resampleChunk(sine(640, 16000, 300));
    const tail = stream.resampleChunk(new Int16Array(0), true);
    stream.clear();
    expect(head.length).toBeLessThan(320);
    expect(head.length + tail.length).toBe(320);
    stream.resampleChunk(sine(640, 16000, 300));
    stream.clear();
    expect(stream.resampleChunk(new Int16Array(0), true).length).toBe(0);
    stream.destroy();
  });
});
