// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_vad_processor.py

import { describe, test } from "bun:test";

import { VADAnalyzer, VADState } from "../src/audio/vad/vad_analyzer.ts";
import {
  InputAudioRawFrame,
  SpeechControlParamsFrame,
  UserSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { VADProcessor } from "../src/processors/audio/vad_processor.ts";
import { runTest } from "../src/tests/utils.ts";

/** A mock VAD analyzer that returns states from a predefined sequence. */
class MockVADAnalyzer extends VADAnalyzer {
  _states: VADState[];
  _callIndex: number;

  constructor(states: VADState[]) {
    super({ sampleRate: 16000 });
    this._states = [...states];
    this._callIndex = 0;
  }

  numFramesRequired(): number {
    return 512;
  }

  voiceConfidence(_buffer: Uint8Array): number {
    return 0.9;
  }

  override async analyzeAudio(_buffer: Uint8Array): Promise<VADState> {
    if (this._callIndex < this._states.length) {
      const state = this._states[this._callIndex]!;
      this._callIndex += 1;
      return state;
    }
    return VADState.QUIET;
  }
}

describe("TestVADProcessor", () => {
  const makeAudioFrame = () =>
    new InputAudioRawFrame({ audio: new Uint8Array(1024), sampleRate: 16000, numChannels: 1 });

  test("test_forwards_audio_frames", async () => {
    // Test that audio frames are forwarded downstream.
    const analyzer = new MockVADAnalyzer([VADState.QUIET]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    await runTest(processor, {
      framesToSend: [makeAudioFrame()],
      expectedDownFrames: [SpeechControlParamsFrame, InputAudioRawFrame],
    });
  });

  test("test_pushes_started_speaking_frame", async () => {
    // Test that VADUserStartedSpeakingFrame is pushed when speech starts.
    const analyzer = new MockVADAnalyzer([VADState.QUIET, VADState.SPEAKING]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    // Audio frames are forwarded first, then VAD processes and broadcasts VAD frames
    await runTest(processor, {
      framesToSend: [makeAudioFrame(), makeAudioFrame()],
      expectedDownFrames: [
        SpeechControlParamsFrame,
        InputAudioRawFrame,
        InputAudioRawFrame,
        VADUserStartedSpeakingFrame,
        UserSpeakingFrame,
      ],
    });
  });

  test("test_pushes_stopped_speaking_frame", async () => {
    // Test that VADUserStoppedSpeakingFrame is pushed when speech stops.
    const analyzer = new MockVADAnalyzer([VADState.SPEAKING, VADState.QUIET]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    // Audio frames are forwarded first, then VAD processes and broadcasts VAD frames
    await runTest(processor, {
      framesToSend: [makeAudioFrame(), makeAudioFrame()],
      expectedDownFrames: [
        SpeechControlParamsFrame,
        InputAudioRawFrame,
        VADUserStartedSpeakingFrame,
        UserSpeakingFrame,
        InputAudioRawFrame,
        VADUserStoppedSpeakingFrame,
      ],
    });
  });

  test("test_pushes_user_speaking_frame", async () => {
    // Test that UserSpeakingFrame is pushed while speaking.
    const analyzer = new MockVADAnalyzer([VADState.SPEAKING]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    // Audio frames are forwarded first, then VAD processes and broadcasts VAD frames
    await runTest(processor, {
      framesToSend: [makeAudioFrame()],
      expectedDownFrames: [
        SpeechControlParamsFrame,
        InputAudioRawFrame,
        VADUserStartedSpeakingFrame,
        UserSpeakingFrame,
      ],
    });
  });

  test("test_no_vad_frames_on_starting_state", async () => {
    // Test that STARTING state doesn't push VAD frames.
    const analyzer = new MockVADAnalyzer([VADState.STARTING]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    await runTest(processor, {
      framesToSend: [makeAudioFrame()],
      expectedDownFrames: [SpeechControlParamsFrame, InputAudioRawFrame],
    });
  });

  test("test_no_vad_frames_on_stopping_state", async () => {
    // Test that STOPPING state doesn't push VAD frames.
    const analyzer = new MockVADAnalyzer([VADState.STOPPING]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    await runTest(processor, {
      framesToSend: [makeAudioFrame()],
      expectedDownFrames: [SpeechControlParamsFrame, InputAudioRawFrame],
    });
  });

  test("test_no_vad_frames_when_quiet", async () => {
    // Test that no VAD frames are pushed when staying quiet.
    const analyzer = new MockVADAnalyzer([VADState.QUIET, VADState.QUIET]);
    const processor = new VADProcessor({ vadAnalyzer: analyzer });

    await runTest(processor, {
      framesToSend: [makeAudioFrame(), makeAudioFrame()],
      expectedDownFrames: [SpeechControlParamsFrame, InputAudioRawFrame, InputAudioRawFrame],
    });
  });
});
