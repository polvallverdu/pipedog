// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_stt_service.py

/** Tests for the audio handling shared by every STTService. */

import { expect, test } from "bun:test";

import {
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
  STTMetadataFrame,
} from "../src/frames/frames.ts";
import { STTService, type STTServiceOptions } from "../src/services/stt_service.ts";
import { runTest } from "../src/tests/utils.ts";

const SAMPLE_RATE = 16000;

/** Equivalent of `pattern * count` on Python bytes. */
function repeatBytes(pattern: number[], count: number): Uint8Array {
  const out = new Uint8Array(pattern.length * count);
  for (let i = 0; i < count; i++) out.set(pattern, i * pattern.length);
  return out;
}

// Distinct payloads so the audio handed to runStt() shows which frame it came from.
const INPUT_PCM = repeatBytes([0x01, 0x00], 160);
const OUTPUT_PCM = repeatBytes([0x02, 0x00], 160);

/**
 * Build an STTService that records the audio handed to runStt().
 *
 * Defined as a factory (not a module-level class) so this concrete subclass
 * isn't picked up by the service-discovery scan in test_service_init.
 */
function makeCapturingService(options: STTServiceOptions = {}) {
  class _CapturingSTTService extends STTService {
    captured: Uint8Array[] = [];

    // biome-ignore lint/correctness/useYield: matches upstream (empty async generator)
    async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
      this.captured.push(audio);
    }
  }

  return new _CapturingSTTService(options);
}

function inputAudio(): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio: INPUT_PCM, sampleRate: SAMPLE_RATE, numChannels: 1 });
}

function outputAudio(): OutputAudioRawFrame {
  return new OutputAudioRawFrame({ audio: OUTPUT_PCM, sampleRate: SAMPLE_RATE, numChannels: 1 });
}

test("test_output_audio_is_forwarded_without_being_transcribed", async () => {
  const service = makeCapturingService();

  await runTest(service, {
    framesToSend: [inputAudio(), outputAudio()],
    expectedDownFrames: [STTMetadataFrame, InputAudioRawFrame, OutputAudioRawFrame],
  });

  expect(service.captured).toEqual([INPUT_PCM]);
});

test("test_output_audio_is_forwarded_even_without_audio_passthrough", async () => {
  const service = makeCapturingService({ audioPassthrough: false });

  await runTest(service, {
    framesToSend: [inputAudio(), outputAudio()],
    expectedDownFrames: [STTMetadataFrame, OutputAudioRawFrame],
  });

  expect(service.captured).toEqual([INPUT_PCM]);
});
