// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_stt.py

/** Tests for the Azure STT service init parameters and recognized handler. */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";

import {
  type AzureProfanity,
  AzureSpeechConfig,
  AzureSTTService,
  PropertyId,
  ResultReason,
} from "../src/stt.ts";

afterEach(() => {
  mock.restore();
});

/**
 * The `profanity` setting surfaces `AzureSpeechConfig.setProfanity` as a
 * runtime-updatable `AzureSTTSettings` field so callers don't have to reach
 * into the private `_speechConfig` to disable Azure's profanity masking.
 */
describe("TestAzureSTTProfanitySetting", () => {
  function _service(profanity: AzureProfanity) {
    return new AzureSTTService({
      apiKey: "fake",
      region: "eastus",
      settings: new AzureSTTService.Settings({ profanity }),
    });
  }

  test("test_profanity_omitted_is_no_op", () => {
    // Omitted = keep Azure default (Masked). Constructor should not crash and
    // `_speechConfig` should still be set up.
    const service = new AzureSTTService({ apiKey: "fake", region: "eastus" });
    expect(service._speechConfig).not.toBeNull();
  });

  test("test_profanity_raw_accepted", () => {
    expect(_service("raw")._speechConfig).not.toBeNull();
  });

  test("test_profanity_masked_accepted", () => {
    expect(_service("masked")._speechConfig).not.toBeNull();
  });

  test("test_profanity_removed_accepted", () => {
    expect(_service("removed")._speechConfig).not.toBeNull();
  });

  test("test_profanity_invalid_value_rejected", () => {
    // Out-of-range value fails fast at init instead of silently falling back
    // to the default.
    expect(() => _service("nope" as AzureProfanity)).toThrow("KeyError");
  });

  test("test_profanity_calls_set_profanity_on_speech_config", () => {
    // Spy on AzureSpeechConfig.setProfanity to confirm the setting is wired
    // through.
    const mockSet = spyOn(AzureSpeechConfig.prototype, "setProfanity");
    _service("raw");
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  test("test_profanity_not_called_when_omitted", () => {
    const mockSet = spyOn(AzureSpeechConfig.prototype, "setProfanity");
    new AzureSTTService({ apiKey: "fake", region: "eastus" });
    expect(mockSet).not.toHaveBeenCalled();
  });
});

/**
 * The `segmentationSilenceTimeoutMs` setting surfaces Azure's
 * `Speech_SegmentationSilenceTimeoutMs` property, which decides how long a
 * pause has to be before Azure finalizes a phrase.
 */
describe("TestAzureSTTSegmentationSilenceTimeout", () => {
  function _segmentationCalls(mockSet: ReturnType<typeof spyOn>): unknown[][] {
    // Look only at the segmentation property.
    return (mockSet.mock.calls as unknown[][]).filter(
      (call) => call[0] === PropertyId.Speech_SegmentationSilenceTimeoutMs,
    );
  }

  test("test_timeout_sets_speech_config_property", () => {
    const mockSet = spyOn(AzureSpeechConfig.prototype, "setProperty");
    new AzureSTTService({
      apiKey: "fake",
      region: "eastus",
      settings: new AzureSTTService.Settings({ segmentationSilenceTimeoutMs: 1200 }),
    });
    const calls = _segmentationCalls(mockSet);
    expect(calls.length).toEqual(1);
    expect(calls[0]![1]).toEqual("1200");
  });

  test("test_timeout_omitted_is_no_op", () => {
    const mockSet = spyOn(AzureSpeechConfig.prototype, "setProperty");
    new AzureSTTService({ apiKey: "fake", region: "eastus" });
    expect(_segmentationCalls(mockSet)).toEqual([]);
  });
});

/**
 * Azure's `RecognizedSpeech` event is the final recognition for an utterance —
 * the emitted `TranscriptionFrame` must carry `finalized=true` so downstream
 * user-turn stop strategies can take their fast-path.
 */
describe("TestAzureSTTFinalizedFlag", () => {
  test("test_recognized_speech_emits_finalized_transcription_frame", async () => {
    // Capture the frames `_onHandleRecognized` pushes, without bringing up the
    // full STT service lifecycle.
    const service = new AzureSTTService({ apiKey: "fake", region: "eastus" });
    const internals = service as unknown as {
      _handleTranscription: (...args: unknown[]) => Promise<void>;
      emitSttUsageMetrics: () => Promise<void>;
    };
    internals._handleTranscription = async () => {};
    internals.emitSttUsageMetrics = async () => {};

    const constructed: Frame[] = [];
    spyOn(service, "pushFrame").mockImplementation(async (frame: Frame) => {
      constructed.push(frame);
    });

    const event = {
      result: {
        reason: ResultReason.RecognizedSpeech,
        text: "hello world",
        language: null,
      },
    };

    await service._onHandleRecognized(event);

    expect(constructed.length).toEqual(1);
    expect(constructed[0]).toBeInstanceOf(TranscriptionFrame);
    // `finalized` is a field of TranscriptionFrame; the recognized path must
    // set it to true.
    expect((constructed[0] as TranscriptionFrame).finalized).toBe(true);
  });
});
