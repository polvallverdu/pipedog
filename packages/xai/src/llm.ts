// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/xai/llm.py

/**
 * Grok LLM service implementation using OpenAI-compatible interface.
 *
 * This module provides a service for interacting with Grok's API through an
 * OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { logger } from "@pipedog/core/utils/logger";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type CompletionUsage,
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** xAI's `reasoning_effort` values. */
export type GrokReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface GrokLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /** How much the model thinks before answering. See `GrokLLMSettings`. */
  reasoningEffort?: GrokReasoningEffort | null | NotGiven;
}

/**
 * Settings for GrokLLMService.
 *
 * - `reasoningEffort`: How much the model thinks before answering. One of
 *   "none", "low", "medium", "high", or "xhigh"; which values a model accepts
 *   varies (`grok-4.6` rejects "none", "xhigh" needs `grok-4.6` or later, and
 *   the non-reasoning models reject the parameter altogether). When unset,
 *   xAI's per-model default applies.
 */
export class GrokLLMSettings extends OpenAILLMSettings {
  reasoningEffort: GrokReasoningEffort | null | NotGiven = NOT_GIVEN;

  constructor(options: GrokLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GrokLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Grok's API. */
  apiKey: string;
  /** The base URL for Grok API. Defaults to `"https://api.x.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: GrokLLMSettings | null;
}

/**
 * A service for interacting with Grok's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Grok's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class GrokLLMService extends OpenAILLMService {
  static override Settings: typeof GrokLLMSettings = GrokLLMSettings;
  declare protected _settings: GrokLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the GrokLLMService with API key and model.
   *
   * @param options.apiKey The API key for accessing Grok's API.
   * @param options.baseUrl The base URL for Grok API. Defaults to
   *   "https://api.x.ai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "grok-4.20-non-reasoning", no reasoning
   *   effort).
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: GrokLLMServiceOptions) {
    const cls = new.target as typeof GrokLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "grok-4.20-non-reasoning",
      reasoningEffort: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.x.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Grok API endpoint.
   *
   * @param options.apiKey The API key to use.
   * @param options.baseUrl The base URL to use.
   *   Other options are passed to the parent createClient().
   * @returns The configured client instance for Grok API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Grok client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for Grok chat completion request.
   *
   * Extends the base OpenAI parameters with Grok's reasoning effort control.
   *
   * @param paramsFromContext Parameters, derived from the LLM context, to use
   *   for the chat completion. Contains messages, tools, and tool choice.
   * @returns Dictionary of parameters for the chat completion request.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params = super.buildChatCompletionParams(paramsFromContext);

    const reasoningEffort = this._settings.reasoningEffort;
    if (isGiven(reasoningEffort) && reasoningEffort !== null && !("reasoning_effort" in params)) {
      params.reasoning_effort = reasoningEffort;
    }

    return params;
  }

  /**
   * Convert a Grok chat completion's usage into Pipecat's token usage.
   *
   * xAI reports reasoning tokens apart from `completion_tokens`, with
   * `total_tokens` covering both, so they are added to the completion count.
   * A total that already matches the prompt and completion counts means
   * reasoning was included, and the counts are kept as reported.
   *
   * @param usage The usage reported with the completion.
   * @returns The token usage to report.
   */
  protected override _tokenUsage(usage: CompletionUsage): LLMTokenUsage {
    const tokens = super._tokenUsage(usage);
    const reasoning = tokens.reasoningTokens || 0;
    if (
      reasoning &&
      tokens.totalTokens === tokens.promptTokens + tokens.completionTokens + reasoning
    ) {
      tokens.completionTokens += reasoning;
    }
    return tokens;
  }
}
