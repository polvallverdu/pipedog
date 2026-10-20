// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_zero_audio_contexts.py

/**
 * Tests for writing off a TTS service that stops producing audio.
 *
 * A provider can accept every request and return no audio at all — an unknown
 * voice ID, say — without reporting an error. TTSService reports every context
 * that completes in silence and, past a configurable limit, reports itself unable
 * to do its job so the pipeline worker and any ServiceSwitcher can act on it.
 */

import { expect, test } from "bun:test";

import { sleep, waitFor } from "@pipedog/asyncio";

import {
  DataFrame,
  type DataFrameOptions,
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  TextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
} from "../src/frames/frames.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const _FAKE_AUDIO = (() => {
  const out = new Uint8Array(640);
  for (let i = 0; i < 640; i += 2) {
    out[i] = 0x00;
    out[i + 1] = 0x01;
  }
  return out;
})();
const _SAMPLE_RATE = 16000;

// Long enough for a context to be dequeued and played out, short enough to keep
// the tests quick: a silent context is only complete once it times out.
const _STOP_FRAME_TIMEOUT_S = 0.1;

interface MockTTSServiceOptions extends TTSServiceOptions {
  speakingUtterances?: Set<number> | null;
}

/**
 * HTTP-style TTS service that returns audio only for chosen utterances.
 *
 * Every other request is accepted and answered with nothing, like a provider
 * given a voice it doesn't know.
 */
class MockTTSService extends TTSService {
  _speakingUtterances: Set<number>;
  _utterances = 0;

  constructor(options: MockTTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: false,
      sampleRate: _SAMPLE_RATE,
      stopFrameTimeoutS: _STOP_FRAME_TIMEOUT_S,
      ...options,
    });
    this._speakingUtterances = options.speakingUtterances ?? new Set();
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this._utterances += 1;
    if (this._speakingUtterances.has(this._utterances)) {
      yield new TTSAudioRawFrame({
        audio: _FAKE_AUDIO,
        sampleRate: _SAMPLE_RATE,
        numChannels: 1,
        contextId,
      });
    }
  }
}

interface MarkerFrameOptions extends DataFrameOptions {
  label?: string;
}

/** Marks how far downstream processing has got. */
class MarkerFrame extends DataFrame {
  label: string;

  constructor(options: MarkerFrameOptions = {}) {
    super(options);
    this.label = options.label ?? "";
  }
}

/**
 * WebSocket-style service that pauses frame processing and never speaks.
 *
 * The provider reports the context finished with no audio at all, so the
 * transport never sends BotStartedSpeakingFrame or BotStoppedSpeakingFrame.
 */
class MockPausingTTSService extends TTSService {
  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      sampleRate: _SAMPLE_RATE,
      ...options,
    });
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const _deliverZeroAudioCompletion = async () => {
      await sleep(0.01);
      await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
      await this.removeAudioContext(contextId);
    };

    this.createTask(_deliverZeroAudioCompletion, `zero_audio_${contextId}`);
  }
}

/** Speak each text in its own context, waiting for each one to complete. */
function _speak(...texts: string[]): Frame[] {
  const frames: Frame[] = [];
  for (const text of texts) {
    frames.push(new TTSSpeakFrame({ text }));
    frames.push(new SleepFrame({ sleep: _STOP_FRAME_TIMEOUT_S * 3 }));
  }
  return frames;
}

function _errors(up: readonly Frame[]): ErrorFrame[] {
  return up.filter((frame): frame is ErrorFrame => frame instanceof ErrorFrame);
}

/**
 * A turn that produces no speech is reported without waiting for the limit.
 *
 * Nothing else marks the end of a turn that never played audio, so this error
 * is all anything waiting on the bot to speak has to go on.
 */
test("test_the_first_silent_context_is_reported", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 3 });

  const [, up] = await waitFor(() => runTest(tts, { framesToSend: _speak("one") }), 5.0);

  const errors = _errors(up);
  expect(errors.length).toBe(1);
  expect(tts.isUsable).toBe(true);
});

test("test_silence_under_the_limit_leaves_the_service_usable", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 3 });

  const [, up] = await waitFor(() => runTest(tts, { framesToSend: _speak("one", "two") }), 5.0);

  expect(tts.isUsable).toBe(true);

  // Each silent context is reported as it happens, so a first turn that never
  // speaks is something application code can act on right away.
  const errors = _errors(up);
  expect(errors.length).toBe(2);
  expect(errors.every((error) => error.processor === tts)).toBe(true);
  expect(errors.every((error) => error.processor!.isUsable)).toBe(true);
});

test("test_consecutive_silent_contexts_write_off_the_service", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 2 });

  const [, up] = await waitFor(() => runTest(tts, { framesToSend: _speak("one", "two") }), 5.0);

  expect(tts.isUsable).toBe(false);

  // The context that reaches the limit reports the permanent error in place of
  // the recoverable one, so each silent context is reported once.
  const errors = _errors(up);
  expect(errors.length).toBe(2);
  expect(errors[0]!.processor).toBe(tts);
  // The processor is already written off by the time the last error is seen,
  // which is what tells application code the error is not a transient one.
  expect(errors[errors.length - 1]!.processor!.isUsable).toBe(false);
});

test("test_audio_resets_the_count", async () => {
  // Silence either side of an utterance that does produce audio: without the
  // reset, the two silent ones together would reach the limit.
  const tts = new MockTTSService({
    speakingUtterances: new Set([2]),
    maxConsecutiveZeroAudioContexts: 2,
  });

  const [, up] = await waitFor(
    () => runTest(tts, { framesToSend: _speak("silent", "spoken", "silent again") }),
    5.0,
  );

  expect(tts.isUsable).toBe(true);
  expect(tts["_consecutiveZeroAudioContexts"]).toBe(1);
  // One per silent context, neither of them reaching the limit.
  expect(_errors(up).length).toBe(2);
});

test("test_zero_reports_silent_contexts_without_writing_the_service_off", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 0 });

  const [, up] = await waitFor(
    () => runTest(tts, { framesToSend: _speak("one", "two", "three", "four") }),
    5.0,
  );

  // Silence is reported however long it goes on, but never costs the service
  // its usability.
  expect(tts.isUsable).toBe(true);
  expect(_errors(up).length).toBe(4);
});

test("test_the_service_is_written_off_once", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 1 });

  const [, up] = await waitFor(
    () => runTest(tts, { framesToSend: _speak("one", "two", "three") }),
    5.0,
  );

  // An unusable service is no longer given work, so its silent contexts say
  // nothing new and are not reported again.
  expect(_errors(up).length).toBe(1);
});

test("test_an_interrupted_context_is_not_counted", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 1 });

  const frames: Frame[] = [
    new TTSSpeakFrame({ text: "interrupted" }),
    // Interrupt while the context is still waiting for audio.
    new SleepFrame({ sleep: _STOP_FRAME_TIMEOUT_S / 2 }),
    new InterruptionFrame(),
    new SleepFrame({ sleep: _STOP_FRAME_TIMEOUT_S * 3 }),
  ];

  const [, up] = await waitFor(() => runTest(tts, { framesToSend: frames }), 5.0);

  expect(tts.isUsable).toBe(true);
  expect(tts["_consecutiveZeroAudioContexts"]).toBe(0);
  expect(_errors(up)).toEqual([]);
});

test("test_becoming_usable_again_clears_the_count", async () => {
  const tts = new MockTTSService({ maxConsecutiveZeroAudioContexts: 2 });

  await waitFor(() => runTest(tts, { framesToSend: _speak("one") }), 5.0);

  expect(tts["_consecutiveZeroAudioContexts"]).toBe(1);

  await tts.setUsable(true);

  expect(tts["_consecutiveZeroAudioContexts"]).toBe(0);
});

/**
 * A context known to have played nothing lifts the pause it took.
 *
 * The pause is taken while the context is still open and might yet produce
 * audio; nothing else will resume it once the context completes in silence.
 */
test("test_a_silent_context_resumes_frame_processing", async () => {
  const tts = new MockPausingTTSService({ maxConsecutiveZeroAudioContexts: 0 });

  const framesToSend: Frame[] = [
    new LLMFullResponseStartFrame(),
    new TextFrame({ text: "Hello." }),
    new LLMFullResponseEndFrame(),
    new SleepFrame({ sleep: 0.2 }),
    new MarkerFrame({ label: "after_silence" }),
  ];

  const [down, up] = await waitFor(() => runTest(tts, { framesToSend }), 5.0);

  const markers = down.filter((frame): frame is MarkerFrame => frame instanceof MarkerFrame);
  // frame processing stayed paused after a context completed with no audio
  expect(markers.some((marker) => marker.label === "after_silence")).toBe(true);
  // The silence is reported, and the service carries on able to do its job.
  expect(_errors(up).length).toBe(1);
  expect(tts.isUsable).toBe(true);
});
