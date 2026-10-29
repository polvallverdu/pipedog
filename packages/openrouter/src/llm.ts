// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openrouter/llm.py

/**
 * OpenRouter LLM service implementation.
 *
 * This module provides an OpenAI-compatible interface for interacting with
 * OpenRouter's API, extending the base OpenAI LLM service functionality.
 *
 * Porting notes:
 * - The deprecated `model` constructor option is not ported (use `settings`).
 * - `OpenRouterProviderPreferences` is a pydantic model with
 *   `extra="allow"` upstream. Here it is a class whose options take the
 *   fields in camelCase (or OpenRouter's snake_case spelling); options it
 *   doesn't know are kept as given and sent unchanged. `modelDump()` writes
 *   the request's snake_case keys.
 */

import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type OpenAIClientOptions,
  OpenAILLMSettings,
  type OpenAILLMSettingsOptions,
} from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Options for `OpenRouterProviderPreferences`. See the class for each field. */
export interface OpenRouterProviderPreferencesOptions {
  order?: string[] | null;
  allowFallbacks?: boolean | null;
  requireParameters?: boolean | null;
  dataCollection?: "allow" | "deny" | (string & {}) | null;
  zdr?: boolean | null;
  enforceDistillableText?: boolean | null;
  only?: string[] | null;
  ignore?: string[] | null;
  quantizations?: string[] | null;
  sort?: "price" | "throughput" | "latency" | (string & {}) | Record<string, unknown> | null;
  preferredMinThroughput?: number | Record<string, number> | null;
  preferredMaxLatency?: number | Record<string, number> | null;
  maxPrice?: Record<string, number> | null;
  /**
   * Routing options added by OpenRouter after this class was written, sent
   * as given. OpenRouter's snake_case spelling of the fields above is
   * accepted too.
   */
  [option: string]: unknown;
}

/** The declared fields, with their request keys. */
const PROVIDER_FIELDS = [
  ["order", "order"],
  ["allowFallbacks", "allow_fallbacks"],
  ["requireParameters", "require_parameters"],
  ["dataCollection", "data_collection"],
  ["zdr", "zdr"],
  ["enforceDistillableText", "enforce_distillable_text"],
  ["only", "only"],
  ["ignore", "ignore"],
  ["quantizations", "quantizations"],
  ["sort", "sort"],
  ["preferredMinThroughput", "preferred_min_throughput"],
  ["preferredMaxLatency", "preferred_max_latency"],
  ["maxPrice", "max_price"],
] as const;

type ProviderField = (typeof PROVIDER_FIELDS)[number][0];

/**
 * OpenRouter's preferences for which upstream provider serves a request.
 *
 * Every model on OpenRouter can be served by several providers, and by
 * default OpenRouter picks among them and falls back to another when one
 * fails. These preferences constrain that choice. See
 * https://openrouter.ai/docs/guides/routing/provider-selection for the
 * provider slugs and the full semantics.
 *
 * - `order`: Provider slugs to try, in order, before any others. Setting it
 *   turns off load balancing.
 * - `allowFallbacks`: Whether to fall back to providers outside `order`,
 *   `only` and `quantizations`. Defaults to true.
 * - `requireParameters`: Whether to route only to providers that support
 *   every parameter in the request. Defaults to false.
 * - `dataCollection`: "deny" restricts routing to providers that do not
 *   collect user data. Defaults to "allow".
 * - `zdr`: Whether to route only to zero-data-retention endpoints.
 * - `enforceDistillableText`: Whether to route only to models that allow text
 *   distillation.
 * - `only`: Provider slugs to route to, to the exclusion of all others.
 * - `ignore`: Provider slugs never to route to.
 * - `quantizations`: Quantization levels to accept, e.g. `["fp8", "bf16"]`.
 * - `sort`: Attribute to rank providers by ("price", "throughput" or
 *   "latency") or an object of the form `{ by: ..., partition: "model" |
 *   "none" }`. Setting it turns off load balancing.
 * - `preferredMinThroughput`: Throughput, in tokens per second, below which a
 *   provider is deprioritized. Either a number or percentile thresholds keyed
 *   "p50", "p75", "p90" and "p99".
 * - `preferredMaxLatency`: Latency, in seconds, above which a provider is
 *   deprioritized. Either a number or percentile thresholds keyed "p50",
 *   "p75", "p90" and "p99".
 * - `maxPrice`: Ceilings on what a request may cost, in USD: "prompt" and
 *   "completion" per million tokens, "request" per request, and "image" per
 *   image.
 */
export class OpenRouterProviderPreferences {
  // Why keep unknown options, and accept any string or object on the
  // constrained fields? OpenRouter adds routing options regularly, and one
  // that landed after this class was written should still reach the request
  // rather than be rejected or dropped here.
  order: string[] | null = null;
  allowFallbacks: boolean | null = null;
  requireParameters: boolean | null = null;
  dataCollection: "allow" | "deny" | (string & {}) | null = null;
  zdr: boolean | null = null;
  enforceDistillableText: boolean | null = null;
  only: string[] | null = null;
  ignore: string[] | null = null;
  quantizations: string[] | null = null;
  sort: "price" | "throughput" | "latency" | (string & {}) | Record<string, unknown> | null = null;
  preferredMinThroughput: number | Record<string, number> | null = null;
  preferredMaxLatency: number | Record<string, number> | null = null;
  maxPrice: Record<string, number> | null = null;
  /** Options not declared above, kept as given (pydantic's `extra="allow"`). */
  extra: Record<string, unknown> = {};

  constructor(options: OpenRouterProviderPreferencesOptions = {}) {
    const self = this as unknown as Record<ProviderField, unknown>;
    const known = new Map<string, ProviderField>();
    for (const [field, key] of PROVIDER_FIELDS) {
      known.set(field, field);
      known.set(key, field);
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue;
      const field = known.get(key);
      if (field !== undefined) {
        self[field] = value;
      } else {
        this.extra[key] = value;
      }
    }
  }

  /**
   * Validate a value as provider preferences (pydantic's `model_validate`):
   * an instance is returned as is, and a plain object is converted.
   */
  static modelValidate(
    value: OpenRouterProviderPreferences | OpenRouterProviderPreferencesOptions,
  ): OpenRouterProviderPreferences {
    if (value instanceof OpenRouterProviderPreferences) return value;
    return new OpenRouterProviderPreferences(value);
  }

  /**
   * The preferences as the request's `provider` field (pydantic's
   * `model_dump`), with OpenRouter's snake_case keys.
   *
   * @param options.excludeNone Leave out the fields whose value is null.
   */
  modelDump(options: { excludeNone?: boolean } = {}): Record<string, unknown> {
    const self = this as unknown as Record<ProviderField, unknown>;
    const result: Record<string, unknown> = {};
    for (const [field, key] of PROVIDER_FIELDS) {
      result[key] = self[field];
    }
    Object.assign(result, this.extra);
    if (options.excludeNone) {
      for (const [key, value] of Object.entries(result)) {
        if (value === null || value === undefined) delete result[key];
      }
    }
    return result;
  }
}

export interface OpenRouterLLMSettingsOptions extends OpenAILLMSettingsOptions {
  /**
   * Which upstream providers may serve the request. A plain object is
   * converted to `OpenRouterProviderPreferences`.
   */
  provider?: OpenRouterProviderPreferences | OpenRouterProviderPreferencesOptions | null | NotGiven;
}

/**
 * Settings for OpenRouterLLMService.
 *
 * - `provider`: Which upstream providers may serve the request. A plain object
 *   is converted to `OpenRouterProviderPreferences`. Left unset, or set to
 *   `null`, the request omits it and OpenRouter routes by its own default
 *   order.
 */
export class OpenRouterLLMSettings extends OpenAILLMSettings {
  provider: OpenRouterProviderPreferences | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenRouterLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
    // Coerce a plain `provider` object to OpenRouterProviderPreferences.
    const provider = this.provider as unknown;
    if (
      provider !== null &&
      typeof provider === "object" &&
      provider !== NOT_GIVEN &&
      !(provider instanceof OpenRouterProviderPreferences)
    ) {
      this.provider = new OpenRouterProviderPreferences(
        provider as OpenRouterProviderPreferencesOptions,
      );
    }
  }
}

export interface OpenRouterLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing OpenRouter's API. */
  apiKey: string;
  /** The base URL for OpenRouter API. Defaults to `"https://openrouter.ai/api/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: OpenRouterLLMSettings | null;
}

/**
 * A service for interacting with OpenRouter's API using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to OpenRouter's API
 * endpoint while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class OpenRouterLLMService extends OpenAILLMService {
  static override Settings: typeof OpenRouterLLMSettings = OpenRouterLLMSettings;
  declare protected _settings: OpenRouterLLMSettings;
  static override _requiresApiKey = true;
  static override supportsDeveloperRole = false;

  static ProviderPreferences: typeof OpenRouterProviderPreferences = OpenRouterProviderPreferences;

  /**
   * Initialize the OpenRouter LLM service.
   *
   * @param options.apiKey The API key for accessing OpenRouter's API.
   * @param options.baseUrl The base URL for OpenRouter API. Defaults to
   *   "https://openrouter.ai/api/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "openai/gpt-4.1", no provider
   *   preferences).
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: OpenRouterLLMServiceOptions) {
    const cls = new.target as typeof OpenRouterLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "openai/gpt-4.1", provider: null });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create an OpenRouter API client.
   *
   * @param options.apiKey The API key to use for authentication.
   * @param options.baseUrl The base URL for the API.
   *   Other options are passed to the parent createClient().
   * @returns The configured OpenRouter API client instance.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating OpenRouter client with api ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Put the caller's provider preferences in a request.
   *
   * `provider` is OpenRouter's own request field rather than an OpenAI one,
   * so it travels in `extra_body`, which is merged into the JSON body that is
   * sent. A `provider` already in `extra_body`, supplied through
   * `Settings.extra`, wins.
   */
  protected _applyProviderPreferences(params: Record<string, any>): void {
    const preferences = this._settings.provider;
    if (!isGiven(preferences) || preferences === null) {
      return;
    }

    const validated = OpenRouterProviderPreferences.modelValidate(preferences);
    OpenRouterLLMService._mergeExtraBody(params, {
      provider: validated.modelDump({ excludeNone: true }),
    });
  }

  /**
   * Builds chat parameters, handling model-specific constraints.
   *
   * @param paramsFromContext Parameters from the LLM context.
   * @returns Transformed parameters ready for the API call.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
    const params = super.buildChatCompletionParams(paramsFromContext);
    this._applyProviderPreferences(params);
    const model = assertGiven(this._settings.model);
    if (model !== null && model.toLowerCase().includes("gemini")) {
      const messages: Record<string, any>[] = params.messages ?? [];
      if (messages.length === 0) {
        return params;
      }
      const transformedMessages: Record<string, any>[] = [];
      let systemMessageSeen = false;
      for (const msg of messages) {
        if (msg.role === "system") {
          if (!systemMessageSeen) {
            transformedMessages.push(msg);
            systemMessageSeen = true;
          } else {
            transformedMessages.push({ ...msg, role: "user" });
          }
        } else {
          transformedMessages.push(msg);
        }
      }
      params.messages = transformedMessages;
    }

    return params;
  }
}
