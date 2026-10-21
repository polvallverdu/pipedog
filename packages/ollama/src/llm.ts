// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/ollama/llm.py

/**
 * OLLama LLM service implementation for Pipecat AI framework.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for OLLamaLLMService. */
export class OllamaLLMSettings extends OpenAILLMSettings {}

export interface OLLamaLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The base URL for the OLLama API endpoint. Defaults to `"http://localhost:11434/v1"`. */
  baseUrl?: string | null;
  /**
   * API key for an Ollama server that requires one, such as one behind an
   * authenticating proxy. A local Ollama ignores it. Defaults to `"ollama"`.
   */
  apiKey?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: OllamaLLMSettings | null;
}

/**
 * OLLama LLM service that provides local language model capabilities.
 *
 * This service extends OpenAILLMService to work with locally hosted OLLama models,
 * providing a compatible interface for running large language models locally.
 */
export class OLLamaLLMService extends OpenAILLMService {
  // OLLama doesn't support the "developer" message role (it seems to quietly
  // ignore "developer" messages).
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof OllamaLLMSettings = OllamaLLMSettings;
  declare protected _settings: OllamaLLMSettings;

  /**
   * Initialize OLLama LLM service.
   *
   * @param options.baseUrl The base URL for the OLLama API endpoint.
   *   Defaults to "http://localhost:11434/v1".
   * @param options.apiKey API key for an Ollama server that requires one, such
   *   as one behind an authenticating proxy. A local Ollama ignores it.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "llama2").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: OLLamaLLMServiceOptions = {}) {
    const cls = new.target as typeof OLLamaLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "llama2" });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "http://localhost:11434/v1",
      apiKey: options.apiKey ?? "ollama",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Ollama.
   *
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Ollama.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Ollama client with api ${options.baseUrl}`);
    return super.createClient(options);
  }
}
