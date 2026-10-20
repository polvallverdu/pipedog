// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_audio_context_hooks.py

/**
 * Tests that a failing audio-context hook can't stop TTS playback.
 *
 * Services override onAudioContextCompleted and onAudioContextInterrupted
 * to message the provider, so the hooks can fail while the connection is down.
 */

import { expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";

import {
  type Frame,
  InterruptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "../src/frames/frames.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const _SAMPLE_RATE = 16000;

interface FailingHookTTSServiceOptions extends TTSServiceOptions {
  delayS?: number;
}

/** HTTP-style service whose audio-context hooks raise, like a closed socket. */
class FailingHookTTSService extends TTSService {
  #delayS: number;
  #utterances = 0;

  constructor(options: FailingHookTTSServiceOptions = {}) {
    super({ ...options, pushTextFrames: false, sampleRate: _SAMPLE_RATE });
    this.#delayS = options.delayS ?? 0;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async onAudioContextCompleted(_contextId: string): Promise<void> {
    throw new Error("Websocket not connected");
  }

  override async onAudioContextInterrupted(_contextId: string): Promise<void> {
    throw new Error("Websocket not connected");
  }

  override async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.#utterances += 1;
    // Each utterance's audio is tagged with its position, so tests can tell
    // which ones played.
    const audio = new Uint8Array(320);
    for (let i = 0; i < audio.length; i += 2) audio[i] = this.#utterances;
    yield new TTSAudioRawFrame({ audio, sampleRate: _SAMPLE_RATE, numChannels: 1, contextId });
    if (this.#delayS) {
      await sleep(this.#delayS);
    }
  }
}

function _utterancesHeard(frames: Frame[]): number[] {
  const heard = new Set<number>();
  for (const f of frames) {
    if (f instanceof TTSAudioRawFrame) heard.add(f.audio[0]!);
  }
  return [...heard].sort((a, b) => a - b);
}

test("test_failing_completed_hook_keeps_playback_running", async () => {
  const service = new FailingHookTTSService();

  const [downFrames] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "One." }), new TTSSpeakFrame({ text: "Two." })],
  });

  expect(_utterancesHeard(downFrames)).toEqual([1, 2]);
});

test("test_failing_interrupted_hook_keeps_playback_running", async () => {
  const service = new FailingHookTTSService({ delayS: 0.2 });

  const [downFrames] = await runTest(service, {
    framesToSend: [
      new TTSSpeakFrame({ text: "One." }),
      new SleepFrame({ sleep: 0.05 }),
      new InterruptionFrame(),
      new TTSSpeakFrame({ text: "Two." }),
      new SleepFrame({ sleep: 0.3 }),
    ],
  });

  expect(_utterancesHeard(downFrames)).toContain(2);
});
