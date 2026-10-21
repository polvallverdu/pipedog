// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_inworld_tts_language.py

/** Tests for Inworld TTS language code mapping. */

import { expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";

import { languageToInworldLanguage } from "../src/tts.ts";

/** Base GA languages should use the regional tags emitted by Inworld Playground. */
test("test_inworld_base_languages_resolve_to_canonical_regional_tags", () => {
  expect(languageToInworldLanguage(Language.EN)).toBe("en-US");
  expect(languageToInworldLanguage(Language.RU)).toBe("ru-RU");
  expect(languageToInworldLanguage(Language.FR)).toBe("fr-FR");
  expect(languageToInworldLanguage(Language.ZH)).toBe("zh-CN");
});

/** Explicit regional variants should be passed through as supported BCP-47 tags. */
test("test_inworld_regional_languages_are_preserved", () => {
  expect(languageToInworldLanguage(Language.EN_GB)).toBe("en-GB");
  expect(languageToInworldLanguage(Language.PT_PT)).toBe("pt-PT");
  expect(languageToInworldLanguage(Language.RU_RU)).toBe("ru-RU");
});

/** Languages outside the canonical locale map should keep their BCP-47 enum value. */
test("test_inworld_other_languages_are_passed_through_as_bcp47_tags", () => {
  expect(languageToInworldLanguage(Language.SV_SE)).toBe("sv-SE");
  expect(languageToInworldLanguage(Language.UK_UA)).toBe("uk-UA");
});
