// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_safety_settings.py

/** Tests for safety settings support in GoogleLLMService. */

import { expect, test } from "bun:test";

import { HarmBlockThreshold, HarmCategory, type SafetySetting } from "@google/genai";
import { isGiven } from "@pipedog/core/utils/types";

import { GoogleLLMService, GoogleLLMSettings } from "../src/llm.ts";

// Access to protected members (`_buildGenerationParams`, `_settings`), as upstream does.
type Internals = any;

function _safetySetting(
  category: HarmCategory = HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  threshold: HarmBlockThreshold = HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
): SafetySetting {
  return { category, threshold };
}

test("test_safety_settings_omitted_by_default", () => {
  // Generation params carry no safety_settings key unless configured.
  const service: Internals = new GoogleLLMService({ apiKey: "test-key" });

  const params = service._buildGenerationParams();

  expect("safety_settings" in params).toBe(false);
});

test("test_safety_settings_passed_to_generation_params", () => {
  // Configured safety settings reach the generation params verbatim.
  const safety = [_safetySetting()];
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ safetySettings: safety }),
  });

  const params = service._buildGenerationParams();

  expect(params.safety_settings).toEqual(safety);
});

test("test_safety_settings_survive_config_construction", () => {
  // The generation params build a GenerateContentConfig the SDK accepts.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ safetySettings: [_safetySetting()] }),
  });

  // Upstream: `GenerateContentConfig(**service._build_generation_params())`.
  const config = service._toGenerateContentConfig(service._buildGenerationParams());

  expect(config.safetySettings).not.toBeNull();
  expect(config.safetySettings).toBeDefined();
  expect(config.safetySettings[0].category).toBe(HarmCategory.HARM_CATEGORY_HATE_SPEECH);
  expect(config.safetySettings[0].threshold).toBe(HarmBlockThreshold.BLOCK_LOW_AND_ABOVE);
});

test("test_safety_settings_updated_at_runtime", () => {
  // A settings delta replaces the safety settings on the live service.
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ safetySettings: [_safetySetting()] }),
  });
  const updated = [
    _safetySetting(HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, HarmBlockThreshold.BLOCK_NONE),
  ];

  service._settings.applyUpdate(new GoogleLLMService.Settings({ safetySettings: updated }));

  expect(service._buildGenerationParams().safety_settings).toEqual(updated);
});

test("test_from_mapping_coerces_dict_entries", () => {
  // Plain dicts from a dict-based settings update become SafetySetting objects.
  const settings = GoogleLLMSettings.fromMapping({
    safety_settings: [
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_LOW_AND_ABOVE",
      },
    ],
  }) as GoogleLLMSettings;

  expect(settings.safetySettings).toEqual([_safetySetting()]);
});

test("test_from_mapping_leaves_safety_setting_objects_untouched", () => {
  // Already-typed entries pass through from_mapping unchanged.
  const safety = [_safetySetting()];

  const settings = GoogleLLMSettings.fromMapping({ safety_settings: safety }) as GoogleLLMSettings;

  expect(settings.safetySettings).toEqual(safety);
});

test("test_from_mapping_without_safety_settings_is_not_given", () => {
  // Omitting safety_settings leaves the delta field unset.
  const settings = GoogleLLMSettings.fromMapping({ temperature: 0.5 }) as GoogleLLMSettings;

  expect(isGiven(settings.safetySettings)).toBe(false);
});
