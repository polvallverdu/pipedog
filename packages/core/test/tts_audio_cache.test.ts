// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";

import {
  ErrorFrame,
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import { TTSSettings } from "../src/services/settings.ts";
import { TTSAudioCache } from "../src/services/tts_audio_cache.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest } from "../src/tests/utils.ts";

const SAMPLE_RATE = 16000;

function pcm(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** An HTTP-style service: yields two chunks per request, counting requests. */
class FakeTTSService extends TTSService {
  requests: string[] = [];
  failNext = false;

  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      settings: new TTSSettings({ model: "m", voice: "v", language: null }),
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.requests.push(text);
    if (this.failNext) {
      this.failNext = false;
      yield new ErrorFrame({ error: "boom" });
      return;
    }
    const fill = text.length % 250;
    for (let i = 0; i < 2; i++) {
      yield new TTSAudioRawFrame({
        audio: pcm(1000, fill),
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    }
  }
}

function audioOf(frames: Frame[]): number[] {
  return frames.filter((f) => f instanceof TTSAudioRawFrame).map((f) => f.audio.byteLength);
}

describe("TTSAudioCache", () => {
  test("drops the least recently used audio past maxBytes", () => {
    const cache = new TTSAudioCache({ maxBytes: 10 });
    cache.set("a", pcm(4, 1));
    cache.set("b", pcm(4, 2));
    cache.get("a");
    cache.set("c", pcm(4, 3));
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.bytes).toBe(8);
    cache.set("huge", pcm(11, 0));
    expect(cache.has("huge")).toBe(false);
    cache.set("a", pcm(2, 1));
    expect(cache.bytes).toBe(6);
  });
});

describe("TTSService audio cache", () => {
  test("without a cache, nothing changes", async () => {
    const tts = new FakeTTSService({ sampleRate: SAMPLE_RATE });
    await expect(tts.warmAudioCache("Hi.")).rejects.toThrow("audioCache");
  });

  test("warmed lines play from the cache, others are synthesized", async () => {
    const audioCache = new TTSAudioCache();
    const tts = new FakeTTSService({ audioCache });
    const warmed = await tts.warmAudioCache("Hello there. How are you today?", {
      sampleRate: SAMPLE_RATE,
    });
    expect(warmed).toBe(2);
    expect(tts.requests).toEqual(["Hello there.", "How are you today?"]);
    // Sample rate is back to unset until the pipeline starts.
    expect(tts.sampleRate).toBe(0);
    // Warming again synthesizes nothing.
    expect(await tts.warmAudioCache("Hello there.", { sampleRate: SAMPLE_RATE })).toBe(0);

    tts.requests = [];
    const [down] = await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello there." }),
        new TTSSpeakFrame({ text: "Something new." }),
      ],
      pipelineParams: new PipelineParams({ audioOutSampleRate: SAMPLE_RATE }),
    });
    expect(tts.requests).toEqual(["Something new."]);
    expect(down.filter((f) => f instanceof TTSStartedFrame)).toHaveLength(2);
    expect(down.filter((f) => f instanceof TTSStoppedFrame)).toHaveLength(2);
    // Cached audio comes in chunkSize pieces (0.5 s = 16000 bytes), here one.
    expect(audioOf(down)).toEqual([2000, 1000, 1000]);
    const cached = down.find((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame;
    expect(cached.contextId).toBeTruthy();
    expect(cached.sampleRate).toBe(SAMPLE_RATE);
    // Live synthesis is not stored by default.
    expect(audioCache.size).toBe(2);
  });

  test("cacheSynthesizedAudio stores live synthesis", async () => {
    const audioCache = new TTSAudioCache();
    const tts = new FakeTTSService({
      audioCache,
      sampleRate: SAMPLE_RATE,
      cacheSynthesizedAudio: (text) => text.startsWith("Keep"),
    });
    await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Keep this." }),
        new TTSSpeakFrame({ text: "Not this." }),
        new TTSSpeakFrame({ text: "Keep this." }),
      ],
    });
    expect(tts.requests).toEqual(["Keep this.", "Not this."]);
    expect(audioCache.size).toBe(1);
  });

  test("failed synthesis is not stored", async () => {
    const audioCache = new TTSAudioCache();
    const tts = new FakeTTSService({ audioCache, sampleRate: SAMPLE_RATE });
    tts.failNext = true;
    expect(await tts.warmAudioCache("Hi.", { split: false })).toBe(0);
    expect(audioCache.size).toBe(0);
  });

  test("the key depends on settings and namespace", async () => {
    const audioCache = new TTSAudioCache();
    const a = new FakeTTSService({ audioCache, sampleRate: SAMPLE_RATE });
    const b = new FakeTTSService({
      audioCache,
      sampleRate: SAMPLE_RATE,
      settings: new TTSSettings({ model: "m", voice: "other", language: null }),
    });
    const c = new FakeTTSService({ audioCache, sampleRate: SAMPLE_RATE, audioCacheNamespace: "x" });
    const d = new FakeTTSService({ audioCache, sampleRate: 24000 });
    for (const tts of [a, b, c, d]) {
      expect(await tts.warmAudioCache("Hi.", { split: false })).toBe(1);
    }
    expect(audioCache.size).toBe(4);
  });

  test("serves a service that opens its own audio context", async () => {
    class SelfStart extends FakeTTSService {
      constructor(options: TTSServiceOptions) {
        super({ ...options, pushStartFrame: false });
      }
    }
    const audioCache = new TTSAudioCache();
    const tts = new SelfStart({ audioCache, sampleRate: SAMPLE_RATE });
    await tts.warmAudioCache("Hi.", { split: false });
    tts.requests = [];
    const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
    expect(tts.requests).toEqual([]);
    expect(down.filter((f) => f instanceof TTSStartedFrame)).toHaveLength(1);
    expect(audioOf(down)).toEqual([2000]);
  });

  test("services that receive audio on their own connection don't use it", async () => {
    class Streaming extends FakeTTSService {
      override get supportsProcessingMetrics(): boolean {
        return false;
      }
    }
    const tts = new Streaming({ audioCache: new TTSAudioCache(), sampleRate: SAMPLE_RATE });
    expect(await tts.warmAudioCache("Hi.")).toBe(0);
    expect(tts.requests).toEqual([]);
  });

  test("warming before start needs a sample rate", async () => {
    const tts = new FakeTTSService({ audioCache: new TTSAudioCache() });
    await expect(tts.warmAudioCache("Hi.")).rejects.toThrow("sample rate");
  });

  test("spokenSentences are the texts LLM output is synthesized as", async () => {
    const text = "One. Two? Three, and four.\nFive";
    const tts = new FakeTTSService({ sampleRate: SAMPLE_RATE });
    await runTest(tts, {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        ...text.split(/(?<= )/).map((token) => new LLMTextFrame({ text: token })),
        new LLMFullResponseEndFrame(),
      ],
    });
    expect(tts.requests.length).toBeGreaterThan(1);
    expect(await tts.spokenSentences(text)).toEqual(tts.requests);
  });
});
