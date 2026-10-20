// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_processor_usable_gating.py

/** Tests that STT and TTS services stop working once the provider rejects them. */

import { describe, expect, test } from "bun:test";

import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  TextFrame,
  TTSAudioRawFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
  STTService,
  type STTServiceOptions,
} from "../src/services/stt_service.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest } from "../src/tests/utils.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import { logger } from "../src/utils/logger.ts";

// The services are built by factories (not module-level classes) so these
// concrete subclasses aren't picked up by the service-discovery scan in
// test_service_init.

/** STT service that counts how often it's asked to transcribe. */
function makeCountingSTTService(options: STTServiceOptions = {}) {
  class CountingSTTService extends STTService {
    transcribeCalls = 0;

    async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
      this.transcribeCalls += 1;
      yield null;
    }
  }
  return new CountingSTTService(options);
}

/** Segmented STT service that counts how often it's asked to transcribe. */
function makeCountingSegmentedSTTService(options: SegmentedSTTServiceOptions = {}) {
  class CountingSegmentedSTTService extends SegmentedSTTService {
    transcribeCalls = 0;

    async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
      this.transcribeCalls += 1;
      yield null;
    }
  }
  return new CountingSegmentedSTTService(options);
}

/** TTS service that counts how often it's asked to synthesize. */
function makeCountingTTSService(options: TTSServiceOptions = {}) {
  class CountingTTSService extends TTSService {
    synthesizeCalls = 0;

    async *runTts(_text: string, contextId: string): AsyncGenerator<Frame | null, void> {
      this.synthesizeCalls += 1;
      yield new TTSAudioRawFrame({
        audio: new Uint8Array(320),
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    }
  }
  return new CountingTTSService(options);
}

function audioFrame(): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 16000, numChannels: 1 });
}

describe("TestSTTStatusGating", () => {
  test("test_audio_is_transcribed_while_the_service_is_healthy", async () => {
    const service = makeCountingSTTService();

    await runTest(service, {
      framesToSend: [audioFrame(), audioFrame()],
      expectedDownFrames: null,
    });

    expect(service.transcribeCalls).toEqual(2);
  });

  test("test_audio_is_dropped_once_the_service_is_unusable", async () => {
    const service = makeCountingSTTService();
    await service.setUsable(false);

    await runTest(service, {
      framesToSend: [audioFrame(), audioFrame()],
      expectedDownFrames: null,
    });

    expect(service.transcribeCalls).toEqual(0);
  });

  test("test_a_service_that_can_still_work_keeps_transcribing", async () => {
    const service = makeCountingSTTService();

    await runTest(service, {
      framesToSend: [audioFrame()],
      expectedDownFrames: null,
    });

    expect(service.transcribeCalls).toEqual(1);
  });
});

describe("TestSegmentedSTTStatusGating", () => {
  test("test_segment_is_dropped_once_the_service_is_unusable", async () => {
    const service = makeCountingSegmentedSTTService();
    await service.setUsable(false);

    await runTest(service, {
      framesToSend: [audioFrame(), new VADUserStoppedSpeakingFrame()],
      expectedDownFrames: null,
    });

    expect(service.transcribeCalls).toEqual(0);
    // The buffered audio is released rather than growing for the rest of
    // the session.
    expect((service as unknown as { _audioBuffer: Uint8Array })._audioBuffer.length).toEqual(0);
  });
});

describe("TestTTSStatusGating", () => {
  test("test_text_is_synthesized_while_the_service_is_healthy", async () => {
    const service = makeCountingTTSService();

    await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: null,
    });

    expect(service.synthesizeCalls).toEqual(1);
  });

  test("test_text_is_dropped_once_the_service_is_unusable", async () => {
    const service = makeCountingTTSService();
    await service.setUsable(false);

    await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: null,
    });

    expect(service.synthesizeCalls).toEqual(0);
  });

  test("test_dropped_text_is_reported", async () => {
    const service = makeCountingTTSService();
    await service.setUsable(false);

    const messages: string[] = [];
    const removeSink = logger.addSink((record) => {
      if (record.level === "WARNING" || record.level === "ERROR" || record.level === "CRITICAL") {
        messages.push(record.message);
      }
    });
    try {
      await runTest(service, {
        framesToSend: [new TextFrame({ text: "this should be spoken" })],
        expectedDownFrames: null,
      });
    } finally {
      removeSink();
    }

    const warning = messages.find((m) => m.includes("this should be spoken"));
    expect(warning, `dropped text was not reported: ${messages}`).toBeDefined();
    expect(warning).toContain("no longer usable");
  });
});

/** Application code a service invokes must not affect the service's health. */
describe("TestApplicationErrorClassification", () => {
  test("test_failing_text_transformer_leaves_the_service_usable", async () => {
    const service = makeCountingTTSService();

    async function failingTransform(_text: string, _textType: string): Promise<string> {
      // A transformer calling some API that rejects its own credentials.
      // (httpx.HTTPStatusError equivalent: an error carrying a fetch Response.)
      const error = new Error("Unauthorized") as Error & { response: Response };
      error.response = new Response(null, { status: 401 });
      throw error;
    }

    service.addTextTransformer(failingTransform);

    const [, up] = await runTest(service, {
      framesToSend: [new TextFrame({ text: "hello" })],
      expectedDownFrames: null,
      expectedUpFrames: [ErrorFrame],
    });

    expect((up[0] as ErrorFrame).category).toBe(ErrorCategory.APPLICATION);
    expect(service.isUsable).toBe(true);
    // The turn produces no audio: a transformer may exist to remove
    // something, so speaking the untransformed text isn't safe.
    expect(service.synthesizeCalls).toEqual(0);
  });
});
