// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_moonshine_stt.py

/**
 * Tests for the Moonshine STT service.
 *
 * Upstream installs a fake `moonshine_voice` module in `sys.modules` and
 * re-imports `pipecat.services.moonshine.stt`. Here the fake module is
 * installed with `mock.module` and the service is loaded with a dynamic
 * import, so this file still loads while `packages/moonshine/src/stt.ts`
 * (`@pipecat-ts/moonshine`) is unported; the tests are `test.todo` until it
 * lands.
 *
 * The fake exposes the `moonshine_voice` functions under both their upstream
 * names and camelCase, since the JS binding is not settled yet.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TranscriptionFrame } from "../src/frames/frames.ts";
import { Language } from "../src/transcriptions/language.ts";

const TODO = "unported module: pipecat.services.moonshine.stt (packages/moonshine/src/stt.ts)";

// The service module is not ported yet.
type AnyModule = any;

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
  audio?: number[];
  sampleRate?: number;

  constructor(modelPath: string, modelArch: string) {
    this.modelPath = modelPath;
    this.modelArch = modelArch;
    FakeTranscriber.instances.push(this);
  }

  transcribeWithoutStreaming(audio: number[], sampleRate: number): { lines: { text: string }[] } {
    this.audio = audio;
    this.sampleRate = sampleRate;
    return { lines: [{ text: " hello there " }] };
  }

  transcribe_without_streaming(audio: number[], sampleRate: number): { lines: { text: string }[] } {
    return this.transcribeWithoutStreaming(audio, sampleRate);
  }
}

// Upstream reassigns `stt.Transcriber`; an ES module binding cannot be
// reassigned, so the module's `Transcriber` delegates to this replaceable factory.
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

const modelArchToString = (modelArch: string): string => modelArch;
const supportedLanguages = (): string[] => Object.keys(FAKE_MODELS);
const supportedLanguagesFriendly = (): string => Object.keys(FAKE_MODELS).join(", ");

let stt: AnyModule;

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

beforeEach(async () => {
  makeTranscriber = (modelPath, modelArch) => new FakeTranscriber(modelPath, modelArch);
  mock.module("moonshine_voice", () => ({
    Transcriber,
    get_model_for_language: getModelForLanguage,
    getModelForLanguage,
    model_arch_to_string: modelArchToString,
    modelArchToString,
    string_to_model_arch: stringToModelArch,
    stringToModelArch,
    supported_languages: supportedLanguages,
    supportedLanguages,
    supported_languages_friendly: supportedLanguagesFriendly,
    supportedLanguagesFriendly,
  }));
  const modPath = "../../moonshine/src/stt.ts";
  try {
    stt = await import(modPath);
  } catch {
    // The tests below are todo until the module exists.
    stt = undefined;
  }
  FakeTranscriber.instances = [];
});

afterEach(() => {
  stt = undefined;
});

describe("test_moonshine_stt", () => {
  test.todo(`test_defaults_load_the_english_streaming_model (${TODO})`, () => {
    const service = new stt.MoonshineSTTService();

    expect(service._settings.model).toBe("small-streaming");
    expect(service._settings.language).toBe("en");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/en-small-streaming");
    expect(FakeTranscriber.instances.at(-1)!.modelArch).toBe("small-streaming");
  });

  test.todo(`test_regional_variants_resolve_to_the_base_code (${TODO})`, () => {
    const service = new stt.MoonshineSTTService({
      settings: new stt.MoonshineSTTSettings({ language: Language.EN_GB }),
    });

    expect(service._settings.language).toBe("en");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/en-small-streaming");
  });

  test.todo(`test_unavailable_architecture_falls_back_to_the_language_default (${TODO})`, () => {
    const service = new stt.MoonshineSTTService({
      settings: new stt.MoonshineSTTSettings({ language: Language.UK_UA }),
    });

    expect(service._settings.language).toBe("uk");
    expect(service._settings.model).toBe("base");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/uk-base");
  });

  test.todo(`test_requested_architecture_is_kept_when_available (${TODO})`, () => {
    const service = new stt.MoonshineSTTService({
      settings: new stt.MoonshineSTTSettings({
        model: stt.Model.TINY,
        language: Language.JA,
      }),
    });

    expect(service._settings.model).toBe("tiny");
    expect(FakeTranscriber.instances.at(-1)!.modelPath).toBe("/models/ja-tiny");
  });

  test.todo(`test_unsupported_language_raises (${TODO})`, () => {
    expect(
      () =>
        new stt.MoonshineSTTService({
          settings: new stt.MoonshineSTTSettings({ language: Language.FR }),
        }),
    ).toThrow(/does not support language 'fr'/);
  });

  test.todo(`test_unknown_model_raises (${TODO})`, () => {
    expect(
      () =>
        new stt.MoonshineSTTService({
          settings: new stt.MoonshineSTTSettings({ model: "huge" }),
        }),
    ).toThrow(/Invalid model architecture string/);
  });

  test.todo(`test_language_to_moonshine_language (${TODO})`, () => {
    expect(stt.languageToMoonshineLanguage(Language.EN_US)).toBe("en");
    expect(stt.languageToMoonshineLanguage(Language.ZH_TW)).toBe("zh");
    expect(stt.languageToMoonshineLanguage(Language.UK)).toBe("uk");
    expect(stt.languageToMoonshineLanguage(Language.DE)).toBe("de");
    expect(stt.languageToMoonshineLanguage(Language.TL)).toBe("tl");
    expect(stt.languageToMoonshineLanguage(Language.FIL)).toBe("tl");
  });

  test.todo(`test_moonshine_language_to_frame_language (${TODO})`, () => {
    expect(stt.moonshineLanguageToFrameLanguage("es")).toBe(Language.ES);
    expect(stt.moonshineLanguageToFrameLanguage(null)).toBeNull();
    expect(stt.moonshineLanguageToFrameLanguage("not-a-language")).toBeNull();
  });

  test.todo(`test_service_exposes_metrics_and_language_mapping (${TODO})`, () => {
    const service = new stt.MoonshineSTTService();

    expect(service.canGenerateMetrics()).toBe(true);
    expect(service.languageToServiceLanguage(Language.EN_US)).toBe("en");
  });

  test.todo(`test_run_stt_yields_a_transcription_frame (${TODO})`, async () => {
    const service = new stt.MoonshineSTTService({
      settings: new stt.MoonshineSTTSettings({ language: Language.ES }),
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

  test.todo(`test_language_update_reloads_the_model (${TODO})`, async () => {
    const service = new stt.MoonshineSTTService();

    await service._updateSettings(new stt.MoonshineSTTSettings({ language: Language.UK }));

    expect(service._settings.language).toBe("uk");
    expect(service._settings.model).toBe("base");
    expect(service._transcriber).toBe(FakeTranscriber.instances.at(-1));
    expect(service._transcriber.modelPath).toBe("/models/uk-base");
  });

  test.todo(`test_failed_reload_keeps_the_loaded_model (${TODO})`, async () => {
    const service = new stt.MoonshineSTTService();
    const loaded = service._transcriber;

    const errors: string[] = [];

    service.pushError = async (errorMsg: string, _options?: unknown) => {
      errors.push(errorMsg);
    };

    makeTranscriber = () => {
      throw new Error("boom");
    };

    await service._updateSettings(new stt.MoonshineSTTSettings({ language: Language.JA }));

    expect(service._transcriber).toBe(loaded);
    expect(errors).toEqual(["Moonshine model load error: boom"]);
  });

  // @pytest.mark.parametrize("model", [None, ""], ids=["none", "blank"])
  for (const [id, model] of [
    ["none", null],
    ["blank", ""],
  ] as const) {
    test.todo(`test_missing_or_blank_model_is_rejected[${id}] (${TODO})`, () => {
      expect(
        () =>
          new stt.MoonshineSTTService({
            settings: new stt.MoonshineSTTSettings({ model }),
          }),
      ).toThrow(/Moonshine model must be specified/);
    });
  }
});
