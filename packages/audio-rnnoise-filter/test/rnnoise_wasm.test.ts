// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The WebAssembly engine on its own: loading from each kind of source, frames, state. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FRAME_SIZE, initRnnoise, RNNoise, RNNoiseFilter } from "../src/index.ts";

const wasmUrl = new URL("../wasm/rnnoise.wasm", import.meta.url);

describe("RNNoise WASM", () => {
  test("loads from bytes, a module, a URL and a Response", async () => {
    const bytes = readFileSync(wasmUrl);
    const sources = [
      new Uint8Array(bytes),
      await WebAssembly.compile(new Uint8Array(bytes)),
      wasmUrl,
      new Response(new Uint8Array(bytes)),
    ];
    for (const source of sources) {
      const engine = await initRnnoise(source);
      const state = engine.createState();
      const out = new Float32Array(FRAME_SIZE);
      const vad = state.processFrame(new Float32Array(FRAME_SIZE), out);
      expect(vad).toBeGreaterThanOrEqual(0);
      expect(vad).toBeLessThanOrEqual(1);
      state.destroy();
    }
    await initRnnoise(); // back to the bundled module
  });

  test("states are independent and frames have a fixed size", async () => {
    const engine = await initRnnoise();
    const a = engine.createState();
    const b = engine.createState();
    const loud = Float32Array.from({ length: FRAME_SIZE }, (_, i) => 8000 * Math.sin(i / 3));
    const outA = new Float32Array(FRAME_SIZE);
    const outB = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < 5; i++) a.processFrame(loud, outA);
    b.processFrame(loud, outB);
    expect(outA).not.toEqual(outB);
    expect(() => a.processFrame(new Float32Array(10), outA)).toThrow();
    a.destroy();
    expect(() => a.processFrame(loud, outA)).toThrow("destroyed");
    b.destroy();
  });

  test("RNNoise buffers partial frames and flushes them with partial=true", async () => {
    const rnnoise = new RNNoise({ engine: await initRnnoise() });
    expect([...rnnoise.denoiseChunk(new Int16Array(100))]).toHaveLength(0);
    expect([...rnnoise.denoiseChunk(new Int16Array(400))]).toHaveLength(1);
    const flushed = [...rnnoise.denoiseChunk(new Int16Array(0), true)];
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.[1]).toHaveLength(FRAME_SIZE);
    expect(() => new RNNoise({ sampleRate: 16000, engine: undefined as never })).toThrow("48000");
    rnnoise.destroy();
  });

  test("a failing denoiser factory leaves the filter passing audio through", async () => {
    const filter = new RNNoiseFilter({
      rnnoise: () => {
        throw new Error("no rnnoise");
      },
    });
    await filter.start(48000);
    const audio = new Uint8Array([1, 2, 3, 4]);
    expect(await filter.filter(audio)).toEqual(audio);
  });

  test("odd-length and unaligned input is handled", async () => {
    const filter = new RNNoiseFilter();
    await filter.start(48000);
    const padded = new Uint8Array(1 + 2 * FRAME_SIZE + 1);
    const out = await filter.filter(padded.subarray(1, 1 + 2 * FRAME_SIZE));
    expect(out.length).toBe(2 * FRAME_SIZE);
    await filter.stop();
  });
});
