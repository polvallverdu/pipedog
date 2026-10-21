// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/qwen/llm.py

/**
 * Qwen LLM service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for QwenLLMService. */
export class QwenLLMSettings extends OpenAILLMSettings {}

export interface QwenLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Qwen's API (DashScope API key). */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://dashscope-intl.aliyuncs.com/compatible-mode/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: QwenLLMSettings | null;
}

/**
 * A service for interacting with Alibaba Cloud's Qwen LLM API using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Qwen's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class QwenLLMService extends OpenAILLMService {
  // Qwen doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof QwenLLMSettings = QwenLLMSettings;
  declare protected _settings: QwenLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Qwen LLM service.
   *
   * @param options.apiKey The API key for accessing Qwen's API (DashScope API key).
   * @param options.baseUrl Base URL for Qwen API. Defaults to "https://dashscope-intl.aliyuncs.com/compatible-mode/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "qwen-plus").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: QwenLLMServiceOptions) {
    const cls = new.target as typeof QwenLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "qwen-plus" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      settings: defaultSettings,
    });
    logger.info(`Initialized Qwen LLM service with model: ${this._settings.model}`);
  }

  /**
   * Create OpenAI-compatible client for Qwen API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Qwen's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Qwen client with base URL: ${options.baseUrl}`);
    return super.createClient(options);
  }
}
