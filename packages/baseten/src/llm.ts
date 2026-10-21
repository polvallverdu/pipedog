// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/baseten/llm.py

/**
 * Baseten LLM service implementation using OpenAI-compatible interface.

 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for BasetenLLMService. */
export class BasetenLLMSettings extends OpenAILLMSettings {}

export interface BasetenLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Baseten's inference API. */
  apiKey: string;
  /** The base URL for the API. Defaults to `"https://inference.baseten.co/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: BasetenLLMSettings | null;
}

/**
 * A service for interacting with Baseten's OpenAI-compatible inference API.
 *
 * Defaults to Baseten's Model APIs, a serverless endpoint hosting open-weights
 * models. To use a dedicated deployment running on your own GPUs, point
 * `baseUrl` at it and set `model` to the deployment's served model name:
 *
 * @example
 * new BasetenLLMService({
 *   apiKey: process.env.BASETEN_API_KEY ?? "",
 *   baseUrl: "https://model-{model_id}.api.baseten.co/environments/production/sync/v1",
 *   settings: new BasetenLLMService.Settings({ model: "Qwen/Qwen2.5-3B-Instruct" }),
 * });
 */
export class BasetenLLMService extends OpenAILLMService {
  // Baseten's message role enum is system/user/assistant/tool.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof BasetenLLMSettings = BasetenLLMSettings;
  declare protected _settings: BasetenLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Baseten LLM service.
   *
   * @param options.apiKey The API key for accessing Baseten's inference API.
   * @param options.baseUrl The base URL for the Baseten API. Defaults to
   *   `"https://inference.baseten.co/v1"`. Set this to a dedicated
   *   deployment's `/sync/v1` URL to use your own hosted model.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "zai-org/GLM-5.3").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: BasetenLLMServiceOptions) {
    const cls = new.target as typeof BasetenLLMService;

    // Initialize default_settings with hardcoded defaults.
    const defaultSettings = new cls.Settings({ model: "zai-org/GLM-5.3" });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://inference.baseten.co/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Baseten API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Baseten's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Baseten client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
