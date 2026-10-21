// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/anthropic/llm.py

/**
 * Anthropic AI service integration for Pipecat.
 *
 * This module provides LLM services and context management for Anthropic's Claude models,
 * including support for function calling, vision, and prompt caching features.
 *
 * Porting notes:
 * - The client is the official `@anthropic-ai/sdk` (fetch-based, runs on every
 *   runtime). Any object with the same `beta.messages.create()` shape can be
 *   passed as `client` (e.g. `AnthropicBedrock` or `AnthropicVertex`).
 * - The Python SDK's `NOT_GIVEN` sentinel has no JS counterpart (the JS SDK
 *   omits `undefined` fields). Here the sampling settings (`temperature`,
 *   `topK`, `topP`) and `thinking` store `null` for "not sent to the API".
 *   DIVERGENCE: an explicit `null` sampling value is omitted from the request,
 *   where upstream would send it as JSON `null`.
 * - The JS SDK has no `extra_body` request option; the request params keep
 *   upstream's `extra_body` entry and it is merged into the request JSON when
 *   the request is sent, which is what the Python SDK does with it.
 * - The JS SDK has no `RequestTooLargeError`; a 413 is recognized by status.
 *   `APIStatusError` is an `APIError` that carries a status.
 * - Deprecated upstream APIs are not ported: `AnthropicLLMService.InputParams`
 *   and the `model` / `params` constructor arguments.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  abortable,
  CancelledError,
  currentSignal,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/base_llm_adapter";
import {
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMEnablePromptCachingFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import {
  LLMSettings,
  type LLMSettingsOptions,
  type ServiceSettings,
} from "@pipedog/core/services/settings";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  type AnthropicCacheTTL,
  AnthropicLLMAdapter,
  type AnthropicLLMInvocationParams,
  anthropicIsGiven,
} from "./anthropic_adapter.ts";

/** `str(e)` for an exception, as upstream's f-strings print it. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The lowest thinking setting Anthropic documents for each model, sent when the
 * caller configures neither `thinking` nor `effort`, keyed by model name.
 * Each entry is the request fields to send: `thinking`, or `output_config`
 * with an effort on models whose thinking can't be turned off. "between_tools"
 * is Sonnet 5.5's lowest setting, and "disabled" is already the default on the
 * Claude 4 models.
 */
export const _THINKING_DEFAULTS: Readonly<Record<string, Record<string, Record<string, unknown>>>> =
  {
    "claude-fable-5-1": { output_config: { effort: "low" } },
    "claude-fable-5": { output_config: { effort: "low" } },
    "claude-opus-5-5": { output_config: { effort: "low" } },
    "claude-opus-5": { thinking: { type: "disabled" } },
    "claude-sonnet-5-5": { thinking: { type: "between_tools" } },
    "claude-sonnet-5": { thinking: { type: "disabled" } },
    "claude-haiku-5-5": { thinking: { type: "disabled" } },
    "claude-opus-4-8": { thinking: { type: "disabled" } },
    "claude-opus-4-7": { thinking: { type: "disabled" } },
    "claude-opus-4-6": { thinking: { type: "disabled" } },
    "claude-sonnet-4-6": { thinking: { type: "disabled" } },
    "claude-opus-4-5": { thinking: { type: "disabled" } },
    "claude-sonnet-4-5": { thinking: { type: "disabled" } },
    "claude-haiku-4-5": { thinking: { type: "disabled" } },
  };

/**
 * The name a model id refers to, the key it's looked up by in `_THINKING_DEFAULTS`.
 *
 * Bedrock and Vertex ids wrap the name, and a dated snapshot gets its model's
 * entry: `us.anthropic.claude-sonnet-5-20260630-v1:0`,
 * `claude-sonnet-5@20260630` and `claude-sonnet-5-20260630` all name
 * `claude-sonnet-5`.
 */
export function _modelName(model: string): string {
  const lower = model.toLowerCase();
  let name = lower.slice(lower.lastIndexOf(".") + 1);
  const at = name.indexOf("@");
  if (at !== -1) name = name.slice(0, at);
  name = name.replace(/-v\d+:\d+$/, "");
  return name.replace(/-\d{8}$/, "");
}

/**
 * Carry the sampling settings into a request through `extra_body`.
 *
 * `temperature`, `top_k` and `top_p` are not parameters of the Messages
 * API methods, since current models don't use them. Older models still honor
 * them, and `extra_body` is merged into the request JSON as-is.
 *
 * @param params Request parameters, updated in place.
 * @param settings Settings to read the sampling values from. Values left unset
 *   are omitted from the request.
 */
export function _applySamplingSettings(
  params: Record<string, unknown>,
  settings: AnthropicLLMSettings,
): void {
  const sampling: Record<string, unknown> = {};
  for (const [name, value] of [
    ["temperature", settings.temperature],
    ["top_k", settings.topK],
    ["top_p", settings.topP],
  ] as const) {
    // `null` stands in for the Anthropic SDK's NOT_GIVEN (see porting notes).
    if (isGiven(value) && value !== null) {
      sampling[name] = value;
    }
  }
  // An extra_body supplied through Settings.extra wins key by key, matching
  // how extra overrides every other request parameter.
  const extraBody = {
    ...sampling,
    ...((params.extra_body as Record<string, unknown> | undefined) ?? {}),
  };
  if (Object.keys(extraBody).length > 0) {
    params.extra_body = extraBody;
  }
}

/** Options for `AnthropicThinkingConfig`. */
export interface AnthropicThinkingConfigOptions {
  /**
   * Thinking mode. "adaptive" lets the model decide when and how deeply to
   * think; prefer it. "enabled" is legacy manual thinking, sized by
   * `budgetTokens`: Claude 4.7 and later reject it, and Claude 4.5 and
   * earlier accept only it. "disabled" turns thinking off on the models that
   * allow it. "between_tools" is how Claude Sonnet 5.5, which rejects
   * "disabled", runs without up-front thinking; no other model accepts it.
   */
  // Why `| string` here? To not break compatibility in case Anthropic adds
  // more types in the future.
  type: "adaptive" | "enabled" | "disabled" | "between_tools" | (string & {});
  /**
   * Maximum number of tokens for thinking. With today's models, the minimum
   * is 1024. Required when type is "enabled", not allowed otherwise.
   */
  // No client-side validation on budget_tokens — we let the server
  // enforce the rules so we stay forward-compatible if they change.
  budgetTokens?: number | null;
  /**
   * How thinking text comes back: "summarized" for readable thinking, which
   * is what `LLMThoughtTextFrame` carries, or "omitted" for thinking blocks
   * whose text is empty. Claude 4.7 and later default to "omitted", so set
   * "summarized" there to keep those frames carrying text. Not allowed when
   * type is "disabled".
   */
  display?: "summarized" | "omitted" | (string & {}) | null;
}

/**
 * Configuration for thinking.
 *
 * - `type`: thinking mode (see `AnthropicThinkingConfigOptions.type`).
 * - `budgetTokens`: maximum number of tokens for thinking.
 * - `display`: how thinking text comes back.
 */
export class AnthropicThinkingConfig {
  type: string;
  budgetTokens: number | null;
  display: string | null;
  // Fields passed explicitly, for `modelDump({ excludeUnset: true })`.
  readonly #setFields: Set<string>;

  constructor(options: AnthropicThinkingConfigOptions) {
    this.type = options.type;
    this.budgetTokens = options.budgetTokens ?? null;
    this.display = options.display ?? null;
    this.#setFields = new Set(
      (["type", "budgetTokens", "display"] as const).filter((k) => options[k] !== undefined),
    );
  }

  /**
   * The config as the API's `thinking` request field (pydantic's `model_dump`).
   *
   * @param options.excludeUnset Leave out the fields that were not passed.
   */
  modelDump(options: { excludeUnset?: boolean } = {}): Record<string, unknown> {
    const fields: [keyof AnthropicThinkingConfigOptions, string, unknown][] = [
      ["type", "type", this.type],
      ["budgetTokens", "budget_tokens", this.budgetTokens],
      ["display", "display", this.display],
    ];
    const result: Record<string, unknown> = {};
    for (const [field, key, value] of fields) {
      if (options.excludeUnset && !this.#setFields.has(field)) continue;
      result[key] = value;
    }
    return result;
  }

  /** Build a config from a plain dict with the API's snake_case keys or camelCase keys. */
  static fromDict(dict: Record<string, unknown>): AnthropicThinkingConfig {
    const options: Record<string, unknown> = { type: dict.type };
    if ("budget_tokens" in dict) options.budgetTokens = dict.budget_tokens;
    if ("budgetTokens" in dict) options.budgetTokens = dict.budgetTokens;
    if ("display" in dict) options.display = dict.display;
    return new AnthropicThinkingConfig(options as unknown as AnthropicThinkingConfigOptions);
  }
}

/** Options for `AnthropicLLMSettings`. */
export interface AnthropicLLMSettingsOptions extends LLMSettingsOptions {
  /** Whether to enable prompt caching. */
  enablePromptCaching?: boolean | NotGiven;
  /**
   * Lifetime of the system prompt's cache entry when prompt caching is
   * enabled: "5m" or "1h". `null` uses Anthropic's default of 5 minutes.
   * "1h" keeps a system prompt shared by many conversations cached across
   * gaps between them, at twice the base input price per cache write
   * instead of 1.25 times. Anthropic caches nothing when the tools and
   * system prompt together fall below the model's minimum cacheable prompt
   * length.
   */
  systemPromptCacheTtl?: AnthropicCacheTTL | null | NotGiven;
  /**
   * Thinking configuration. If neither this nor `effort` is set, Pipecat
   * sends the lowest thinking setting Anthropic documents for the model, for
   * the fastest responses, and logs what it sent. Models Pipecat doesn't
   * list, and any model when `useProviderThinkingDefault` is set, run at
   * Anthropic's default.
   */
  thinking?: AnthropicThinkingConfig | null | NotGiven;
  /**
   * How much the model spends on its response, thinking included: "low",
   * "medium", "high", "xhigh" or "max". Sent as `output_config.effort`.
   * `null` uses the model's default. Lower effort is Anthropic's recommended
   * way to reduce thinking, and the only one on models whose thinking can't
   * be turned off.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | (string & {}) | null | NotGiven;
}

/**
 * Settings for AnthropicLLMService.
 *
 * - `enablePromptCaching`: whether to enable prompt caching.
 * - `systemPromptCacheTtl`: lifetime of the system prompt's cache entry when
 *   prompt caching is enabled.
 * - `thinking`: thinking configuration.
 * - `effort`: how much the model spends on its response, thinking included.
 *
 * See `AnthropicLLMSettingsOptions` for details.
 */
export class AnthropicLLMSettings extends LLMSettings {
  enablePromptCaching: boolean | NotGiven = NOT_GIVEN;
  systemPromptCacheTtl: AnthropicCacheTTL | null | NotGiven = NOT_GIVEN;
  thinking: AnthropicThinkingConfig | null | NotGiven = NOT_GIVEN;
  effort: string | null | NotGiven = NOT_GIVEN;

  constructor(options: AnthropicLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /**
   * Convert a plain dict to settings, coercing thinking dicts.
   *
   * For backward compatibility, a `thinking` value that is a plain dict is
   * converted to an `AnthropicThinkingConfig`.
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    // biome-ignore lint/complexity/noThisInStatic: classmethod semantics.
    const instance = LLMSettings.fromMapping.call(this, settings) as T & {
      thinking: unknown;
    };
    const thinking = instance.thinking;
    if (
      isGiven(thinking) &&
      thinking !== null &&
      typeof thinking === "object" &&
      !(thinking instanceof AnthropicThinkingConfig)
    ) {
      instance.thinking = AnthropicThinkingConfig.fromDict(thinking as Record<string, unknown>);
    }
    return instance;
  }
}

/** Options for `AnthropicLLMService`. */
export interface AnthropicLLMServiceOptions extends LLMServiceOptions {
  /** Anthropic API key for authentication. */
  apiKey: string;
  /**
   * Runtime-updatable settings for this service. Values given here override
   * the service defaults.
   */
  settings?: AnthropicLLMSettings | null;
  /** Optional custom Anthropic client instance. */
  client?: AnthropicClient | null;
  /** Request timeout in seconds for retry logic. Defaults to 5.0. */
  retryTimeoutSecs?: number | null;
  /** Whether to retry the request once if it times out. Defaults to false. */
  retryOnTimeout?: boolean | null;
}

/**
 * The part of the Anthropic client this service uses. `Anthropic`,
 * `AnthropicBedrock` and `AnthropicVertex` all satisfy it.
 */
export interface AnthropicClient {
  beta: {
    messages: {
      create(params: any, options?: { signal?: AbortSignal }): PromiseLike<any>;
    };
  };
}

/** The Anthropic API method `_createMessageStream` calls. */
export type AnthropicApiCall = (
  params: Record<string, unknown>,
  options: { signal: AbortSignal },
) => PromiseLike<any>;

/**
 * LLM service for Anthropic's Claude models.
 *
 * Provides inference capabilities with Claude models including support for
 * function calling, vision processing, streaming responses, and prompt caching.
 * Can use custom clients like AnthropicBedrock and AnthropicVertex.
 */
export class AnthropicLLMService extends LLMService<AnthropicLLMAdapter> {
  static Settings = AnthropicLLMSettings;
  declare protected _settings: AnthropicLLMSettings;

  // Overriding the default adapter to use the Anthropic one.
  static override adapterClass = AnthropicLLMAdapter;

  static override supportsResponseSchema = true;

  // Backward compatibility: ThinkingConfig used to be defined inline here.
  static ThinkingConfig = AnthropicThinkingConfig;

  /**
   * Models known to support assistant message prefilling (a request whose
   * message list ends with an assistant message). Anthropic dropped prefill
   * support starting with the 4.6-generation models, so this is a frozen
   * legacy set: any model NOT matching is assumed to reject prefill and gets
   * a trailing user message injected when needed.
   */
  static _PREFILL_SUPPORTED_PATTERNS: readonly string[] = [
    "claude-2",
    "claude-instant",
    "claude-3",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ];

  protected _client: AnthropicClient;
  protected _retryTimeoutSecs: number | null;
  protected _retryOnTimeout: boolean | null;

  static {
    // `@traced_llm` on `_process_context`.
    AnthropicLLMService.prototype._processContext = tracedLlm(
      AnthropicLLMService.prototype._processContext,
    );
  }

  /**
   * Initialize the Anthropic LLM service.
   *
   * @param options.apiKey Anthropic API key for authentication.
   * @param options.settings Runtime-updatable settings for this service.
   * @param options.client Optional custom Anthropic client instance.
   * @param options.retryTimeoutSecs Request timeout in seconds for retry logic.
   * @param options.retryOnTimeout Whether to retry the request once if it times out.
   */
  constructor(options: AnthropicLLMServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new AnthropicLLMSettings({
      model: "claude-sonnet-4-6",
      systemInstruction: null,
      maxTokens: 4096,
      enablePromptCaching: false,
      systemPromptCacheTtl: null,
      temperature: null,
      topK: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      thinking: null,
      effort: null,
      extra: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== null && options.settings !== undefined) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    // if the client is provided, use it, otherwise create a new one
    this._client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this._retryTimeoutSecs =
      options.retryTimeoutSecs === undefined ? 5.0 : options.retryTimeoutSecs;
    this._retryOnTimeout = options.retryOnTimeout ?? false;
    if (this._settings.systemInstruction) {
      logger.debug(`${this}: Using system instruction: ${this._settings.systemInstruction}`);
    }
  }

  /**
   * Check if this service can generate usage metrics.
   *
   * @returns True, as Anthropic provides detailed token usage metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Send a request: drop the fields the adapter left unset (the SDK's
   * NOT_GIVEN) and merge `extra_body` into the request JSON.
   */
  #requestBody(params: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "extra_body" || !anthropicIsGiven(value)) continue;
      body[key] = value;
    }
    Object.assign(body, (params.extra_body as Record<string, unknown> | undefined) ?? {});
    return body;
  }

  /** Call the API, as a cancellation point, aborting the request if `signal` aborts. */
  async #call(
    apiCall: AnthropicApiCall,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<any> {
    return await abortable(apiCall(this.#requestBody(params), { signal }));
  }

  /**
   * Create message stream with optional timeout and retry.
   *
   * @param apiCall The Anthropic API method to call.
   * @param params Parameters for the API call.
   * @returns Async stream of message events.
   */
  protected async _createMessageStream(
    apiCall: AnthropicApiCall,
    params: Record<string, unknown>,
  ): Promise<any> {
    if (this._retryOnTimeout) {
      const attempt = new AbortController();
      try {
        const response = await waitFor(
          () => this.#call(apiCall, params, AbortSignal.any([currentSignal(), attempt.signal])),
          this._retryTimeoutSecs,
        );
        return response;
      } catch (e) {
        if (e instanceof TimeoutError || e instanceof Anthropic.APIConnectionTimeoutError) {
          // Stop the request that timed out.
          attempt.abort();
          // Retry, this time without a timeout so we get a response
          logger.debug(`${this}: Retrying message creation due to timeout`);
          const response = await this.#call(apiCall, params, currentSignal());
          return response;
        }
        throw e;
      }
    } else {
      const response = await this.#call(apiCall, params, currentSignal());
      return response;
    }
  }

  /**
   * Build `output_config` from the effort setting and a response schema.
   *
   * @param responseSchema JSON schema the reply must follow, if any.
   * @returns The `output_config` request field, empty when there is nothing to send.
   */
  protected _outputConfig(
    responseSchema: Record<string, unknown> | null = null,
  ): Record<string, unknown> {
    const outputConfig: Record<string, unknown> = {};
    const effort = assertGiven(this._settings.effort);
    if (effort) {
      outputConfig.effort = effort;
    }
    if (responseSchema !== null) {
      outputConfig.format = { type: "json_schema", schema: responseSchema };
    }
    return outputConfig;
  }

  /**
   * Send the model's lowest thinking setting when no reasoning is configured.
   *
   * Applies the model's entry in `_THINKING_DEFAULTS`, if it has one. A
   * request that already sets `thinking` or an effort, from the settings or
   * from `extra`, is left as it is, since the two together decide how much
   * the model thinks. So is every request when `useProviderThinkingDefault`
   * is set. The first request for each model logs the setting sent, or that
   * the model runs at Anthropic's default, warning for an unlisted Claude
   * model.
   *
   * @param params The request params dict (modified in place).
   */
  protected _maybeApplyThinkingDefault(params: Record<string, unknown>): void {
    const outputConfig = (params.output_config as Record<string, unknown> | undefined) ?? {};
    if ("thinking" in params || "effort" in outputConfig) {
      return;
    }
    const model = assertGiven(this._settings.model) || "";
    const name = _modelName(model);
    this._applyThinkingDefault(
      params,
      model,
      Object.hasOwn(_THINKING_DEFAULTS, name) ? _THINKING_DEFAULTS[name]! : null,
      {
        canThink: name.startsWith("claude-"),
        provider: "Anthropic",
        settingsFields: "`thinking` or `effort`",
      },
    );
  }

  /**
   * Whether a model can enforce a response schema.
   *
   * Structured outputs arrived with the 4.5 models. A model id without a
   * version, such as a preview, is assumed to support them.
   *
   * @param model The model name.
   */
  static override modelSupportsResponseSchema(model: string): boolean {
    const match = /claude(?:-[a-z]+)?-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
    if (!match) {
      return true;
    }
    const major = Number.parseInt(match[1]!, 10);
    const minor = Number.parseInt(match[2] ?? "0", 10);
    return major > 4 || (major === 4 && minor >= 5);
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the given LLM context.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate. If
   *   provided, overrides the service's default max_tokens setting.
   * @param options.systemInstruction Optional system instruction to use for
   *   this inference. If provided, overrides any system instruction in the context.
   * @param options.responseSchema Optional JSON schema the reply must follow.
   *   The service asks the provider to enforce it, so the reply is JSON text
   *   matching the schema.
   * @returns The LLM's response as a string, or null if no response is generated.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    const maxTokens = options.maxTokens ?? null;
    const effectiveInstruction =
      options.systemInstruction || assertGiven(this._settings.systemInstruction);
    const adapter = this.getLlmAdapter();
    const invocationParams = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: assertGiven(this._settings.enablePromptCaching),
      systemInstruction: effectiveInstruction,
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
      systemPromptCacheTtl: assertGiven(this._settings.systemPromptCacheTtl),
    });
    const messages = invocationParams.messages;
    const system = invocationParams.system;
    const tools = invocationParams.tools;

    // Build params using the same method as streaming completions
    const params: Record<string, unknown> = {
      model: this._settings.model,
      max_tokens: maxTokens !== null ? maxTokens : this._settings.maxTokens,
      stream: false,
      messages,
      system,
      tools,
      betas: ["interleaved-thinking-2025-05-14"],
    };
    const thinking = assertGiven(this._settings.thinking);
    if (thinking) {
      params.thinking = thinking.modelDump({ excludeUnset: true });
    }
    const outputConfig = this._outputConfig(this._checkResponseSchema(options.responseSchema));
    if (Object.keys(outputConfig).length > 0) {
      params.output_config = outputConfig;
    }

    Object.assign(params, this._settings.extra);
    _applySamplingSettings(params, this._settings);

    // Applied last, so an explicit thinking or effort setting, from the
    // settings or from extra, wins over the low-latency default.
    this._maybeApplyThinkingDefault(params);

    // LLM completion
    const response = await this.#call(
      (p, o) => this._client.beta.messages.create(p, o),
      params,
      currentSignal(),
    );
    this._handleStopReason(response);

    for (const block of (response.content ?? []) as Record<string, unknown>[]) {
      if (block !== null && typeof block === "object" && "text" in block) {
        return block.text as string;
      }
    }
    return null;
  }

  /**
   * Whether to fix up requests whose message list ends with an assistant message.
   *
   * Models without assistant-prefill support reject such requests, so
   * injection is on for every model not known to support prefill.
   * Subclasses with exotic model naming can override
   * `_PREFILL_SUPPORTED_PATTERNS`.
   */
  protected _shouldInjectTrailingUserMessage(): boolean {
    const configured = this._settings.model;
    const model = (isGiven(configured) && configured) || "";
    const patterns = (this.constructor as typeof AnthropicLLMService)._PREFILL_SUPPORTED_PATTERNS;
    return !patterns.some((p) => model.startsWith(p));
  }

  protected async _getLlmInvocationParams(
    context: LLMContext,
  ): Promise<AnthropicLLMInvocationParams> {
    const adapter = this.getLlmAdapter();
    const params = await adapter.getLlmInvocationParams(context, {
      enablePromptCaching: assertGiven(this._settings.enablePromptCaching),
      systemInstruction: assertGiven(this._settings.systemInstruction),
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
      systemPromptCacheTtl: assertGiven(this._settings.systemPromptCacheTtl),
    });
    return params;
  }

  protected async _processContext(context: LLMContext): Promise<void> {
    // Usage tracking. We track the usage reported by Anthropic in prompt_tokens and
    // completion_tokens. We also estimate the completion tokens from output text
    // and use that estimate if we are interrupted, because we almost certainly won't
    // get a complete usage report if the task we're running in is cancelled.
    let promptTokens = 0;
    let completionTokens = 0;
    let completionTokensEstimate = 0;
    let useCompletionTokensEstimate = false;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let reasoningTokens: number | null = null;

    try {
      await this.pushFrame(new LLMFullResponseStartFrame());
      await this.startProcessingMetrics();

      const paramsFromContext = await this._getLlmInvocationParams(context);

      this._logLlmResponse(context);

      await this.startTtfbMetrics();

      const params: Record<string, unknown> = {
        model: this._settings.model,
        max_tokens: this._settings.maxTokens,
        stream: true,
      };

      // Add thinking parameter if set
      const thinking = assertGiven(this._settings.thinking);
      if (thinking) {
        params.thinking = thinking.modelDump({ excludeUnset: true });
      }

      const outputConfig = this._outputConfig();
      if (Object.keys(outputConfig).length > 0) {
        params.output_config = outputConfig;
      }

      // Messages, system, tools
      Object.assign(params, paramsFromContext);

      Object.assign(params, this._settings.extra);
      _applySamplingSettings(params, this._settings);

      // Applied last, so an explicit thinking or effort setting, from the
      // settings or from extra, wins over the low-latency default.
      this._maybeApplyThinkingDefault(params);

      // "Interleaved thinking" needed to allow thinking between sequences
      // of function calls, when extended thinking is enabled.
      // Note that this requires us to use `client.beta`, below.
      Object.assign(params, { betas: ["interleaved-thinking-2025-05-14"] });

      const response = await this._createMessageStream(
        (p, o) => this._client.beta.messages.create(p, o),
        params,
      );

      // Function calling
      let toolUseBlock: Record<string, any> | null = null;
      let jsonAccumulator = "";

      const functionCalls: FunctionCallFromLLM[] = [];
      const iterator = (response as AsyncIterable<any>)[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(iterator.next());
        if (next.done) break;
        const event = next.value;
        // Aggregate streaming content, create frames, trigger events

        // The events that open the stream (message_start, ping) carry no
        // model output, so TTFB ends at the first content block.
        if (event.type === "content_block_start" || event.type === "content_block_delta") {
          await this.stopTtfbMetrics();
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if ("text" in delta) {
            await this._pushLlmText(delta.text);
            completionTokensEstimate += this._estimateTokens(delta.text);
          } else if ("partial_json" in delta && toolUseBlock) {
            jsonAccumulator += delta.partial_json;
            completionTokensEstimate += this._estimateTokens(delta.partial_json);
          } else if ("thinking" in delta) {
            await this.pushFrame(new LLMThoughtTextFrame({ text: delta.thinking }));
          } else if ("signature" in delta) {
            await this.pushFrame(new LLMThoughtEndFrame({ signature: delta.signature }));
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            // A turn that only calls tools produces no answer text, so
            // the call itself is what the caller gets and TTFAT ends
            // here rather than going unmeasured.
            await this.stopTtfatMetrics();
            toolUseBlock = event.content_block;
            jsonAccumulator = "";
          } else if (event.content_block.type === "thinking") {
            await this.pushFrame(
              new LLMThoughtStartFrame({
                appendToContext: true,
                llm: this.getLlmAdapter().idForLlmSpecificMessages,
              }),
            );
          }
        } else if (
          event.type === "message_delta" &&
          "stop_reason" in event.delta &&
          event.delta.stop_reason === "tool_use"
        ) {
          if (toolUseBlock) {
            const args = jsonAccumulator
              ? (pyJsonLoads(jsonAccumulator) as Record<string, unknown>)
              : {};
            functionCalls.push(
              new FunctionCallFromLLM({
                context,
                toolCallId: toolUseBlock.id,
                functionName: toolUseBlock.name,
                arguments: args,
              }),
            );
          }
        }

        if (event.type === "message_delta") {
          this._handleStopReason(event.delta);
        }

        // Usage counts are cumulative: message_start reports them so far
        // and message_delta for the whole message, so each replaces the
        // last. A field a message_delta leaves out keeps its earlier value.
        let usage: Record<string, any> | null = null;
        if (event.type === "message_start") {
          usage = event.message.usage ?? null;
        } else if (event.type === "message_delta") {
          usage = event.usage ?? null;
        }
        if (usage !== null) {
          if (usage.input_tokens != null) {
            promptTokens = usage.input_tokens;
          }
          if (usage.output_tokens != null) {
            completionTokens = usage.output_tokens;
          }
          if (usage.cache_creation_input_tokens != null) {
            cacheCreationInputTokens = usage.cache_creation_input_tokens;
          }
          if (usage.cache_read_input_tokens != null) {
            cacheReadInputTokens = usage.cache_read_input_tokens;
          }
          // Thinking tokens are part of output_tokens.
          if (usage.output_tokens_details) {
            reasoningTokens = usage.output_tokens_details.thinking_tokens ?? null;
          }
        }
      }

      await this.runFunctionCalls(functionCalls);
    } catch (e) {
      if (e instanceof CancelledError) {
        // If we're interrupted, we won't get a complete usage report. So set our flag to use the
        // token estimate. The reraise the exception so all the processors running in this task
        // also get cancelled.
        useCompletionTokensEstimate = true;
        throw e;
      }
      if (isTimeoutException(e)) {
        await this._callEventHandler("on_completion_timeout");
      } else if (e instanceof LLMContextConversionError) {
        await this.pushError(errorMessage(e), { exception: e });
        // A conversion failure (e.g. an unsupported file MIME type, corrupt
        // base64 data) can't reach the API at all, but is just as much
        // evidence of an invalid file as a rejection from Anthropic itself, so
        // it gets the same best-effort cleanup.
        context.removeInvalidFileMessage();
      } else if (e instanceof Anthropic.APIError && e.status !== undefined) {
        // Only the payload-shaped errors (bad request, payload too large,
        // unprocessable content) are grounds to remove a pending file
        // message on a best-effort basis. The rest of the 4xx range —
        // auth, permissions, not-found, rate limiting — says nothing
        // about whether our request (or its file) was bad, and removing
        // the file there would discard it for no benefit: the file isn't
        // what needs fixing before the next retry can succeed. When a
        // message is removed as a result of this error, the fault lay in
        // application-supplied content and the context is repaired, so the
        // error is pushed as APPLICATION instead of letting the rejection
        // classify as permanent and cost the service its usability.
        const removed =
          (e instanceof Anthropic.BadRequestError ||
            e.status === 413 ||
            e instanceof Anthropic.UnprocessableEntityError) &&
          context.removeInvalidFileMessage();
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, {
          exception: e,
          category: removed ? ErrorCategory.APPLICATION : null,
        });
      } else {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    } finally {
      await this.stopProcessingMetrics();
      await this.pushFrame(new LLMFullResponseEndFrame());
      const compTokens = !useCompletionTokensEstimate ? completionTokens : completionTokensEstimate;
      await this._reportUsageMetrics(
        promptTokens,
        compTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        !useCompletionTokensEstimate ? reasoningTokens : null,
      );
    }
  }

  /**
   * Process incoming frames and route them appropriately.
   *
   * Handles various frame types including context frames, message frames,
   * vision frames, and settings updates.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._processContext(frame.context as LLMContext);
    } else if (frame instanceof LLMEnablePromptCachingFrame) {
      logger.debug(`Setting enable prompt caching to: [${frame.enable}]`);
      this._settings.enablePromptCaching = frame.enable;
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /**
   * Log why Claude stopped generating, when it stopped for a notable reason.
   *
   * Anything other than a normal stop leaves the turn short of what the model
   * would otherwise have said: the request was refused, or the output hit the
   * token limit or the context window. Whatever text did arrive is still
   * passed on.
   *
   * @param result A streamed `message_delta`'s delta or a complete message;
   *   both carry `stop_reason` and `stop_details`.
   */
  protected _handleStopReason(result: unknown): void {
    const r = (result ?? {}) as Record<string, any>;
    const stopReason = r.stop_reason ?? null;
    if (
      stopReason === null ||
      stopReason === "end_turn" ||
      stopReason === "tool_use" ||
      stopReason === "stop_sequence"
    ) {
      return;
    }

    const category = r.stop_details?.category ?? null;
    const detail = category ? ` (${category})` : "";
    logger.warning(`${this}: response incomplete, the model stopped for ${stopReason}${detail}`);
  }

  protected _estimateTokens(text: string): number {
    return Math.trunc(text.split(/[^\p{L}\p{N}_]+/u).length * 1.3);
  }

  protected async _reportUsageMetrics(
    promptTokens: number,
    completionTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
    reasoningTokens: number | null = null,
  ): Promise<void> {
    if (promptTokens || completionTokens || cacheCreationInputTokens || cacheReadInputTokens) {
      const tokens = new LLMTokenUsage({
        promptTokens,
        completionTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        reasoningTokens,
        // Anthropic reports input_tokens net of the cache, so the cached
        // tokens are added back to keep the total comparable with services
        // whose provider supplies it already gross.
        totalTokens:
          promptTokens + cacheCreationInputTokens + cacheReadInputTokens + completionTokens,
      });
      await this.startLlmUsageMetrics(tokens);
    }
  }
}
