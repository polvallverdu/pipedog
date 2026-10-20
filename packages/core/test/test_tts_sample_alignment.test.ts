// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_sample_alignment.py

/**
 * Tests for keeping TTS audio frames aligned to whole 16-bit samples.
 *
 * Providers may cut their PCM stream at any byte, so a chunk can end mid-sample.
 * TTSService holds the partial sample back and prepends it to the context's next
 * frame, so every audio frame it emits holds whole samples.
 */

import { expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { detectSpeechOnset } from "../src/audio/utils.ts";
import {
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
} from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const _SAMPLE_RATE = 16000;
const _PCM = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

function _split(data: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  for (const size of sizes) {
    chunks.push(data.slice(pos, pos + size));
    pos += size;
  }
  return chunks;
}

function _concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

interface MockTTSServiceOptions extends TTSServiceOptions {
  numChannels?: number;
  delayS?: number;
}

/** HTTP-style TTS service that yields each utterance as the given chunks. */
class MockTTSService extends TTSService {
  _chunks: Uint8Array[];
  _numChannels: number;
  _delayS: number;
  yieldedFrames: TTSAudioRawFrame[] = [];

  constructor(chunks: Uint8Array[], options: MockTTSServiceOptions = {}) {
    super({
      ...options,
      pushTextFrames: false,
      pushStopFrames: true,
      sampleRate: _SAMPLE_RATE,
    });
    this._chunks = chunks;
    this._numChannels = options.numChannels ?? 1;
    this._delayS = options.delayS ?? 0;
  }

  override canGenerateMetrics(): boolean {
    return true;
  }

  async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    for (const chunk of this._chunks) {
      const frame = new TTSAudioRawFrame({
        audio: chunk,
        sampleRate: _SAMPLE_RATE,
        numChannels: this._numChannels,
        contextId,
      });
      this.yieldedFrames.push(frame);
      yield frame;
      if (this._delayS) {
        await sleep(this._delayS);
      }
    }
  }

  get remainders(): Map<string, unknown> {
    return this._audioContextManager["_remainders"] as Map<string, unknown>;
  }
}

async function _run(service: TTSService, ...frames: Frame[]): Promise<Frame[]> {
  const [downFrames] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), ...frames],
    pipelineParams: new PipelineParams({ enableMetrics: true }),
  });
  return downFrames;
}

async function _speak(service: TTSService, ...frames: Frame[]): Promise<TTSAudioRawFrame[]> {
  return (await _run(service, ...frames)).filter(
    (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
  );
}

test("test_split_samples_are_realigned", async () => {
  // Odd chunk sizes, including a single byte, totaling an even length.
  const service = new MockTTSService(_split(_PCM, [1023, 1, 2047, 1, 1024]));

  const audioFrames = await _speak(service);

  expect(audioFrames.every((f) => f.audio.length % 2 === 0)).toBe(true);
  expect(audioFrames.every((f) => f.numFrames === Math.floor(f.audio.length / 2))).toBe(true);
  expect(_concat(audioFrames.map((f) => f.audio))).toEqual(_PCM);
});

test("test_aligned_frames_pass_through_untouched", async () => {
  const service = new MockTTSService(_split(_PCM, [1024, 2048, 1024]));

  const audioFrames = await _speak(service);

  expect(audioFrames.map((f) => f.id)).toEqual(service.yieldedFrames.map((f) => f.id));
  expect(audioFrames.map((f) => f.audio)).toEqual(service.yieldedFrames.map((f) => f.audio));
});

test("test_stereo_frames_align_to_whole_sample_pairs", async () => {
  const service = new MockTTSService(_split(_PCM, [1022, 3, 2049, 1022]), { numChannels: 2 });

  const audioFrames = await _speak(service);

  expect(audioFrames.every((f) => f.audio.length % 4 === 0)).toBe(true);
  expect(_concat(audioFrames.map((f) => f.audio))).toEqual(_PCM);
});

test("test_trailing_partial_sample_is_padded_at_end_of_context", async () => {
  const service = new MockTTSService(_split(_PCM.slice(0, 2047), [1023, 1024]));

  const downFrames = await _run(service);

  const audioFrames = downFrames.filter(
    (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
  );
  expect(audioFrames.every((f) => f.audio.length % 2 === 0)).toBe(true);
  expect(_concat(audioFrames.map((f) => f.audio))).toEqual(
    _concat([_PCM.slice(0, 2047), new Uint8Array([0])]),
  );
  // The padded sample is part of the utterance, so it plays before the stop frame.
  let lastAudio = -1;
  downFrames.forEach((f, i) => {
    if (f instanceof TTSAudioRawFrame) lastAudio = i;
  });
  expect(lastAudio).toBeGreaterThanOrEqual(0);
  const stopped = downFrames.findIndex((f) => f instanceof TTSStoppedFrame);
  expect(stopped).toBeGreaterThanOrEqual(0);
  expect(lastAudio).toBeLessThan(stopped);
  expect(service.remainders.size).toBe(0);
});

test("test_context_timeout_drops_partial_sample", async () => {
  // The response stalls mid-sample until its audio context times out.
  const service = new MockTTSService([_PCM.slice(0, 1023)], {
    delayS: 0.3,
    stopFrameTimeoutS: 0.1,
  });

  await runTest(service, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "Hello." }),
      new LLMFullResponseEndFrame(),
      new SleepFrame({ sleep: 0.5 }),
    ],
  });

  expect(service.remainders.size).toBe(0);
});

test("test_interruption_discards_partial_sample", async () => {
  const service = new MockTTSService(_split(_PCM, [1023, 1024, 2049]), { delayS: 0.05 });

  await _speak(
    service,
    new SleepFrame({ sleep: 0.02 }),
    new InterruptionFrame(),
    new SleepFrame({ sleep: 0.2 }),
  );

  expect(service.remainders.size).toBe(0);
});

test("test_speech_onset_tolerates_partial_trailing_sample", () => {
  const silence = new Uint8Array(2 * 1600);
  const speech = new Uint8Array(4 * 1600);
  for (let i = 0; i < 1600; i++) {
    speech.set([0x00, 0x40, 0x00, 0xc0], i * 4);
  }

  const onset = detectSpeechOnset(_concat([silence, speech, new Uint8Array([0x01])]), _SAMPLE_RATE);

  expect(onset).not.toBeNull();
});
