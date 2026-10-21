// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_services.py

/** Tests for the eval service constructors (config -> EvalJudge/CachingTTSService/STT). */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BaseClassifier, type ClassifierResult } from "@pipedog/core/classifiers/base_classifier";
import { LLMClassifier } from "@pipedog/core/classifiers/llm/classifier";
import { TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { LLMService } from "@pipedog/core/services/llm_service";
import type { TTSService } from "@pipedog/core/services/tts_service";
import { WebsocketService } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { BaseObject } from "@pipedog/core/utils/base_object";
import { NOT_GIVEN } from "@pipedog/core/utils/types";

import { EvalJudge } from "../src/judge.ts";
import {
  _cfgLanguage,
  classifierFromConfig,
  llmServiceFromConfig,
  type ServiceConfig,
  sttServiceFromConfig,
  ttsServiceFromConfig,
} from "../src/services.ts";
import { CachingTTSService, ttsCacheKey, ttsSampleRate } from "../src/tts.ts";

// Factories are named as "<module>.<export>": this file, and one of its exports.
const HERE = import.meta.path;

export function _fakeStt(config: ServiceConfig): unknown {
  return ["FAKE_STT", config];
}

export function _fakeTts(config: ServiceConfig): unknown {
  return ["FAKE_TTS", config];
}

export class _FakeJudgeLLM extends LLMService {
  config: ServiceConfig;

  constructor(config: ServiceConfig) {
    super();
    this.config = config;
  }
}

export function _fakeJudgeLlm(config: ServiceConfig): _FakeJudgeLLM {
  return new _FakeJudgeLLM(config);
}

export function _notAJudge(config: ServiceConfig): unknown {
  return ["FAKE_JUDGE", config];
}

/** Whether `promise` rejects with an `Error`; returns it. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("TestSTTServiceFromConfig", () => {
  test("test_unknown_service_rejected", async () => {
    await rejection(sttServiceFromConfig({ service: "nope" }));
  });

  test("test_factory_escape_hatch", async () => {
    const stt = (await sttServiceFromConfig({ factory: `${HERE}._fakeStt` })) as unknown as [
      string,
      unknown,
    ];
    expect(stt[0]).toEqual("FAKE_STT");
  });
});

describe("TestVoiceFromConfig", () => {
  test("test_cache_key_excludes_sample_rate", () => {
    const a = ttsCacheKey({ service: "kokoro", voice: "v", model: "m", sample_rate: 16000 });
    const b = ttsCacheKey({ service: "kokoro", voice: "v", model: "m", sample_rate: 24000 });
    expect(a).toEqual(b);
  });

  test("test_cache_key_distinguishes_voice", () => {
    expect(ttsCacheKey({ service: "kokoro", voice: "a" })).not.toEqual(
      ttsCacheKey({ service: "kokoro", voice: "b" }),
    );
  });

  test("test_cache_key_distinguishes_speed", () => {
    // A faster render of the same text is different audio.
    expect(ttsCacheKey({ service: "kokoro", voice: "v" })).not.toEqual(
      ttsCacheKey({ service: "kokoro", voice: "v", speed: 1.3 }),
    );
    // An absent speed and the default rate render the same audio.
    expect(ttsCacheKey({ service: "kokoro", voice: "v" })).toEqual(
      ttsCacheKey({ service: "kokoro", voice: "v", speed: 1.0 }),
    );
  });

  test("test_cache_key_distinguishes_language", () => {
    // Two configs identical except for language must not collide, so an
    // English and a Chinese render of the same text get separate cache slots.
    expect(ttsCacheKey({ service: "cartesia", voice: "v", language: "en" })).not.toEqual(
      ttsCacheKey({ service: "cartesia", voice: "v", language: "zh" }),
    );
    // An absent language and an explicit empty one key to the same slot.
    expect(ttsCacheKey({ service: "cartesia", voice: "v" })).toEqual(
      ttsCacheKey({ service: "cartesia", voice: "v", language: "" }),
    );
  });

  test("test_sample_rate_default", () => {
    expect(ttsSampleRate({})).toEqual(16000);
    expect(ttsSampleRate({ sample_rate: 24000 })).toEqual(24000);
  });

  test("test_unknown_service_rejected", async () => {
    await rejection(ttsServiceFromConfig({ service: "nope", voice: "v" }));
  });

  test("test_missing_service_or_voice_rejected", async () => {
    await rejection(ttsServiceFromConfig({}));
  });

  test("test_factory_escape_hatch", async () => {
    const tts = await ttsServiceFromConfig({ factory: `${HERE}._fakeTts` });
    const inner = (tts as unknown as { _inner: [string, unknown] })._inner;
    expect(inner[0]).toEqual("FAKE_TTS");
  });

  // Skipped: `_cartesia_service` only backs the deprecated `service: cartesia`
  // (since 1.9.0, removed in 2.0.0), which is not ported; a Cartesia voice is
  // a `factory`.
  test.skip("test_language_reaches_cartesia_settings", () => {});

  // Skipped: as above, `_cartesia_service` is deprecated and not ported.
  test.skip("test_no_language_leaves_cartesia_default", () => {});

  test("test_websocket_service_rejected", () => {
    // run_tts can't be driven without a pipeline to manage the connection, so a
    // websocket-streaming TTS service must be rejected at construction.
    class _FakeWS extends WebsocketService(BaseObject) {
      override async _connectWebsocket(): Promise<void> {}

      override async _disconnectWebsocket(): Promise<void> {}

      override async _receiveMessages(): Promise<void> {}
    }

    expect(
      () => new CachingTTSService(new _FakeWS() as unknown as TTSService, { cacheKey: "k" }),
    ).toThrow(Error);
  });
});

describe("TestCfgLanguage", () => {
  test("test_absent_leaves_the_field_unset", () => {
    expect(_cfgLanguage({})).toBe(NOT_GIVEN);
    expect(_cfgLanguage({ language: null })).toBe(NOT_GIVEN);
  });

  test("test_blank_leaves_the_field_unset", () => {
    // A key present but empty in the YAML means "unset", not "unknown language".
    expect(_cfgLanguage({ language: "" })).toBe(NOT_GIVEN);
    expect(_cfgLanguage({ language: "   " })).toBe(NOT_GIVEN);
  });

  test("test_code_or_language_accepted", () => {
    expect(_cfgLanguage({ language: "zh" })).toEqual(Language.ZH);
    expect(_cfgLanguage({ language: " zh-TW " })).toEqual(Language.ZH_TW);
    expect(_cfgLanguage({ language: Language.ES })).toEqual(Language.ES);
  });

  test("test_unknown_code_rejected", () => {
    expect(() => _cfgLanguage({ language: "notalang" })).toThrow(Error);
  });

  test("test_non_string_rejected", () => {
    // YAML 1.1 reads a bare `language: no` as False rather than Norwegian, so
    // the coercion has to reject non-strings instead of passing them through.
    expect(() => _cfgLanguage({ language: false })).toThrow(Error);
  });
});

/** Minimal stand-in for a TTSService: runTts yields one audio frame. */
class _CountingTTS {
  pcm: Uint8Array;
  sampleRate: number;
  calls = 0;

  constructor(pcm: Uint8Array, sampleRate: number) {
    this.pcm = pcm;
    this.sampleRate = sampleRate;
  }

  async *runTts(_text: string, _contextId: string): AsyncGenerator<TTSAudioRawFrame, void> {
    this.calls += 1;
    yield new TTSAudioRawFrame({ audio: this.pcm, sampleRate: this.sampleRate, numChannels: 1 });
  }
}

/** Drive `runTts` and return the concatenated audio it yields. */
async function _runTtsPcm(tts: CachingTTSService, text: string): Promise<Uint8Array> {
  const chunks: number[] = [];
  for await (const frame of tts.runTts(text, "ctx")) {
    if (frame instanceof TTSAudioRawFrame) {
      chunks.push(...frame.audio);
    }
  }
  return new Uint8Array(chunks);
}

describe("TestCachingTTSCache", () => {
  test("test_cache_round_trip_and_sr_mismatch", async () => {
    // 100ms of 16kHz mono
    const pcm = new Uint8Array(3200);
    for (let i = 0; i < pcm.length; i += 2) {
      pcm[i] = 1;
      pcm[i + 1] = 2;
    }

    const tmp = await mkdtemp(join(tmpdir(), "evals-tts-"));
    try {
      const inner = new _CountingTTS(pcm, 16000);
      const tts = new CachingTTSService(inner as unknown as TTSService, {
        cacheKey: "k",
        cacheDir: tmp,
      });
      // set by setup(); skip the FrameProcessor lifecycle
      (tts as unknown as { _sampleRate: number })._sampleRate = 16000;

      const out = await _runTtsPcm(tts, "hello");
      expect(out).toEqual(pcm);
      expect(inner.calls).toEqual(1);

      // Second call hits the WAV cache; the inner service is not called again.
      const out2 = await _runTtsPcm(tts, "hello");
      expect(out2).toEqual(pcm);
      expect(inner.calls).toEqual(1);

      // A different requested sample rate misses the cached file's rate and
      // regenerates (the cache slot is shared across rates by design).
      const inner24 = new _CountingTTS(pcm, 24000);
      const tts24 = new CachingTTSService(inner24 as unknown as TTSService, {
        cacheKey: "k",
        cacheDir: tmp,
      });
      (tts24 as unknown as { _sampleRate: number })._sampleRate = 24000;
      await _runTtsPcm(tts24, "hello");
      expect(inner24.calls).toEqual(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

export function _fakeClassifier(config: ServiceConfig): _FakeClassifier {
  return new _FakeClassifier(config);
}

export class _FakeClassifier extends BaseClassifier {
  config: ServiceConfig;

  constructor(config: ServiceConfig) {
    super();
    this.config = config;
  }

  protected async _ask(): Promise<[Record<string, ClassifierResult>, null]> {
    throw new Error("NotImplementedError");
  }
}

describe("TestClassifierFromConfig", () => {
  test("test_an_llm_block_builds_an_llm_classifier_over_it", async () => {
    const classifier = await classifierFromConfig(
      { service: "ollama", model: "a" },
      { where: "judge.eval" },
    );
    expect(classifier).toBeInstanceOf(LLMClassifier);
    expect((classifier as LLMClassifier).llm.settings.model).toEqual("a");
  });

  test("test_a_factory_returning_a_classifier_is_used_as_is", async () => {
    const config = { factory: `${HERE}._fakeClassifier`, model: "x" };
    const classifier = await classifierFromConfig(config, { where: "judge.eval" });
    expect(classifier).toBeInstanceOf(_FakeClassifier);
    expect((classifier as _FakeClassifier).config).toBe(config);
  });

  test("test_a_factory_returning_an_llm_is_classified_with", async () => {
    const classifier = await classifierFromConfig(
      { factory: `${HERE}._fakeJudgeLlm` },
      { where: "judge.eval" },
    );
    expect(classifier).toBeInstanceOf(LLMClassifier);
    expect((classifier as LLMClassifier).llm).toBeInstanceOf(_FakeJudgeLLM);
  });

  test("test_a_factory_returning_anything_else_is_an_error", async () => {
    const raised = await rejection(
      classifierFromConfig({ factory: `${HERE}._notAJudge` }, { where: "judge.eval" }),
    );
    // DIVERGENCE: upstream's factory returns a Python `tuple`; its JS
    // counterpart is an `Array`, and the message names the type it got.
    expect(raised.message).toContain("Array");
  });
});

describe("TestJudgeFromConfig", () => {
  test("test_unknown_service_rejected", async () => {
    await rejection(EvalJudge.fromConfig({ service: "nope" }));
  });

  test("test_factory_escape_hatch", async () => {
    const j = await EvalJudge.fromConfig({ factory: `${HERE}._fakeJudgeLlm` });
    expect(j).not.toBeNull();
    expect((j.classifier as LLMClassifier).llm).toBeInstanceOf(_FakeJudgeLLM);
  });
});

/** The built-in names are the local services; a paid one still builds, with a warning. */
describe("TestPaidServicesAreDeprecated", () => {
  // Skipped: `service: cartesia` is deprecated (since 1.9.0, removed in
  // 2.0.0) and not ported; it is an unknown service here.
  test.skip("test_cartesia_by_name_warns_and_builds", () => {});

  // Skipped: `service: openai` is deprecated (since 1.9.0, removed in 2.0.0)
  // and not ported; it is an unknown service here.
  test.skip("test_openai_by_name_warns_and_builds", () => {});

  test("test_unknown_names_point_at_the_factory", async () => {
    let cm = await rejection(ttsServiceFromConfig({ service: "elevenlabs", voice: "v" }));
    expect(cm.message).toContain("Known: kokoro.");
    expect(cm.message).toContain("factory");
    cm = await rejection(llmServiceFromConfig({ service: "anthropic" }, { where: "judge.eval" }));
    expect(cm.message).toContain("Known: ollama.");
    cm = await rejection(sttServiceFromConfig({ service: "deepgram" }));
    expect(cm.message).toContain("Known: moonshine, whisper.");
  });
});
