// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/responses/llm.py

/**
 * OpenAI Responses API LLM service implementations (WebSocket and HTTP).
 *
 * Porting notes:
 * - Upstream's `_BaseOpenAIResponsesLLMService` is mixed into two different
 *   bases (`LLMService` for HTTP, `WebsocketLLMService` for WebSocket), so it
 *   is a class-factory mixin here (`BaseOpenAIResponsesLLMServiceMixin`),
 *   with `_BaseOpenAIResponsesLLMService` as its plain-class form.
 *   `instanceof _BaseOpenAIResponsesLLMService` holds for both services.
 *   The mixin's members are public (a mixin can't export protected members).
 * - The HTTP client is the `openai` JS SDK, which runs over `fetch`. Its
 *   streamed events are plain objects, so upstream's `isinstance` checks on
 *   the SDK's event classes are checks of the event's `type`. Upstream's
 *   `DefaultAsyncHttpxClient(limits=connection_limits(...))` has no `fetch`
 *   counterpart; connection reuse is left to the runtime. The SDK's
 *   `APITimeoutError` is `APIConnectionTimeoutError`.
 * - The SDK's `NOT_GIVEN` sentinel is `undefined` (`OPENAI_NOT_GIVEN`). It is
 *   stored in the `temperature`, `topP` and `maxCompletionTokens` settings
 *   after the defaults are built, since an `undefined` option means "not
 *   given" to Pipecat.
 * - The tracing decorator is applied in a static block (decorator syntax is
 *   not erasable).
 */

import {
  abortable,
  CancelledError,
  currentSignal,
  monotonic,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import type { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  OPENAI_NOT_GIVEN,
  type OpenAINotGiven,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import {
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
import {
  type LLMAdapterClass,
  LLMService,
  type LLMServiceOptions,
  WebsocketLLMService,
  type WebsocketLLMServiceOptions,
  WebsocketReconnectedError,
} from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { getEnv } from "@pipedog/core/utils/env";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { addVirtualBase, type Ctor, defineMixin } from "@pipedog/core/utils/mixin";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import OpenAI, { APIConnectionTimeoutError } from "openai";
import { OPENAI_MODEL_WITHOUT_RESPONSE_SCHEMA } from "../base_llm.ts";
import {
  OpenAIResponsesLLMAdapter,
  type OpenAIResponsesLLMInvocationParams,
} from "../open_ai_responses_adapter.ts";

type Dict = Record<string, any>;

// The adapter's invocation params are an interface, which isn't assignable to
// the `Record<string, unknown>` of `LLMService`'s adapter constraint.
type ResponsesAdapter = OpenAIResponsesLLMAdapter & BaseLLMAdapter;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `json.dumps(value, indent=2, default=str)`, for log lines. */
function jsonIndent(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2);
}

/** A copy of `value` with every dict's keys sorted, for `json.dumps(..., sort_keys=True)`. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const v = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, sortKeysDeep(v[key])]),
      );
    }
  }
  return value;
}

/** `json.dumps(value, sort_keys=True)`: keys sorted at every level. */
function jsonSortKeys(value: unknown): string {
  return pyJsonDumps(sortKeysDeep(value));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Hex SHA-256 digest of a string (`hashlib.sha256(s.encode()).hexdigest()`).
 *
 * Synchronous, as upstream's is: WebCrypto's digest is async and would add
 * suspension points upstream doesn't have.
 */
function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// Private retry exception classes
// ---------------------------------------------------------------------------

/** Base for errors that should trigger a retry in `_processContext`. */
export class _RetryableError extends Error {
  override name = "_RetryableError";
}

/** Server could not find the previous response (connection-local cache miss). */
export class _PreviousResponseNotFoundError extends _RetryableError {
  override name = "_PreviousResponseNotFoundError";
}

/** WebSocket connection hit the 60-minute server-side limit. */
export class _ConnectionLimitReachedError extends _RetryableError {
  override name = "_ConnectionLimitReachedError";
}

/** Response did not begin producing output within the retry timeout. */
export class _ResponseTimeoutError extends _RetryableError {
  override name = "_ResponseTimeoutError";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface OpenAIResponsesReasoningConfigOptions {
  /** How much reasoning effort the model applies. */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | string | null;
  /** Verbosity of the reasoning summary to return. */
  summary?: "auto" | "concise" | "detailed" | string | null;
  /** Reasoning mode for models that offer one: "standard" or "pro". */
  mode?: "standard" | "pro" | string | null;
}

/**
 * Reasoning configuration for reasoning-capable OpenAI Responses models.
 *
 * Only reasoning-capable models use this — the mainline gpt series from gpt-5
 * onward and the o-series. The service's default model, `gpt-4.1`, does not
 * reason, so this config has no effect there; select a reasoning-capable model
 * to use it. See OpenAI's reasoning guide
 * (https://platform.openai.com/docs/guides/reasoning) and model list
 * (https://platform.openai.com/docs/models) to choose one and to check which
 * effort levels it accepts.
 *
 * Reasoning models use internal reasoning tokens before producing a response.
 * This controls how much reasoning they do and whether a human-readable
 * summary of it is returned.
 *
 * - `effort`: how much reasoning effort the model applies. `null` (the
 *   default) leaves the field unset, so the model's own default applies;
 *   `"none"` disables reasoning for latency-sensitive use and `"max"` applies
 *   the model's deepest reasoning. At lower efforts (e.g. `"low"`) the model
 *   reasons only when a turn calls for it, so simple prompts may produce no
 *   summary at all.
 * - `summary`: verbosity of the reasoning summary to return. `null` (the
 *   default) requests no summary. Any summary is surfaced via thought frames
 *   (the `on_assistant_thought` event); the encrypted reasoning itself is
 *   preserved across turns regardless of this setting.
 * - `mode`: reasoning mode for models that offer one, such as the gpt-5.6
 *   series: `"standard"` or the slower, more thorough `"pro"`. `null` (the
 *   default) leaves the field unset, so the model's own default applies.
 *   `effort` selects the reasoning intensity within the chosen mode.
 */
export class OpenAIResponsesReasoningConfig {
  // `| string` for forward compatibility: if OpenAI adds new levels, users can
  // pass the new string without waiting for a Pipecat release.
  effort: string | null;
  summary: string | null;
  mode: string | null;

  constructor(options: OpenAIResponsesReasoningConfigOptions = {}) {
    this.effort = options.effort ?? null;
    this.summary = options.summary ?? null;
    this.mode = options.mode ?? null;
  }

  /**
   * The config as a dict of its wire fields (pydantic's `model_dump`).
   *
   * @param options.excludeNone Leave out fields whose value is `null`.
   */
  modelDump(options: { excludeNone?: boolean } = {}): Record<string, string | null> {
    const result: Record<string, string | null> = {
      effort: this.effort,
      summary: this.summary,
      mode: this.mode,
    };
    if (options.excludeNone) {
      for (const [key, value] of Object.entries(result)) {
        if (value === null) delete result[key];
      }
    }
    return result;
  }
}

export interface OpenAIResponsesLLMSettingsOptions extends LLMSettingsOptions {
  /** Maximum completion tokens to generate. */
  maxCompletionTokens?: number | NotGiven | OpenAINotGiven;
  /** Reasoning configuration for reasoning-capable models. */
  reasoning?: OpenAIResponsesReasoningConfig | null | NotGiven;
}

/**
 * Settings for OpenAI Responses API LLM services.
 *
 * - `maxCompletionTokens`: maximum completion tokens to generate.
 * - `reasoning`: reasoning configuration for reasoning-capable models. `null`
 *   (the default) leaves reasoning unconfigured: the service then sends the
 *   lowest effort OpenAI documents for the model, for the fastest responses,
 *   and logs what it sent. Models Pipecat doesn't list, and any model when
 *   `useProviderThinkingDefault` is set, run at OpenAI's default. The default
 *   model, `gpt-4.1`, does not reason.
 *
 * The inherited `temperature` and `topP` fields also hold the OpenAI SDK's
 * sentinel (`OPENAI_NOT_GIVEN`), which the service stores so these fields
 * can be passed through unchanged to the client.
 */
export class OpenAIResponsesLLMSettings extends LLMSettings {
  maxCompletionTokens: number | NotGiven | OpenAINotGiven = NOT_GIVEN;
  reasoning: OpenAIResponsesReasoningConfig | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAIResponsesLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

// ---------------------------------------------------------------------------
// Model classification
// ---------------------------------------------------------------------------

/** Whether the model is an o-series reasoning model (o1, o3, o4-mini, ...). */
export function _isOSeries(model: string): boolean {
  return /^o\d/.test(model.toLowerCase());
}

// The lowest reasoning effort OpenAI documents for each model, sent when the
// caller doesn't configure `reasoning`, keyed by model name. The pro models
// accept nothing below "medium", and gpt-5-pro only "high".
export const _THINKING_DEFAULTS: Readonly<Record<string, string>> = {
  "gpt-5": "minimal",
  "gpt-5-mini": "minimal",
  "gpt-5-nano": "minimal",
  "gpt-5-pro": "high",
  "gpt-5.1": "none",
  "gpt-5.2": "none",
  "gpt-5.2-pro": "medium",
  "gpt-5.4": "none",
  "gpt-5.4-mini": "none",
  "gpt-5.4-nano": "none",
  "gpt-5.4-pro": "medium",
  "gpt-5.5": "none",
  "gpt-5.5-pro": "medium",
  "gpt-5.6-luna": "none",
  "gpt-5.6-sol": "none",
  "gpt-5.6-terra": "none",
  "gpt-6-astra": "low",
  "gpt-6-luna": "none",
  "gpt-6-sol": "none",
  "gpt-6.1-sol": "low",
  "gpt-6.1-terra": "none",
  o1: "low",
  "o1-pro": "low",
  o3: "low",
  "o3-mini": "low",
  "o3-pro": "low",
  "o4-mini": "low",
};

/**
 * The name a model id refers to, the key it's looked up by in
 * `_THINKING_DEFAULTS`.
 *
 * A dated snapshot (`gpt-5-2025-08-07`) gets its model's entry.
 */
export function _modelName(model: string): string {
  return model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * Classify whether an OpenAI model supports reasoning.
 *
 * Assumes that future (beyond gpt-5.x) mainline gpt series models will also
 * support reasoning. This can be revisited if OpenAI changes their model
 * lineup or reasoning support in the future.
 *
 * @param model The model name (e.g. `"gpt-5.4"`, `"o3"`, `"gpt-4.1"`).
 * @returns `true` for reasoning-capable models — the o-series and the
 *   mainline gpt series from gpt-5 onward. `false` for models known *not* to
 *   reason: gpt-4.x and earlier, and the `gpt-5-chat` non-reasoning variant.
 *   `null` when the model is unrecognized and we can't tell either way.
 */
export function _modelSupportsReasoning(model: string): boolean | null {
  const lower = model.toLowerCase();
  if (_isOSeries(lower)) {
    return true;
  }
  // Mainline gpt series: reasons from gpt-5 onward. `gpt-5-chat` is the
  // non-reasoning variant of the series.
  const match = /^gpt-(\d+)/.exec(lower);
  if (match) {
    return Number.parseInt(match[1]!, 10) >= 5 && !lower.includes("chat");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared base class (private)
// ---------------------------------------------------------------------------

/** Options for creating the AsyncOpenAI client. */
export interface OpenAIResponsesClientOptions {
  /** OpenAI API key. */
  apiKey?: string | null;
  /** Custom base URL for the API. */
  baseUrl?: string | null;
  /** OpenAI organization ID. */
  organization?: string | null;
  /** OpenAI project ID. */
  project?: string | null;
  /** Additional HTTP headers. */
  defaultHeaders?: Record<string, string> | null;
}

export interface BaseOpenAIResponsesLLMServiceOptions
  extends LLMServiceOptions,
    OpenAIResponsesClientOptions {
  /**
   * Service tier to use: "auto", "default", "flex", "scale", "fast",
   * "priority" or "ultrafast". "fast" is OpenAI's low-latency tier, the name
   * that replaced "priority"; both values are accepted. "ultrafast" is the
   * access-controlled Ultrafast Processing tier, which shortens the time
   * between output tokens on the models that offer it.
   */
  serviceTier?: string | null;
  /** Runtime-updatable settings. */
  settings?: OpenAIResponsesLLMSettings | null;
  /**
   * How long an inference may go without producing output before it is
   * abandoned and re-issued, when `retryOnTimeout` is set. Defaults to 5.0
   * seconds.
   */
  retryTimeoutSecs?: number | null;
  /**
   * Whether to re-issue the request once if the first attempt produces no
   * output within `retryTimeoutSecs`. The retry is unbounded.
   */
  retryOnTimeout?: boolean | null;
}

/** Accumulated data for one function call: name, call_id and arguments. */
export interface ResponsesFunctionCallData {
  name: string;
  call_id: string;
  arguments: string;
}

/** Members a class gets from `BaseOpenAIResponsesLLMServiceMixin`. */
export interface BaseOpenAIResponsesLLMServiceMembers {
  _apiKey: string | null;
  _serviceTier: string | null;
  _retryTimeoutSecs: number | null;
  _retryOnTimeout: boolean | null;
  _reasoningUnsupportedWarnedFor: string | null;
  _client: OpenAI;
  _fullModelName: string | null;
  _createClient(options?: OpenAIResponsesClientOptions): OpenAI;
  canGenerateMetrics(): boolean;
  _buildResponseParams(invocationParams: OpenAIResponsesLLMInvocationParams): Dict;
  runInference(
    context: LLMContext,
    options?: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    },
  ): Promise<string | null>;
  _processFunctionCalls(
    context: LLMContext,
    functionCalls: Map<string, ResponsesFunctionCallData>,
  ): FunctionCallFromLLM[];
  _maybeApplyThinkingDefault(params: Dict): void;
  _warnIfReasoningUnsupported(): void;
  _appendReasoningMessage(
    itemId: string | null,
    summary: Dict[],
    encryptedContent: string | null,
  ): Promise<void>;
  _reportEmptyResponse(
    responseId: string | null,
    output: Dict[],
    options?: { incremental?: boolean | null },
  ): Promise<void>;
}

/** Static members a class gets from `BaseOpenAIResponsesLLMServiceMixin`. */
export interface BaseOpenAIResponsesLLMServiceStatics {
  Settings: typeof OpenAIResponsesLLMSettings;
  ReasoningConfig: typeof OpenAIResponsesReasoningConfig;
  supportsResponseSchema: boolean;
  modelSupportsResponseSchema(model: string): boolean;
}

/**
 * Shared base for HTTP and WebSocket OpenAI Responses API services.
 *
 * Contains settings, adapter reference, HTTP client creation, parameter
 * building, `runInference`, and metrics support. Subclasses implement
 * `processFrame` and `_processContext` for their transport.
 *
 * A mixin over an `LLMService` base: upstream's
 * `class OpenAIResponsesLLMService(_BaseOpenAIResponsesLLMService, WebsocketLLMService)`
 * is `class OpenAIResponsesLLMService extends BaseOpenAIResponsesLLMServiceMixin(WebsocketLLMService)`.
 */
export const BaseOpenAIResponsesLLMServiceMixin = defineMixin<
  BaseOpenAIResponsesLLMServiceMembers,
  <B extends Ctor>(
    base: B,
  ) => B & Ctor<BaseOpenAIResponsesLLMServiceMembers> & BaseOpenAIResponsesLLMServiceStatics
>("_BaseOpenAIResponsesLLMService", <B extends Ctor>(Base: B) => {
  // The base must be an LLMService (upstream's base subclasses it).
  const LLMBase = Base as unknown as Ctor<LLMService<ResponsesAdapter>>;

  abstract class BaseOpenAIResponsesLLMServiceImpl
    extends LLMBase
    implements BaseOpenAIResponsesLLMServiceMembers
  {
    static Settings = OpenAIResponsesLLMSettings;
    declare protected _settings: OpenAIResponsesLLMSettings;

    static ReasoningConfig = OpenAIResponsesReasoningConfig;

    static adapterClass: LLMAdapterClass | null =
      OpenAIResponsesLLMAdapter as unknown as LLMAdapterClass;

    static supportsResponseSchema = true;

    _apiKey: string | null;
    _serviceTier: string | null;
    _retryTimeoutSecs: number | null;
    _retryOnTimeout: boolean | null;
    // Tracks the model we've already warned about (reasoning configured on a
    // non-reasoning model) so we log it once per model rather than per turn.
    _reasoningUnsupportedWarnedFor: string | null = null;
    _client: OpenAI;
    // Used by tracedLlm for a more detailed model name in tracing spans.
    _fullModelName: string | null = null;

    /**
     * Initialize the OpenAI Responses API LLM service.
     *
     * @param options.apiKey OpenAI API key. If null, uses environment variable.
     * @param options.baseUrl Custom base URL for OpenAI API. If null, uses default.
     * @param options.organization OpenAI organization ID.
     * @param options.project OpenAI project ID.
     * @param options.defaultHeaders Additional HTTP headers to include in requests.
     * @param options.serviceTier Service tier to use (see
     *   `BaseOpenAIResponsesLLMServiceOptions.serviceTier`).
     * @param options.settings Runtime-updatable settings.
     * @param options.retryTimeoutSecs How long an inference may go without
     *   producing output before it is abandoned and re-issued, when
     *   `retryOnTimeout` is set. Defaults to 5.0 seconds.
     * @param options.retryOnTimeout Whether to re-issue the request once if the
     *   first attempt produces no output within `retryTimeoutSecs`. The retry
     *   is unbounded.
     *   Other options are passed to the parent LLMService.
     */
    constructor(...args: any[]) {
      const options = (args[0] ?? {}) as BaseOpenAIResponsesLLMServiceOptions;
      const settingsClass =
        (new.target as unknown as BaseOpenAIResponsesLLMServiceStatics).Settings ??
        OpenAIResponsesLLMSettings;
      const defaultSettings = new settingsClass({
        model: "gpt-4.1",
        systemInstruction: null,
        frequencyPenalty: null,
        presencePenalty: null,
        seed: null,
        topK: null,
        maxTokens: null,
        reasoning: null,
        filterIncompleteUserTurns: false,
        userTurnCompletionConfig: null,
        extra: {},
      });
      // The OpenAI SDK's sentinel can't travel in an options object (an
      // `undefined` option means "not given" to Pipecat), so it is stored
      // here.
      const raw = defaultSettings as unknown as Record<string, unknown>;
      raw.temperature = OPENAI_NOT_GIVEN;
      raw.topP = OPENAI_NOT_GIVEN;
      raw.maxCompletionTokens = OPENAI_NOT_GIVEN;

      if (options.settings !== null && options.settings !== undefined) {
        defaultSettings.applyUpdate(options.settings);
      }

      super({ ...options, settings: defaultSettings });

      // Resolve the API key from the environment if not provided. The
      // AsyncOpenAI HTTP client does this automatically, but the WebSocket
      // variant connects via raw websockets and needs the key explicitly.
      this._apiKey = options.apiKey || (getEnv("OPENAI_API_KEY") ?? null);
      this._serviceTier = options.serviceTier ?? null;
      this._retryTimeoutSecs =
        options.retryTimeoutSecs === undefined ? 5.0 : options.retryTimeoutSecs;
      this._retryOnTimeout = options.retryOnTimeout === undefined ? false : options.retryOnTimeout;
      this._client = this._createClient({
        apiKey: options.apiKey ?? null,
        baseUrl: options.baseUrl ?? null,
        organization: options.organization ?? null,
        project: options.project ?? null,
        defaultHeaders: options.defaultHeaders ?? null,
      });

      if (this._settings.systemInstruction) {
        logger.debug(`${this}: Using system instruction: ${this._settings.systemInstruction}`);
      }
    }

    /**
     * Create an AsyncOpenAI client instance.
     *
     * @param options.apiKey OpenAI API key.
     * @param options.baseUrl Custom base URL for the API.
     * @param options.organization OpenAI organization ID.
     * @param options.project OpenAI project ID.
     * @param options.defaultHeaders Additional HTTP headers.
     * @returns Configured AsyncOpenAI client instance.
     */
    _createClient(options: OpenAIResponsesClientOptions = {}): OpenAI {
      return new OpenAI({
        apiKey: options.apiKey ?? undefined,
        baseURL: options.baseUrl ?? undefined,
        organization: options.organization ?? undefined,
        project: options.project ?? undefined,
        defaultHeaders: options.defaultHeaders ?? undefined,
      });
    }

    /** Check if this service can generate processing metrics. */
    override canGenerateMetrics(): boolean {
      return true;
    }

    /**
     * Build parameters for a Responses API call.
     *
     * @param invocationParams Parameters derived from the LLM context.
     * @returns Dictionary of parameters for the Responses API call.
     */
    _buildResponseParams(invocationParams: OpenAIResponsesLLMInvocationParams): Dict {
      const params: Dict = {
        model: this._settings.model,
        stream: true,
        // store=false avoids OpenAI-side 30-day conversation storage.
        // The WebSocket variant's previous_response_id optimization
        // still works with store=false because it uses a connection-local
        // in-memory cache. See the class docstrings for details.
        store: false,
        input: invocationParams.input,
      };

      // instructions (set by the adapter when input is non-empty)
      if ("instructions" in invocationParams) {
        params.instructions = invocationParams.instructions;
      }

      // Optional parameters - only include if given
      if (typeof this._settings.temperature === "number") {
        params.temperature = this._settings.temperature;
      }

      if (typeof this._settings.topP === "number") {
        params.top_p = this._settings.topP;
      }

      if (
        typeof this._settings.maxCompletionTokens === "number" &&
        Number.isInteger(this._settings.maxCompletionTokens)
      ) {
        params.max_output_tokens = this._settings.maxCompletionTokens;
      }

      if (this._serviceTier !== null) {
        params.service_tier = this._serviceTier;
      }

      // Tools
      const tools = invocationParams.tools;
      if (tools !== null && tools !== OPENAI_NOT_GIVEN) {
        params.tools = tools;
      }

      // Reasoning
      const reasoning = assertGiven(this._settings.reasoning);
      const reasoningParams = reasoning ? reasoning.modelDump({ excludeNone: true }) : {};
      if (Object.keys(reasoningParams).length > 0) {
        params.reasoning = reasoningParams;
        // Ask for the encrypted reasoning so it can be sent back on later
        // turns, preserving reasoning context across the conversation.
        params.include = ["reasoning.encrypted_content"];
        this._warnIfReasoningUnsupported();
      }

      // Extra settings
      Object.assign(params, this._settings.extra);

      // Applied last, so reasoning configured in the settings or in extra wins
      // over the low-latency default.
      this._maybeApplyThinkingDefault(params);

      return params;
    }

    /**
     * Whether a model can enforce a response schema.
     *
     * OpenAI models before gpt-4o-mini and gpt-4o-2024-08-06 cannot.
     *
     * @param model The model name.
     */
    static modelSupportsResponseSchema(model: string): boolean {
      return !OPENAI_MODEL_WITHOUT_RESPONSE_SCHEMA.test(model);
    }

    /**
     * Run a one-shot, out-of-band inference with the given LLM context.
     *
     * Always uses the HTTP client regardless of transport variant.
     *
     * @param context The LLM context containing conversation history.
     * @param options.maxTokens Optional maximum number of tokens to generate.
     * @param options.systemInstruction Optional system instruction for this
     *   inference.
     * @param options.responseSchema Optional JSON schema the reply must
     *   follow. The service asks the provider to enforce it, so the reply is
     *   JSON text matching the schema.
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
      const adapter = this.getLlmAdapter();
      const effectiveInstruction =
        options.systemInstruction || assertGiven(this._settings.systemInstruction);
      const invocationParams = await adapter.getLlmInvocationParams(context, {
        systemInstruction: effectiveInstruction,
      });

      const params = this._buildResponseParams(invocationParams);

      // Override for non-streaming
      params.stream = false;

      if (options.maxTokens !== null && options.maxTokens !== undefined) {
        params.max_output_tokens = options.maxTokens;
      }

      const responseSchema = this._checkResponseSchema(options.responseSchema);
      if (responseSchema !== null) {
        params.text = {
          format: {
            type: "json_schema",
            name: "response",
            schema: responseSchema,
            strict: true,
          },
        };
      }

      const response = (await abortable(
        this._client.responses.create(params as any, { signal: currentSignal() }),
      )) as OpenAI.Responses.Response;

      return response.output_text;
    }

    /**
     * Convert accumulated function call data into FunctionCallFromLLM list.
     *
     * @param context The LLM context for the current inference.
     * @param functionCalls Map of item_id to {name, call_id, arguments}.
     * @returns List of parsed function call objects.
     */
    _processFunctionCalls(
      context: LLMContext,
      functionCalls: Map<string, ResponsesFunctionCallData>,
    ): FunctionCallFromLLM[] {
      const fcList: FunctionCallFromLLM[] = [];
      for (const fc of functionCalls.values()) {
        let args: Record<string, unknown>;
        try {
          args = fc.arguments ? (pyJsonLoads(fc.arguments) as Record<string, unknown>) : {};
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          logger.warning(`${this}: Failed to parse function call arguments: ${fc.arguments}`);
          args = {};
        }
        fcList.push(
          new FunctionCallFromLLM({
            context,
            toolCallId: fc.call_id,
            functionName: fc.name,
            arguments: args,
          }),
        );
      }
      return fcList;
    }

    // -- reasoning ------------------------------------------------------------

    /**
     * Send the model's lowest reasoning effort when no reasoning is configured.
     *
     * Applies the model's entry in `_THINKING_DEFAULTS`, if it has one. A
     * request that already sets `reasoning`, from the settings or from
     * `extra`, is left as it is. So is every request when
     * `useProviderThinkingDefault` is set. The first request for each model
     * logs the effort sent, or that the model runs at OpenAI's default,
     * warning for an unlisted reasoning model.
     *
     * @param params The response params dict (modified in place).
     */
    _maybeApplyThinkingDefault(params: Dict): void {
      if ("reasoning" in params) {
        return;
      }
      const model = assertGiven(this._settings.model) || "";
      const name = _modelName(model);
      const effort = Object.hasOwn(_THINKING_DEFAULTS, name) ? _THINKING_DEFAULTS[name] : undefined;
      this._applyThinkingDefault(
        params,
        model,
        effort !== undefined ? { reasoning: { effort } } : null,
        {
          canThink: Boolean(_modelSupportsReasoning(model)),
          provider: "OpenAI",
          settingsFields: "`reasoning`",
        },
      );
    }

    /**
     * Log a clear error when reasoning is configured on a model that can't use
     * it.
     *
     * The raw API error in this case ("Encrypted content is not supported with
     * this model") is cryptic, so surface an actionable one instead. Only
     * fires for models *known* not to reason; unrecognized models are left
     * alone. Logs once per model rather than on every turn.
     */
    _warnIfReasoningUnsupported(): void {
      const model = assertGiven(this._settings.model);
      if (!model || _modelSupportsReasoning(model) !== false) {
        // No model, reasoning-capable, or unrecognized — say nothing.
        return;
      }
      if (model === this._reasoningUnsupportedWarnedFor) {
        return;
      }
      this._reasoningUnsupportedWarnedFor = model;
      logger.error(
        `${this}: \`reasoning\` is configured but model '${model}' does not support ` +
          "reasoning, so requests will fail. Reasoning is supported only by " +
          "reasoning-capable models — the mainline gpt series from gpt-5 onward " +
          "and the o-series; see " +
          "OpenAI's reasoning guide (https://platform.openai.com/docs/guides/reasoning). " +
          "Remove the `reasoning` setting or select a reasoning-capable model.",
      );
    }

    /**
     * Persist a reasoning item so it round-trips on the next request.
     *
     * The encrypted reasoning is sent back on later requests to preserve
     * reasoning context. Store it as an LLM-specific message the adapter
     * re-emits as a Responses reasoning input item — positioned, by append
     * order, before the assistant message or function call it produced.
     *
     * @param itemId The reasoning item id.
     * @param summary The reasoning summary parts (`summary_text` dicts).
     * @param encryptedContent The encrypted reasoning payload.
     */
    async _appendReasoningMessage(
      itemId: string | null,
      summary: Dict[],
      encryptedContent: string | null,
    ): Promise<void> {
      if (!encryptedContent) {
        // Nothing to round-trip (e.g. reasoning disabled / effort="none").
        return;
      }
      const message = {
        type: "reasoning",
        id: itemId,
        summary,
        encrypted_content: encryptedContent,
      };
      await this.pushFrame(
        new LLMMessagesAppendFrame({
          messages: [this.getLlmAdapter().createLlmSpecificMessage(message)],
        }),
      );
    }

    /**
     * Report a completed response that produced no text and no function call.
     *
     * Nothing reaches the TTS for such a response, so the bot stays silent
     * until the user speaks again. The warning lists the response's output
     * items (a message with its content types, e.g. `message[refusal]`) to
     * show why, and the non-fatal error lets the application react.
     *
     * @param responseId The response id.
     * @param output The response's `output` items, as dicts.
     * @param options.incremental Whether the request sent only the new input
     *   items via `previous_response_id`. null for a transport that always
     *   sends the full context.
     */
    async _reportEmptyResponse(
      responseId: string | null,
      output: Dict[],
      options: { incremental?: boolean | null } = {},
    ): Promise<void> {
      const incremental = options.incremental ?? null;
      const items: string[] = [];
      for (const item of output) {
        let itemType: string = item.type ?? "unknown";
        if (itemType === "message") {
          const contentTypes = ((item.content || []) as Dict[])
            .map((c) => c.type ?? "unknown")
            .join(",");
          itemType = `message[${contentTypes}]`;
        }
        items.push(itemType);
      }
      // Python's repr of a list of strings.
      let details = `output: [${items.map((i) => `'${i}'`).join(", ")}]`;
      if (incremental !== null) {
        details += `, incremental: ${incremental ? "True" : "False"}`;
      }
      logger.warning(
        `${this}: Response ${responseId ?? "None"} completed with no text or function call (${details})`,
      );
      await this.pushError(
        `LLM response ${responseId ?? "None"} completed with no text or function call`,
      );
    }
  }

  return BaseOpenAIResponsesLLMServiceImpl as unknown as B &
    Ctor<BaseOpenAIResponsesLLMServiceMembers> &
    BaseOpenAIResponsesLLMServiceStatics;
});

/**
 * Shared base for HTTP and WebSocket OpenAI Responses API services, as a
 * plain class over `LLMService` (see `BaseOpenAIResponsesLLMServiceMixin`).
 */
export class _BaseOpenAIResponsesLLMService extends BaseOpenAIResponsesLLMServiceMixin(
  LLMService,
)<ResponsesAdapter> {
  declare protected _settings: OpenAIResponsesLLMSettings;

  constructor(options: BaseOpenAIResponsesLLMServiceOptions = {}) {
    super(options);
  }
}

// ---------------------------------------------------------------------------
// WebSocket variant (default / recommended)
// ---------------------------------------------------------------------------

// Lanes the WebSocket service's responses go on. A connection runs at most 16
// responses at once, abandoned ones included.
const _LANE_COUNT = 16;

// The events that end a response on its lane: it completed, failed or was cut
// short, or its request got an error.
const _RESPONSE_END_EVENT_TYPES: readonly string[] = [
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
];

export interface OpenAIResponsesLLMServiceOptions
  extends BaseOpenAIResponsesLLMServiceOptions,
    WebsocketLLMServiceOptions {
  /** Runtime-updatable settings. */
  settings?: OpenAIResponsesLLMSettings | null;
  /** WebSocket endpoint URL. Defaults to `wss://api.openai.com/v1/responses`. */
  wsUrl?: string;
}

/**
 * OpenAI Responses API LLM service using WebSocket transport.
 *
 * Maintains a persistent WebSocket connection to
 * `wss://api.openai.com/v1/responses` for lower-latency inference, especially
 * beneficial for tool-call-heavy workflows. Automatically uses
 * `previous_response_id` to send only incremental context when possible, and
 * falls back to full context on reconnection or cache miss.
 *
 * The `previous_response_id` optimization works with `store=false` (the
 * default) because WebSocket mode uses a connection-local in-memory cache —
 * no conversations are stored on OpenAI's servers. This is why the HTTP
 * variant (`OpenAIResponsesHttpLLMService`) does not offer this optimization
 * by default (or at all, yet): over HTTP, `previous_response_id` requires
 * `store=true`, which enables OpenAI-side 30-day conversation storage.
 *
 * This is the recommended variant for real-time / conversational use.
 *
 * @example
 * const llm = new OpenAIResponsesLLMService({
 *   apiKey: getEnv("OPENAI_API_KEY"),
 *   settings: new OpenAIResponsesLLMService.Settings({
 *     systemInstruction: "You are a helpful assistant.",
 *   }),
 * });
 */
export class OpenAIResponsesLLMService extends BaseOpenAIResponsesLLMServiceMixin(
  WebsocketLLMService,
)<ResponsesAdapter> {
  declare protected _settings: OpenAIResponsesLLMSettings;

  static {
    const proto = OpenAIResponsesLLMService.prototype as unknown as Record<string, any>;
    proto._processContext = tracedLlm(proto._processContext);
  }

  protected _wsUrl: string;

  // State for previous_response_id optimization
  protected _previousResponseId: string | null = null;
  protected _previousInputHash: string | null = null;
  protected _previousInputLength: number | null = null;
  protected _previousResponseOutput: Dict[] | null = null;
  protected _previousResponseLane: string | null = null;

  // Response lanes (see _chooseNextResponseLane): the lane of the response in
  // flight, from its response.create until its last event, and the lanes
  // still draining an abandoned response.
  protected _currentResponseLane: string | null = null;
  protected _drainingLanes = new Set<string>();

  /**
   * Initialize the WebSocket-based OpenAI Responses API LLM service.
   *
   * @param options.wsUrl WebSocket endpoint URL. Defaults to
   *   `wss://api.openai.com/v1/responses`.
   *   Other options are passed to the base class (apiKey, baseUrl,
   *   organization, project, defaultHeaders, serviceTier, settings, etc.).
   */
  constructor(options: OpenAIResponsesLLMServiceOptions = {}) {
    super(options);

    this._wsUrl = options.wsUrl ?? "wss://api.openai.com/v1/responses";
  }

  // -- WebsocketLLMService interface ----------------------------------------

  /** Establish the WebSocket connection. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket) {
        return;
      }
      this._websocket = await this._websocketConnect(this._wsUrl, {
        additionalHeaders: {
          Authorization: `Bearer ${this._apiKey}`,
        },
      });
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Error connecting to WebSocket: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /** Close the WebSocket connection and clear state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      if (this._websocket) {
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting from WebSocket: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      this._clearPreviousResponseState();
      this._clearLaneState();
    }
  }

  /** Release resources at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._disconnect();
  }

  // -- previous_response_id optimization ------------------------------------

  /**
   * Compute a deterministic hash of input items for comparison.
   *
   * @param items List of Responses API input items.
   * @returns Hex digest of the SHA-256 hash.
   */
  static _hashInputItems(items: unknown[]): string {
    return sha256Hex(jsonSortKeys(items));
  }

  /**
   * Try to use previous_response_id to send only new input items.
   *
   * If the prefix of `fullInput` matches the stored hash from the previous
   * inference call, only new items are sent along with
   * `previous_response_id`. Otherwise the full input is sent.
   *
   * @param params The response params dict (modified in place).
   * @param fullInput The complete input items list from the adapter.
   * @returns The (possibly modified) params dict.
   */
  protected _applyPreviousResponseOptimization(params: Dict, fullInput: Dict[]): Dict {
    if (this._previousResponseId === null) {
      logger.debug(`${this}: Sending full context (${fullInput.length} items)`);
      logger.trace(`${this}: Reason: no previous response`);
      return params;
    }

    if (
      this._previousInputLength === null ||
      this._previousInputHash === null ||
      fullInput.length <= this._previousInputLength
    ) {
      logger.debug(`${this}: Sending full context (${fullInput.length} items)`);
      logger.trace(
        `${this}: Reason: input not longer than previous (${this._previousInputLength ?? "None"})`,
      );
      return params;
    }

    const prefix = fullInput.slice(0, this._previousInputLength);
    const prefixHash = OpenAIResponsesLLMService._hashInputItems(prefix);
    if (prefixHash !== this._previousInputHash) {
      logger.debug(`${this}: Sending full context (${fullInput.length} items)`);
      logger.trace(
        `${this}: Reason: input prefix hash mismatch ` +
          `(previous input: ${jsonIndent(prefix)}, ` +
          `expected hash: ${this._previousInputHash}, ` +
          `actual hash: ${prefixHash})`,
      );
      return params;
    }

    const itemsAfterPrefix = fullInput.slice(this._previousInputLength);
    const responseOutput = this._previousResponseOutput ?? [];

    if (!OpenAIResponsesLLMService._startsWithResponseOutput(itemsAfterPrefix, responseOutput)) {
      logger.debug(`${this}: Sending full context (${fullInput.length} items)`);
      logger.trace(
        `${this}: Reason: response output mismatch after prefix ` +
          `(previous response output: ${jsonIndent(responseOutput)}, ` +
          `items after prefix: ${jsonIndent(itemsAfterPrefix)})`,
      );
      return params;
    }

    // The server already knows its own output — skip those items
    const itemsToSend = itemsAfterPrefix.slice(responseOutput.length);
    const cached = this._previousInputLength + responseOutput.length;
    params.input = itemsToSend;
    params.previous_response_id = this._previousResponseId;
    logger.debug(
      `${this}: Sending incremental context via previous_response_id ` +
        `(${itemsToSend.length} new items, ${cached} cached)`,
    );
    return params;
  }

  /**
   * Check whether `items` begins with entries that match `responseOutput`.
   *
   * When using `previous_response_id`, the server already knows its own
   * output. After confirming that the input prefix matches what we
   * previously sent, this method checks whether the items immediately
   * following that prefix correspond to the server's response output. If
   * they do, those items can be skipped so we send only the truly new items
   * (user messages, tool results, etc.).
   *
   * For messages, the comparison checks role and text content (extracting
   * text from the output's `output_text` content parts and comparing against
   * the input's content). For function calls, it matches by `call_id`. This
   * avoids requiring exact format equality while still confirming the items
   * represent the same data. If the match fails for any reason, the caller
   * falls back to sending the full context.
   *
   * @param items The input items following the matched prefix.
   * @param responseOutput Raw `output` array from the previous
   *   `response.completed` event.
   * @returns True if the leading items correspond to the response output.
   */
  static _startsWithResponseOutput(items: Dict[], responseOutput: Dict[]): boolean {
    if (items.length < responseOutput.length) {
      return false;
    }

    for (let i = 0; i < responseOutput.length; i++) {
      const outputItem = responseOutput[i]!;
      const inputItem = items[i]!;
      const outputType = outputItem.type;
      if (outputType === "message") {
        if (inputItem.role !== (outputItem.role ?? "assistant")) {
          return false;
        }
        // Extract text from the output's content array and compare against
        // the input's content (which the adapter stores as a plain string
        // for simple text responses).
        const outputContent = outputItem.content ?? [];
        let outputText: string;
        if (Array.isArray(outputContent)) {
          outputText = outputContent
            .filter((p: Dict) => p.type === "output_text")
            .map((p: Dict) => p.text ?? "")
            .join("");
        } else {
          outputText = String(outputContent);
        }
        const inputContent = inputItem.content ?? "";
        let inputText: string;
        if (Array.isArray(inputContent)) {
          // Adapter may produce multimodal content parts
          inputText = inputContent
            .filter((p: Dict) => p.type === "input_text")
            .map((p: Dict) => p.text ?? "")
            .join("");
        } else {
          inputText = String(inputContent);
        }
        if (outputText !== inputText) {
          return false;
        }
      } else if (outputType === "function_call") {
        if (inputItem.type !== "function_call" || inputItem.call_id !== outputItem.call_id) {
          return false;
        }
      } else if (outputType === "reasoning") {
        // Reasoning items round-trip via an LLMSpecificMessage; match by the
        // server-assigned id so the optimization can skip them too.
        if (inputItem.type !== "reasoning" || inputItem.id !== outputItem.id) {
          return false;
        }
      } else {
        // Unknown output type — can't confirm match
        return false;
      }
    }

    return true;
  }

  /**
   * Store state for the next call's previous_response_id optimization.
   *
   * @param responseId The response ID returned by the server.
   * @param fullInput The complete input items list that was sent.
   * @param responseOutput Raw `output` array from the `response.completed`
   *   event, stored for loose comparison on the next call.
   */
  protected _storePreviousResponseState(
    responseId: string,
    fullInput: Dict[],
    responseOutput: Dict[],
  ): void {
    this._previousResponseId = responseId;
    this._previousInputLength = fullInput.length;
    this._previousInputHash = OpenAIResponsesLLMService._hashInputItems(fullInput);
    this._previousResponseOutput = responseOutput;
  }

  /** Clear stored previous_response_id state. */
  protected _clearPreviousResponseState(): void {
    this._previousResponseId = null;
    this._previousInputLength = null;
    this._previousInputHash = null;
    this._previousResponseOutput = null;
    this._previousResponseLane = null;
  }

  // -- response lanes -------------------------------------------------------

  /** Clear response lane tracking state. */
  protected _clearLaneState(): void {
    this._currentResponseLane = null;
    this._drainingLanes.clear();
  }

  /**
   * Choose the lane for the next response.
   *
   * Every response goes on a named lane of the connection (the API's
   * `stream_id`), so each of its events says which lane it came from. That
   * lets a cancelled response be abandoned rather than waited for: WebSocket
   * mode can't stop a response (it ignores `response.cancel`), so an abandoned
   * response drains from its lane while the next one runs on another, and its
   * events are discarded as they arrive. The lane is free again once the
   * response ends.
   *
   * The lane chosen isn't draining, since a lane runs its responses one at a
   * time, and isn't the previous response's lane. Each lane caches only its
   * latest response, so an abandoned response on the previous response's lane
   * would evict the previous response when it ended, and the next request
   * couldn't continue from it. Continuing from another lane's response (a
   * fork) costs no more than continuing on the same lane.
   *
   * If every lane is taken, the connection is closed, which ends the abandoned
   * responses; the next send opens a new one.
   *
   * @returns The lane, as its `stream_id`.
   */
  protected async _chooseNextResponseLane(): Promise<string> {
    for (let i = 0; i < _LANE_COUNT; i++) {
      const lane = `lane-${i}`;
      if (lane !== this._previousResponseLane && !this._drainingLanes.has(lane)) {
        return lane;
      }
    }
    logger.debug(`${this}: Every lane is draining or holds the previous response — reconnecting`);
    await this._disconnectWebsocket();
    return "lane-0";
  }

  // -- frame processing -----------------------------------------------------

  /**
   * Process frames for LLM completion requests.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      try {
        await this.pushFrame(new LLMFullResponseStartFrame());
        await this.startProcessingMetrics();
        await this._processContext(frame.context);
      } catch (e) {
        if (e instanceof CancelledError) {
          // The pipeline cancelled us (e.g. due to an interruption). The
          // response drains from its lane, and the next one goes on another
          // (see _chooseNextResponseLane).
          if (this._currentResponseLane) {
            logger.debug(`${this}: Abandoning the response on ${this._currentResponseLane}`);
            this._drainingLanes.add(this._currentResponseLane);
            this._currentResponseLane = null;
          }
          throw e;
        }
        await this.pushError(`Error during inference: ${errorMessage(e)}`, { exception: e });
      } finally {
        await this.stopProcessingMetrics();
        await this.pushFrame(new LLMFullResponseEndFrame());
      }
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  // -- core inference -------------------------------------------------------

  /**
   * Run inference over WebSocket with retry and previous_response_id.
   *
   * Tries once with the `previous_response_id` optimization. On a retriable
   * error (cache miss, connection limit, connection drop, or — when
   * `retryOnTimeout` is set — a response that produces no output in time),
   * clears state and retries once with the full context and no timeout.
   * Transport-level `ConnectionClosed` errors are handled transparently by
   * `_wsSend`/`_wsRecv` (auto-reconnect → `WebsocketReconnectedError`).
   *
   * Traced with `tracedLlm` (see the static block).
   *
   * @param context The LLM context containing conversation history.
   */
  protected async _processContext(context: LLMContext): Promise<void> {
    const lane = await this._chooseNextResponseLane();

    const adapter = this.getLlmAdapter();
    this._logLlmResponse(context);

    const invocationParams = await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
    });

    const fullInput = invocationParams.input;

    const buildParams = (options: { applyOptimization: boolean }): Dict => {
      let params = this._buildResponseParams(invocationParams);
      // WebSocket mode does not use the "stream" parameter.
      delete params.stream;
      if (options.applyOptimization) {
        params = this._applyPreviousResponseOptimization(params, fullInput);
      }
      return params;
    };

    const sendAndReceive = async (
      params: Dict,
      outputTimeoutSecs: number | null = null,
    ): Promise<void> => {
      await this._ensureConnected();
      await this.startTtfbMetrics();
      // Set before sending: a cancellation during the send may still let the
      // response go out, and its lane must then count as draining.
      this._currentResponseLane = lane;
      await this._wsSend({ type: "response.create", stream_id: lane, ...params });
      await this._receiveResponseEvents(context, fullInput, outputTimeoutSecs, {
        incremental: "previous_response_id" in params,
      });
    };

    const cleanup = async (): Promise<void> => {
      this._clearPreviousResponseState();
      await this.stopTtfbMetrics();
    };

    // -- first attempt (with previous_response_id optimization) -----------

    try {
      await sendAndReceive(
        buildParams({ applyOptimization: true }),
        this._retryOnTimeout ? this._retryTimeoutSecs : null,
      );
      return; // Success
    } catch (e) {
      if (e instanceof _ResponseTimeoutError) {
        // Dropping the connection also ends the response that produced
        // nothing, so the retry starts on a clean socket.
        logger.warning(
          `${this}: No output within ${this._retryTimeoutSecs}s — reconnecting ` +
            `and retrying with full context (${fullInput.length} items)`,
        );
        await cleanup();
        await this._tryReconnect({
          reportError: (error, options) => this._reportError(error, options),
        });
      } else if (e instanceof _PreviousResponseNotFoundError) {
        logger.warning(
          `${this}: previous_response_not_found — ` +
            `retrying with full context (${fullInput.length} items)`,
        );
        await cleanup();
      } else if (e instanceof _ConnectionLimitReachedError) {
        logger.warning(
          `${this}: WebSocket connection limit reached — ` +
            `reconnecting and retrying with full context (${fullInput.length} items)`,
        );
        await cleanup();
        await this._tryReconnect({
          reportError: (error, options) => this._reportError(error, options),
        });
      } else if (e instanceof WebsocketReconnectedError) {
        // ConnectionClosed was handled by the base class — connection is
        // fresh, so any connection-local server state is gone.
        logger.warning(
          `${this}: Connection lost and recovered — ` +
            `retrying with full context (${fullInput.length} items)`,
        );
        await cleanup();
      } else {
        rethrowIfCancelled(e);
        await cleanup();
        throw e;
      }
    }

    // -- retry with full context (no optimization) ------------------------

    try {
      await sendAndReceive(buildParams({ applyOptimization: false }));
    } catch (e) {
      rethrowIfCancelled(e);
      await cleanup();
      throw e;
    }
  }

  /** Report the token usage of a response received over the WebSocket. */
  protected async _reportEventUsage(usage: Dict | null | undefined): Promise<void> {
    if (!usage || Object.keys(usage).length === 0) {
      return;
    }
    const inputDetails: Dict = usage.input_tokens_details || {};
    const outputDetails: Dict = usage.output_tokens_details || {};
    const tokens = new LLMTokenUsage({
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      cacheReadInputTokens: inputDetails.cached_tokens ?? 0,
      cacheCreationInputTokens: inputDetails.cache_write_tokens ?? 0,
      reasoningTokens: outputDetails.reasoning_tokens ?? 0,
    });
    await this.startLlmUsageMetrics(tokens);
  }

  /**
   * Receive and process WebSocket events until the response completes.
   *
   * @param context The LLM context for the current inference.
   * @param fullInput The complete input items list (for storing state on
   *   success).
   * @param outputTimeoutSecs How long to wait for the response to start
   *   producing output before raising `_ResponseTimeoutError`. Once the first
   *   output event arrives the wait becomes unbounded, since by then content
   *   is already on its way downstream and re-issuing would duplicate it.
   *   null waits indefinitely throughout.
   * @param options.incremental Whether the request sent only the new input
   *   items via `previous_response_id`.
   * @throws _PreviousResponseNotFoundError Server couldn't find previous response.
   * @throws _ConnectionLimitReachedError 60-minute connection limit reached.
   * @throws _ResponseTimeoutError Response produced no output in time.
   * @throws WebsocketReconnectedError Connection was lost and auto-recovered.
   * @throws ConnectionClosed Connection was lost and could not be recovered.
   */
  protected async _receiveResponseEvents(
    context: LLMContext,
    fullInput: Dict[],
    outputTimeoutSecs: number | null = null,
    options: { incremental?: boolean } = {},
  ): Promise<void> {
    const incremental = options.incremental ?? false;
    const functionCalls = new Map<string, ResponsesFunctionCallData>();
    const currentArguments = new Map<string, string>();
    let reasoningSummaryOpen = false;
    let hasText = false;
    const lane = this._currentResponseLane;

    let deadline: number | null = outputTimeoutSecs ? monotonic() + outputTimeoutSecs : null;

    while (true) {
      let event: Dict;
      if (deadline === null) {
        event = await this._wsRecv();
      } else {
        try {
          event = await waitFor(() => this._wsRecv(), Math.max(deadline - monotonic(), 0));
        } catch (e) {
          if (e instanceof TimeoutError) {
            throw new _ResponseTimeoutError(`No output within ${outputTimeoutSecs}s`);
          }
          throw e;
        }
      }

      const eventType = event.type;

      // An event on another lane is a draining lane's, from an abandoned
      // response; the lane is free again once that response ends. Events with
      // no stream_id concern the connection, and so the response in flight.
      const eventLane = event.stream_id ?? null;
      if (eventLane !== null && eventLane !== lane) {
        if (_RESPONSE_END_EVENT_TYPES.includes(eventType)) {
          this._drainingLanes.delete(eventLane);
        }
        continue;
      }

      if (_RESPONSE_END_EVENT_TYPES.includes(eventType)) {
        this._currentResponseLane = null;
      }

      if (eventType === "response.created") {
        const responseId = (event.response ?? {}).id ?? null;
        logger.debug(`${this}: Response started: ${responseId}`);
        continue;
      }

      // Anything past response.created means the response is under way, so
      // the window for abandoning and re-issuing it has closed.
      deadline = null;

      if (eventType === "response.output_text.delta") {
        await this.stopTtfbMetrics();
        const delta: string = event.delta ?? "";
        hasText = hasText || delta.trim().length > 0;
        await this._pushLlmText(delta);
      } else if (eventType === "response.reasoning_summary_text.delta") {
        await this.stopTtfbMetrics();
        if (!reasoningSummaryOpen) {
          await this.pushFrame(new LLMThoughtStartFrame());
          reasoningSummaryOpen = true;
        }
        await this.pushFrame(new LLMThoughtTextFrame({ text: event.delta ?? "" }));
      } else if (eventType === "response.output_item.added") {
        await this.stopTtfbMetrics();
        const item: Dict = event.item ?? {};
        if (item.type === "function_call") {
          // A turn that only calls tools produces no answer text, so the call
          // itself is what the caller gets and TTFAT ends here rather than
          // going unmeasured.
          await this.stopTtfatMetrics();
          const itemId: string = item.id ?? "";
          functionCalls.set(itemId, {
            name: item.name ?? "",
            call_id: item.call_id ?? "",
            arguments: "",
          });
          currentArguments.set(itemId, "");
        }
      } else if (eventType === "response.function_call_arguments.delta") {
        const itemId: string = event.item_id ?? "";
        if (currentArguments.has(itemId)) {
          currentArguments.set(itemId, currentArguments.get(itemId)! + (event.delta ?? ""));
        }
      } else if (eventType === "response.function_call_arguments.done") {
        const itemId: string = event.item_id ?? "";
        const call = functionCalls.get(itemId);
        if (call) {
          call.arguments = event.arguments ?? "";
        }
      } else if (eventType === "response.output_item.done") {
        const item: Dict = event.item ?? {};
        if (item.type === "function_call") {
          const itemId: string = item.id ?? "";
          const call = functionCalls.get(itemId);
          if (call) {
            call.name = item.name ?? "";
            call.call_id = item.call_id ?? "";
            call.arguments = item.arguments ?? "";
          }
        } else if (item.type === "reasoning") {
          if (reasoningSummaryOpen) {
            await this.pushFrame(new LLMThoughtEndFrame());
            reasoningSummaryOpen = false;
          }
          await this._appendReasoningMessage(
            item.id ?? null,
            ((item.summary || []) as Dict[]).map((s) => ({
              type: "summary_text",
              text: s.text ?? "",
            })),
            item.encrypted_content ?? null,
          );
        }
      } else if (eventType === "response.completed") {
        const response: Dict = event.response ?? {};
        await this._reportEventUsage(response.usage);

        this._fullModelName = response.model ?? null;

        // Store state for next call's previous_response_id optimization.
        // Include the response output so the hash covers the assistant's
        // reply — the server already knows it, so we won't resend it.
        const responseId = response.id;
        const responseOutput: Dict[] = response.output || [];
        if (responseId) {
          this._storePreviousResponseState(responseId, fullInput, responseOutput);
          this._previousResponseLane = lane;
        }

        if (!hasText && functionCalls.size === 0) {
          await this._reportEmptyResponse(responseId ?? null, responseOutput, { incremental });
        }

        break; // Response complete
      } else if (eventType === "response.failed" || eventType === "response.incomplete") {
        const response: Dict = event.response ?? {};
        // A response cut short or failed is still billed for its tokens.
        await this._reportEventUsage(response.usage);
        const errorMsg =
          (response.error || {}).message ||
          (response.incomplete_details || {}).reason ||
          `Response ${eventType.split(".").at(-1)}`;
        await this.pushError(`LLM response error: ${errorMsg}`);
        break;
      } else if (eventType === "error") {
        const error: Dict = event.error ?? {};
        const code = error.code ?? "";
        const message = error.message ?? "Unknown error";

        if (code === "previous_response_not_found") {
          throw new _PreviousResponseNotFoundError(message);
        } else if (code === "websocket_connection_limit_reached") {
          throw new _ConnectionLimitReachedError(message);
        } else {
          await this.pushError(`WebSocket API error: ${message}`);
          break;
        }
      }
    }

    // Process any function calls
    if (functionCalls.size > 0) {
      const fcList = this._processFunctionCalls(context, functionCalls);
      await this.runFunctionCalls(fcList);
    }
  }
}

addVirtualBase(OpenAIResponsesLLMService, _BaseOpenAIResponsesLLMService);

// ---------------------------------------------------------------------------
// HTTP variant
// ---------------------------------------------------------------------------

/** A streamed Responses API event (`openai.types.responses.ResponseStreamEvent`). */
export type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
/** A Responses API usage (`openai.types.responses.ResponseUsage`). */
export type ResponseUsage = OpenAI.Responses.ResponseUsage;
/** The async stream of events returned by a streaming Responses API call. */
export type ResponseStream = AsyncIterable<ResponseStreamEvent> & {
  controller?: AbortController;
};

/**
 * OpenAI Responses API LLM service using HTTP streaming transport.
 *
 * Uses server-sent events (SSE) via the OpenAI SDK for streaming inference.
 * Each `_processContext` call opens a new HTTP connection.
 *
 * Unlike the WebSocket variant, this service does not use
 * `previous_response_id` for incremental context delivery by default (or at
 * all, yet). Over HTTP, `previous_response_id` requires `store=true`, which
 * enables OpenAI-side 30-day conversation storage — a privacy/compliance
 * tradeoff that many users won't want. The WebSocket variant avoids this
 * because its `previous_response_id` uses a connection-local in-memory cache
 * that works with `store=false` (nothing is stored long-term).
 *
 * @example
 * const llm = new OpenAIResponsesHttpLLMService({
 *   apiKey: getEnv("OPENAI_API_KEY"),
 *   settings: new OpenAIResponsesHttpLLMService.Settings({
 *     systemInstruction: "You are a helpful assistant.",
 *   }),
 * });
 */
export class OpenAIResponsesHttpLLMService extends _BaseOpenAIResponsesLLMService {
  static {
    const proto = OpenAIResponsesHttpLLMService.prototype as unknown as Record<string, any>;
    proto._processContext = tracedLlm(proto._processContext);
  }

  /**
   * Process frames for LLM completion requests.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof LLMContextFrame) {
      try {
        await this.pushFrame(new LLMFullResponseStartFrame());
        await this.startProcessingMetrics();
        await this._processContext(frame.context);
      } catch (e) {
        rethrowIfCancelled(e);
        if (isTimeoutException(e)) {
          await this._callEventHandler("on_completion_timeout");
          await this.pushError("LLM completion timeout", { exception: e });
        } else {
          await this.pushError(`Error during inference: ${errorMessage(e)}`, { exception: e });
        }
      } finally {
        await this.stopProcessingMetrics();
        await this.pushFrame(new LLMFullResponseEndFrame());
      }
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Report a response's token usage, if it carries any. */
  protected async _reportUsage(usage: ResponseUsage | null | undefined): Promise<void> {
    if (!usage) {
      return;
    }
    await this.startLlmUsageMetrics(this._tokenUsage(usage));
  }

  /**
   * Open a streaming Responses API request, retrying once on timeout.
   *
   * @param params Parameters for the Responses API call.
   * @returns Async stream of response events.
   */
  protected async _createStream(params: Dict): Promise<ResponseStream> {
    const create = (): Promise<ResponseStream> =>
      abortable(
        this._client.responses.create(params as any, {
          signal: currentSignal(),
        }) as unknown as PromiseLike<ResponseStream>,
      );

    if (!this._retryOnTimeout) {
      return await create();
    }

    try {
      return await waitFor(() => create(), this._retryTimeoutSecs);
    } catch (e) {
      if (e instanceof TimeoutError || e instanceof APIConnectionTimeoutError) {
        // Retry, this time without a timeout so we get a response
        logger.debug(`${this}: Retrying response creation due to timeout`);
        return await create();
      }
      throw e;
    }
  }

  /**
   * Convert a response's usage into Pipecat's token usage.
   *
   * Subclasses for servers that report usage fields OpenAI doesn't override
   * this.
   *
   * @param usage The usage reported with the response.
   * @returns The token usage to report.
   */
  protected _tokenUsage(usage: ResponseUsage): LLMTokenUsage {
    // Third-party Responses API servers may omit fields the OpenAI SDK treats
    // as required. Anything omitted is left undefined — at the top level
    // (token counts), as a missing detail sub-object, or as a missing field
    // inside one. Coalesce each to 0 so a partial usage payload can't raise or
    // leak null into metrics.
    const inputDetails = usage.input_tokens_details as Dict | null | undefined;
    const outputDetails = usage.output_tokens_details as Dict | null | undefined;
    return new LLMTokenUsage({
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      cacheReadInputTokens: inputDetails ? inputDetails.cached_tokens || 0 : 0,
      cacheCreationInputTokens: inputDetails ? inputDetails.cache_write_tokens || 0 : 0,
      reasoningTokens: outputDetails ? outputDetails.reasoning_tokens || 0 : 0,
    });
  }

  /** Traced with `tracedLlm` (see the static block). */
  protected async _processContext(context: LLMContext): Promise<void> {
    const adapter = this.getLlmAdapter();
    this._logLlmResponse(context);

    const invocationParams = await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
    });

    const params = this._buildResponseParams(invocationParams);

    await this.startTtfbMetrics();

    const stream = await this._createStream(params);

    // Track function calls across stream events
    // item_id -> {name, call_id, arguments}
    let functionCalls = new Map<string, ResponsesFunctionCallData>();
    // item_id -> accumulated arguments
    const currentArguments = new Map<string, string>();
    let reasoningSummaryOpen = false;
    let streamErrored = false;
    let hasText = false;

    // Ensure the stream and its async iterator are closed on
    // cancellation/exception to release the HTTP connection. Each event is
    // awaited as a cancellation point, since the SDK's iterator is a foreign
    // await.
    const eventIter = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await abortable(eventIter.next());
        if (next.done) break;
        const event = next.value as Dict;

        if (event.type === "response.output_text.delta") {
          await this.stopTtfbMetrics();
          hasText = hasText || (event.delta as string).trim().length > 0;
          await this._pushLlmText(event.delta);
        } else if (event.type === "response.reasoning_summary_text.delta") {
          await this.stopTtfbMetrics();
          if (!reasoningSummaryOpen) {
            await this.pushFrame(new LLMThoughtStartFrame());
            reasoningSummaryOpen = true;
          }
          await this.pushFrame(new LLMThoughtTextFrame({ text: event.delta }));
        } else if (event.type === "response.output_item.added") {
          await this.stopTtfbMetrics();
          const item: Dict = event.item;
          if (item?.type === "function_call") {
            // A turn that only calls tools produces no answer text, so the
            // call itself is what the caller gets and TTFAT ends here rather
            // than going unmeasured.
            await this.stopTtfatMetrics();
            const itemId: string = item.id || "";
            functionCalls.set(itemId, {
              name: item.name,
              call_id: item.call_id,
              arguments: "",
            });
            currentArguments.set(itemId, "");
          }
        } else if (event.type === "response.function_call_arguments.delta") {
          const itemId: string = event.item_id;
          if (currentArguments.has(itemId)) {
            currentArguments.set(itemId, currentArguments.get(itemId)! + event.delta);
          }
        } else if (event.type === "response.function_call_arguments.done") {
          const itemId: string = event.item_id;
          const call = functionCalls.get(itemId);
          if (call) {
            call.arguments = event.arguments;
          }
        } else if (event.type === "response.output_item.done") {
          const item: Dict = event.item;
          if (item?.type === "function_call") {
            const itemId: string = item.id || "";
            const call = functionCalls.get(itemId);
            if (call) {
              call.name = item.name;
              call.call_id = item.call_id;
              call.arguments = item.arguments;
            }
          } else if (item?.type === "reasoning") {
            if (reasoningSummaryOpen) {
              await this.pushFrame(new LLMThoughtEndFrame());
              reasoningSummaryOpen = false;
            }
            await this._appendReasoningMessage(
              item.id ?? null,
              ((item.summary || []) as Dict[]).map((s) => ({
                type: "summary_text",
                text: s.text,
              })),
              item.encrypted_content ?? null,
            );
          }
        } else if (event.type === "response.completed") {
          const response: Dict = event.response;
          await this._reportUsage(response.usage);

          // This field is used by tracedLlm for more detailed model name in
          // tracing spans
          this._fullModelName = response.model;

          if (!hasText && functionCalls.size === 0) {
            await this._reportEmptyResponse(response.id, response.output as Dict[]);
          }
        } else if (event.type === "response.failed") {
          await this._reportUsage(event.response.usage);
          // As with usage, the detail objects and their fields are only as
          // reliable as the server; coalesce to a generic message so a sparse
          // payload still reports something.
          const error = event.response.error;
          const message = error ? error.message : null;
          await this.pushError(`LLM response error: ${message || "Response failed"}`);
          streamErrored = true;
          break;
        } else if (event.type === "response.incomplete") {
          await this._reportUsage(event.response.usage);
          const details = event.response.incomplete_details;
          const reason = details ? details.reason : null;
          await this.pushError(`LLM response error: ${reason || "Response incomplete"}`);
          streamErrored = true;
          break;
        } else if (event.type === "error") {
          await this.pushError(`Responses API error: ${event.message}`);
          streamErrored = true;
          break;
        }
      }
    } finally {
      // Close the iterator first, then abort the request to release HTTP
      // resources.
      try {
        await eventIter.return?.();
      } catch (e) {
        rethrowIfCancelled(e);
      }
      stream.controller?.abort();
    }

    // A stream that ended in a terminal error may have announced a function
    // call whose arguments never finished streaming — drop those rather than
    // run them with fabricated empty arguments. `arguments` is only written
    // by the Done events, so a non-empty string means the call completed
    // (e.g. parallel tool calls finished before a later item was truncated)
    // and it still runs.
    if (streamErrored) {
      functionCalls = new Map([...functionCalls].filter(([, call]) => call.arguments));
    }

    // Process any function calls
    if (functionCalls.size > 0) {
      const fcList = this._processFunctionCalls(context, functionCalls);
      await this.runFunctionCalls(fcList);
    }
  }
}
