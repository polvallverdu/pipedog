// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_smallest_stt.py

/**
 * Tests for SmallestSTTService's Pulse 2.0 model support.
 *
 * Porting notes:
 * - `pytest.raises(ValueError, match="English-only")` → `toThrow("English-only")`.
 * - `AsyncMock` → an assigned async function.
 */

import { expect, test } from "bun:test";
import { STTSettings } from "@pipedog/core/services/settings";
import { Language } from "@pipedog/core/transcriptions/language";
import { SmallestSTTModel, SmallestSTTService } from "../src/stt.ts";

test("test_default_model_is_pulse", () => {
  const service = new SmallestSTTService({ apiKey: "test-key" });
  expect(service._settings.model).toBe(SmallestSTTModel.PULSE);
});

test("test_pulse_2_defaults_to_english", () => {
  const service = new SmallestSTTService({
    apiKey: "test-key",
    settings: new SmallestSTTService.Settings({ model: SmallestSTTModel.PULSE_2 }),
  });
  expect(service._settings.language).toBe("en");
});

test("test_pulse_2_accepts_regional_english_string", () => {
  const service = new SmallestSTTService({
    apiKey: "test-key",
    settings: new SmallestSTTService.Settings({
      model: SmallestSTTModel.PULSE_2,
      language: "en-US" as Language,
    }),
  });
  expect(service._settings.language).toBe("en");
});

test("test_pulse_2_rejects_non_english_language_at_construction", () => {
  expect(
    () =>
      new SmallestSTTService({
        apiKey: "test-key",
        settings: new SmallestSTTService.Settings({
          model: SmallestSTTModel.PULSE_2,
          language: Language.HI,
        }),
      }),
  ).toThrow("English-only");
});

test("test_pulse_rejects_english_only_restriction_does_not_apply", () => {
  // Non-English languages are fine on the default `pulse` model.
  const service = new SmallestSTTService({
    apiKey: "test-key",
    settings: new SmallestSTTService.Settings({ language: Language.HI }),
  });
  expect(service._settings.language).toBe("hi");
});

test("test_switching_to_pulse_2_with_non_english_language_raises", async () => {
  const service: any = new SmallestSTTService({ apiKey: "test-key" });

  await expect(
    service._updateSettings(
      new STTSettings({ model: SmallestSTTModel.PULSE_2, language: Language.HI }),
    ),
  ).rejects.toThrow("English-only");
});

test("test_switching_to_pulse_2_with_regional_english_string_succeeds", async () => {
  const service: any = new SmallestSTTService({ apiKey: "test-key" });
  service._disconnect = async () => {};
  service._connect = async () => {};

  await service._updateSettings(
    new STTSettings({ model: SmallestSTTModel.PULSE_2, language: "en-US" as Language }),
  );
  expect(service._settings.model).toBe(SmallestSTTModel.PULSE_2);
});

test("test_emotion_and_gender_detection_default_on", () => {
  const service = new SmallestSTTService({ apiKey: "test-key" });
  expect(service._settings.emotionDetection).toBe(true);
  expect(service._settings.genderDetection).toBe(true);
});
