// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_together_tts.py

/** Unit tests for TogetherTTSService's WebSocket URL. */

import { expect, test } from "bun:test";
import { Language } from "@pipedog/core/transcriptions/language";
import { TogetherTTSService, type TogetherTTSSettingsOptions } from "../src/tts.ts";

function service(settings?: TogetherTTSSettingsOptions): TogetherTTSService {
  return new TogetherTTSService({
    apiKey: "test-key",
    settings: settings ? new TogetherTTSService.Settings(settings) : null,
  });
}

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test("test_websocket_url_sends_default_language", () => {
  const q = query(service()._buildWebsocketUrl());

  expect(q.getAll("model")).toEqual(["hexgrad/Kokoro-82M"]);
  expect(q.getAll("voice")).toEqual(["af_heart"]);
  expect(q.getAll("language")).toEqual(["en"]);
  expect(q.has("max_partial_length")).toBe(false);
});

test("test_websocket_url_escapes_blended_voice", () => {
  const url = service({ voice: "af_bella(2)+af_heart(1)" })._buildWebsocketUrl();

  expect(url).toContain("voice=af_bella%282%29%2Baf_heart%281%29");
  expect(url).toContain("model=hexgrad/Kokoro-82M");
});

test.each([
  [Language.FR, "fr"],
  [Language.EN_US, "en"],
  [Language.ZH_HK, "zh-hk"],
  ["pt-BR", "pt"],
])("test_language_resolves_to_together_code[%s]", (language, expected) => {
  const q = query(service({ language: language as Language })._buildWebsocketUrl());

  expect(q.getAll("language")).toEqual([expected]);
});

test("test_language_none_is_omitted", () => {
  const q = query(service({ language: null })._buildWebsocketUrl());

  expect(q.has("language")).toBe(false);
});
