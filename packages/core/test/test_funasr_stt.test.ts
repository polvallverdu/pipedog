// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_funasr_stt.py

/**
 * Tests for the FunASR speech-to-text service.
 *
 * Upstream installs fake `funasr` and `funasr.utils.postprocess_utils` modules
 * in `sys.modules` and re-imports `pipecat.services.funasr.stt`. Here the fake
 * modules are installed with `mock.module` and the service is loaded with a
 * dynamic import, so this file still loads while `packages/funasr/src/stt.ts`
 * (`@pipecat-ts/funasr`) is unported; the tests are `test.todo` until it lands.
 *
 * The keyword arguments the service passes to the third-party `AutoModel`
 * constructor and `generate()` are the funasr library's own names, so they keep
 * their upstream spelling (`disable_update`, `use_itn`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ErrorFrame, TranscriptionFrame } from "../src/frames/frames.ts";
import { Language } from "../src/transcriptions/language.ts";

const TODO = "unported module: pipecat.services.funasr.stt (packages/funasr/src/stt.ts)";

// The service module is not ported yet.
type AnyModule = any;

class FakeAutoModel {
  static instances: FakeAutoModel[] = [];

  kwargs: Record<string, unknown>;
  generateCalls: Record<string, unknown>[] = [];

  constructor(kwargs: Record<string, unknown>) {
    this.kwargs = kwargs;
    FakeAutoModel.instances.push(this);
  }

  generate(kwargs: Record<string, unknown>): { text: string }[] {
    this.generateCalls.push(kwargs);
    return [{ text: " raw text " }];
  }
}

// Upstream reassigns `stt.rich_transcription_postprocess`; an ES module binding
// cannot be reassigned, so the fake delegates to this replaceable function.
let postprocess: (text: string) => string;

function richTranscriptionPostprocess(text: string): string {
  return postprocess(text);
}

let stt: AnyModule;

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function pcm(): Uint8Array {
  // b"\x00\x00" * 160
  return new Uint8Array(320);
}

beforeEach(async () => {
  FakeAutoModel.instances = [];
  postprocess = (text: string) => text.replace("raw", "clean");
  mock.module("funasr", () => ({ AutoModel: FakeAutoModel }));
  mock.module("funasr/utils", () => ({}));
  mock.module("funasr/utils/postprocess_utils", () => ({
    rich_transcription_postprocess: richTranscriptionPostprocess,
    richTranscriptionPostprocess,
  }));
  const modPath = "../../funasr/src/stt.ts";
  try {
    stt = await import(modPath);
  } catch {
    // The tests below are todo until the module exists.
    stt = undefined;
  }
});

afterEach(() => {
  stt = undefined;
});

describe("test_funasr_stt", () => {
  test.todo(`test_funasr_stt_defaults_use_stt_settings (${TODO})`, () => {
    const service = new stt.FunASRSTTService();

    expect(service._settings.model).toBe("iic/SenseVoiceSmall");
    expect(service._settings.language).toBe("en");
    expect(service._settings.useItn).toBe(true);
    expect(FakeAutoModel.instances.at(-1)!.kwargs).toEqual({
      model: "iic/SenseVoiceSmall",
      device: "cpu",
      disable_update: true,
    });
  });

  test.todo(`test_funasr_stt_applies_settings_overrides (${TODO})`, () => {
    const service = new stt.FunASRSTTService({
      device: "cuda",
      settings: new stt.FunASRSTTSettings({
        model: "custom/sensevoice",
        language: Language.ZH,
        useItn: false,
      }),
    });

    expect(service._settings.model).toBe("custom/sensevoice");
    expect(service._settings.language).toBe("zh");
    expect(service._settings.useItn).toBe(false);
    expect(FakeAutoModel.instances.at(-1)!.kwargs).toEqual({
      model: "custom/sensevoice",
      device: "cuda",
      disable_update: true,
    });
  });

  test.todo(`test_language_to_funasr_language_accepts_enums_and_strings (${TODO})`, () => {
    expect(stt.languageToFunasrLanguage(Language.EN_US)).toBe("en");
    expect(stt.languageToFunasrLanguage("zh-CN")).toBe("zh");
    expect(stt.languageToFunasrLanguage("yue")).toBe("yue");
    expect(stt.languageToFunasrLanguage("de")).toBe("auto");
    expect(stt.languageToFunasrLanguage(null)).toBe("auto");
  });

  test.todo(`test_funasr_language_to_frame_language_maps_supported_codes (${TODO})`, () => {
    expect(stt.funasrLanguageToFrameLanguage("en")).toBe(Language.EN);
    expect(stt.funasrLanguageToFrameLanguage("auto")).toBeNull();
    expect(stt.funasrLanguageToFrameLanguage(null)).toBeNull();
    expect(stt.funasrLanguageToFrameLanguage("nospeech")).toBeNull();
  });

  test.todo(`test_funasr_stt_exposes_metrics_and_language_mapping (${TODO})`, () => {
    const service = new stt.FunASRSTTService();

    expect(service.canGenerateMetrics()).toBe(true);
    expect(service.languageToServiceLanguage(Language.EN_US)).toBe("en");
  });

  test.todo(`test_run_stt_uses_settings_for_generation (${TODO})`, async () => {
    const service = new stt.FunASRSTTService({
      settings: new stt.FunASRSTTSettings({
        model: "custom/sensevoice",
        language: Language.ZH,
        useItn: false,
      }),
    });

    const frames = await collect(service.runStt(pcm()));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(TranscriptionFrame);
    const frame = frames[0] as TranscriptionFrame;
    expect(frame.text).toBe("clean text");
    expect(frame.language).toBe(Language.ZH);
    const generateCall = FakeAutoModel.instances.at(-1)!.generateCalls.at(-1)!;
    expect(generateCall.language).toBe("zh");
    expect(generateCall.use_itn).toBe(false);
  });

  test.todo(`test_run_stt_returns_error_frame_when_model_is_missing (${TODO})`, async () => {
    const service = new stt.FunASRSTTService();
    service._model = null;

    const frames = await collect(service.runStt(pcm()));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toBe("FunASR model not available");
  });

  test.todo(`test_run_stt_returns_error_frame_when_generation_fails (${TODO})`, async () => {
    const service = new stt.FunASRSTTService();

    FakeAutoModel.instances.at(-1)!.generate = () => {
      throw new Error("boom");
    };

    const frames = await collect(service.runStt(pcm()));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toBe("FunASR transcription error: boom");
  });

  test.todo(`test_run_stt_skips_empty_transcripts (${TODO})`, async () => {
    const service = new stt.FunASRSTTService();
    postprocess = () => "   ";

    const frames = await collect(service.runStt(pcm()));

    expect(frames).toEqual([]);
  });
});
