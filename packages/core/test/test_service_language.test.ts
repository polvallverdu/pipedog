// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_service_language.py

/**
 * Tests for language parameter handling in TTS and STT services.
 *
 * Verifies that Language enums, raw strings (e.g. "de-DE"), and unrecognized
 * strings are all resolved correctly at both init time and runtime update time.
 */

import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";

import type { Frame } from "../src/frames/frames.ts";
import { STTSettings, TTSSettings } from "../src/services/settings.ts";
import { STTService } from "../src/services/stt_service.ts";
import { TTSService } from "../src/services/tts_service.ts";
import { Language, resolveLanguage } from "../src/transcriptions/language.ts";
import { logger } from "../src/utils/logger.ts";

// ---------------------------------------------------------------------------
// Minimal concrete subclasses for testing
// ---------------------------------------------------------------------------

// A simple language map using only base codes (like ElevenLabs does).
const _LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.DE]: "de",
  [Language.EN]: "en",
  [Language.FR]: "fr",
};

class _TestTTSSettings extends TTSSettings {}

/** Minimal concrete TTS service for testing language resolution. */
class _TestTTSService extends TTSService {
  static Settings = _TestTTSSettings;

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {}

  override languageToServiceLanguage(language: Language): string | null {
    return resolveLanguage(language, _LANGUAGE_MAP, true);
  }
}

class _TestSTTSettings extends STTSettings {}

/** Minimal concrete STT service for testing language resolution. */
class _TestSTTService extends STTService {
  static Settings = _TestSTTSettings;

  override async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {}

  override async processAudioFrame(): Promise<void> {}

  override languageToServiceLanguage(language: Language): string | null {
    return resolveLanguage(language, _LANGUAGE_MAP, true);
  }
}

// Python patches the service module's logger; here the logger is shared, so
// spy on its debug method for the duration of a test.
let mockDebug: Mock<(...args: unknown[]) => void> | null = null;

function patchDebug(): Mock<(...args: unknown[]) => void> {
  mockDebug = spyOn(logger, "debug").mockImplementation(() => {}) as unknown as Mock<
    (...args: unknown[]) => void
  >;
  return mockDebug;
}

afterEach(() => {
  mockDebug?.mockRestore();
  mockDebug = null;
});

function expectDebugOnceWith(mock: Mock<(...args: unknown[]) => void>, text: string): void {
  expect(mock).toHaveBeenCalledTimes(1);
  expect(String(mock.mock.calls[0]?.[0])).toContain(text);
}

// ---------------------------------------------------------------------------
// TTS init tests
// ---------------------------------------------------------------------------

/** Test language resolution at TTS service init time. */
describe("TestTTSLanguageInit", () => {
  test("test_language_enum_base_code", () => {
    // Language.DE (base code in map) resolves to 'de'.
    const svc = new _TestTTSService({
      settings: new _TestTTSService.Settings({ language: Language.DE }),
    });
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_language_enum_regional_code", () => {
    // Language.DE_DE (regional, not in map) falls back to base code 'de'.
    const svc = new _TestTTSService({
      settings: new _TestTTSService.Settings({ language: Language.DE_DE }),
    });
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_raw_string_base_code", () => {
    // Raw string 'de' is converted to Language.DE then resolved to 'de'.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: "de" }) });
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_raw_string_regional_code", () => {
    // Raw string 'de-DE' is converted to Language.DE_DE then resolved to 'de'.
    const svc = new _TestTTSService({
      settings: new _TestTTSService.Settings({ language: "de-DE" }),
    });
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_raw_string_other_regional", () => {
    // Raw string 'en-US' is converted to Language.EN_US then resolved to 'en'.
    const svc = new _TestTTSService({
      settings: new _TestTTSService.Settings({ language: "en-US" }),
    });
    expect(svc["_settings"].language).toBe("en");
  });

  test("test_raw_string_unrecognized", () => {
    // Unrecognized raw string logs a debug message and is passed through as-is.
    const mock = patchDebug();
    const svc = new _TestTTSService({
      settings: new _TestTTSService.Settings({ language: "klingon" }),
    });
    expect(svc["_settings"].language).toBe("klingon");
    expectDebugOnceWith(mock, "klingon");
  });

  test("test_language_none", () => {
    // None language is left as None.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    expect(svc["_settings"].language).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// STT init tests
// ---------------------------------------------------------------------------

/** Test language resolution at STT service init time. */
describe("TestSTTLanguageInit", () => {
  test("test_language_enum_base_code", () => {
    // Language.FR (base code in map) resolves to 'fr'.
    const svc = new _TestSTTService({
      settings: new _TestSTTService.Settings({ language: Language.FR }),
    });
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_language_enum_regional_code", () => {
    // Language.FR_FR (regional, not in map) falls back to base code 'fr'.
    const svc = new _TestSTTService({
      settings: new _TestSTTService.Settings({ language: Language.FR_FR }),
    });
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_raw_string_base_code", () => {
    // Raw string 'fr' is converted to Language.FR then resolved to 'fr'.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: "fr" }) });
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_raw_string_regional_code", () => {
    // Raw string 'de-DE' is converted to Language.DE_DE then resolved to 'de'.
    const svc = new _TestSTTService({
      settings: new _TestSTTService.Settings({ language: "de-DE" }),
    });
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_raw_string_unrecognized", () => {
    // Unrecognized raw string logs a debug message and is passed through as-is.
    const mock = patchDebug();
    const svc = new _TestSTTService({
      settings: new _TestSTTService.Settings({ language: "klingon" }),
    });
    expect(svc["_settings"].language).toBe("klingon");
    expectDebugOnceWith(mock, "klingon");
  });

  test("test_language_none", () => {
    // None language is left as None.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    expect(svc["_settings"].language).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTS runtime update tests
// ---------------------------------------------------------------------------

/** Test language resolution during runtime settings updates. */
describe("TestTTSLanguageUpdate", () => {
  test("test_update_language_enum_base_code", async () => {
    // Updating with Language.EN resolves to 'en'.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestTTSService.Settings({ language: Language.EN }));
    expect(svc["_settings"].language).toBe("en");
  });

  test("test_update_language_enum_regional_code", async () => {
    // Updating with Language.DE_DE falls back to base code 'de'.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestTTSService.Settings({ language: Language.DE_DE }));
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_update_raw_string_base_code", async () => {
    // Updating with raw string 'de' resolves to 'de'.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestTTSService.Settings({ language: "de" }));
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_update_raw_string_regional_code", async () => {
    // Updating with raw string 'de-DE' resolves to 'de'.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestTTSService.Settings({ language: "de-DE" }));
    expect(svc["_settings"].language).toBe("de");
  });

  test("test_update_raw_string_unrecognized", async () => {
    // Updating with unrecognized string logs debug message and passes through.
    const svc = new _TestTTSService({ settings: new _TestTTSService.Settings({ language: null }) });
    const mock = patchDebug();
    await svc["_updateSettings"](new _TestTTSService.Settings({ language: "klingon" }));
    expect(svc["_settings"].language).toBe("klingon");
    expectDebugOnceWith(mock, "klingon");
  });
});

// ---------------------------------------------------------------------------
// STT runtime update tests
// ---------------------------------------------------------------------------

/** Test language resolution during runtime settings updates. */
describe("TestSTTLanguageUpdate", () => {
  test("test_update_language_enum_base_code", async () => {
    // Updating with Language.EN resolves to 'en'.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestSTTService.Settings({ language: Language.EN }));
    expect(svc["_settings"].language).toBe("en");
  });

  test("test_update_language_enum_regional_code", async () => {
    // Updating with Language.FR_FR falls back to base code 'fr'.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestSTTService.Settings({ language: Language.FR_FR }));
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_update_raw_string_base_code", async () => {
    // Updating with raw string 'fr' resolves to 'fr'.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestSTTService.Settings({ language: "fr" }));
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_update_raw_string_regional_code", async () => {
    // Updating with raw string 'fr-FR' resolves to 'fr'.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    await svc["_updateSettings"](new _TestSTTService.Settings({ language: "fr-FR" }));
    expect(svc["_settings"].language).toBe("fr");
  });

  test("test_update_raw_string_unrecognized", async () => {
    // Updating with unrecognized string logs debug message and passes through.
    const svc = new _TestSTTService({ settings: new _TestSTTService.Settings({ language: null }) });
    const mock = patchDebug();
    await svc["_updateSettings"](new _TestSTTService.Settings({ language: "klingon" }));
    expect(svc["_settings"].language).toBe("klingon");
    expectDebugOnceWith(mock, "klingon");
  });
});

// ---------------------------------------------------------------------------
// resolve_language tests
// ---------------------------------------------------------------------------

/** Test resolve_language fallbacks for languages missing from the map. */
describe("TestResolveLanguage", () => {
  const _CODED_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "eng",
    [Language.ES]: "spa",
  };

  test("test_mapped_language", () => {
    // A language in the map resolves to its mapped code.
    expect(resolveLanguage(Language.EN, _CODED_MAP)).toBe("eng");
  });

  test("test_regional_variant_uses_mapped_base_code", () => {
    // A regional variant resolves to the map's code for its base language.
    expect(resolveLanguage(Language.EN_US, _CODED_MAP)).toBe("eng");
    expect(resolveLanguage(Language.ES_MX, _CODED_MAP)).toBe("spa");
  });

  test("test_regional_variant_without_mapped_base", () => {
    // A regional variant whose base isn't mapped resolves to the base code.
    expect(resolveLanguage(Language.FR_FR, _CODED_MAP)).toBe("fr");
  });

  test("test_base_code_not_a_language", () => {
    // A base code with no Language member resolves to the base code.
    expect(resolveLanguage(Language.IU_CANS, _CODED_MAP)).toBe("iu");
  });

  test("test_full_code_ignores_base_language", () => {
    // With use_base_code=False, a regional variant passes through unchanged.
    expect(resolveLanguage(Language.EN_US, _CODED_MAP, false)).toBe("en-US");
  });
});
