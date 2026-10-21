// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_xai_stt.py

/**
 * Tests for the xAI streaming STT service.
 *
 * Porting notes:
 * - `monkeypatch.setattr(service, "_connect", fake)` → assigning the instance
 *   property.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported
 *   locally.
 */

import { expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { XAISTTService } from "../src/stt.ts";

type Dict = Record<string, any>;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager,
  });
}

/** Build the WebSocket URL and return its parsed query parameters. */
function _query(service: XAISTTService): Record<string, string[]> {
  const params = new URL(service._buildWsUrl()).searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    out[key] = params.getAll(key);
  }
  return out;
}

/** Set the service up with the given input sample rate, without connecting. */
async function _setupService(service: XAISTTService, sampleRate: number): Promise<void> {
  (service as any)._connect = async () => {};
  await service.setup(frameProcessorSetup(new TaskManager(), { audioInSampleRate: sampleRate }));
}

test("test_sample_rate_inherits_setup_when_omitted", async () => {
  const service = new XAISTTService({ apiKey: "test-key" });

  await _setupService(service, 8000);

  expect(service.sampleRate).toBe(8000);
  expect(_query(service).sample_rate).toEqual(["8000"]);
});

test("test_explicit_sample_rate_overrides_setup", async () => {
  const service = new XAISTTService({ apiKey: "test-key", sampleRate: 16000 });

  await _setupService(service, 8000);

  expect(service.sampleRate).toBe(16000);
  expect(_query(service).sample_rate).toEqual(["16000"]);
});

test("test_model_is_sent_as_query_parameter", () => {
  let service = new XAISTTService({ apiKey: "test-key" });
  expect(_query(service).model).toEqual(["grok-voice-transcribe-2.0"]);

  service = new XAISTTService({
    apiKey: "test-key",
    settings: new XAISTTService.Settings({ model: "grok-voice-transcribe-1.0" }),
  });
  expect(_query(service).model).toEqual(["grok-voice-transcribe-1.0"]);
});

/** Record every frame the service pushes, bypassing metrics and tracing. */
function _collectFrames(service: XAISTTService): Frame[] {
  const pushed: Frame[] = [];
  const svc = service as any;
  svc.pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };
  svc.emitSttUsageMetrics = async () => {};
  svc._traceTranscription = async () => {};
  return pushed;
}

async function _feed(service: XAISTTService, messages: Dict[]): Promise<void> {
  for (const message of messages) {
    await service._handleMessage(message);
  }
}

function _partial(text: string, options: { isFinal?: boolean; speechFinal?: boolean } = {}): Dict {
  return {
    type: "transcript.partial",
    text,
    is_final: options.isFinal ?? false,
    speech_final: options.speechFinal ?? false,
  };
}

function _describe(frames: Frame[]): [string, string][] {
  return frames.map((frame) => [frame.constructor.name, (frame as any).text]);
}

test("test_utterance_final_is_the_only_transcription_frame", async () => {
  // The utterance final restates every chunk final, so it is the one
  // TranscriptionFrame for the utterance; chunk finals are interims.
  const service = new XAISTTService({ apiKey: "test-key" });
  const pushed = _collectFrames(service);

  await _feed(service, [
    _partial("my order"),
    _partial("my order number", { isFinal: true }),
    _partial("is four"),
    _partial("is four two one.", { isFinal: true }),
    _partial("my order number is four two one.", { isFinal: true, speechFinal: true }),
  ]);

  expect(_describe(pushed)).toEqual([
    ["InterimTranscriptionFrame", "my order"],
    ["InterimTranscriptionFrame", "my order number"],
    ["InterimTranscriptionFrame", "is four"],
    ["InterimTranscriptionFrame", "is four two one."],
    ["TranscriptionFrame", "my order number is four two one."],
  ]);
  expect((pushed.at(-1) as TranscriptionFrame).finalized).toBe(true);
});

test("test_each_utterance_gets_its_own_transcription_frame", async () => {
  // Utterance finals are scoped to one utterance, not cumulative across the
  // session, so back-to-back utterances yield one frame each.
  const service = new XAISTTService({ apiKey: "test-key" });
  const pushed = _collectFrames(service);

  await _feed(service, [
    _partial("My order number is", { isFinal: false }),
    _partial("My order number is four two one.", { isFinal: true }),
    _partial("My order number is four two one.", { isFinal: true, speechFinal: true }),
    _partial("And I would like to know when it will ship.", { isFinal: true }),
    _partial("And I would like to know when it will ship.", { isFinal: true, speechFinal: true }),
  ]);

  const finals = pushed.filter((frame) => frame instanceof TranscriptionFrame);
  expect(finals.map((frame) => (frame as TranscriptionFrame).text)).toEqual([
    "My order number is four two one.",
    "And I would like to know when it will ship.",
  ]);
});

test("test_empty_finals_are_ignored", async () => {
  // The server sends an empty chunk final and an empty transcript.done after
  // the stream ends; neither produces a frame.
  const service = new XAISTTService({ apiKey: "test-key" });
  const pushed = _collectFrames(service);

  await _feed(service, [
    _partial("", { isFinal: true }),
    { type: "transcript.done", text: "", duration: 5.6 },
  ]);

  expect(pushed).toEqual([]);
});

test("test_transcript_done_with_text_is_a_transcription_frame", async () => {
  const service = new XAISTTService({ apiKey: "test-key" });
  const pushed = _collectFrames(service);

  await _feed(service, [{ type: "transcript.done", text: "trailing words", duration: 1.0 }]);

  expect(_describe(pushed)).toEqual([["TranscriptionFrame", "trailing words"]]);
  expect((pushed[0] as TranscriptionFrame).finalized).toBe(true);
});
