// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterAll, describe, expect, test } from "bun:test";
import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import { SmartTurnWorkerPool } from "../src/smart_turn_pool.ts";
import { isWorkerThread, parentThread, spawnThread } from "../src/threads.ts";

const WAV = new URL(
  "../../../packages/audio-silero/test/assets/continuous_speech_16k.wav",
  import.meta.url,
);

/** The recording's samples (16 kHz mono, 16-bit) as float32. */
async function speech(): Promise<Float32Array> {
  const wav = new Uint8Array(await Bun.file(WAV).arrayBuffer());
  const pcm = new Int16Array(wav.slice(44).buffer);
  return Float32Array.from(pcm, (s) => s / 32768);
}

/** The largest delay of a 5 ms timer while `work` runs. */
async function maxTimerLag(work: () => Promise<unknown>): Promise<number> {
  let max = 0;
  let running = true;
  const probe = (async () => {
    while (running) {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 5));
      max = Math.max(max, performance.now() - t - 5);
    }
  })();
  await work();
  running = false;
  await probe;
  return max;
}

describe("threads", () => {
  test("the main thread is not a worker", async () => {
    expect(await isWorkerThread()).toBe(false);
    expect(await parentThread()).toBeNull();
  });

  test("messages and transferred buffers round-trip", async () => {
    const port = await spawnThread(new URL("./fixtures/echo_thread.ts", import.meta.url));
    try {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const reply = new Promise<any>((resolve) => port.addListener(resolve));
      port.postMessage({ bytes }, [bytes.buffer]);
      // Transferred, not copied: the buffer is gone from this thread.
      expect(bytes.byteLength).toBe(0);
      const msg = await reply;
      expect(msg.isWorker).toBe(true);
      expect(Array.from(msg.echo)).toEqual([1, 2, 3, 4]);
    } finally {
      await port.terminate();
    }
  });
});

describe("SmartTurnWorkerPool", () => {
  const pool = new SmartTurnWorkerPool({
    size: 2,
    spawn: () => spawnThread(new URL("../src/smart_turn_thread.ts", import.meta.url)),
  });
  afterAll(() => pool.close());

  test("predicts what the inline analyzer predicts", async () => {
    const audio = await speech();
    const inline = createLocalSmartTurnAnalyzerV3();
    inline.setSampleRate(16000);
    const expected = await (inline as any)._predictEndpoint(audio.slice());
    const pooled = pool.analyzer();
    pooled.setSampleRate(16000);
    const got = await (pooled as any)._predictEndpoint(audio.slice());
    expect(got.prediction).toBe(expected.prediction);
    expect(got.probability).toBeCloseTo(expected.probability, 4);
  }, 30_000);

  test("predictions don't block the event loop", async () => {
    const audio = await speech();
    // Warm both threads up (model load).
    await Promise.all([pool.predict(audio.slice(), 16000), pool.predict(audio.slice(), 16000)]);
    const inline = createLocalSmartTurnAnalyzerV3();
    inline.setSampleRate(16000);
    await (inline as any)._predictEndpoint(audio.slice());

    const inlineLag = await maxTimerLag(async () => {
      for (let i = 0; i < 4; i++) await (inline as any)._predictEndpoint(audio.slice());
    });
    const pooledLag = await maxTimerLag(() =>
      Promise.all(Array.from({ length: 4 }, () => pool.predict(audio.slice(), 16000))),
    );
    // Inline, the loop waits for a whole prediction (tens of ms); pooled, only for a postMessage.
    expect(pooledLag).toBeLessThan(inlineLag);
    expect(pooledLag).toBeLessThan(20);
  }, 30_000);

  test("the analyzer ends a turn through the pool", async () => {
    const audio = await speech();
    const pcm = new Int16Array(Float32Array.from(audio, (s) => s * 32767));
    const analyzer = pool.analyzer();
    analyzer.setSampleRate(16000);
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i += 640)
      analyzer.appendAudio(bytes.subarray(i, i + 640), true);
    const [, metrics] = await analyzer.analyzeEndOfTurn();
    expect(metrics).not.toBeNull();
  }, 30_000);
});
