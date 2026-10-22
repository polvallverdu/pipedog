// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pockettts_tts.py

/**
 * Tests for PocketTTSService.
 *
 * Porting notes:
 * - `patch("pipecat.services.pocket_tts.tts.TTSModel")` → `spyOn(TTSModel,
 *   "loadModel")` on the engine module the service imports; torch tensors
 *   become `Float32Array`s.
 * - The model and voice state load in `start()` instead of the constructor
 *   (async in JS), so the "voice state derived once with alba" check runs
 *   after `runTest()`.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  AggregatedTextFrame,
  type Frame,
  LLMAssistantPushAggregationFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  TTSUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { type ModelState, TTSModel } from "../src/pocket_tts.ts";
import { PocketTTSService } from "../src/tts.ts";

const SAMPLE_RATE = 24000;

function makeMockModel() {
  return {
    sampleRate: SAMPLE_RATE,
    getStateForAudioPrompt: mock(
      async (_voice: string) => ({ state: "voice" }) as unknown as ModelState,
    ),
    generateAudioStream: mock(
      (_state: ModelState, _text: string, _kwargs?: { copyState?: boolean }) =>
        (async function* () {
          yield new Float32Array(2400);
          yield new Float32Array(2400).fill(0.5);
        })(),
    ),
  };
}

let loadModelSpy: ReturnType<typeof spyOn> | null = null;

function patchTTSModel(model: ReturnType<typeof makeMockModel> | null = null) {
  loadModelSpy = spyOn(TTSModel, "loadModel").mockImplementation(
    async () => model as unknown as TTSModel,
  );
  return loadModelSpy;
}

afterEach(() => {
  loadModelSpy?.mockRestore();
  loadModelSpy = null;
});

function typesOf(frames: Frame[]): (abstract new (...args: any[]) => Frame)[] {
  return frames.map((f) => f.constructor as abstract new (...args: any[]) => Frame);
}

/**
 * Test successful TTS generation.
 *
 * Checks frame ordering, audio conversion to int16, and that the cached
 * voice state is passed with copyState=true.
 */
test("test_run_pocket_tts_success", async () => {
  const model = makeMockModel();
  patchTTSModel(model);

  const ttsService = new PocketTTSService({ sampleRate: SAMPLE_RATE });

  const framesToSend = [new TTSSpeakFrame({ text: "Hello world." })];

  const [downFrames] = await runTest(ttsService, { framesToSend });

  // DIVERGENCE: upstream asserts this right after construction; the voice
  // state is derived in start() here.
  expect(model.getStateForAudioPrompt).toHaveBeenCalledTimes(1);
  expect(model.getStateForAudioPrompt).toHaveBeenCalledWith("alba");

  const frameTypes = typesOf(downFrames);

  // Verify key frames are present
  expect(frameTypes).toContain(AggregatedTextFrame);
  expect(frameTypes).toContain(TTSStartedFrame);
  expect(frameTypes).toContain(TTSStoppedFrame);
  expect(frameTypes).toContain(TTSTextFrame);

  // Verify ordering: Started → audio/text → Stopped
  const startedIdx = frameTypes.indexOf(TTSStartedFrame);
  const stoppedIdx = frameTypes.indexOf(TTSStoppedFrame);
  const textIdx = frameTypes.indexOf(TTSTextFrame);
  expect(startedIdx < textIdx && textIdx < stoppedIdx).toBe(true);

  // Frames between Started and Stopped must all be audio or text. A
  // LLMAssistantPushAggregationFrame is also expected here: TTSSpeakFrame
  // defaults to appendToContext=true, so the service emits one at the end
  // of the utterance to commit the spoken text to the LLM context.
  for (let i = startedIdx + 1; i < stoppedIdx; i++) {
    expect([TTSAudioRawFrame, TTSTextFrame, LLMAssistantPushAggregationFrame]).toContain(
      frameTypes[i]!,
    );
  }

  const audioFrames = downFrames.filter((f) => f instanceof TTSAudioRawFrame);
  expect(audioFrames.length).toBeGreaterThanOrEqual(1);
  for (const aFrame of audioFrames) {
    expect(aFrame.sampleRate).toBe(SAMPLE_RATE);
  }

  // The two mock chunks are 2400 zero samples then 2400 samples of 0.5,
  // which convert to int16 0 and 16383 respectively.
  const audio = new Uint8Array(audioFrames.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audioFrames) {
    audio.set(f.audio, offset);
    offset += f.audio.length;
  }
  const samples = new Int16Array(audio.buffer, 0, audio.length / 2);
  expect(samples.length).toBe(4800);
  expect(samples.subarray(0, 2400).every((s) => s === 0)).toBe(true);
  expect(samples.subarray(2400).every((s) => s === 16383)).toBe(true);

  expect(model.generateAudioStream).toHaveBeenCalledTimes(1);
  const [args0, , kwargs] = model.generateAudioStream.mock.calls[0]!;
  expect(args0 as unknown).toEqual({ state: "voice" }); // Expected the cached voice state
  expect(kwargs?.copyState).toBe(true);
});

/** Test that a runtime voice change re-derives the voice state. */
test("test_pocket_tts_voice_update", async () => {
  const model = makeMockModel();
  patchTTSModel(model);

  const ttsService = new PocketTTSService({ sampleRate: SAMPLE_RATE });

  const framesToSend = [
    new TTSSpeakFrame({ text: "First voice." }),
    new SleepFrame({ sleep: 0.5 }),
    new TTSUpdateSettingsFrame({ delta: new PocketTTSService.Settings({ voice: "jane" }) }),
    new TTSSpeakFrame({ text: "Second voice." }),
    new SleepFrame({ sleep: 0.5 }),
  ];

  await runTest(ttsService, { framesToSend });

  const voices = model.getStateForAudioPrompt.mock.calls.map((call) => call[0]);
  expect(voices).toEqual(["alba", "jane"]);
  expect(model.generateAudioStream).toHaveBeenCalledTimes(2);
});

for (const [id, voice] of [
  ["none", null],
  ["blank", ""],
] as const) {
  test(`test_missing_or_blank_voice_is_rejected_before_the_model_loads[${id}]`, () => {
    const loadModel = patchTTSModel();

    expect(
      () => new PocketTTSService({ settings: new PocketTTSService.Settings({ voice }) }),
    ).toThrow("Pocket TTS voice must be specified");

    expect(loadModel).not.toHaveBeenCalled();
  });
}
