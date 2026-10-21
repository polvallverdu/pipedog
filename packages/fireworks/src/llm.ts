// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/fireworks/llm.py

/**
 * Fireworks AI service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for FireworksLLMService. */
export class FireworksLLMSettings extends OpenAILLMSettings {}

export interface FireworksLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Fireworks AI. */
  apiKey: string;
  /** The base URL for Fireworks API. Defaults to `"https://api.fireworks.ai/inference/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: FireworksLLMSettings | null;
}

/**
 * A service for interacting with Fireworks AI using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Fireworks' API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class FireworksLLMService extends OpenAILLMService {
  static override Settings: typeof FireworksLLMSettings = FireworksLLMSettings;
  declare protected _settings: FireworksLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Fireworks LLM service.
   *
   * @param options.apiKey The API key for accessing Fireworks AI.
   * @param options.baseUrl The base URL for Fireworks API. Defaults to
   *   "https://api.fireworks.ai/inference/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model
   *   "accounts/fireworks/models/nemotron-3-ultra-nvfp4").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: FireworksLLMServiceOptions) {
    const cls = new.target as typeof FireworksLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.fireworks.ai/inference/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Fireworks API endpoint.
   *
   * @param options.apiKey API key for authentication.
   * @param options.baseUrl Base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns Configured OpenAI client instance for Fireworks API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Fireworks client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for Fireworks chat completion request.
   *
   * Fireworks doesn't support some OpenAI parameters like seed,
   * max_completion_tokens, and stream_options.
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
      frequency_penalty: this._settings.frequencyPenalty,
      presence_penalty: this._settings.presencePenalty,
      temperature: this._settings.temperature,
      top_p: this._settings.topP,
      max_tokens: this._settings.maxTokens,
    };

    // Messages, tools, tool_choice
    Object.assign(params, paramsFromContext);

    Object.assign(params, this._settings.extra);

    return params;
  }
}
