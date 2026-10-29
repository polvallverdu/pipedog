// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/smallest/llm.py

/**
 * Smallest AI LLM service implementation using OpenAI-compatible interface.
 *
 * This module provides an integration with Electron, Smallest AI's LLM, served
 * through the Waves API's OpenAI-compatible chat completions endpoint.
 *
 * Porting note: `X-Pipecat-Version` carries the pipedog version.
 */

import { version as pipecatVersion } from "@pipedog/core";
import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for SmallestLLMService. */
export class SmallestLLMSettings extends OpenAILLMSettings {}

export interface SmallestLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Smallest AI's API. */
  apiKey: string;
  /** The base URL for Smallest AI's API. Defaults to `"https://api.smallest.ai/waves/v1"`. */
  baseUrl?: string | null;
  /**
   * Runtime-updatable settings. Defaults to Electron, Smallest AI's LLM, via
   * `settings: new SmallestLLMService.Settings({ model: "electron" })`.
   */
  settings?: SmallestLLMSettings | null;
  /** Additional HTTP headers to include in requests. */
  defaultHeaders?: Record<string, string> | null;
}

/**
 * A service for interacting with Smallest AI's Electron model using the OpenAI-compatible interface.
 *
 * This service extends OpenAILLMService to connect to Smallest AI's Waves API
 * endpoint while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class SmallestLLMService extends OpenAILLMService {
  // Electron doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof SmallestLLMSettings = SmallestLLMSettings;
  declare protected _settings: SmallestLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize Smallest AI LLM service.
   *
   * @param options.apiKey The API key for accessing Smallest AI's API.
   * @param options.baseUrl The base URL for Smallest AI's API. Defaults to
   *   "https://api.smallest.ai/waves/v1".
   * @param options.settings Runtime-updatable settings. Defaults to Electron, Smallest
   *   AI's LLM, via `settings: new SmallestLLMService.Settings({ model: "electron" })`.
   * @param options.defaultHeaders Additional HTTP headers to include in requests.
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: SmallestLLMServiceOptions) {
    const cls = new.target as typeof SmallestLLMService;
    const defaultSettings = new cls.Settings({ model: "electron" });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.smallest.ai/waves/v1",
      settings: defaultSettings,
      defaultHeaders: options.defaultHeaders ?? null,
    });
  }

  /**
   * Create OpenAI-compatible client for Smallest AI's API endpoint.
   *
   * @param options.apiKey The API key to use for the client. If null, uses instance apiKey.
   * @param options.baseUrl The base URL for the API. If null, uses instance baseUrl.
   * @param options.defaultHeaders Additional HTTP headers. Smallest's own source and
   *   version identification headers are always included.
   *   Other options are passed to the parent createClient() method.
   * @returns An OpenAI-compatible client configured for Smallest AI's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    const mergedHeaders: Record<string, string> = { ...(options.defaultHeaders ?? {}) };
    Object.assign(mergedHeaders, {
      "X-Source": "pipecat",
      "X-Pipecat-Version": pipecatVersion(),
    });

    logger.debug(`Creating Smallest AI client with api ${options.baseUrl}`);
    return super.createClient({ ...options, defaultHeaders: mergedHeaders });
  }
}
