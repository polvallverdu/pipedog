// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/sarvam/llm.py

/**
 * Sarvam LLM service implementation using OpenAI-compatible interface.
 *
 * Porting notes:
 * - Upstream calls `self._validate_model(model)` before `super().__init__`.
 *   TypeScript can't use `this` there, so validation is a static method.
 * - `NOT_GIVEN` for the OpenAI SDK is `undefined` here (`OPENAI_NOT_GIVEN`).
 */

import {
  OPENAI_NOT_GIVEN,
  type OpenAILLMInvocationParams,
  openaiIsGiven,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  BaseOpenAILLMService,
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";
import { sdkHeaders } from "./_sdk.ts";

/** Sarvam's `reasoning_effort` values. */
export type SarvamReasoningEffort = "low" | "medium" | "high";

export interface SarvamLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /** Sarvam wiki grounding toggle. */
  wikiGrounding?: boolean | null | NotGiven;
  /** Reasoning effort level (low, medium, high). */
  reasoningEffort?: SarvamReasoningEffort | null | NotGiven;
}

/**
 * Settings for SarvamLLMService.
 *
 * - `wikiGrounding`: Sarvam wiki grounding toggle.
 * - `reasoningEffort`: Reasoning effort level (low, medium, high).
 */
export class SarvamLLMSettings extends OpenAILLMSettings {
  wikiGrounding: boolean | null | NotGiven = NOT_GIVEN;
  reasoningEffort: SarvamReasoningEffort | null | NotGiven = NOT_GIVEN;

  constructor(options: SarvamLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SarvamLLMServiceOptions extends OpenAILLMServiceOptions {
  /** Sarvam API key used for both OpenAI auth and Sarvam subscription header. */
  apiKey: string;
  /**
   * Sarvam OpenAI-compatible base URL. When null, resolved from the model:
   * `/v1` for `sarvam-105b-conversations`, `/v2` for all other models.
   */
  baseUrl?: string | null;
  /** Runtime-updatable settings. */
  settings?: SarvamLLMSettings | null;
  /** Additional HTTP headers to include in requests. */
  defaultHeaders?: Record<string, string> | null;
}

/**
 * A service for interacting with Sarvam's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to Sarvam's API endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class SarvamLLMService extends OpenAILLMService {
  // Sarvam doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static readonly _SUPPORTED_MODELS: ReadonlySet<string> = new Set([
    "deepseekv4.1-flash",
    "gemma4",
    "glm5.3",
    "sarvam-105b",
    "sarvam-105b-conversations",
  ]);
  static readonly _VISION_MODELS: ReadonlySet<string> = new Set(["gemma4"]);
  static readonly _REASONING_MODELS: ReadonlySet<string> = new Set([
    "deepseekv4.1-flash",
    "gemma4",
    "glm5.3",
    "sarvam-105b",
  ]);
  static readonly _WIKI_GROUNDING_MODELS: ReadonlySet<string> = new Set(["gemma4", "sarvam-105b"]);
  static readonly _V1_MODELS: ReadonlySet<string> = new Set(["sarvam-105b-conversations"]);
  static override Settings: typeof SarvamLLMSettings = SarvamLLMSettings;
  declare protected _settings: SarvamLLMSettings;
  static override _requiresApiKey = true;

  static readonly _DEFAULT_BASE_URL = "https://api.sarvam.ai";

  /**
   * Initialize Sarvam LLM service.
   *
   * @param options.apiKey Sarvam API key used for both OpenAI auth and Sarvam
   *   subscription header.
   * @param options.baseUrl Sarvam OpenAI-compatible base URL. When null,
   *   resolved from the model: `/v1` for `sarvam-105b-conversations`, `/v2`
   *   for all other models.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "sarvam-105b", no wiki grounding or
   *   reasoning effort).
   * @param options.defaultHeaders Additional HTTP headers to include in requests.
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: SarvamLLMServiceOptions) {
    const cls = new.target as typeof SarvamLLMService;

    // Initialize only Sarvam-specific defaults; inherited defaults are
    // provided by the OpenAI base service initialization.
    const defaultSettings = new cls.Settings({
      model: "sarvam-105b",
      wikiGrounding: null,
      reasoningEffort: null,
    });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const model = defaultSettings.model;
    if (typeof model !== "string") {
      throw new Error("Sarvam LLM requires a non-empty model string.");
    }
    cls._validateModel(model);

    let baseUrl = options.baseUrl ?? null;
    if (baseUrl === null) {
      const apiVersion = cls._V1_MODELS.has(model) ? "v1" : "v2";
      baseUrl = `${cls._DEFAULT_BASE_URL}/${apiVersion}`;
    }

    super({ ...options, baseUrl, settings: defaultSettings });
  }

  /**
   * Create OpenAI-compatible client for Sarvam API endpoint.
   *
   * Ensures Sarvam auth and SDK identification headers are always attached.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    const mergedHeaders: Record<string, string> = { ...(options.defaultHeaders ?? {}) };
    // sdkHeaders() carries the Pipedog User-Agent and should override the
    // caller-provided value.
    Object.assign(mergedHeaders, sdkHeaders());
    if (options.apiKey) {
      mergedHeaders["api-subscription-key"] = options.apiKey;
    }

    logger.debug(`Creating Sarvam client with API ${options.baseUrl}`);
    return super.createClient({ ...options, defaultHeaders: mergedHeaders });
  }

  /**
   * Process a context, pushing an error frame on misconfiguration.
   *
   * Validates tool parameters, vision support, and capability support before
   * delegating to the base class. Validation failures are pushed as non-fatal
   * error frames rather than raised, so an `LLMSwitcher` can fall back to
   * another service at runtime.
   */
  protected override async _processContext(context: LLMContext): Promise<void> {
    const error = this._validateRequest(await this._invocationParams(context));
    if (error) {
      await this.pushError(error);
      return;
    }

    await super._processContext(context);
  }

  /**
   * Run inference, pushing an error frame on misconfiguration.
   *
   * Validates tool parameters, vision support, and capability support before
   * delegating to the base class. Validation failures are pushed as non-fatal
   * error frames rather than raised, so an `LLMSwitcher` can fall back to
   * another service at runtime.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate.
   * @param options.systemInstruction Optional system instruction for this inference.
   * @param options.responseSchema Optional JSON schema the reply must follow.
   * @returns The LLM's response, or null if the request is invalid or produced
   *   no response.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    const error = this._validateRequest(
      await this._invocationParams(context, options.systemInstruction ?? null),
    );
    if (error) {
      await this.pushError(error);
      return null;
    }

    return await super.runInference(context, options);
  }

  /** Derive the invocation params the request will be built from. */
  protected async _invocationParams(
    context: LLMContext,
    systemInstruction: string | null = null,
  ): Promise<OpenAILLMInvocationParams> {
    const adapter = this.getLlmAdapter();
    return await adapter.getLlmInvocationParams(context, {
      systemInstruction: systemInstruction || assertGiven(this._settings.systemInstruction),
      convertDeveloperToUser: !this.supportsDeveloperRole,
    });
  }

  /**
   * Build parameters for Sarvam chat completion request.
   *
   * Starts from OpenAI-compatible defaults, then removes unsupported request
   * fields and applies Sarvam-specific options.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params = super.buildChatCompletionParams(paramsFromContext);
    delete params.stream_options;
    delete params.max_completion_tokens;
    delete params.service_tier;

    const cls = this.constructor as typeof SarvamLLMService;
    const model = this._settings.model as string;

    if (cls._WIKI_GROUNDING_MODELS.has(model)) {
      BaseOpenAILLMService._mergeExtraBody(params, {
        wiki_grounding: this._settings.wikiGrounding,
      });
    }

    const reasoningEffort = this._settings.reasoningEffort;
    if (cls._REASONING_MODELS.has(model) && isGiven(reasoningEffort) && reasoningEffort !== null) {
      params.reasoning_effort = reasoningEffort;
    }

    return params;
  }

  /**
   * Run all pre-request validations, returning an error message or null.
   *
   * Returns a human-readable error string when the current configuration is
   * incompatible with the selected model (e.g. image input on a non-vision
   * model, or `reasoning_effort` on a model that doesn't support it). Returns
   * null when the request is valid.
   */
  protected _validateRequest(paramsFromContext: OpenAILLMInvocationParams): string | null {
    const error = this._checkToolParameters(paramsFromContext);
    if (error) {
      return error;
    }

    const visionError = this._checkVisionSupport(paramsFromContext);
    if (visionError) {
      return visionError;
    }

    return this._checkCapabilitySupport();
  }

  static _validateModel(model: string): void {
    if (!SarvamLLMService._SUPPORTED_MODELS.has(model)) {
      const allowed = [...SarvamLLMService._SUPPORTED_MODELS].sort().join(", ");
      throw new Error(`Unsupported Sarvam LLM model '${model}'. Allowed values: ${allowed}.`);
    }
  }

  protected _checkToolParameters(paramsFromContext: OpenAILLMInvocationParams): string | null {
    const tools = paramsFromContext.tools ?? OPENAI_NOT_GIVEN;
    const toolChoice = paramsFromContext.tool_choice ?? OPENAI_NOT_GIVEN;

    const hasTools =
      openaiIsGiven(tools) && tools !== null && (!Array.isArray(tools) || tools.length > 0);
    const hasToolChoice = openaiIsGiven(toolChoice) && toolChoice !== null;

    if (hasToolChoice && !hasTools) {
      return "Sarvam requires non-empty `tools` when `tool_choice` is provided.";
    }
    return null;
  }

  protected _checkVisionSupport(paramsFromContext: OpenAILLMInvocationParams): string | null {
    const cls = this.constructor as typeof SarvamLLMService;
    const model = this._settings.model as string;
    if (cls._VISION_MODELS.has(model)) {
      return null;
    }

    const messages = (paramsFromContext.messages ?? []) as unknown[];
    for (const message of messages) {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        continue;
      }
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            !Array.isArray(part) &&
            (part as Record<string, unknown>).type === "image_url"
          ) {
            return `Model '${model}' does not support image input. Use a vision-capable model instead.`;
          }
        }
      }
    }
    return null;
  }

  /**
   * Check whether configured capabilities are supported by the current model.
   *
   * Returns an error message when `reasoningEffort` or `wikiGrounding` is
   * configured for a model that doesn't support it, so the user gets a clear
   * error instead of the setting being silently dropped.
   */
  protected _checkCapabilitySupport(): string | null {
    const cls = this.constructor as typeof SarvamLLMService;
    const model = this._settings.model as string;

    if (
      isGiven(this._settings.reasoningEffort) &&
      this._settings.reasoningEffort !== null &&
      !cls._REASONING_MODELS.has(model)
    ) {
      return `Model '${model}' does not support reasoning_effort. Use a reasoning-capable model instead.`;
    }

    if (
      isGiven(this._settings.wikiGrounding) &&
      this._settings.wikiGrounding !== null &&
      !cls._WIKI_GROUNDING_MODELS.has(model)
    ) {
      return `Model '${model}' does not support wiki_grounding. Use a model that supports it instead.`;
    }

    return null;
  }
}
