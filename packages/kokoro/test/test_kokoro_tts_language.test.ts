// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_kokoro_tts_language.py

/**
 * Tests for Kokoro TTS language code mapping.
 *
 * Porting note: upstream skips the module when the Kokoro extra is missing;
 * here the service module imports without any optional dependency.
 */

import { expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";
import { languageToKokoroLanguage } from "../src/tts.ts";

test("test_kokoro_uses_espeak_names_not_iso_codes", () => {
  // Mandarin and French use espeak-ng voice names, which differ from the ISO code.
  //
  // espeak-ng has no `zh` or bare `fr` — a name it doesn't know fails at
  // synthesis time rather than falling back.
  expect(languageToKokoroLanguage(Language.ZH)).toBe("cmn");
  expect(languageToKokoroLanguage(Language.FR)).toBe("fr-fr");
});

test("test_kokoro_chinese_variants_all_map_to_mandarin", () => {
  // Kokoro's `zf_`/`zm_` voices are Mandarin, whatever the script.
  expect(languageToKokoroLanguage(Language.ZH_CN)).toBe("cmn");
  expect(languageToKokoroLanguage(Language.ZH_HK)).toBe("cmn");
  expect(languageToKokoroLanguage(Language.ZH_TW)).toBe("cmn");
  expect(languageToKokoroLanguage(Language.CMN)).toBe("cmn");
});

test("test_kokoro_regional_variants_use_their_own_espeak_voice", () => {
  // Regions espeak-ng ships separately keep their own name.
  expect(languageToKokoroLanguage(Language.EN_GB)).toBe("en-gb");
  expect(languageToKokoroLanguage(Language.FR_BE)).toBe("fr-be");
  expect(languageToKokoroLanguage(Language.FR_CH)).toBe("fr-ch");
  expect(languageToKokoroLanguage(Language.PT_BR)).toBe("pt-br");
  // espeak-ng has no Canadian French; fr-fr is the nearest it ships.
  expect(languageToKokoroLanguage(Language.FR_CA)).toBe("fr-fr");
});

test("test_kokoro_base_languages_pass_through", () => {
  expect(languageToKokoroLanguage(Language.EN)).toBe("en-us");
  expect(languageToKokoroLanguage(Language.ES)).toBe("es");
  expect(languageToKokoroLanguage(Language.HI)).toBe("hi");
  expect(languageToKokoroLanguage(Language.IT)).toBe("it");
  expect(languageToKokoroLanguage(Language.JA)).toBe("ja");
  expect(languageToKokoroLanguage(Language.PT)).toBe("pt");
});
