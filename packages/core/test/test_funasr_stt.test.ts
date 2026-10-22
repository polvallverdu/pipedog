// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_funasr_stt.py

/**
 * Tests for the FunASR speech-to-text service.
 *
 * Upstream installs fake `funasr` and `funasr.utils.postprocess_utils` modules
 * in `sys.modules` and re-imports `pipecat.services.funasr.stt`. Here the
 * service's engine module (`packages/funasr/src/funasr.ts`, which stands in for
 * the `funasr` library) is replaced with `mock.module` and the service is
 * loaded with a dynamic import.
 *
 * The engine is pipedog's own module, so the options the service passes to
 * `AutoModel` and `generate()` are camelCase (`disableUpdate`, `useItn`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ErrorFrame, TranscriptionFrame } from "../src/frames/frames.ts";
import { Language } from "../src/transcriptions/language.ts";

// The service module lives in @pipedog/funasr, loaded dynamically after the mock.
type AnyModule = any;

const ENGINE_PATH = "../../funasr/src/funasr.ts";

// mock.module() is process-wide: keep a copy of the real engine's exports and
// put them back afterwards, so other test files see the real module.
const realEngine = { ...(await import(ENGINE_PATH)) };

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
  mock.module(ENGINE_PATH, () => ({
    AutoModel: FakeAutoModel,
    richTranscriptionPostprocess,
  }));
  const modPath = "../../funasr/src/stt.ts";
  stt = await import(modPath);
});

afterEach(() => {
  stt = undefined;
});

afterAll(() => {
  mock.module(ENGINE_PATH, () => realEngine);
});

describe("test_funasr_stt", () => {
  test("test_funasr_stt_defaults_use_stt_settings", () => {
    const service = new stt.FunASRSTTService();

    expect(service._settings.model).toBe("iic/SenseVoiceSmall");
    expect(service._settings.language).toBe("en");
    expect(service._settings.useItn).toBe(true);
    expect(FakeAutoModel.instances.at(-1)!.kwargs).toEqual({
      model: "iic/SenseVoiceSmall",
      device: "cpu",
      disableUpdate: true,
    });
  });

  test("test_funasr_stt_applies_settings_overrides", () => {
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
      disableUpdate: true,
    });
  });

  test("test_language_to_funasr_language_accepts_enums_and_strings", () => {
    expect(stt.languageToFunasrLanguage(Language.EN_US)).toBe("en");
    expect(stt.languageToFunasrLanguage("zh-CN")).toBe("zh");
    expect(stt.languageToFunasrLanguage("yue")).toBe("yue");
    expect(stt.languageToFunasrLanguage("de")).toBe("auto");
    expect(stt.languageToFunasrLanguage(null)).toBe("auto");
  });

  test("test_funasr_language_to_frame_language_maps_supported_codes", () => {
    expect(stt.funasrLanguageToFrameLanguage("en")).toBe(Language.EN);
    expect(stt.funasrLanguageToFrameLanguage("auto")).toBeNull();
    expect(stt.funasrLanguageToFrameLanguage(null)).toBeNull();
    expect(stt.funasrLanguageToFrameLanguage("nospeech")).toBeNull();
  });

  test("test_funasr_stt_exposes_metrics_and_language_mapping", () => {
    const service = new stt.FunASRSTTService();

    expect(service.canGenerateMetrics()).toBe(true);
    expect(service.languageToServiceLanguage(Language.EN_US)).toBe("en");
  });

  test("test_run_stt_uses_settings_for_generation", async () => {
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
    expect(generateCall.useItn).toBe(false);
  });

  test("test_run_stt_returns_error_frame_when_model_is_missing", async () => {
    const service = new stt.FunASRSTTService();
    service._model = null;

    const frames = await collect(service.runStt(pcm()));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toBe("FunASR model not available");
  });

  test("test_run_stt_returns_error_frame_when_generation_fails", async () => {
    const service = new stt.FunASRSTTService();

    FakeAutoModel.instances.at(-1)!.generate = () => {
      throw new Error("boom");
    };

    const frames = await collect(service.runStt(pcm()));

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toBe("FunASR transcription error: boom");
  });

  test("test_run_stt_skips_empty_transcripts", async () => {
    const service = new stt.FunASRSTTService();
    postprocess = () => "   ";

    const frames = await collect(service.runStt(pcm()));

    expect(frames).toEqual([]);
  });
});
