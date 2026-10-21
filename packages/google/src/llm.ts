// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/llm.py

/**
 * Google Gemini integration for Pipecat.
 *
 * This module provides Google Gemini integration for the Pipecat framework,
 * including LLM services, context management, and message aggregation.
 *
 * Porting notes:
 * - The client is `GoogleGenAI` from `@google/genai` (fetch based, runs on
 *   every runtime). Subclasses can override `createClient()`.
 * - Generation params are built as upstream builds them, as a dict with the
 *   Python SDK's snake_case keys (so `extra` and the thinking-default log
 *   lines carry over), and converted to the JS SDK's camelCase
 *   `GenerateContentConfig` when the request is sent (`_toGenerateContentConfig`);
 *   so are the top-level keys of each tool (`function_declarations`), which the
 *   JS SDK would otherwise drop. Other nested values the caller supplies (JSON
 *   schemas) are passed as they are.
 * - The JS SDK carries bytes as base64 strings: `inlineData.data` is decoded
 *   with `base64ToBytes` for `AssistantImageRawFrame.originalData`, and
 *   thought signatures are kept as the SDK gives them (base64 strings).
 * - Upstream decodes inline images with Pillow. Here that is the injectable
 *   `imageDecoder` option; the default is a stub that throws "not ported yet",
 *   so without one an image response surfaces as a pushed error.
 * - `google.api_core.exceptions.DeadlineExceeded` has no JS counterpart; only
 *   `TimeoutError` is treated as a completion timeout. `ClientError.status ==
 *   "INVALID_ARGUMENT"` is read from the JS SDK's `ApiError` (a 4xx whose
 *   body's `error.status` is `INVALID_ARGUMENT`).
 * - The JS client sends a streaming request when `generateContentStream()` is
 *   awaited; it is deferred to the first pull of the stream, as the Python
 *   client does it, so the first-chunk timeout covers the whole round trip.
 *   An abandoned stream is released by aborting its request.
 * - Upstream sets `GRPC_ENABLE_FORK_SUPPORT=false` and enlarges the SDK read
 *   buffer at import; neither applies to the JS SDK.
 * - Deprecated upstream APIs are not ported: `GoogleLLMService.InputParams`
 *   and the `model`, `params` and `systemInstruction` constructor options.
 */

import {
  ApiError,
  FinishReason,
  type GenerateContentConfig,
  type GenerateContentResponse,
  GoogleGenAI,
  type HttpOptions,
  type SafetySetting,
} from "@google/genai";
import {
  abortable,
  currentSignal,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import {
  type BaseLLMAdapter,
  LLMContextConversionError,
} from "@pipedog/core/adapters/base_llm_adapter";
import {
  AssistantImageRawFrame,
  type CancelFrame,
  type EndFrame,
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
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
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { LLMSearchOrigin, LLMSearchResponseFrame, LLMSearchResult } from "./frames.ts";
import { GeminiLLMAdapter, type GeminiLLMInvocationParams } from "./gemini_adapter.ts";
import { type ImageDecoder, notPortedImageDecoder } from "./image_decoder.ts";
import { updateGoogleClientHttpOptions } from "./utils.ts";

/**
 * The lowest thinking setting Google documents for each model, sent when the
 * caller doesn't configure `thinking`, keyed by model name. The 2.5 models
 * take a budget, where 0 turns thinking off and 2.5 Pro's minimum is 128;
 * later models take a level. 3.7 Flash, 3.8 Flash, 3.1 Pro and 4 Argon reject
 * "minimal", and the Flash-Lite models already default to it. Aliases such as
 * `gemini-flash-latest` are left out, since the model they name changes.
 */
const _THINKING_DEFAULTS: Record<string, Record<string, unknown>> = {
  "gemini-2.5-flash": { thinking_budget: 0 },
  "gemini-2.5-flash-lite": { thinking_budget: 0 },
  "gemini-2.5-pro": { thinking_budget: 128 },
  "gemini-3-flash-preview": { thinking_level: "minimal" },
  "gemini-3.1-flash-lite": { thinking_level: "minimal" },
  "gemini-3.1-pro-preview": { thinking_level: "low" },
  "gemini-3.1-pro-preview-customtools": { thinking_level: "low" },
  "gemini-3.5-flash": { thinking_level: "minimal" },
  "gemini-3.5-flash-lite": { thinking_level: "minimal" },
  "gemini-3.6-flash": { thinking_level: "minimal" },
  "gemini-3.7-flash": { thinking_level: "low" },
  "gemini-3.8-flash": { thinking_level: "low" },
  "gemini-4-argon": { thinking_level: "low" },
  "gemma-4-26b-a4b-it": { thinking_level: "minimal" },
  "gemma-4-31b-it": { thinking_level: "minimal" },
};

/**
 * The name a model id refers to, for looking the model up.
 *
 * `_THINKING_DEFAULTS` and `_MODELS_SUPPORTING_THINKING_LEVEL` are keyed by
 * name. Ids can name a model by resource path (`models/gemini-3.6-flash`,
 * `publishers/google/models/gemini-3.6-flash`) or by version
 * (`gemini-2.5-flash-001`).
 */
export function _modelName(model: string): string {
  const parts = model.toLowerCase().split("/");
  return (parts[parts.length - 1] as string).replace(/-\d{3}$/, "");
}

/**
 * Models that take their thinking configuration from thinking_level, keyed by
 * model name prefix. Whether one of these honors a thinking_budget set
 * alongside it varies by model and by backend, so such a budget can't be
 * relied on.
 */
const _MODELS_SUPPORTING_THINKING_LEVEL = ["gemini-3", "gemini-4", "gemma-4"] as const;

/**
 * Whether a model name belongs to a Gemini or Gemma text model that can think.
 *
 * Covers Gemini 2.5 and later, Gemma 4, and aliases such as
 * `gemini-flash-latest`. Image, speech and embedding models are excluded.
 */
export function _canThink(name: string): boolean {
  if (["image", "tts", "audio", "live", "embedding"].some((kind) => name.includes(kind))) {
    return false;
  }
  return /^(?:gemini-(2\.5|[3-9])|gemma-4|gemini-[a-z-]+-latest$)/.test(name);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function camelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [snakeToCamel(k), v]));
}

export interface GoogleThinkingConfigOptions {
  /** Token budget for thinking, for the Gemini 2.5 series. */
  thinkingBudget?: number | null;
  /** Thinking level, for Gemini 3 models. */
  thinkingLevel?: "low" | "high" | "medium" | "minimal" | (string & {}) | null;
  /** Whether to include thought summaries in the response. */
  includeThoughts?: boolean | null;
}

/**
 * Configuration for controlling the model's internal "thinking" process used
 * before generating a response.
 *
 * Gemini 2.5 and 3 series models have this thinking process. Set either
 * `thinkingLevel` or `thinkingBudget`, never both.
 *
 * - `thinkingLevel`: thinking level, for Gemini 3 models. Gemini 3 Flash
 *   accepts "minimal", "low", "medium", and "high", except Gemini 3.7 Flash
 *   and Gemini 3.8 Flash, which accept only "low", "medium", and "high".
 *   Gemini 3 Pro accepts "low" and "high". If not provided, the flash models
 *   default to "medium" and Pro defaults to "high". Note: Gemini 2.5 series
 *   must use thinkingBudget instead.
 * - `thinkingBudget`: token budget for thinking, for the Gemini 2.5 series.
 *   -1 for dynamic thinking (model decides), 0 to disable thinking, or a
 *   specific token count (e.g., 128-32768 for 2.5 Pro). If not provided, most
 *   models today default to dynamic thinking. See
 *   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking#gemini-2-5-and-earlier-models
 *   for default values and allowed ranges. Note: Gemini 3 models must use
 *   thinkingLevel instead.
 * - `includeThoughts`: whether to include thought summaries in the response.
 *   Today's models default to not including thoughts (false).
 */
export class GoogleThinkingConfig {
  thinkingBudget: number | null;
  // Why `| string` here? To not break compatibility in case Google adds more
  // levels in the future.
  thinkingLevel: "low" | "high" | "medium" | "minimal" | (string & {}) | null;
  includeThoughts: boolean | null;

  /** Fields given to the constructor (pydantic's `model_fields_set`). */
  readonly #fieldsSet: Set<string>;

  constructor(options: GoogleThinkingConfigOptions = {}) {
    // Plain dicts may use the Python snake_case keys.
    const opts = camelKeys(options as Record<string, unknown>) as GoogleThinkingConfigOptions;
    this.thinkingBudget = opts.thinkingBudget ?? null;
    this.thinkingLevel = opts.thinkingLevel ?? null;
    this.includeThoughts = opts.includeThoughts ?? null;
    this.#fieldsSet = new Set(
      Object.entries(opts)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k),
    );
  }

  /**
   * The config as a dict with the Python SDK's snake_case keys (pydantic
   * `model_dump`).
   *
   * @param options.excludeUnset Leave out the fields not given to the
   *   constructor.
   */
  modelDump(options: { excludeUnset?: boolean } = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ["thinkingBudget", "thinkingLevel", "includeThoughts"] as const) {
      if (options.excludeUnset && !this.#fieldsSet.has(key)) continue;
      out[camelToSnake(key)] = this[key];
    }
    return out;
  }
}

export interface GoogleLLMSettingsOptions extends LLMSettingsOptions {
  /** Thinking configuration. */
  thinking?: GoogleThinkingConfig | null | NotGiven;
  /** Content safety filters. */
  safetySettings?: SafetySetting[] | null | NotGiven;
}

/**
 * Settings for GoogleLLMService.
 *
 * - `thinking`: thinking configuration. If this is not provided, Pipecat
 *   sends the lowest thinking setting Google documents for the model, for the
 *   fastest responses, and logs what it sent. Models Pipecat doesn't list,
 *   and any model when `useProviderThinkingDefault` is set, run at Google's
 *   default.
 * - `safetySettings`: content safety filters, as a list of `SafetySetting`.
 *   Each entry pairs a harm category with the threshold at which content is
 *   blocked. Categories left unspecified keep the Gemini API defaults.
 */
export class GoogleLLMSettings extends LLMSettings {
  thinking: GoogleThinkingConfig | null | NotGiven = NOT_GIVEN;
  safetySettings: SafetySetting[] | null | NotGiven = NOT_GIVEN;

  constructor(options: GoogleLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /**
   * Convert a plain dict to settings, coercing thinking and safety dicts.
   *
   * For backward compatibility, a `thinking` value that is a plain dict is
   * converted to a `GoogleThinkingConfig`, and any `safety_settings` entry
   * that is a plain dict with snake_case keys gets the SDK's camelCase keys.
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    // Mapped here rather than through `ServiceSettings.fromMapping`, which
    // builds a plain `ServiceSettings` (so `thinking` would land in `extra`).
    const aliases = GoogleLLMSettings._aliases;
    const fieldNames = new Set(Object.keys(new this()));
    const kwargs: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
      // Resolve aliases first
      const canonical = aliases[key] ?? key;
      if (canonical !== "extra" && fieldNames.has(canonical)) {
        kwargs[canonical] = value;
      } else if (canonical !== "extra" && fieldNames.has(snakeToCamel(canonical))) {
        kwargs[snakeToCamel(canonical)] = value;
      } else {
        extra[key] = value;
      }
    }
    const instance = new this(kwargs) as unknown as GoogleLLMSettings;
    instance.extra = extra;
    if (isGiven(instance.thinking) && isPlainObject(instance.thinking)) {
      instance.thinking = new GoogleThinkingConfig(
        instance.thinking as unknown as GoogleThinkingConfigOptions,
      );
    }
    if (isGiven(instance.safetySettings) && instance.safetySettings) {
      instance.safetySettings = instance.safetySettings.map((entry) =>
        isPlainObject(entry) ? (camelKeys(entry) as SafetySetting) : entry,
      );
    }
    return instance as unknown as T;
  }
}

/** The part of the GenAI client this service uses. */
export interface GoogleLLMClient {
  models: Pick<GoogleGenAI["models"], "generateContent" | "generateContentStream">;
}

export interface GoogleLLMServiceOptions extends LLMServiceOptions {
  /** Google AI API key for authentication. */
  apiKey: string;
  /** Runtime-updatable settings for this service. */
  settings?: GoogleLLMSettings | null;
  /** List of available tools/functions. */
  tools?: Record<string, unknown>[] | null;
  /** Configuration for tool usage. */
  toolConfig?: Record<string, unknown> | null;
  /** HTTP options for the client. */
  httpOptions?: HttpOptions | null;
  /** Gap allowed between streamed chunks, in seconds. `null` waits forever. Default 20. */
  streamIdleTimeoutSecs?: number | null;
  /** First-chunk wait before re-issuing, in seconds. Default 5. */
  retryTimeoutSecs?: number | null;
  /** Whether to re-issue the request once on a first-chunk timeout. Default false. */
  retryOnTimeout?: boolean | null;
  /** Decodes inline images to pixels (upstream: Pillow). */
  imageDecoder?: ImageDecoder | null;
}

/**
 * Google AI (Gemini) LLM service implementation.
 *
 * This class implements inference with Google's AI models, translating
 * internally from an LLMContext to the messages format expected by the
 * Google AI model.
 */
// The adapter's invocation params are an interface, which TypeScript does not
// treat as a `Record<string, unknown>`; the intersection satisfies the bound.
export class GoogleLLMService extends LLMService<GeminiLLMAdapter & BaseLLMAdapter> {
  static Settings = GoogleLLMSettings;
  declare protected _settings: GoogleLLMSettings;

  // Overriding the default adapter to use the Gemini one.
  static override adapterClass = GeminiLLMAdapter;

  static override supportsResponseSchema = true;

  /** `GoogleThinkingConfig`, as upstream exposes it on the class. */
  static ThinkingConfig = GoogleThinkingConfig;

  /**
   * Models known to accept a request whose contents end with a model turn,
   * continuing that turn as the start of the response. Newer models reject
   * such requests, so this is a frozen legacy set: any model NOT matching is
   * assumed to reject them and gets a trailing user message injected when
   * needed. gemini-3.5-flash accepts them but shares a prefix with
   * gemini-3.5-flash-lite, which doesn't, so it's left out.
   */
  protected _PREFILL_SUPPORTED_PATTERNS: readonly string[] = [
    "gemini-2.",
    "gemini-3-",
    "gemini-3.1-",
    "gemini-pro-latest",
  ];

  protected _apiKey: string;
  protected _httpOptions: HttpOptions;
  protected _tools: Record<string, unknown>[] | null;
  protected _toolConfig: Record<string, unknown> | null;
  protected _streamIdleTimeoutSecs: number | null;
  protected _retryTimeoutSecs: number | null;
  protected _retryOnTimeout: boolean | null;
  protected _imageDecoder: ImageDecoder;
  protected _client: GoogleLLMClient | null = null;

  static {
    GoogleLLMService.prototype._processContext = tracedLlm(
      GoogleLLMService.prototype._processContext,
    );
  }

  /**
   * Initialize the Google LLM service.
   *
   * @param options.apiKey Google AI API key for authentication.
   * @param options.settings Runtime-updatable settings for this service.
   * @param options.tools List of available tools/functions.
   * @param options.toolConfig Configuration for tool usage.
   * @param options.httpOptions HTTP options for the client.
   * @param options.streamIdleTimeoutSecs How long to wait for the next chunk
   *   of a streamed response before giving up on it. Bounds the wait when the
   *   API accepts a request and then stops producing without closing the
   *   stream. This is a gap between chunks, not a limit on how long a
   *   response may take overall. The first chunk is the slowest, since its
   *   wait spans the whole round trip including any thinking the model does
   *   before it emits anything; raise this for models configured to think at
   *   length. Set to `null` to wait indefinitely.
   * @param options.retryTimeoutSecs How long to wait for the first chunk
   *   before giving up on the request and re-issuing it, when
   *   `retryOnTimeout` is set. Like the first-chunk wait above, this window
   *   spans the whole round trip including any thinking, so it is only a good
   *   fit for models that start emitting quickly.
   * @param options.retryOnTimeout Whether to re-issue the request once if the
   *   first chunk doesn't arrive within `retryTimeoutSecs`. Only the first
   *   chunk is retried: once a chunk has been pushed downstream, re-issuing
   *   would duplicate the response.
   * @param options.imageDecoder Decodes inline images to pixels.
   *   Other options are passed to the parent class.
   */
  constructor(options: GoogleLLMServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new GoogleLLMSettings({
      model: "gemini-3.6-flash",
      systemInstruction: null,
      maxTokens: 4096,
      temperature: null,
      topK: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      thinking: null,
      safetySettings: null,
      extra: {},
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    this._apiKey = options.apiKey;
    this._httpOptions = updateGoogleClientHttpOptions(options.httpOptions ?? null) as HttpOptions;
    this._tools = options.tools ?? null;
    this._toolConfig = options.toolConfig ?? null;
    this._streamIdleTimeoutSecs =
      options.streamIdleTimeoutSecs === undefined ? 20.0 : options.streamIdleTimeoutSecs;
    this._retryTimeoutSecs =
      options.retryTimeoutSecs === undefined ? 5.0 : options.retryTimeoutSecs;
    this._retryOnTimeout = options.retryOnTimeout ?? false;
    this._imageDecoder = options.imageDecoder ?? notPortedImageDecoder;

    // Initialize the API client. Subclasses can override this if needed.
    this.createClient();

    this._warnIfThinkingBudgetIgnored();
  }

  /**
   * Check if the service can generate usage metrics.
   *
   * @returns True, as Google AI provides token usage metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Create the Gemini client instance. Subclasses can override this. */
  createClient(): void {
    this._client = new GoogleGenAI({ apiKey: this._apiKey, httpOptions: this._httpOptions });
  }

  /**
   * Whether a model can enforce a response schema.
   *
   * Gemini takes a JSON schema from the 2.5 models on. A model id without a
   * version is assumed to support it.
   *
   * @param model The model name.
   */
  static override modelSupportsResponseSchema(model: string): boolean {
    const match = /gemini(?:-[a-z]+)*-(\d+)(?:\.(\d+))?/.exec(model);
    if (!match) {
      return true;
    }
    const major = Number.parseInt(match[1] as string, 10);
    const minor = Number.parseInt(match[2] ?? "0", 10);
    return major > 2 || (major === 2 && minor >= 5);
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the
   * given LLM context.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate.
   *   If provided, overrides the service's default max_tokens setting.
   * @param options.systemInstruction Optional system instruction to use for
   *   this inference. If provided, overrides any system instruction in the
   *   context.
   * @param options.responseSchema Optional JSON schema the reply must follow.
   *   The service asks the provider to enforce it, so the reply is JSON text
   *   matching the schema.
   * @returns The LLM's response as a string, or null if no response is
   *   generated.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    const effectiveInstruction =
      options.systemInstruction || assertGiven(this._settings.systemInstruction);
    const adapter = this.getLlmAdapter();
    const params = (await adapter.getLlmInvocationParams(context, {
      systemInstruction: effectiveInstruction,
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
    })) as GeminiLLMInvocationParams;
    const messages = params.messages;
    const system = params.system_instruction;
    const tools = isGiven(params.tools) ? params.tools : [];

    // Build generation config using the same method as streaming
    const generationParams = this._buildGenerationParams({
      systemInstruction: system,
      tools: tools.length > 0 ? tools : null,
    });

    // Override max_output_tokens if provided
    if (options.maxTokens !== undefined && options.maxTokens !== null) {
      generationParams.max_output_tokens = options.maxTokens;
    }

    const responseSchema = this._checkResponseSchema(options.responseSchema);
    if (responseSchema !== null) {
      generationParams.response_mime_type = "application/json";
      generationParams.response_json_schema = responseSchema;
    }

    const generationConfig = this._toGenerateContentConfig(generationParams);
    generationConfig.abortSignal = currentSignal();

    if (this._client === null) {
      throw new Error("assertion failed: client is null");
    }

    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("assertion failed: model is null");
    }

    const response = await abortable(
      this._client.models.generateContent({
        model,
        contents: messages as never,
        config: generationConfig,
      }),
    );

    const first = response.candidates?.[0];
    if (first?.finishReason) {
      this._handleFinishReason(first.finishReason);
    }

    // Extract text from response
    if (first?.content) {
      for (const part of first.content.parts ?? []) {
        if (part.text) {
          return part.text;
        }
      }
    }

    return null;
  }

  /**
   * Build generation parameters for Google AI API.
   *
   * @param options.systemInstruction Optional system instruction to use.
   * @param options.tools Optional list of tools to include.
   * @param options.toolConfig Optional tool configuration.
   * @returns Dictionary of generation parameters (Python SDK snake_case keys)
   *   with null values filtered out, carrying the low-latency thinking default
   *   when none is configured.
   */
  protected _buildGenerationParams(
    options: {
      systemInstruction?: string | null;
      tools?: unknown[] | null;
      toolConfig?: Record<string, unknown> | null;
    } = {},
  ): Record<string, unknown> {
    const given = <T>(v: T | NotGiven): T | null => (isGiven(v) ? v : null);
    // Filter out None values and create GenerationContentConfig
    const generationParams: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        system_instruction: options.systemInstruction ?? null,
        temperature: given(this._settings.temperature),
        top_p: given(this._settings.topP),
        top_k: given(this._settings.topK),
        max_output_tokens: given(this._settings.maxTokens),
        // DIVERGENCE: upstream leaves frequency_penalty and presence_penalty
        // out of the generation params, so the inherited LLMSettings fields
        // are never sent. GenerateContentConfig accepts both, so they are
        // sent here when set.
        frequency_penalty: given(this._settings.frequencyPenalty),
        presence_penalty: given(this._settings.presencePenalty),
        seed: given(this._settings.seed),
        safety_settings: assertGiven(this._settings.safetySettings),
        tools: options.tools ?? null,
        tool_config: options.toolConfig ?? null,
      }).filter(([, v]) => v !== null && v !== undefined),
    );

    // Add thinking parameters if configured
    const thinking = assertGiven(this._settings.thinking);
    if (thinking) {
      generationParams.thinking_config = thinking.modelDump({ excludeUnset: true });
    }

    if (this._settings.extra && Object.keys(this._settings.extra).length > 0) {
      Object.assign(generationParams, this._settings.extra);
    }

    // Applied last, so an explicit thinking config from the settings or from
    // extra wins over the low-latency default.
    this._maybeApplyThinkingDefault(generationParams);

    return generationParams;
  }

  /**
   * Convert generation params (Python SDK snake_case keys, as
   * `_buildGenerationParams` builds them) to the JS SDK's
   * `GenerateContentConfig`. Top-level keys and the keys of
   * `thinking_config` are converted; other nested values are passed as is.
   */
  protected _toGenerateContentConfig(params: Record<string, unknown>): GenerateContentConfig {
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const camel = snakeToCamel(key);
      if (
        camel === "thinkingConfig" &&
        (isPlainObject(value) || value instanceof GoogleThinkingConfig)
      ) {
        const thinkingConfig = camelKeys(
          value instanceof GoogleThinkingConfig ? value.modelDump({ excludeUnset: true }) : value,
        );
        // The Python SDK coerces thinking_level case-insensitively to its
        // ThinkingLevel enum ("minimal" -> "MINIMAL"); the JS SDK sends the
        // string as is, so normalize it to the enum value here.
        if (typeof thinkingConfig.thinkingLevel === "string") {
          thinkingConfig.thinkingLevel = thinkingConfig.thinkingLevel.toUpperCase();
        }
        config[camel] = thinkingConfig;
      } else if (camel === "tools" && Array.isArray(value)) {
        // The adapter builds each tool as upstream does, with snake_case keys
        // (`function_declarations`); the JS SDK drops keys it does not know,
        // so the tool's own keys are converted too.
        config[camel] = value.map((tool) => (isPlainObject(tool) ? camelKeys(tool) : tool));
      } else {
        config[camel] = value;
      }
    }
    return config as GenerateContentConfig;
  }

  /**
   * Apply a settings delta, re-checking the thinking configuration.
   *
   * @param delta An LLM settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(
    delta: GoogleLLMSettings,
  ): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("model" in changed || "thinking" in changed) {
      this._warnIfThinkingBudgetIgnored();
    }

    return changed;
  }

  /**
   * Warn when a thinking budget is set on a model that takes a level instead.
   *
   * Gemini 3 models control thinking through `thinking_level`. Whether a
   * budget set alongside one is honored, quietly ignored, or rejected varies
   * by model and by backend, and the rejection names no field, so this
   * warning is the only signal the caller gets in the cases that don't work.
   */
  protected _warnIfThinkingBudgetIgnored(): void {
    const thinking = assertGiven(this._settings.thinking);
    if (!thinking || thinking.thinkingBudget === null) {
      return;
    }

    const model = assertGiven(this._settings.model);
    const name = model ? _modelName(model) : "";
    if (!model || !_MODELS_SUPPORTING_THINKING_LEVEL.some((p) => name.startsWith(p))) {
      return;
    }

    logger.warning(
      `${this}: thinking_budget is the pre-Gemini 3 thinking control, and ${model} may ` +
        "ignore it or reject the request outright. Use thinking_level instead.",
    );
  }

  /**
   * Send the model's lowest thinking setting when none is configured.
   *
   * Applies the model's entry in `_THINKING_DEFAULTS`, if it has one.
   * Generation params that already set `thinking_config`, from the settings
   * or from `extra`, are left as they are, and so are all generation params
   * when `useProviderThinkingDefault` is set. The first request for each
   * model logs the setting sent, or that the model runs at Google's default,
   * warning for an unlisted model that can think.
   *
   * @param generationParams The generation params dict (modified in place).
   */
  protected _maybeApplyThinkingDefault(generationParams: Record<string, unknown>): void {
    if ("thinking_config" in generationParams || "thinkingConfig" in generationParams) {
      return;
    }
    const model = assertGiven(this._settings.model) || "";
    const name = _modelName(model);
    const thinking = _THINKING_DEFAULTS[name];
    this._applyThinkingDefault(
      generationParams,
      model,
      thinking !== undefined ? { thinking_config: thinking } : null,
      {
        canThink: _canThink(name),
        provider: "Google",
        settingsFields: "`thinking`",
      },
    );
  }

  /**
   * Whether to fix up requests whose contents end with a model turn.
   *
   * Models without support for continuing a trailing model turn reject such
   * requests, so injection is on for every model not known to support it.
   * Subclasses with other model naming can override
   * `_PREFILL_SUPPORTED_PATTERNS`.
   */
  protected _shouldInjectTrailingUserMessage(): boolean {
    const model = (isGiven(this._settings.model) ? this._settings.model : null) || "";
    return !this._PREFILL_SUPPORTED_PATTERNS.some((p) => model.startsWith(p));
  }

  /**
   * Prepare a streaming request for the context.
   *
   * The request itself is sent when the first chunk is pulled, as the Python
   * client does.
   *
   * @param context The context to generate a response for.
   * @param abortSignal Aborts the request (used to release an abandoned stream).
   */
  protected async _streamContent(
    context: LLMContext,
    abortSignal?: AbortSignal,
  ): Promise<AsyncGenerator<GenerateContentResponse, void, unknown>> {
    const adapter = this.getLlmAdapter();
    const params = (await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      ensureLastMessageIsUser: this._shouldInjectTrailingUserMessage(),
    })) as GeminiLLMInvocationParams;

    this._logLlmResponse(context);

    const messages = params.messages;

    // The adapter already resolved system_instruction vs context system message.
    const systemInstruction = params.system_instruction;

    let tools: unknown[] = [];
    if (isGiven(params.tools) && params.tools.length > 0) {
      tools = params.tools;
    } else if (this._tools && this._tools.length > 0) {
      tools = this._tools;
    }
    let toolConfig: Record<string, unknown> | null = null;
    if (this._toolConfig && Object.keys(this._toolConfig).length > 0) {
      toolConfig = this._toolConfig;
    }

    // Build generation parameters
    const generationParams = this._buildGenerationParams({
      systemInstruction,
      tools,
      toolConfig,
    });

    const generationConfig = this._toGenerateContentConfig(generationParams);
    if (abortSignal) {
      generationConfig.abortSignal = abortSignal;
    }

    const client = this._client;
    if (client === null) {
      throw new Error("assertion failed: client is null");
    }

    const model = assertGiven(this._settings.model);
    if (model === null) {
      throw new Error("assertion failed: model is null");
    }

    return (async function* () {
      yield* await client.models.generateContentStream({
        model,
        contents: messages as never,
        config: generationConfig,
      });
    })();
  }

  /**
   * Yield the model's streamed chunks, re-issuing the request once if it
   * stalls.
   *
   * The API client sends the request lazily, when the first chunk is pulled,
   * so a request that is accepted and then produces nothing shows up as a
   * first chunk that never arrives. Re-issuing is safe only up to that point:
   * once a chunk has been yielded, its content is already on its way
   * downstream.
   *
   * @param context The context to generate a response for.
   * @throws TimeoutError If the stream stalls past the timeout it is bounded by.
   */
  protected async *_streamResponse(
    context: LLMContext,
  ): AsyncGenerator<GenerateContentResponse, void, unknown> {
    if (this._retryOnTimeout) {
      const controller = new AbortController();
      const stream = this._iterStream(await this._streamContent(context, controller.signal), {
        firstChunkTimeout: this._retryTimeoutSecs,
        abortController: controller,
      });
      try {
        let first: IteratorResult<GenerateContentResponse, void> | null = null;
        try {
          first = await stream.next();
        } catch (e) {
          if (!(e instanceof TimeoutError)) throw e;
          logger.debug(`${this}: retrying content generation due to timeout`);
        }
        if (first !== null) {
          if (first.done) {
            return;
          }
          yield first.value;
          for await (const chunk of stream) {
            yield chunk;
          }
          return;
        }
      } finally {
        await stream.return(undefined);
      }
    }

    // Either retries are disabled, or the initial attempt timed out.
    const controller = new AbortController();
    const stream = this._iterStream(await this._streamContent(context, controller.signal), {
      firstChunkTimeout: this._streamIdleTimeoutSecs,
      abortController: controller,
    });
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
    } finally {
      await stream.return(undefined);
    }
  }

  /**
   * Yield streamed chunks, giving up if the stream stalls between them.
   *
   * A stream that stops producing without closing would otherwise leave the
   * response open indefinitely, since the API client applies no timeout of
   * its own. The timeout covers the gap between chunks rather than the
   * response as a whole, so a slow but healthy stream is never cut short.
   *
   * @param response The streamed response to consume.
   * @param options.firstChunkTimeout How long to wait for the first chunk.
   *   Every later chunk is bounded by `streamIdleTimeoutSecs`.
   * @param options.abortController Aborted when the stream is left, to
   *   release its HTTP resources.
   * @throws TimeoutError If the next chunk doesn't arrive in time.
   */
  protected async *_iterStream(
    response: AsyncIterator<GenerateContentResponse>,
    options: { firstChunkTimeout: number | null; abortController?: AbortController | null },
  ): AsyncGenerator<GenerateContentResponse, void, unknown> {
    let timeout = options.firstChunkTimeout;
    try {
      while (true) {
        let result: IteratorResult<GenerateContentResponse>;
        if (timeout === null) {
          result = await abortable(response.next());
        } else {
          result = await waitFor(() => abortable(response.next()), timeout);
        }
        if (result.done) {
          return;
        }
        yield result.value;
        timeout = this._streamIdleTimeoutSecs;
      }
    } finally {
      // Release the HTTP resources held by a stream we walk away from,
      // whether that's because it stalled, was interrupted, or is being
      // re-issued. Aborting the request is the JS counterpart of upstream's
      // best-effort `aclose()`; a pending `next()` would block `return()`.
      options.abortController?.abort();
    }
  }

  /**
   * Log why Gemini stopped generating, when it stopped for a notable reason.
   *
   * Anything other than a normal stop leaves the turn short of what the model
   * would otherwise have said: the response was withheld (safety, recitation,
   * prohibited content), a tool call was rejected, or the output hit the
   * token limit. Whatever text did arrive is still passed on.
   */
  protected _handleFinishReason(finishReason: FinishReason): void {
    if (
      finishReason === FinishReason.STOP ||
      finishReason === FinishReason.FINISH_REASON_UNSPECIFIED
    ) {
      return;
    }

    logger.warning(`${this}: response incomplete, the model stopped for ${finishReason}`);
  }

  protected async _processContext(context: LLMContext): Promise<void> {
    await this.pushFrame(new LLMFullResponseStartFrame());

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheReadInputTokens = 0;
    let reasoningTokens = 0;

    let groundingMetadata: {
      renderedContent: string | null;
      origins: LLMSearchOrigin[];
    } | null = null;
    let accumulatedText = "";

    try {
      await this.startTtfbMetrics();

      const functionCalls: FunctionCallFromLLM[] = [];
      for await (const chunk of this._streamResponse(context)) {
        // Gemini may send usage_metadata in multiple chunks with varying behavior:
        // - Sometimes a single chunk, sometimes multiple chunks
        // - Token counts may be cumulative (growing) or may change between chunks
        // - Early chunks may include estimates/overhead that gets refined
        // We use assignment (not accumulation) because the final chunk always contains
        // the authoritative, billable token usage for the entire response.
        const usage = chunk.usageMetadata;
        if (usage) {
          reasoningTokens = usage.thoughtsTokenCount || 0;
          // Gemini counts tool results fed back to the model apart from the
          // prompt, and thinking tokens apart from the candidates, but they
          // are input and output too.
          promptTokens = (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0);
          completionTokens = (usage.candidatesTokenCount || 0) + reasoningTokens;
          totalTokens = promptTokens + completionTokens;
          cacheReadInputTokens = usage.cachedContentTokenCount || 0;
        }

        if (!chunk.candidates || chunk.candidates.length === 0) {
          continue;
        }

        // A leading chunk can carry usage metadata and no candidates, so
        // TTFB ends at the first chunk that holds model output.
        await this.stopTtfbMetrics();

        for (const candidate of chunk.candidates) {
          if (candidate.content?.parts && candidate.content.parts.length > 0) {
            for (const part of candidate.content.parts) {
              let functionCallId: string | null = null;
              if (part.text) {
                if (part.thought) {
                  // Gemini emits fully-formed thoughts rather
                  // than chunks so bracket each thought in
                  // start/end
                  await this.pushFrame(new LLMThoughtStartFrame());
                  await this.pushFrame(new LLMThoughtTextFrame({ text: part.text }));
                  await this.pushFrame(new LLMThoughtEndFrame());
                } else {
                  accumulatedText += part.text;
                  await this._pushLlmText(part.text);
                }
              } else if (part.functionCall) {
                // A turn that only calls tools produces no answer
                // text, so the call itself is what the caller gets
                // and TTFAT ends here rather than going unmeasured.
                await this.stopTtfatMetrics();
                const functionCall = part.functionCall;
                functionCallId = functionCall.id || crypto.randomUUID();
                logger.debug(`Function call: ${functionCall.name}:${functionCallId}`);
                functionCalls.push(
                  new FunctionCallFromLLM({
                    context,
                    toolCallId: functionCallId,
                    functionName: functionCall.name || "",
                    arguments: functionCall.args || {},
                  }),
                );
              } else if (part.inlineData?.data) {
                // Here we assume that inline_data is an image.
                const data = base64ToBytes(part.inlineData.data);
                const image = await this._imageDecoder(data, part.inlineData.mimeType ?? null);
                await this.pushFrame(
                  new AssistantImageRawFrame({
                    image: image.image,
                    size: image.size,
                    format: "RGB",
                    originalData: data,
                    originalMimeType: part.inlineData.mimeType ?? null,
                  }),
                );
              }

              // Handle Gemini thought signatures.
              //
              // - Gemini 2.5: they appear on function_call Parts,
              // and then (surprisingly) on the last(*) Part of
              // model responses following the first function_call
              // in a conversation.
              // - Gemini 3 Pro: they appear on the last(*) Part
              // of model responses, regardless of Part type.
              //
              // (*) Since we're using the streaming API, though,
              // where text Parts may be split across multiple
              // chunks (each represented by a Part, confusingly),
              // signatures may actually appear with the first
              // chunk (Gemini 2.5) or in a trailing empty-text
              // chunk (Gemini 3 Pro).
              if (part.thoughtSignature) {
                // Save a "bookmark" for the signature, so we
                // can later be sure we've put it in the right
                // place in context when sending the context
                // back to the LLM to continue the conversation.
                const bookmark: Record<string, unknown> = {};
                if (part.functionCall) {
                  bookmark.function_call = functionCallId;
                } else if (part.inlineData?.data) {
                  bookmark.inline_data = part.inlineData;
                } else if (part.text !== undefined && part.text !== null) {
                  // Account for Gemini 3 Pro trailing
                  // empty-text chunk by using all the text
                  // seen so far in this response's chunks.
                  bookmark.text = accumulatedText;
                } else {
                  logger.warning("Thought signature found on unhandled Part type");
                }
                if (Object.keys(bookmark).length > 0) {
                  await this.pushFrame(
                    new LLMMessagesAppendFrame({
                      messages: [
                        this.getLlmAdapter().createLlmSpecificMessage({
                          type: "thought_signature",
                          signature: part.thoughtSignature,
                          bookmark,
                        }),
                      ],
                    }),
                  );
                }
              }
            }
          }

          const m = candidate.groundingMetadata;
          if (m?.groundingChunks && m.groundingChunks.length > 0) {
            const renderedContent = m.searchEntryPoint
              ? (m.searchEntryPoint.renderedContent ?? null)
              : null;
            const origins = (m.groundingChunks ?? []).map(
              (groundingChunk, index) =>
                new LLMSearchOrigin({
                  siteUri: groundingChunk.web ? (groundingChunk.web.uri ?? null) : null,
                  siteTitle: groundingChunk.web ? (groundingChunk.web.title ?? null) : null,
                  results: (m.groundingSupports ?? [])
                    .filter((groundingSupport) =>
                      groundingSupport.groundingChunkIndices?.includes(index),
                    )
                    .map(
                      (groundingSupport) =>
                        new LLMSearchResult({
                          text: groundingSupport.segment
                            ? (groundingSupport.segment.text ?? "")
                            : "",
                          confidence: groundingSupport.confidenceScores ?? [],
                        }),
                    ),
                }),
            );
            groundingMetadata = { renderedContent, origins };
          }

          if (candidate.finishReason) {
            this._handleFinishReason(candidate.finishReason);
          }
        }
      }

      await this.runFunctionCalls(functionCalls);
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof TimeoutError) {
        await this._callEventHandler("on_completion_timeout");
        await this.pushError("LLM completion timeout", { exception: e });
      } else if (e instanceof LLMContextConversionError) {
        await this.pushError(e.message, { exception: e });
        // A conversion failure (e.g. corrupt base64 data) can't reach the
        // API at all, but is just as much evidence of an invalid file as a
        // rejection from Gemini itself, so it gets the same best-effort
        // cleanup.
        context.removeInvalidFileMessage();
      } else {
        // Gemini doesn't say which field was invalid, but ClientError.status
        // carries the gRPC-style code, and INVALID_ARGUMENT (unsupported MIME
        // type, corrupt bytes, etc.) is grounds to remove a pending file
        // message on a best-effort basis. The rest of the 4xx range —
        // UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND, RESOURCE_EXHAUSTED —
        // says nothing about whether our request (or its file) was bad, and
        // removing the file there would discard it for no benefit. When a
        // message is removed as a result of this error, the fault lay in
        // application-supplied content and the context is repaired, so the
        // error is pushed as APPLICATION instead of letting the rejection
        // classify as permanent and cost the service its usability.
        const removed =
          clientErrorStatus(e) === "INVALID_ARGUMENT" && context.removeInvalidFileMessage();
        await this.pushError(
          `Unknown error occurred: ${e instanceof Error ? e.message : String(e)}`,
          {
            exception: e,
            category: removed ? ErrorCategory.APPLICATION : null,
          },
        );
      }
    } finally {
      if (groundingMetadata) {
        const llmSearchFrame = new LLMSearchResponseFrame({
          searchResult: accumulatedText,
          origins: groundingMetadata.origins,
          renderedContent: groundingMetadata.renderedContent,
        });
        await this.pushFrame(llmSearchFrame);
      }

      await this.startLlmUsageMetrics(
        new LLMTokenUsage({
          promptTokens,
          completionTokens,
          totalTokens,
          cacheReadInputTokens,
          reasoningTokens,
        }),
      );
      await this.pushFrame(new LLMFullResponseEndFrame());
    }
  }

  /**
   * Process incoming frames and handle different frame types.
   *
   * @param frame The frame to process.
   * @param direction Direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      await this._processContext(frame.context);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Override stop to gracefully close the client. */
  override async stop(frame: EndFrame): Promise<void> {
    await super.stop(frame);
    await this._closeClient();
  }

  /** Override cancel to gracefully close the client. */
  override async cancel(frame: CancelFrame): Promise<void> {
    await super.cancel(frame);
    await this._closeClient();
  }

  /** Release resources held by the service. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._closeClient();
  }

  protected async _closeClient(): Promise<void> {
    if (!this._client) {
      return;
    }
    try {
      // The JS GenAI client keeps no session to close; a client that does
      // expose `aclose()` (e.g. a custom one) is closed.
      await (this._client as { aclose?: () => Promise<void> }).aclose?.();
    } catch (e) {
      rethrowIfCancelled(e);
      // Do nothing - we're shutting down anyway
    } finally {
      this._client = null;
    }
  }
}

/**
 * The gRPC-style status (`INVALID_ARGUMENT`, ...) of a Gemini client (4xx)
 * error, as the Python SDK's `ClientError.status` gives it; null for any
 * other error.
 */
function clientErrorStatus(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500) {
    return null;
  }
  const start = e.message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(e.message.slice(start)) as { error?: { status?: unknown } };
      if (typeof body.error?.status === "string") {
        return body.error.status;
      }
    } catch (err) {
      rethrowIfCancelled(err);
    }
  }
  const match =
    /\b(INVALID_ARGUMENT|FAILED_PRECONDITION|UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND|RESOURCE_EXHAUSTED)\b/.exec(
      e.message,
    );
  return match ? (match[1] as string) : null;
}
