// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/nebius/llm.py

/**
 * Nebius LLM service implementation using OpenAI-compatible interface.

 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for NebiusLLMService. */
export class NebiusLLMSettings extends OpenAILLMSettings {}

export interface NebiusLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Nebius's API. */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://api.tokenfactory.nebius.com/v1/"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: NebiusLLMSettings | null;
}

/**
 * A service for interacting with Nebius's API using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Nebius's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class NebiusLLMService extends OpenAILLMService {
  // Nebius doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof NebiusLLMSettings = NebiusLLMSettings;
  declare protected _settings: NebiusLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Nebius LLM service.
   *
   * @param options.apiKey The API key for accessing Nebius's API.
   * @param options.baseUrl The base URL for the Nebius API. Defaults to
   *   `"https://api.tokenfactory.nebius.com/v1/"`.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "Qwen/Qwen3-30B-A3B-Instruct-2507").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: NebiusLLMServiceOptions) {
    const cls = new.target as typeof NebiusLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "Qwen/Qwen3-30B-A3B-Instruct-2507" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.tokenfactory.nebius.com/v1/",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Nebius API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Nebius's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Nebius client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
