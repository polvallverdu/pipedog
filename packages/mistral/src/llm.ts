// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/mistral/llm.py

/**
 * Mistral LLM service implementation using OpenAI-compatible interface.
 *
 * Porting note: the deprecated `model` constructor option is not ported (use
 * `settings`).
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import type { FunctionCallFromLLM } from "@pipedog/core/frames/frames";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import { MistralLLMAdapter } from "./mistral_adapter.ts";

/** Settings for MistralLLMService. */
export class MistralLLMSettings extends OpenAILLMSettings {}

export interface MistralLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing Mistral's API. */
  apiKey: string;
  /** The base URL for Mistral API. Defaults to `"https://api.mistral.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: MistralLLMSettings | null;
}

/**
 * A service for interacting with Mistral's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Mistral's API endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class MistralLLMService extends OpenAILLMService {
  // Mistral doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override adapterClass = MistralLLMAdapter;

  static override Settings: typeof MistralLLMSettings = MistralLLMSettings;
  declare protected _settings: MistralLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize the Mistral LLM service.
   *
   * @param options.apiKey The API key for accessing Mistral's API.
   * @param options.baseUrl The base URL for Mistral API. Defaults to
   *   "https://api.mistral.ai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "mistral-small-latest").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: MistralLLMServiceOptions) {
    const cls = new.target as typeof MistralLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "mistral-small-latest" });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.mistral.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for Mistral API endpoint.
   *
   * @param options.apiKey The API key for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns An OpenAI-compatible client configured for Mistral API.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating Mistral client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Execute function calls, filtering out already-completed ones.
   *
   * Mistral and OpenAI have different function call detection patterns:
   *
   * OpenAI (Stream-based detection):
   *
   * - Detects function calls only from streaming chunks as the LLM generates
   *   them
   * - Second LLM completion doesn't re-detect existing tool_calls in message
   *   history
   * - Function calls execute exactly once
   *
   * Mistral (Message-based detection):
   *
   * - Detects function calls from the complete message history on each
   *   completion
   * - Second LLM completion with the response re-detects the same tool_calls
   *   from previous messages
   * - Without filtering, function calls would execute twice
   *
   * This method prevents duplicate execution by:
   *
   * 1. Checking message history for existing tool result messages
   * 2. Filtering out function calls that already have corresponding results
   * 3. Only executing function calls that haven't been completed yet
   *
   * Note: This filtering prevents duplicate function execution, but the
   * on_function_calls_started event may still fire twice due to the detection
   * pattern difference. This is expected behavior.
   *
   * @param functionCalls The function calls to potentially execute.
   */
  override async runFunctionCalls(functionCalls: readonly FunctionCallFromLLM[]): Promise<void> {
    if (functionCalls.length === 0) {
      return;
    }

    // Filter out function calls that already have results
    const callsToExecute: FunctionCallFromLLM[] = [];

    // Get messages from the first function call's context (they should all
    // have the same context)
    const context = functionCalls[0]!.context as LLMContext;
    const messages = context.getMessages() as Record<string, any>[];

    // Get all tool_call_ids that already have results
    const executedCallIds = new Set<unknown>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        executedCallIds.add(msg.tool_call_id);
      }
    }

    // Only include function calls that haven't been executed yet
    for (const call of functionCalls) {
      if (!executedCallIds.has(call.toolCallId)) {
        callsToExecute.push(call);
      } else {
        logger.trace(
          `Skipping already-executed function call: ${call.functionName}:${call.toolCallId}`,
        );
      }
    }

    // Call parent method with filtered list
    if (callsToExecute.length > 0) {
      await super.runFunctionCalls(callsToExecute);
    }
  }

  /**
   * Build parameters for Mistral chat completion request.
   *
   * Handles Mistral-specific parameter mapping (`random_seed` in place of
   * `seed`). Message-shape fixups required by Mistral are applied by
   * `MistralLLMAdapter` upstream.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params: Record<string, any> = {
      model: this._settings.model,
      stream: true,
      messages: paramsFromContext.messages,
      tools: paramsFromContext.tools,
      tool_choice: paramsFromContext.tool_choice,
      frequency_penalty: this._settings.frequencyPenalty,
      presence_penalty: this._settings.presencePenalty,
      temperature: this._settings.temperature,
      top_p: this._settings.topP,
      max_tokens: this._settings.maxTokens,
    };

    // Handle Mistral-specific parameter mapping
    // Mistral uses "random_seed" instead of "seed"
    const seed = this._settings.seed;
    if (typeof seed === "number" && Number.isInteger(seed)) {
      params.random_seed = seed;
    }

    // Add any extra parameters
    Object.assign(params, this._settings.extra);

    return params;
  }
}
