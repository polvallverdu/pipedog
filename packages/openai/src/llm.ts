// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/llm.py

/**
 * OpenAI LLM service implementation with context aggregators.
 *
 * Porting note: the deprecated `model` and `params` constructor options are
 * not ported (use `settings`), so `serviceTier` is only read from its own
 * option.
 */

import {
  BaseOpenAILLMService,
  type BaseOpenAILLMServiceOptions,
  type OpenAILLMSettings,
  setOpenAINotGiven,
} from "./base_llm.ts";

export interface OpenAILLMServiceOptions extends BaseOpenAILLMServiceOptions {}

/**
 * OpenAI LLM service implementation.
 *
 * Provides a complete OpenAI LLM service with context aggregation support.
 * Uses the BaseOpenAILLMService for core functionality and adds
 * OpenAI-specific context aggregator creation.
 */
export class OpenAILLMService extends BaseOpenAILLMService {
  static override Settings: typeof OpenAILLMSettings = BaseOpenAILLMService.Settings;

  /**
   * Initialize OpenAI LLM service.
   *
   * @param options.serviceTier Service tier to use (e.g., "auto", "flex", "priority").
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-4.1").
   *   Other options are passed to the parent BaseOpenAILLMService.
   */
  constructor(options: OpenAILLMServiceOptions = {}) {
    const cls = new.target as typeof OpenAILLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "gpt-4.1",
      systemInstruction: null,
      topK: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      extra: {},
    });
    setOpenAINotGiven(defaultSettings);

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, serviceTier: options.serviceTier ?? null, settings: defaultSettings });
  }
}
