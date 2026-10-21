// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Tests for language settings in GeminiLiveLLMService. */

import { expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiLiveLLMService, type GeminiLiveLLMSettingsOptions } from "../src/gemini_live/llm.ts";

// Test access to protected members, as upstream does with `service._settings`.
type Internals = {
  _settings: InstanceType<typeof GeminiLiveLLMService.Settings>;
  _updateSettings(delta: InstanceType<typeof GeminiLiveLLMService.Settings>): Promise<unknown>;
};

function _service(settings: GeminiLiveLLMSettingsOptions = {}): Internals {
  return new GeminiLiveLLMService({
    apiKey: "test-key",
    settings: new GeminiLiveLLMService.Settings(settings),
  }) as unknown as Internals;
}

test("test_constructor_converts_language_to_locale_code", () => {
  const service = _service({ language: Language.ES });
  expect(service._settings.language).toEqual("es-ES");
});

test("test_constructor_keeps_language_string_as_given", () => {
  const service = _service({ language: "es-MX" });
  expect(service._settings.language).toEqual("es-MX");
});

test("test_settings_update_converts_language_to_locale_code", async () => {
  const service = _service();
  await service._updateSettings(new GeminiLiveLLMService.Settings({ language: Language.FR }));
  expect(service._settings.language).toEqual("fr-FR");
});

test("test_settings_update_keeps_language_string_as_given", async () => {
  const service = _service();
  await service._updateSettings(new GeminiLiveLLMService.Settings({ language: "fr-CA" }));
  expect(service._settings.language).toEqual("fr-CA");
});
