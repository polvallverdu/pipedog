// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_processing_metrics.py

/**
 * Tests for which TTS services report a processing-time metric.
 *
 * PORTING NOTES:
 * - `pytest.mark.parametrize("cls", ...)` → `test.each`, keeping the test
 *   name with the class name appended.
 * - `cls.__new__(cls)` (an instance without running `__init__`) →
 *   `Object.create(cls.prototype)`.
 * - `Cls.supports_processing_metrics.fget(None)` → the getter from the
 *   prototype's property descriptor, called with `this` = null.
 * - Deepgram, ElevenLabs and OpenAI services are imported by relative path,
 *   since this package does not depend on those packages.
 */

import { describe, expect, test } from "bun:test";
import { TTSService, WebsocketTTSService } from "@pipedog/core/services/tts_service";
import { DeepgramHttpTTSService, DeepgramTTSService } from "../../deepgram/src/tts.ts";
import { ElevenLabsHttpTTSService, ElevenLabsTTSService } from "../../elevenlabs/src/tts.ts";
import { OpenAITTSService } from "../../openai/src/tts.ts";
import { CartesiaHttpTTSService, CartesiaTTSService } from "../src/tts.ts";

type ServiceClass = abstract new (...args: any[]) => TTSService;

// Services whose runTts completes synthesis before returning.
const SYNCHRONOUS: ServiceClass[] = [
  CartesiaHttpTTSService,
  DeepgramHttpTTSService,
  ElevenLabsHttpTTSService,
  OpenAITTSService,
];

// Services whose runTts sends the text and returns, leaving audio to arrive
// on the receive task.
const HANDS_OFF: ServiceClass[] = [CartesiaTTSService, DeepgramTTSService, ElevenLabsTTSService];

function newWithoutInit(cls: ServiceClass): TTSService {
  return Object.create(cls.prototype) as TTSService;
}

function fget(cls: ServiceClass): () => boolean {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, "supportsProcessingMetrics");
  if (!descriptor?.get) {
    throw new Error(`${cls.name}.prototype has no supportsProcessingMetrics getter`);
  }
  return descriptor.get as () => boolean;
}

describe("test_tts_processing_metrics", () => {
  test.each(SYNCHRONOUS.map((cls) => [cls.name, cls] as const))(
    "test_synchronous_services_report_processing_metrics[%s]",
    (_name, cls) => {
      const service = newWithoutInit(cls);
      expect(service.supportsProcessingMetrics).toBeTruthy();
    },
  );

  test.each(HANDS_OFF.map((cls) => [cls.name, cls] as const))(
    "test_handoff_services_do_not_report_processing_metrics[%s]",
    (_name, cls) => {
      const service = newWithoutInit(cls);
      expect(service.supportsProcessingMetrics).toBeFalsy();
    },
  );

  test("test_default_is_to_report", () => {
    // A service that synthesizes inside runTts is the common case, so the base
    // class opts in and the handoff services opt out.
    expect(fget(TTSService).call(null)).toBeTruthy();
    expect(fget(WebsocketTTSService).call(null)).toBeFalsy();
  });
});
