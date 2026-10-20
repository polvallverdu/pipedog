// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for the resampler engine behind the SOXR resamplers: injection, the
 * default WASM engine, the pure-TypeScript fallback, and that both engines
 * actually resample (frequency preserved, streams continuous across chunks).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createSoxrCompatibleEngine, initResampler } from "@pipedog/resampler-wasm";
import type { SoxrQuality } from "../src/audio/resamplers/base_audio_resampler.ts";
import {
  _resetResamplerEngineForTests,
  getLoadedResamplerEngine,
  getResamplerEngine,
  type ResamplerEngine,
  setResamplerEngine,
} from "../src/audio/resamplers/engine.ts";
import { createSincResamplerEngine } from "../src/audio/resamplers/sinc_engine.ts";
import { SOXRAudioResampler, soxrResample } from "../src/audio/resamplers/soxr_resampler.ts";
import { SOXRStreamAudioResampler } from "../src/audio/resamplers/soxr_stream_resampler.ts";
import { createFileResampler, createStreamResampler } from "../src/audio/utils.ts";
import { logger } from "../src/utils/logger.ts";

afterEach(() => {
  _resetResamplerEngineForTests();
});

const RATES = [8000, 16000, 24000, 48000];

function sine(freq: number, rate: number, seconds: number, amplitude = 10000): Int16Array {
  const n = Math.round(rate * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

function bytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function samples(audio: Uint8Array): Int16Array {
  return new Int16Array(audio.slice().buffer);
}

/** Frequency from interpolated rising zero crossings, ignoring the edges. */
function estimateFrequency(x: Int16Array, rate: number): number {
  const from = Math.floor(x.length * 0.1);
  const to = Math.floor(x.length * 0.9);
  const crossings: number[] = [];
  for (let i = from; i < to; i++) {
    const a = x[i] as number;
    const b = x[i + 1] as number;
    if (a < 0 && b >= 0) crossings.push(i + -a / (b - a));
  }
  const first = crossings[0] as number;
  const last = crossings[crossings.length - 1] as number;
  return ((crossings.length - 1) * rate) / (last - first);
}

function rms(x: Int16Array): number {
  const from = Math.floor(x.length * 0.1);
  const to = Math.floor(x.length * 0.9);
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / (to - from));
}

const wasmEngine = createSoxrCompatibleEngine(await initResampler());
const ENGINES: [string, ResamplerEngine][] = [
  ["wasm", wasmEngine],
  ["sinc", createSincResamplerEngine()],
];

describe("default engine", () => {
  test("loads the WASM engine and makes it available synchronously", async () => {
    _resetResamplerEngineForTests();
    expect(getLoadedResamplerEngine()).toBeNull();
    expect(() => soxrResample(new Int16Array(4), 8000, 16000, "VHQ")).toThrow(/getResamplerEngine/);

    const engine = await getResamplerEngine();
    expect(getLoadedResamplerEngine()).toBe(engine);
    // Same output as the WASM engine used directly.
    const audio = sine(440, 8000, 0.1);
    expect(engine.resample(audio, 8000, 16000, "HQ")).toEqual(
      wasmEngine.resample(audio, 8000, 16000, "HQ"),
    );
  });

  test("equal rates return the input unchanged without loading anything", async () => {
    let loads = 0;
    _resetResamplerEngineForTests(async () => {
      loads++;
      return wasmEngine;
    });
    const audio = bytes(sine(440, 16000, 0.05));
    expect(await new SOXRAudioResampler().resample(audio, 16000, 16000)).toBe(audio);
    expect(await new SOXRStreamAudioResampler().resample(audio, 16000, 16000)).toBe(audio);
    expect(loads).toEqual(0);
  });

  test("concurrent first uses share one load", async () => {
    let loads = 0;
    _resetResamplerEngineForTests(async () => {
      loads++;
      return wasmEngine;
    });
    const audio = bytes(sine(440, 8000, 0.05));
    await Promise.all([
      createFileResampler().resample(audio, 8000, 16000),
      createStreamResampler().resample(audio, 8000, 16000),
      getResamplerEngine(),
    ]);
    expect(loads).toEqual(1);
  });
});

describe("setResamplerEngine", () => {
  test("file and stream resamplers use the injected engine", async () => {
    const calls: string[] = [];
    const engine: ResamplerEngine = {
      resample(audio, inRate, outRate, quality) {
        calls.push(`resample ${inRate}->${outRate} ${quality}`);
        return audio;
      },
      createStream({ inRate, outRate, numChannels, quality }) {
        calls.push(`stream ${inRate}->${outRate} x${numChannels} ${quality}`);
        return {
          resampleChunk(chunk, last) {
            calls.push(`chunk ${chunk.length} ${last ? "last" : ""}`.trim());
            return chunk;
          },
          clear() {
            calls.push("clear");
          },
        };
      },
    };
    setResamplerEngine(engine);
    expect(await getResamplerEngine()).toBe(engine);
    expect(getLoadedResamplerEngine()).toBe(engine);

    const audio = bytes(new Int16Array([1, 2, 3, 4]));
    await createFileResampler({ quality: "MQ" }).resample(audio, 8000, 24000);
    const stream = createStreamResampler({ quality: "LQ" });
    await stream.resample(audio, 48000, 16000);
    await stream.flush();

    expect(calls).toEqual([
      "resample 8000->24000 MQ",
      "stream 48000->16000 x1 LQ",
      "chunk 4",
      "chunk 0 last",
      "clear",
    ]);
  });

  test("setResamplerEngine(null) goes back to the default engine", async () => {
    const fake: ResamplerEngine = {
      resample: (audio) => audio,
      createStream: () => ({ resampleChunk: (c) => c, clear() {} }),
    };
    setResamplerEngine(fake);
    expect(await getResamplerEngine()).toBe(fake);
    setResamplerEngine(null);
    expect(await getResamplerEngine()).not.toBe(fake);
  });

  test("stream clears its history after clearAfterSecs of inactivity", async () => {
    let clears = 0;
    setResamplerEngine({
      resample: (audio) => audio,
      createStream: () => ({
        resampleChunk: (c) => c,
        clear() {
          clears++;
        },
      }),
    });
    const audio = bytes(new Int16Array(160));
    const resampler = createStreamResampler({ clearAfterSecs: 0.05 });
    await resampler.resample(audio, 16000, 8000);
    await resampler.resample(audio, 16000, 8000);
    expect(clears).toEqual(0);
    await Bun.sleep(80);
    await resampler.resample(audio, 16000, 8000);
    expect(clears).toEqual(1);

    const never = createStreamResampler({ clearAfterSecs: null });
    await never.resample(audio, 16000, 8000);
    await Bun.sleep(80);
    await never.resample(audio, 16000, 8000);
    expect(clears).toEqual(1);
  });

  test("a stream resampler refuses different rates once started", async () => {
    const resampler = new SOXRStreamAudioResampler();
    await resampler.resample(bytes(sine(440, 16000, 0.02)), 16000, 8000);
    await expect(resampler.resample(bytes(sine(440, 24000, 0.02)), 24000, 8000)).rejects.toThrow(
      /different sample rates/,
    );
  });
});

describe("fallback", () => {
  test("falls back to the TypeScript engine with one warning when WASM fails to load", async () => {
    _resetResamplerEngineForTests(async () => {
      throw new Error("Wasm code generation disallowed by embedder");
    });
    const warning = spyOn(logger, "warning").mockImplementation(() => {});
    try {
      const audio = sine(440, 8000, 0.5);
      const out1 = samples(await createFileResampler().resample(bytes(audio), 8000, 16000));
      const out2 = samples(await createStreamResampler().resample(bytes(audio), 8000, 48000));
      await getResamplerEngine();

      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]?.[0])).toContain("disallowed by embedder");
      expect(out1.length).toEqual(8000);
      expect(estimateFrequency(out1, 16000)).toBeCloseTo(440, 0);
      expect(out2.length).toBeGreaterThan(0);
      expect(out1).toEqual(createSincResamplerEngine().resample(audio, 8000, 16000, "VHQ"));
    } finally {
      warning.mockRestore();
    }
  });
});

for (const [name, engine] of ENGINES) {
  describe(`${name} engine`, () => {
    for (const inRate of RATES) {
      for (const outRate of RATES) {
        if (inRate === outRate) continue;
        test(`440 Hz stays 440 Hz, ${inRate} -> ${outRate}`, () => {
          const input = sine(440, inRate, 0.5);
          const out = engine.resample(input, inRate, outRate, "VHQ");
          expect(out).toBeInstanceOf(Int16Array);
          expect(out.length).toEqual(Math.round((input.length * outRate) / inRate));
          expect(Math.abs(estimateFrequency(out, outRate) - 440)).toBeLessThan(0.5);
          // Level within 0.1 dB.
          expect(Math.abs(20 * Math.log10(rms(out) / rms(input)))).toBeLessThan(0.1);
        });
      }
    }

    test("float32 audio round-trips 16k -> 48k -> 16k", () => {
      const input = new Float32Array(16000);
      for (let i = 0; i < input.length; i++)
        input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
      const up = engine.resample(input, 16000, 48000, "VHQ");
      const back = engine.resample(up, 48000, 16000, "VHQ");
      expect(up).toBeInstanceOf(Float32Array);
      expect(back.length).toEqual(input.length);
      let maxErr = 0;
      for (let i = 1000; i < 15000; i++) {
        maxErr = Math.max(maxErr, Math.abs((back[i] as number) - (input[i] as number)));
      }
      expect(maxErr).toBeLessThan(1e-3);
    });

    test("downsampling removes content above the new Nyquist frequency", () => {
      // 6 kHz cannot be represented at 8 kHz; it must not alias down to 2 kHz.
      const out = engine.resample(sine(6000, 48000, 0.5), 48000, 8000, "VHQ");
      expect(20 * Math.log10(Math.max(rms(out), 1e-9) / 7071)).toBeLessThan(-60);
    });

    for (const quality of ["QQ", "LQ", "MQ", "HQ", "VHQ"] as SoxrQuality[]) {
      test(`streaming in random chunk sizes matches one-shot (${quality})`, () => {
        let seed = 1234;
        const random = () => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed / 2147483648;
        };
        for (const [inRate, outRate] of [
          [16000, 48000],
          [48000, 16000],
          [24000, 8000],
          [8000, 24000],
        ] as [number, number][]) {
          const input = sine(440, inRate, 0.4);
          for (let i = 0; i < input.length; i++) {
            input[i] = (input[i] as number) + Math.round((random() - 0.5) * 2000);
          }
          const oneShot = engine.resample(input, inRate, outRate, quality);

          const stream = engine.createStream({ inRate, outRate, numChannels: 1, quality });
          const parts: Int16Array[] = [];
          let offset = 0;
          while (offset < input.length) {
            const size = Math.floor(random() * 700);
            parts.push(stream.resampleChunk(input.subarray(offset, offset + size)));
            offset += size;
          }
          parts.push(stream.resampleChunk(new Int16Array(0), true));
          stream.destroy?.();

          const streamed = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
          let at = 0;
          for (const p of parts) {
            streamed.set(p, at);
            at += p.length;
          }
          expect(streamed.length).toEqual(oneShot.length);
          let maxDiff = 0;
          for (let i = 0; i < streamed.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs((streamed[i] as number) - (oneShot[i] as number)));
          }
          expect(maxDiff).toBeLessThanOrEqual(1);
        }
      });
    }

    test("clear() drops the held audio", () => {
      const stream = engine.createStream({
        inRate: 16000,
        outRate: 8000,
        numChannels: 1,
        quality: "VHQ",
      });
      stream.resampleChunk(sine(300, 16000, 0.04));
      stream.clear();
      expect(stream.resampleChunk(new Int16Array(0), true).length).toEqual(0);
    });

    test("interleaved stereo keeps the channels apart", () => {
      const left = sine(440, 16000, 0.25);
      const right = sine(1000, 16000, 0.25, 5000);
      const stereo = new Int16Array(left.length * 2);
      for (let i = 0; i < left.length; i++) {
        stereo[2 * i] = left[i] as number;
        stereo[2 * i + 1] = right[i] as number;
      }
      const stream = engine.createStream({
        inRate: 16000,
        outRate: 48000,
        numChannels: 2,
        quality: "HQ",
      });
      const head = stream.resampleChunk(stereo);
      const tail = stream.resampleChunk(new Int16Array(0), true);
      const out = new Int16Array(head.length + tail.length);
      out.set(head);
      out.set(tail, head.length);
      const outLeft = out.filter((_, i) => i % 2 === 0);
      const outRight = out.filter((_, i) => i % 2 === 1);
      expect(outLeft.length).toEqual(left.length * 3);
      expect(estimateFrequency(outLeft, 48000)).toBeCloseTo(440, 0);
      expect(estimateFrequency(outRight, 48000)).toBeCloseTo(1000, 0);
    });
  });
}
