// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/together/llm.py

/**
 * Together.ai LLM service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

export interface TogetherLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /** Together's reasoning toggle. See `TogetherLLMSettings`. */
  reasoning?: Record<string, unknown> | null | NotGiven;
}

/**
 * Settings for TogetherLLMService.
 *
 * - `reasoning`: Together's reasoning toggle, for the models that support one,
 *   e.g. `{ enabled: false }`. A reasoning model such as GLM runs a reasoning
 *   pass before every answer, which delays the first spoken token. `null`
 *   leaves the choice to the model's own default.
 */
export class TogetherLLMSettings extends OpenAILLMSettings {
  reasoning: Record<string, unknown> | null | NotGiven = NOT_GIVEN;

  constructor(options: TogetherLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface TogetherLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Together.ai's API. */
  apiKey: string;
  /** The base URL for Together.ai API. Defaults to `"https://api.together.xyz/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: TogetherLLMSettings | null;
}

/**
 * A service for interacting with Together.ai's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Together.ai's API
 * endpoint while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class TogetherLLMService extends OpenAILLMService {
  // Together.ai doesn't support the "developer" message role (it seems to
  // quietly ignore "developer" messages).
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof TogetherLLMSettings = TogetherLLMSettings;
  declare protected _settings: TogetherLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize Together.ai LLM service.
   *
   * @param options.apiKey The API key for accessing Together.ai's API.
   * @param options.baseUrl The base URL for Together.ai API. Defaults to
   *   "https://api.together.xyz/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "zai-org/GLM-5.2", no reasoning toggle).
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: TogetherLLMServiceOptions) {
    const cls = new.target as typeof TogetherLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "zai-org/GLM-5.2", reasoning: null });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.together.xyz/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Together.ai API endpoint.
   *
   * @param options.apiKey The API key to use for the client.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Together.ai's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Together.ai client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for a Together.ai chat completion request.
   *
   * @param paramsFromContext Parameters, derived from the LLM context, to use
   *   for the chat completion. Contains messages, tools, and tool choice.
   * @returns Dictionary of parameters for the chat completion request.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params = super.buildChatCompletionParams(paramsFromContext);

    TogetherLLMService._mergeExtraBody(params, { reasoning: this._settings.reasoning });

    return params;
  }
}
