// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/inception/llm.py

/** Inception LLM service implementation using OpenAI-compatible interface. */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Inception's `reasoning_effort` values. */
export type InceptionReasoningEffort = "instant" | "low" | "medium" | "high";

export interface InceptionLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /** Controls how much reasoning the model applies. */
  reasoningEffort?: InceptionReasoningEffort | null | NotGiven;
  /** Reduces time to first diffusion block (TTFT). */
  realtime?: boolean | null | NotGiven;
}

/**
 * Settings for InceptionLLMService.
 *
 * - `reasoningEffort`: Controls how much reasoning the model applies. One of
 *   "instant", "low", "medium", or "high". When unset, the parameter is
 *   omitted and Inception's server-side default applies.
 * - `realtime`: When true, reduces time to first diffusion block (TTFT).
 *   Defaults to true.
 */
export class InceptionLLMSettings extends OpenAILLMSettings {
  reasoningEffort: InceptionReasoningEffort | null | NotGiven = NOT_GIVEN;
  realtime: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: InceptionLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface InceptionLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Inception's API. */
  apiKey: string;
  /** The base URL for Inception API. Defaults to `"https://api.inceptionlabs.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: InceptionLLMSettings | null;
}

/**
 * A service for interacting with Inception's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Inception's API endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality. Supports Mercury-2, Inception's diffusion-based reasoning
 * model.
 */
export class InceptionLLMService extends OpenAILLMService {
  // Inception doesn't support the "developer" message role.
  static override supportsDeveloperRole = false;

  static override Settings: typeof InceptionLLMSettings = InceptionLLMSettings;
  declare protected _settings: InceptionLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Inception LLM service.
   *
   * @param options.apiKey The API key for accessing Inception's API.
   * @param options.baseUrl The base URL for Inception API. Defaults to
   *   "https://api.inceptionlabs.ai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "mercury-2", no reasoning effort, realtime
   *   true). Other options are passed to OpenAILLMService.
   */
  constructor(options: InceptionLLMServiceOptions) {
    const cls = new.target as typeof InceptionLLMService;

    const defaultSettings = new cls.Settings({
      model: "mercury-2",
      reasoningEffort: null,
      realtime: true,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.inceptionlabs.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Inception API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Inception's API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Inception client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for Inception chat completion request.
   *
   * Extends the base OpenAI parameters with Inception-specific options such as
   * reasoning_effort and realtime.
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

    InceptionLLMService._mergeExtraBody(params, { realtime: this._settings.realtime });

    return params;
  }
}
