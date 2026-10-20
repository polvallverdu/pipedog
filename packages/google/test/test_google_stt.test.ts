// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_stt.py

/** Tests for Google STT streaming responses and adaptation handling. */

import { describe, expect, test } from "bun:test";
import { sleep, time } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import {
  _normalizeSpeechAdaptation,
  type GoogleSTTClient,
  GoogleSTTService,
  type SpeechAdaptation,
  type StreamingRecognizeResponse,
} from "../src/stt.ts";

type Any = any;

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

/** Minimal async iterator for Google streaming responses. */
class AsyncResponses implements AsyncIterable<StreamingRecognizeResponse> {
  #responses: Iterator<StreamingRecognizeResponse>;

  constructor(responses: StreamingRecognizeResponse[]) {
    this.#responses = responses[Symbol.iterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamingRecognizeResponse> {
    return {
      next: async () => this.#responses.next(),
    };
  }
}

function result({ transcript, isFinal }: { transcript: string; isFinal: boolean }) {
  return {
    alternatives: [{ transcript }],
    isFinal,
  };
}

/** A fake Speech V2 client, so no credentials or network are needed. */
const fakeClient: GoogleSTTClient = {
  streamingRecognize() {
    throw new Error("not used");
  },
  getProjectId: async () => "test",
};

/**
 * Upstream builds the service with `object.__new__(GoogleSTTService)` to skip
 * credential lookup. Here the constructor needs no credentials when a client
 * is injected, and a real instance keeps the class's private fields intact.
 */
function bareService(): Any {
  return new GoogleSTTService({ client: fakeClient });
}

test("test_google_final_result_emits_finalized_transcription_frame", async () => {
  const service = bareService();
  service._streamStartTime = Math.trunc(time() * 1000);
  service._userId = "user";
  service._lastTranscriptWasFinal = false;
  service._getLanguageCodes = () => ["en-US"];
  service._sttUsagePendingSeconds = 0.0;
  service._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: false });

  const frames: Frame[] = [];
  const transcriptions: [string, boolean, string | null][] = [];

  service.pushFrame = async (frame: Frame) => {
    frames.push(frame);
  };
  service._handleTranscription = async (
    transcript: string,
    isFinal: boolean,
    language: string | null = null,
  ) => {
    transcriptions.push([transcript, isFinal, language]);
  };

  const responses = new AsyncResponses([
    { results: [result({ transcript: "hel", isFinal: false })] },
    { results: [result({ transcript: "hello", isFinal: true })] },
  ]);

  await service._processResponses(responses);

  expect(frames[0]).toBeInstanceOf(InterimTranscriptionFrame);
  expect(frames[1]).toBeInstanceOf(TranscriptionFrame);
  expect((frames[1] as TranscriptionFrame).finalized).toBe(true);
  expect(transcriptions).toEqual([["hello", true, "en-US"]]);
});

test("test_normalize_speech_adaptation_accepts_native_message", () => {
  // `cloud_speech.SpeechAdaptation()`: messages are plain objects in this port.
  const adaptation: SpeechAdaptation = {};

  const normalized = _normalizeSpeechAdaptation(adaptation);

  expect(normalized).toBe(adaptation);
});

test("test_normalize_speech_adaptation_accepts_single_phrase_set_string", () => {
  const phraseSet = "projects/test/locations/global/phraseSets/support-terms";

  const normalized: Any = _normalizeSpeechAdaptation({ phrase_sets: phraseSet });

  expect(normalized.phrase_sets.length).toBe(1);
  expect(normalized.phrase_sets[0].phrase_set).toBe(phraseSet);
});

test("test_normalize_speech_adaptation_accepts_single_inline_phrase_set", () => {
  const normalized: Any = _normalizeSpeechAdaptation({
    phrase_sets: { phrases: [{ value: "pipecat" }] },
  });

  expect(normalized.phrase_sets.length).toBe(1);
  expect(normalized.phrase_sets[0].inline_phrase_set.phrases[0].value).toBe("pipecat");
});

test("test_normalize_speech_adaptation_converts_string_and_inline_phrase_sets", () => {
  const normalized: Any = _normalizeSpeechAdaptation({
    phrase_sets: [
      "projects/test/locations/global/phraseSets/catalog",
      {
        phrases: [{ value: "pipecat", boost: 15.0 }, { value: "voice pipeline" }],
      },
    ],
  });

  expect(normalized.phrase_sets[0].phrase_set).toBe(
    "projects/test/locations/global/phraseSets/catalog",
  );
  expect(normalized.phrase_sets[1].inline_phrase_set.phrases[0].value).toBe("pipecat");
  expect(normalized.phrase_sets[1].inline_phrase_set.phrases[0].boost).toBe(15.0);
  expect(normalized.phrase_sets[1].inline_phrase_set.phrases[1].value).toBe("voice pipeline");
});

test("test_normalize_speech_adaptation_rejects_invalid_phrase_set_entries", () => {
  // upstream: ValueError
  expect(() => _normalizeSpeechAdaptation({ phrase_sets: [123] })).toThrow(
    /Invalid Google SpeechAdaptation phrase_set entry/,
  );
});

test("test_google_stt_rejects_invalid_adaptation_during_initialization", () => {
  const settings = new GoogleSTTService.Settings({
    adaptation: { phrase_sets: [{ phrases: ["hello"] }] },
  });

  let error: unknown;
  try {
    new GoogleSTTService({ settings, client: fakeClient });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toMatch(/expected.*Phrase.*got.*str/);
});

test("test_google_stt_rejects_invalid_runtime_adaptation_before_commit", async () => {
  const service = bareService();
  service._settings = new GoogleSTTService.Settings({ adaptation: null });
  const delta = new GoogleSTTService.Settings({
    adaptation: { phrase_sets: [{ phrases: ["hello"] }] },
  });

  let error: unknown;
  try {
    await service._updateSettings(delta);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toMatch(/expected.*Phrase.*got.*str/);

  expect(service._settings.adaptation).toBeNull();
});

/** Run _connect() on a bare service and return the config it built. */
async function connectedRecognitionConfig(
  adaptation: SpeechAdaptation | null,
  model = "latest_long",
  denoiserConfig: Record<string, unknown> | null = null,
): Promise<Any> {
  const service = bareService();
  service._settings = new GoogleSTTService.Settings({
    model,
    denoiserConfig,
    enableAutomaticPunctuation: true,
    enableSpokenPunctuation: false,
    enableSpokenEmojis: false,
    profanityFilter: false,
    enableWordTimeOffsets: false,
    enableWordConfidence: false,
    enableInterimResults: true,
    enableVoiceActivityEvents: false,
    adaptation,
  });
  service._sampleRate = 16000;
  service._getLanguageCodes = () => ["en-US"];
  service._callEventHandler = (..._args: unknown[]) => sleep(0);

  // Upstream closes the coroutine without running it.
  service.createTask = (_coroutine: unknown) => null;

  await service._connect();

  return service._config.config;
}

describe("test_google_connect_sends_adaptation_for_supporting_models", () => {
  for (const model of ["latest_long", "short", "chirp_2", "telephony_short"]) {
    test(`test_google_connect_sends_adaptation_for_supporting_models[${model}]`, async () => {
      const phraseSet = "projects/test/locations/global/phraseSets/catalog";

      const config = await connectedRecognitionConfig({ phrase_sets: [phraseSet] }, model);

      expect(config.model).toBe(model);
      expect(config.adaptation.phraseSets[0].phraseSet).toBe(phraseSet);
    });
  }
});

describe("test_google_connect_omits_adaptation_for_the_telephony_model", () => {
  for (const model of ["telephony", "TELEPHONY"]) {
    test(`test_google_connect_omits_adaptation_for_the_telephony_model[${model}]`, async () => {
      const phraseSet = "projects/test/locations/global/phraseSets/catalog";

      const config = await connectedRecognitionConfig({ phrase_sets: [phraseSet] }, model);

      expect("adaptation" in config).toBe(false);
    });
  }
});

test("test_google_connect_sends_denoiser_config", async () => {
  const config = await connectedRecognitionConfig(null, "chirp_3", { denoise_audio: true });

  expect(config.denoiserConfig.denoiseAudio).toBe(true);
});

test("test_google_connect_leaves_denoiser_config_unset_when_not_configured", async () => {
  const config = await connectedRecognitionConfig(null);

  expect("denoiserConfig" in config).toBe(false);
});

test("test_google_connect_leaves_adaptation_unset_when_not_configured", async () => {
  const config = await connectedRecognitionConfig(null);

  expect("adaptation" in config).toBe(false);
});
