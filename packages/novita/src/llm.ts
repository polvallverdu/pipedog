// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/novita/llm.py

/**
 * Novita AI LLM service implementation using OpenAI-compatible interface.

 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for NovitaLLMService. */
export class NovitaLLMSettings extends OpenAILLMSettings {}

export interface NovitaLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Novita AI's API. */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://api.novita.ai/openai"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: NovitaLLMSettings | null;
}

/**
 * A service for interacting with Novita AI's API using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Novita AI's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class NovitaLLMService extends OpenAILLMService {
  static override Settings: typeof NovitaLLMSettings = NovitaLLMSettings;
  declare protected _settings: NovitaLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize Novita AI LLM service.
   *
   * @param options.apiKey The API key for accessing Novita AI's API.
   * @param options.baseUrl The base URL for Novita AI API. Defaults to "https://api.novita.ai/openai".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "moonshotai/kimi-k2.5").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: NovitaLLMServiceOptions) {
    const cls = new.target as typeof NovitaLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "moonshotai/kimi-k2.5" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.novita.ai/openai",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Novita AI API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Novita AI's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Novita AI client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
