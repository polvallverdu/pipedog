// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rime_tts.py

import { describe, expect, test } from "bun:test";
import { RimeHttpTTSService, RimeTTSService } from "../src/tts.ts";

// Tests reach into protected members.
type Any = any;

describe("TestRimeTTS", () => {
  test("test_coda_sampling_params_are_included_in_websocket_params", () => {
    const service: Any = new RimeTTSService({
      apiKey: "test-api-key",
      settings: new RimeTTSService.Settings({
        model: "coda",
        voice: "luna",
        repetitionPenalty: 1.1,
        temperature: 0.5,
        topP: 0.9,
        timeScaleFactor: 1.2,
      }),
    });

    const params = service._buildWsParams();

    expect(params.modelId).toBe("coda");
    expect(params.speaker).toBe("luna");
    expect(params.repetition_penalty).toBe(1.1);
    expect(params.temperature).toBe(0.5);
    expect(params.top_p).toBe(0.9);
    expect(params.timeScaleFactor).toBe(1.2);
  });

  test("test_inline_speed_lists_one_speed_per_bracketed_span", () => {
    const service: Any = new RimeTTSService({ apiKey: "test-api-key" });

    const text = `${service.INLINE_SPEED("slow", 0.5)} and ${service.INLINE_SPEED("fast", 1.5)}`;
    const msg = service._buildMsg(text);

    expect(msg.text).toBe("[slow] and [fast]");
    expect(msg.inlineSpeedAlpha).toBe("0.5,1.5");
  });

  test("test_pronounce_wraps_the_phoneme_in_braces", () => {
    const service: Any = new RimeTTSService({ apiKey: "test-api-key" });

    const text = service.PRONOUNCE("Say hello", "hello", "h'El0");
    const msg = service._buildMsg(text);

    expect(msg.text).toBe("Say {h'El0}");
    expect(msg.phonemizeBetweenBrackets).toBe(true);
  });

  // DIVERGENCE: RimeNonJsonTTSService is deprecated upstream (since 0.0.102) and is
  // not ported, so its test is skipped.
  test.skip("test_non_json_service_defaults_to_coda_without_a_voice", () => {});

  /** A fetch that records the request and answers 400. */
  function capturingFetch() {
    const captured: { url?: string; payload?: Any; headers?: Record<string, string> } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.payload = JSON.parse(init.body as string);
      captured.headers = init.headers as Record<string, string>;
      return new Response("", { status: 400 });
    }) as unknown as typeof fetch;
    return { captured, fakeFetch };
  }

  test("test_coda_sampling_params_are_included_in_http_payload", async () => {
    const { captured, fakeFetch } = capturingFetch();
    const service: Any = new RimeHttpTTSService({
      apiKey: "test-api-key",
      fetch: fakeFetch,
      sampleRate: 24000,
      settings: new RimeHttpTTSService.Settings({
        model: "coda",
        voice: "luna",
        repetitionPenalty: 1.1,
        temperature: 0.5,
        topP: 0.9,
        timeScaleFactor: 1.2,
      }),
    });

    for await (const _ of service.runTts("Hello", "context")) {
      // drain
    }

    expect(captured.payload.modelId).toBe("coda");
    expect(captured.payload.speaker).toBe("luna");
    expect(captured.payload.repetition_penalty).toBe(1.1);
    expect(captured.payload.temperature).toBe(0.5);
    expect(captured.payload.top_p).toBe(0.9);
    expect(captured.payload.timeScaleFactor).toBe(1.2);
    expect(captured.headers?.Accept).toBe("audio/pcm");
  });

  test("test_mist_text_settings_are_included_in_http_payload", async () => {
    const { captured, fakeFetch } = capturingFetch();
    const service: Any = new RimeHttpTTSService({
      apiKey: "test-api-key",
      fetch: fakeFetch,
      sampleRate: 24000,
      settings: new RimeHttpTTSService.Settings({
        model: "mistv2",
        voice: "luna",
        pauseBetweenBrackets: true,
        phonemizeBetweenBrackets: true,
        noTextNormalization: true,
      }),
    });

    for await (const _ of service.runTts("Hello", "context")) {
      // drain
    }

    expect(captured.payload.modelId).toBe("mistv2");
    expect(captured.payload.pauseBetweenBrackets).toBe(true);
    expect(captured.payload.phonemizeBetweenBrackets).toBe(true);
    expect(captured.payload.noTextNormalization).toBe(true);
  });
});
