// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/cerebras/llm.py

/**
 * Cerebras LLM service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for CerebrasLLMService. */
export class CerebrasLLMSettings extends OpenAILLMSettings {}

export interface CerebrasLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Cerebras's API. */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://api.cerebras.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: CerebrasLLMSettings | null;
}

/**
 * A service for interacting with Cerebras's API using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Cerebras's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class CerebrasLLMService extends OpenAILLMService {
  static override Settings: typeof CerebrasLLMSettings = CerebrasLLMSettings;
  declare protected _settings: CerebrasLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Cerebras LLM service.
   *
   * @param options.apiKey The API key for accessing Cerebras's API.
   * @param options.baseUrl The base URL for Cerebras API. Defaults to "https://api.cerebras.ai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-oss-120b").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: CerebrasLLMServiceOptions) {
    const cls = new.target as typeof CerebrasLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "gpt-oss-120b" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.cerebras.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Cerebras API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Cerebras API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Cerebras client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
