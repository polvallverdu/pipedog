// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/perplexity/llm.py

/**
 * Perplexity LLM service implementation.
 *
 * This module provides a service for interacting with Perplexity's API using
 * an OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import { PerplexityLLMAdapter } from "./perplexity_adapter.ts";

/** Settings for PerplexityLLMService. */
export class PerplexityLLMSettings extends OpenAILLMSettings {}

export interface PerplexityLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Perplexity's API. */
  apiKey: string;
  /** The base URL for Perplexity's API. Defaults to `"https://api.perplexity.ai"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: PerplexityLLMSettings | null;
}

/**
 * A service for interacting with Perplexity's API.
 *
 * This service extends OpenAILLMService to work with Perplexity's API while
 * maintaining compatibility with the OpenAI-style interface.
 */
export class PerplexityLLMService extends OpenAILLMService {
  static override adapterClass = PerplexityLLMAdapter;
  // Perplexity doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof PerplexityLLMSettings = PerplexityLLMSettings;
  declare protected _settings: PerplexityLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Perplexity LLM service.
   *
   * @param options.apiKey The API key for accessing Perplexity's API.
   * @param options.baseUrl The base URL for Perplexity's API. Defaults to
   *   "https://api.perplexity.ai".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "sonar").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: PerplexityLLMServiceOptions) {
    const cls = new.target as typeof PerplexityLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "sonar" });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.perplexity.ai",
      settings: defaultSettings,
    });
  }

  /**
   * Build parameters for Perplexity chat completion request.
   *
   * Perplexity uses a subset of OpenAI parameters and doesn't support tools.
   *
   * @param paramsFromContext Parameters, derived from the LLM context, to use
   *   for the chat completion. Contains messages, tools, and tool choice.
   * @returns Dictionary of parameters for the chat completion request.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params: Record<string, any> = {
      model: this._settings.model,
      stream: true,
      messages: paramsFromContext.messages,
    };

    // Add OpenAI-compatible parameters if they're set
    if (this._settings.frequencyPenalty !== null) {
      params.frequency_penalty = this._settings.frequencyPenalty;
    }
    if (this._settings.presencePenalty !== null) {
      params.presence_penalty = this._settings.presencePenalty;
    }
    if (this._settings.temperature !== null) {
      params.temperature = this._settings.temperature;
    }
    if (this._settings.topP !== null) {
      params.top_p = this._settings.topP;
    }
    if (this._settings.maxTokens !== null) {
      params.max_tokens = this._settings.maxTokens;
    }

    return params;
  }
}
