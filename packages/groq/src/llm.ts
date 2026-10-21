// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/groq/llm.py

/**
 * Groq LLM Service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Groq's `reasoning_effort` values. */
export type GroqReasoningEffort = "none" | "default" | "low" | "medium" | "high";

export interface GroqLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /** How much the model thinks before answering. See `GroqLLMSettings`. */
  reasoningEffort?: GroqReasoningEffort | null | NotGiven;
}

/**
 * Settings for GroqLLMService.
 *
 * - `reasoningEffort`: How much the model thinks before answering. Which
 *   values a model accepts varies: "low", "medium" and "high" on the GPT-OSS
 *   models and `qwen/qwen3.8-27b`, "none" and "default" on the Qwen models, and
 *   the non-reasoning models reject the parameter altogether. "none" also
 *   keeps a Qwen model's reasoning out of the spoken response, which Groq
 *   otherwise streams inline in `<think>` tags. When unset, Groq's per-model
 *   default applies.
 */
export class GroqLLMSettings extends OpenAILLMSettings {
  reasoningEffort: GroqReasoningEffort | null | NotGiven = NOT_GIVEN;

  constructor(options: GroqLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GroqLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Groq's API. */
  apiKey: string;
  /** The base URL for Groq API. Defaults to `"https://api.groq.com/openai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: GroqLLMSettings | null;
}

/**
 * A service for interacting with Groq's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Groq's API endpoint while
 * maintaining full compatibility with OpenAI's interface and functionality.
 */
export class GroqLLMService extends OpenAILLMService {
  static override Settings: typeof GroqLLMSettings = GroqLLMSettings;
  declare protected _settings: GroqLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize Groq LLM service.
   *
   * @param options.apiKey The API key for accessing Groq's API.
   * @param options.baseUrl The base URL for Groq API. Defaults to
   *   "https://api.groq.com/openai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "openai/gpt-oss-120b", no reasoning effort).
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: GroqLLMServiceOptions) {
    const cls = new.target as typeof GroqLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "openai/gpt-oss-120b",
      reasoningEffort: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.groq.com/openai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Groq API endpoint.
   *
   * @param options.apiKey API key for authentication.
   * @param options.baseUrl Base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Groq's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Groq client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for Groq chat completion request.
   *
   * Extends the base OpenAI parameters with Groq's reasoning effort control.
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
    if (isGiven(reasoningEffort) && reasoningEffort !== null) {
      params.reasoning_effort = reasoningEffort;
    }

    return params;
  }
}
