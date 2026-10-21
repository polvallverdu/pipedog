// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/crusoe/llm.py

/**
 * Crusoe Cloud LLM service implementation using OpenAI-compatible interface.

 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for CrusoeLLMService. */
export class CrusoeLLMSettings extends OpenAILLMSettings {}

export interface CrusoeLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Crusoe's Managed Inference API. */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://api.inference.crusoecloud.com/v1/"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: CrusoeLLMSettings | null;
}

/**
 * A service for interacting with Crusoe Cloud's Managed Inference API.
 *
 * This service extends OpenAILLMService to connect to Crusoe's OpenAI-compatible
 * API endpoint while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class CrusoeLLMService extends OpenAILLMService {
  // Crusoe doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof CrusoeLLMSettings = CrusoeLLMSettings;
  declare protected _settings: CrusoeLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Crusoe LLM service.
   *
   * @param options.apiKey The API key for accessing Crusoe's Managed Inference API.
   * @param options.baseUrl The base URL for the Crusoe API. Defaults to
   *   `"https://api.inference.crusoecloud.com/v1/"`.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "openai/gpt-oss-120b").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: CrusoeLLMServiceOptions) {
    const cls = new.target as typeof CrusoeLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "openai/gpt-oss-120b" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.inference.crusoecloud.com/v1/",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Crusoe API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Crusoe's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Crusoe client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
