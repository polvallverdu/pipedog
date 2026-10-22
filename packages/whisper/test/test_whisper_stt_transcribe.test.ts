// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_whisper_stt_transcribe.py

/**
 * Tests for how the Whisper STT service runs a transcription.
 *
 * Upstream patches `pipecat.services.whisper.stt.WhisperModel`; here the
 * engine module (`../src/faster_whisper.ts`) is replaced with `mock.module`.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { TranscriptionFrame } from "@pipedog/core/frames/frames";
import * as engineModule from "../src/faster_whisper.ts";

const ENGINE = resolve(import.meta.dir, "../src/faster_whisper.ts");

// A snapshot taken before mocking: `mock.module` updates the live bindings of
// modules already imported, and stays in effect for the rest of the run.
const realEngine = { ...engineModule };

let stubModel: unknown = null;

function FakeWhisperModel(this: unknown, name: string, options: unknown): unknown {
  if (stubModel) return stubModel;
  return new realEngine.WhisperModel(name, options as engineModule.WhisperModelOptions);
}

let stt: any;

beforeAll(async () => {
  mock.module(ENGINE, () => ({ ...realEngine, WhisperModel: FakeWhisperModel }));
  stt = await import("../src/stt.ts");
});

afterAll(() => {
  stubModel = null;
});

/**
 * Stands in for `WhisperModel`, whose `transcribe` returns a lazy generator.
 *
 * faster-whisper decodes each segment only when the generator is advanced, so
 * whoever consumes the generator is who does the work.
 */
class _LazyModel {
  supportedLanguages = ["en"];
  /** Upstream records decoding thread ids; here, when each segment was decoded. */
  decodingSteps: string[] = [];
  returned = false;

  transcribe(_audio: Float32Array, _options: Record<string, unknown>) {
    const self = this;
    function* segments() {
      for (const text of ["Hello", "world."]) {
        self.decodingSteps.push(self.returned ? "after-return" : "inside-transcribe");
        yield { text, noSpeechProb: 0.0 };
      }
    }
    const result = [segments(), {}] as const;
    this.returned = true;
    return result;
  }
}

function _build(model: _LazyModel): any {
  stubModel = model;
  try {
    const { WhisperSTTService } = stt;
    return new WhisperSTTService({
      settings: new WhisperSTTService.Settings({ model: "small.en" }),
    });
  } finally {
    stubModel = null;
  }
}

test("test_segments_are_decoded_off_the_event_loop", async () => {
  // Decoding would otherwise stall every other task, audio transports included.
  const model = new _LazyModel();
  const service = _build(model);
  const audio = new Uint8Array(2 * 16000);

  const frames: unknown[] = [];
  for await (const frame of service.runStt(audio)) frames.push(frame);

  // DIVERGENCE: upstream asserts the generator is consumed on a worker thread
  // (`asyncio.to_thread`). JavaScript has no threads: the service consumes the
  // lazy generator itself, after `transcribe` returns, one segment per await,
  // and the real engine's per-step inference runs in the ONNX runtime's own
  // threads (onnxruntime-node). So this checks that decoding happened while
  // the service iterated the segments, not inside `transcribe`.
  expect(model.decodingSteps.length).toBeGreaterThan(0);
  expect(model.decodingSteps.every((s) => s === "after-return")).toBe(true);
  const transcriptions = frames.filter(
    (frame): frame is TranscriptionFrame => frame instanceof TranscriptionFrame,
  );
  expect(transcriptions.map((frame) => frame.text.split(/\s+/).filter(Boolean))).toEqual([
    ["Hello", "world."],
  ]);
});
