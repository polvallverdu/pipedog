// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_whisper_stt_language.py

/**
 * Tests for Whisper STT model/language compatibility checking.
 *
 * Upstream patches `pipecat.services.whisper.stt.WhisperModel` with a
 * MagicMock. Here `../src/faster_whisper.ts` (the engine module that stands in
 * for faster-whisper) is replaced with `mock.module`, keeping its real exports
 * and swapping `WhisperModel` for a stand-in while a test sets one.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { Language } from "@pipedog/core/transcriptions/language";
import * as engineModule from "../src/faster_whisper.ts";

const ENGINE = resolve(import.meta.dir, "../src/faster_whisper.ts");

// A snapshot taken before mocking: `mock.module` updates the live bindings of
// modules already imported, and stays in effect for the rest of the run.
const realEngine = { ...engineModule };

let stubModel: ((name: string, options: unknown) => unknown) | null = null;

function FakeWhisperModel(this: unknown, name: string, options: unknown): unknown {
  if (stubModel) return stubModel(name, options);
  return new realEngine.WhisperModel(name, options as engineModule.WhisperModelOptions);
}

let stt: any;

beforeAll(async () => {
  mock.module(ENGINE, () => ({ ...realEngine, WhisperModel: FakeWhisperModel }));
  stt = await import("../src/stt.ts");
});

afterAll(() => {
  stubModel = null;
});

/** Construct the service against a stand-in model, so nothing is downloaded. */
function _build(supported: string[] | null, settings: Record<string, unknown>): any {
  stubModel = () => ({ supportedLanguages: supported });
  try {
    const { WhisperSTTService } = stt;
    return new WhisperSTTService({ settings: new WhisperSTTService.Settings(settings) });
  } finally {
    stubModel = null;
  }
}

test("test_english_only_model_rejects_another_language", () => {
  // The English-only models transcribe as English rather than refusing.
  let message = "";
  expect(() => {
    try {
      _build(["en"], { model: "distil-medium.en", language: Language.ES });
    } catch (e) {
      message = (e as Error).message;
      throw e;
    }
  }).toThrow(Error);
  expect(message).toContain("distil-medium.en");
  expect(message).toContain("large-v3-turbo"); // names a model that would work
});

test("test_multilingual_model_accepts_the_language", () => {
  const service = _build(["en", "es", "zh"], { model: "large-v3-turbo", language: Language.ES });
  expect(service._settings.language).toBe("es");
});

test("test_english_only_model_without_a_language_is_fine", () => {
  // The default pairing — an English-only model left at its English default.
  const service = _build(["en"], { model: "distil-medium.en" });
  expect(service._settings.language).toBe("en");
});

test("test_no_language_means_auto_detect_on_a_multilingual_model", () => {
  // `language: null` hands language detection to Whisper rather than naming one.
  const service = _build(["en", "es", "zh"], { model: "small", language: null });
  expect(service._settings.language).toBeNull();
});

test("test_no_language_means_auto_detect_on_an_english_only_model", () => {
  const service = _build(["en"], { model: "distil-medium.en", language: null });
  expect(service._settings.language).toBeNull();
});

test("test_model_that_does_not_publish_languages_is_not_second_guessed", () => {
  const service = _build(null, { model: "custom", language: Language.ES });
  expect(service._settings.language).toBe("es");
});

test.each([
  ["none", null],
  ["blank", ""],
])("test_missing_or_blank_model_is_rejected_before_loading[%s]", (_id, model) => {
  expect(() => _build(["en"], { model })).toThrow("Whisper model must be specified");
});

test.each([
  ["none", null],
  ["blank", ""],
])("test_mlx_missing_or_blank_model_is_rejected_at_construction[%s]", (_id, model) => {
  const { WhisperSTTServiceMLX } = stt;
  expect(
    () => new WhisperSTTServiceMLX({ settings: new WhisperSTTServiceMLX.Settings({ model }) }),
  ).toThrow("Whisper model must be specified");
});

test("test_mlx_accepts_a_runtime_language_change", async () => {
  const { WhisperSTTServiceMLX } = stt;

  const service = new WhisperSTTServiceMLX();
  service.pushError = mock(async () => {});

  const changed = await service._updateSettings(
    new WhisperSTTServiceMLX.Settings({ language: Language.FR }),
  );

  expect("language" in changed).toBe(true);
  expect(service.pushError).not.toHaveBeenCalled();
});
