// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepseek/llm.py

/**
 * DeepSeek LLM service implementation using OpenAI-compatible interface.
 *
 * Porting notes:
 * - The deprecated `model` constructor option is not ported (use `settings`).
 * - `DeepSeekThinkingConfig` is a pydantic model upstream; here it is a small
 *   class with `modelDump()`. A plain `thinking` object passed to the
 *   settings is converted to one, as upstream's `__post_init__` does.
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import { DeepSeekLLMAdapter } from "./deepseek_adapter.ts";

export interface DeepSeekThinkingConfigOptions {
  /**
   * Thinking mode. DeepSeek's V4 models think before answering unless
   * "disabled" turns it off, which for real-time voice cuts the time to the
   * first answer token.
   */
  // `| string` keeps the field usable if DeepSeek adds further modes.
  type: "enabled" | "disabled" | (string & {});
}

/**
 * Configuration for thinking.
 *
 * - `type`: Thinking mode. DeepSeek's V4 models think before answering unless
 *   "disabled" turns it off, which for real-time voice cuts the time to the
 *   first answer token.
 */
export class DeepSeekThinkingConfig {
  type: "enabled" | "disabled" | (string & {});

  constructor(options: DeepSeekThinkingConfigOptions) {
    this.type = options.type;
  }

  /**
   * The config as the API's `thinking` request field (pydantic's
   * `model_dump`).
   *
   * @param options.excludeNone Leave out the fields whose value is null.
   */
  modelDump(options: { excludeNone?: boolean } = {}): Record<string, unknown> {
    const result: Record<string, unknown> = { type: this.type };
    if (options.excludeNone) {
      for (const [key, value] of Object.entries(result)) {
        if (value === null || value === undefined) delete result[key];
      }
    }
    return result;
  }
}

export interface DeepSeekLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /**
   * Thinking mode configuration. A plain object is converted to a
   * `DeepSeekThinkingConfig`.
   */
  thinking?: DeepSeekThinkingConfig | DeepSeekThinkingConfigOptions | null | NotGiven;
}

/**
 * Settings for DeepSeekLLMService.
 *
 * - `thinking`: Thinking mode configuration. The service defaults this to
 *   disabled: DeepSeek's V4 models otherwise run a reasoning pass before every
 *   answer, which delays the first spoken token. Set
 *   `new DeepSeekThinkingConfig({ type: "enabled" })` to turn it on, or `null`
 *   to leave the choice to DeepSeek's own default.
 */
export class DeepSeekLLMSettings extends OpenAILLMSettings {
  thinking: DeepSeekThinkingConfig | null | NotGiven = NOT_GIVEN;

  constructor(options: DeepSeekLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
    // Coerce a plain `thinking` object to a DeepSeekThinkingConfig.
    const thinking = this.thinking as unknown;
    if (
      thinking !== null &&
      typeof thinking === "object" &&
      thinking !== NOT_GIVEN &&
      !(thinking instanceof DeepSeekThinkingConfig)
    ) {
      this.thinking = new DeepSeekThinkingConfig(thinking as DeepSeekThinkingConfigOptions);
    }
  }
}

export interface DeepSeekLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing DeepSeek's API. */
  apiKey: string;
  /** The base URL for DeepSeek API. Defaults to `"https://api.deepseek.com/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: DeepSeekLLMSettings | null;
}

/**
 * A service for interacting with DeepSeek's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to DeepSeek's API endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class DeepSeekLLMService extends OpenAILLMService {
  // DeepSeek doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;
  static override supportsResponseSchema = false;

  // Supplies the `reasoning_content` DeepSeek requires on assistant messages
  // in thinking mode.
  static override adapterClass = DeepSeekLLMAdapter;

  static override Settings: typeof DeepSeekLLMSettings = DeepSeekLLMSettings;
  static ThinkingConfig: typeof DeepSeekThinkingConfig = DeepSeekThinkingConfig;
  declare protected _settings: DeepSeekLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the DeepSeek LLM service.
   *
   * @param options.apiKey The API key for accessing DeepSeek's API.
   * @param options.baseUrl The base URL for DeepSeek API. Defaults to
   *   "https://api.deepseek.com/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "deepseek-flash", thinking disabled).
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: DeepSeekLLMServiceOptions) {
    const cls = new.target as typeof DeepSeekLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "deepseek-flash",
      thinking: new DeepSeekThinkingConfig({ type: "disabled" }),
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.deepseek.com/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for DeepSeek API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for DeepSeek's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating DeepSeek client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for DeepSeek chat completion request.
   *
   * DeepSeek doesn't support some OpenAI parameters like seed and
   * max_completion_tokens.
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
      stream_options: { include_usage: true },
      frequency_penalty: this._settings.frequencyPenalty,
      presence_penalty: this._settings.presencePenalty,
      temperature: this._settings.temperature,
      top_p: this._settings.topP,
      max_tokens: this._settings.maxTokens,
    };

    // Messages, tools, tool_choice
    Object.assign(params, paramsFromContext);

    Object.assign(params, this._settings.extra);

    const thinking = assertGiven(this._settings.thinking);
    if (thinking !== null) {
      DeepSeekLLMService._mergeExtraBody(params, {
        thinking: thinking.modelDump({ excludeNone: true }),
      });
    }

    return params;
  }
}
