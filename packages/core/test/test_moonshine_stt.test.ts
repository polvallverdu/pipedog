// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_moonshine_stt.py

/**
 * Tests for the Moonshine STT service.
 *
 * Upstream installs a fake `moonshine_voice` module in `sys.modules` and
 * re-imports `pipecat.services.moonshine.stt`. Here `moonshine_voice` is
 * `@pipedog/moonshine`'s engine module (`packages/moonshine/src/moonshine_voice.ts`):
 * each test replaces its exports with `mock.module`, which the service module's
 * imports see, and restores the real module afterwards.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as moonshineVoiceModule from "../../moonshine/src/moonshine_voice.ts";
import * as stt from "../../moonshine/src/stt.ts";
import { TranscriptionFrame } from "../src/frames/frames.ts";
import { Language } from "../src/transcriptions/language.ts";

const MOONSHINE_VOICE = "../../moonshine/src/moonshine_voice.ts";

// Snapshot before any test mocks the module: mock.module also changes the namespace object.
const originalMoonshineVoice = { ...moonshineVoiceModule };

// Architectures published per language, best first. English has the widest range;
// the other languages have one to four models each.
const FAKE_MODELS: Record<string, string[]> = {
  ar: ["tiny-streaming", "base"],
  de: ["small-streaming", "tiny-streaming"],
  es: ["small-streaming", "tiny-streaming", "base"],
  en: ["medium-streaming", "small-streaming", "base", "tiny-streaming", "tiny"],
  ja: ["small-streaming", "tiny-streaming", "base", "tiny"],
  ko: ["tiny"],
  tl: ["tiny-streaming"],
  vi: ["tiny-streaming", "base"],
  uk: ["base"],
  zh: ["tiny-streaming", "base"],
};

class FakeTranscriber {
  static instances: FakeTranscriber[] = [];

  modelPath: string;
  modelArch: string;
  audio?: Float32Array;
  sampleRate?: number;

  constructor(modelPath: string, modelArch: string) {
    this.modelPath = modelPath;
    this.modelArch = modelArch;
    FakeTranscriber.instances.push(this);
  }

  transcribeWithoutStreaming(audio: Float32Array, sampleRate: number) {
    this.audio = audio;
    this.sampleRate = sampleRate;
    return { lines: [{ text: " hello there " }] };
  }
}

// Upstream reassigns `stt.Transcriber`; an ES module binding cannot be
// reassigned, so the fake module's `Transcriber` delegates to this replaceable factory.
let makeTranscriber: (modelPath: string, modelArch: string) => FakeTranscriber;

function Transcriber(this: unknown, modelPath: string, modelArch: string): FakeTranscriber {
  return makeTranscriber(modelPath, modelArch);
}

function getModelForLanguage(language: string, modelArch: string | null = null): [string, string] {
  if (!(language in FAKE_MODELS)) {
    throw new Error(`Language not found: ${language}`);
  }
  const available = FAKE_MODELS[language]!;
  if (modelArch === null || modelArch === undefined) {
    modelArch = available[0]!;
  }
  if (!available.includes(modelArch)) {
    throw new Error(`Model not found for language: ${language} and arch: ${modelArch}`);
  }
  return [`/models/${language}-${modelArch}`, modelArch];
}

function stringToModelArch(modelArchString: string): string {
  if (!FAKE_MODELS.en!.includes(modelArchString)) {
    throw new Error(`Invalid model architecture string: ${modelArchString}`);
  }
  return modelArchString;
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

// The service keeps its internals protected; the tests reach in as upstream does.
type AnyService = any;

function newService(options?: stt.MoonshineSTTServiceOptions): AnyService {
  return new stt.MoonshineSTTService(options);
}

beforeEach(() => {
  makeTranscriber = (modelPath, modelArch) => new FakeTranscriber(modelPath, modelArch);
  mock.module(MOONSHINE_VOICE, () => ({
    ...originalMoonshineVoice,
    Transcriber,
    getModelForLanguage,
    modelArchToString: (modelArch: string): string => modelArch,
    stringToModelArch,
    supportedLanguages: (): string[] => Object.keys(FAKE_MODELS),
    supportedLanguagesFriendly: (): string => Object.keys(FAKE_MODELS).join(", "),
  }));
  FakeTranscriber.instances = [];
});

afterEach(() => {
  mock.module(MOONSHINE_VOICE, () => originalMoonshineVoice);
});

describe("test_moonshine_stt", () => {
  test("test_defaults_load_the_english_streaming_model", () => {
    const service = newService();

    expect(service._settings.model).toBe("small-streaming");
    expect(service._settings.language).toBe("en");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/en-small-streaming");
    expect(FakeTranscriber.instances.at(-1)!.modelArch).toBe("small-streaming");
  });

  test("test_regional_variants_resolve_to_the_base_code", () => {
    const service = newService({
      settings: new stt.MoonshineSTTService.Settings({ language: Language.EN_GB }),
    });

    expect(service._settings.language).toBe("en");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/en-small-streaming");
  });

  test("test_unavailable_architecture_falls_back_to_the_language_default", () => {
    const service = newService({
      settings: new stt.MoonshineSTTService.Settings({ language: Language.UK_UA }),
    });

    expect(service._settings.language).toBe("uk");
    expect(service._settings.model).toBe("base");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/uk-base");
  });

  test("test_requested_architecture_is_kept_when_available", () => {
    const service = newService({
      settings: new stt.MoonshineSTTService.Settings({
        model: stt.Model.TINY,
        language: Language.JA,
      }),
    });

    expect(service._settings.model).toBe("tiny");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/ja-tiny");
  });

  test("test_unsupported_language_raises", () => {
    expect(() =>
      newService({ settings: new stt.MoonshineSTTService.Settings({ language: Language.FR }) }),
    ).toThrow(/does not support language 'fr'/);
  });

  test("test_unknown_model_raises", () => {
    expect(() =>
      newService({ settings: new stt.MoonshineSTTService.Settings({ model: "huge" }) }),
    ).toThrow(/Invalid model architecture string/);
  });

  test("test_language_to_moonshine_language", () => {
    expect(stt.languageToMoonshineLanguage(Language.EN_US)).toBe("en");
    expect(stt.languageToMoonshineLanguage(Language.ZH_TW)).toBe("zh");
    expect(stt.languageToMoonshineLanguage(Language.UK)).toBe("uk");
    expect(stt.languageToMoonshineLanguage(Language.DE)).toBe("de");
    expect(stt.languageToMoonshineLanguage(Language.TL)).toBe("tl");
    expect(stt.languageToMoonshineLanguage(Language.FIL)).toBe("tl");
  });

  test("test_moonshine_language_to_frame_language", () => {
    expect(stt.moonshineLanguageToFrameLanguage("es")).toBe(Language.ES);
    expect(stt.moonshineLanguageToFrameLanguage(null)).toBeNull();
    expect(stt.moonshineLanguageToFrameLanguage("not-a-language")).toBeNull();
  });

  test("test_service_exposes_metrics_and_language_mapping", () => {
    const service = newService();

    expect(service.canGenerateMetrics()).toBe(true);
    expect(service.languageToServiceLanguage(Language.EN_US)).toBe("en");
  });

  test("test_run_stt_yields_a_transcription_frame", async () => {
    const service = newService({
      settings: new stt.MoonshineSTTService.Settings({ language: Language.ES }),
    });

    // b"\x00\x00" * 160
    const frames = await collect(service.runStt(new Uint8Array(320)));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(TranscriptionFrame);
    const frame = frames[0] as TranscriptionFrame;
    expect(frame.text).toBe("hello there");
    expect(frame.language).toBe(Language.ES);
    expect(FakeTranscriber.instances.at(-1)!.sampleRate).toBe(stt.MOONSHINE_SAMPLE_RATE);
  });

  test("test_language_update_reloads_the_model", async () => {
    const service = newService();

    await service._updateSettings(new stt.MoonshineSTTService.Settings({ language: Language.UK }));

    expect(service._settings.language).toBe("uk");
    expect(service._settings.model).toBe("base");
    expect(service._transcriber).toBe(FakeTranscriber.instances.at(-1));
    expect(service._transcriber.modelPath).toBe("/models/uk-base");
  });

  test("test_failed_reload_keeps_the_loaded_model", async () => {
    const service = newService();
    const loaded = service._transcriber;

    const errors: string[] = [];

    service.pushError = async (errorMsg: string, _options?: unknown) => {
      errors.push(errorMsg);
    };

    makeTranscriber = () => {
      throw new Error("boom");
    };

    await service._updateSettings(new stt.MoonshineSTTService.Settings({ language: Language.JA }));

    expect(service._transcriber).toBe(loaded);
    expect(errors).toEqual(["Moonshine model load error: boom"]);
  });

  // @pytest.mark.parametrize("model", [None, ""], ids=["none", "blank"])
  for (const [id, model] of [
    ["none", null],
    ["blank", ""],
  ] as const) {
    test(`test_missing_or_blank_model_is_rejected[${id}]`, () => {
      expect(() =>
        newService({ settings: new stt.MoonshineSTTService.Settings({ model }) }),
      ).toThrow(/Moonshine model must be specified/);
    });
  }
});
