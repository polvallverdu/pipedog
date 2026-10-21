// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for frequency and presence penalties in GoogleLLMService.
 *
 * pipedog-only: upstream never sends the penalties (see the DIVERGENCE note in
 * `_buildGenerationParams`), so there is no upstream test to port.
 */

import { expect, test } from "bun:test";

import { GoogleLLMService } from "../src/llm.ts";

// Access to protected members (`_buildGenerationParams`, `_settings`).
type Internals = any;

test("test_penalties_omitted_by_default", () => {
  const service: Internals = new GoogleLLMService({ apiKey: "test-key" });

  const params = service._buildGenerationParams();

  expect("frequency_penalty" in params).toBe(false);
  expect("presence_penalty" in params).toBe(false);
});

test("test_penalties_reach_generate_content_config", () => {
  const service: Internals = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ frequencyPenalty: 0.4, presencePenalty: -0.2 }),
  });

  const params = service._buildGenerationParams();
  expect(params.frequency_penalty).toBe(0.4);
  expect(params.presence_penalty).toBe(-0.2);

  const config = service._toGenerateContentConfig(params);
  expect(config.frequencyPenalty).toBe(0.4);
  expect(config.presencePenalty).toBe(-0.2);
});

test("test_penalties_updated_at_runtime", () => {
  const service: Internals = new GoogleLLMService({ apiKey: "test-key" });

  service._settings.applyUpdate(new GoogleLLMService.Settings({ frequencyPenalty: 1 }));

  const config = service._toGenerateContentConfig(service._buildGenerationParams());
  expect(config.frequencyPenalty).toBe(1);
  expect("presencePenalty" in config).toBe(false);
});
