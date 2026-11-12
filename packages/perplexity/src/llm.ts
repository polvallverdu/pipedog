// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/perplexity/llm.py

/**
 * Perplexity LLM service implementations.
 *
 * This module provides services for Perplexity's Agent API, which answers with
 * web search over the OpenAI Responses protocol, and for its Sonar chat
 * completions API, which Perplexity no longer supports.
 *
 * Porting notes:
 * - `PerplexityLLMService` (and its `PerplexityLLMSettings`), the Sonar chat
 *   completions service, is deprecated upstream since 1.13.0 and is not
 *   ported. Use `PerplexityAgentHttpLLMService`.
 * - Upstream's `isinstance` checks on the OpenAI SDK's event classes are
 *   checks of the event's `type` (and its item's `type`), since the JS SDK's
 *   streamed events are plain objects.
 * - DIVERGENCE: the JS SDK has no `extra_body` request option and sends
 *   unknown params as-is. The request params keep upstream's `extra_body`
 *   entry, and the service's client merges it into the request JSON (see
 *   `_createClient`).
 */

import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { LLMSettings } from "@pipedog/core/services/settings";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import type { OpenAIResponsesLLMInvocationParams } from "@pipedog/openai/open_ai_responses_adapter";
import {
  type BaseOpenAIResponsesLLMServiceMembers,
  type BaseOpenAIResponsesLLMServiceOptions,
  type OpenAIResponsesClientOptions,
  OpenAIResponsesHttpLLMService,
  OpenAIResponsesLLMSettings,
  type OpenAIResponsesLLMSettingsOptions,
  type ResponseStream,
  type ResponseStreamEvent,
  type ResponseUsage,
} from "@pipedog/openai/responses/llm";

type Dict = Record<string, any>;

/** The OpenAI SDK client the Responses services use. */
type ResponsesClient = BaseOpenAIResponsesLLMServiceMembers["_client"];

export interface PerplexityAgentLLMSettingsOptions extends OpenAIResponsesLLMSettingsOptions {
  /** Perplexity preset (see `PerplexityAgentLLMSettings`). */
  preset?: string | null | NotGiven;
  /** Whether to offer the `web_search` tool on every request. */
  webSearch?: boolean | NotGiven;
  /** Maximum number of search and reasoning steps per response. */
  maxSteps?: number | null | NotGiven;
}

/**
 * Settings for PerplexityAgentHttpLLMService.
 *
 * - `preset`: Perplexity preset that sets the model, its instructions, its
 *   search budget and how much it reasons, such as `"fast"`, `"low"`,
 *   `"medium"`, `"high"` or `"xhigh"`. `model` replaces the preset's model;
 *   set `model: null` to use it. With `null`, a model must be set, and a
 *   request with no `reasoning` either gets the `"fast"` preset.
 * - `webSearch`: whether to offer the `web_search` tool on every request,
 *   alongside any tools from the context. A preset searches the web whatever
 *   this is set to.
 * - `maxSteps`: maximum number of search and reasoning steps per response.
 *   `null` leaves Perplexity's default.
 */
export class PerplexityAgentLLMSettings extends OpenAIResponsesLLMSettings {
  preset: string | null | NotGiven = NOT_GIVEN;
  webSearch: boolean | NotGiven = NOT_GIVEN;
  maxSteps: number | null | NotGiven = NOT_GIVEN;

  constructor(options: PerplexityAgentLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

const _MODEL_OR_PRESET_REQUIRED =
  "PerplexityAgentHttpLLMService needs a `model`, a `preset`, or both.";

function _hasModelOrPreset(settings: PerplexityAgentLLMSettings): boolean {
  return Boolean(assertGiven(settings.model) || assertGiven(settings.preset));
}

// Perplexity's lowest-latency preset, which keeps reasoning low for models from
// every provider it serves.
const _THINKING_DEFAULT: Record<string, Record<string, unknown>> = {
  extra_body: { preset: "fast" },
};

/**
 * Merge a request's `extra_body` into the request JSON, as the Python SDK
 * does with its `extra_body` keyword argument.
 */
function _mergeExtraBody(params: Dict): Dict {
  if (!params || typeof params !== "object" || !("extra_body" in params)) {
    return params;
  }
  const { extra_body: extraBody, ...rest } = params;
  return { ...rest, ...((extraBody as Dict | null | undefined) ?? {}) };
}

/**
 * A Responses event stream without the function calls the server runs itself.
 *
 * With a preset, Perplexity runs its web search on the server: it announces
 * the search as a function call and completes that output as another kind of
 * item, such as `search_results`. Each function call's announcement is held
 * until its output completes, and dropped unless it completes as a function
 * call, so the search never reaches the service as a call to run. The service
 * takes a call's arguments from its completed item, so argument events pass
 * through.
 */
export class _WithoutServerToolCalls implements AsyncIterable<ResponseStreamEvent> {
  #stream: ResponseStream;

  constructor(stream: ResponseStream) {
    this.#stream = stream;
  }

  /** The underlying stream's abort controller, which releases the request. */
  get controller(): AbortController | undefined {
    return this.#stream.controller;
  }

  [Symbol.asyncIterator](): AsyncIterator<ResponseStreamEvent> {
    return this.#events();
  }

  async *#events(): AsyncGenerator<ResponseStreamEvent, void, undefined> {
    // output_index -> event
    const announced = new Map<number, ResponseStreamEvent>();
    const events = this.#stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await events.next();
        if (next.done) break;
        const event = next.value;
        const raw = event as Dict;
        if (raw.type === "response.output_item.added" && raw.item?.type === "function_call") {
          announced.set(raw.output_index, event);
          continue;
        }
        if (raw.type === "response.output_item.done") {
          const added = announced.get(raw.output_index);
          announced.delete(raw.output_index);
          if (added && raw.item?.type === "function_call") {
            yield added;
          }
        }
        yield event;
      }
    } finally {
      // Closing the stream's iterator first releases the HTTP response
      // through its nested generators, as the service's own cleanup does.
      await events.return?.();
    }
  }

  /** Close the underlying stream. */
  async close(): Promise<void> {
    this.#stream.controller?.abort();
  }
}

export interface PerplexityAgentHttpLLMServiceOptions extends BaseOpenAIResponsesLLMServiceOptions {
  /** The API key for accessing Perplexity's API. */
  apiKey?: string | null;
  /** The base URL for Perplexity's API. Defaults to `"https://api.perplexity.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings. */
  settings?: PerplexityAgentLLMSettings | null;
}

/**
 * A service for Perplexity's Agent API.
 *
 * The Agent API answers questions with web search, using models from
 * Perplexity and other providers. It speaks the OpenAI Responses protocol
 * over HTTP, so function calling and multi-turn context work as they do with
 * `OpenAIResponsesHttpLLMService`.
 *
 * By default the service uses `openai/gpt-5.6-luna` with web search on. When
 * neither `preset` nor `reasoning` is set, it sends Perplexity's `fast`
 * preset, its lowest-latency configuration, with the model in place of the
 * preset's own. Answers can carry citation markers such as `[1]`. Anthropic
 * models need `maxCompletionTokens` set.
 *
 * @example
 * const llm = new PerplexityAgentHttpLLMService({
 *   apiKey: getEnv("PERPLEXITY_API_KEY"),
 *   settings: new PerplexityAgentHttpLLMService.Settings({
 *     systemInstruction: "You are a helpful assistant.",
 *   }),
 * });
 */
export class PerplexityAgentHttpLLMService extends OpenAIResponsesHttpLLMService {
  static override Settings: typeof PerplexityAgentLLMSettings = PerplexityAgentLLMSettings;
  declare protected _settings: PerplexityAgentLLMSettings;

  /**
   * Initialize the Perplexity Agent API LLM service.
   *
   * @param options.apiKey The API key for accessing Perplexity's API.
   * @param options.baseUrl The base URL for Perplexity's API. Defaults to
   *   "https://api.perplexity.ai/v1".
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to OpenAIResponsesHttpLLMService.
   * @throws Error If the settings leave neither a model nor a preset.
   */
  constructor(options: PerplexityAgentHttpLLMServiceOptions = {}) {
    const cls = new.target as typeof PerplexityAgentHttpLLMService;
    const defaultSettings = new cls.Settings({
      model: "openai/gpt-5.6-luna",
      preset: null,
      webSearch: true,
      maxSteps: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    if (!_hasModelOrPreset(defaultSettings)) {
      throw new Error(_MODEL_OR_PRESET_REQUIRED);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.perplexity.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create the client, sending each request's `extra_body` in its JSON body.
   *
   * DIVERGENCE: the JS SDK has no `extra_body` option, so the client's
   * `responses.create` merges it into the request params.
   */
  override _createClient(options: OpenAIResponsesClientOptions = {}): ResponsesClient {
    const client = super._createClient(options);
    const responses = client.responses;
    const create = responses.create.bind(responses);
    responses.create = ((body: Dict, requestOptions?: unknown) =>
      (create as (...args: unknown[]) => unknown)(
        _mergeExtraBody(body),
        requestOptions,
      )) as unknown as typeof responses.create;
    return client;
  }

  /**
   * Apply a settings delta, reporting an update that leaves no model or
   * preset.
   *
   * @param delta A settings delta.
   * @returns Dict mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (!_hasModelOrPreset(this._settings)) {
      await this.pushError(_MODEL_OR_PRESET_REQUIRED);
    }
    return changed;
  }

  /**
   * Build parameters for an Agent API call.
   *
   * @param invocationParams Parameters derived from the LLM context.
   * @returns Dictionary of parameters for the Agent API call.
   */
  override _buildResponseParams(invocationParams: OpenAIResponsesLLMInvocationParams): Dict {
    const params = super._buildResponseParams(invocationParams);

    if (!params.model) {
      // The preset chooses the model.
      delete params.model;
    }

    if (assertGiven(this._settings.webSearch)) {
      const tools: Dict[] = [...((params.tools as Dict[] | null | undefined) || [])];
      if (!tools.some((tool) => tool.type === "web_search")) {
        tools.push({ type: "web_search" });
      }
      params.tools = tools;
    }

    // The OpenAI SDK rejects fields it doesn't know as keyword arguments, so
    // Perplexity's own fields go in the request body.
    const perplexityFields: Dict = {};
    const preset = assertGiven(this._settings.preset);
    if (preset) {
      perplexityFields.preset = preset;
    }
    const maxSteps = assertGiven(this._settings.maxSteps);
    if (maxSteps !== null && maxSteps !== undefined) {
      perplexityFields.max_steps = maxSteps;
    }
    if (Object.keys(perplexityFields).length > 0) {
      params.extra_body = { ...(params.extra_body ?? {}), ...perplexityFields };
    }

    return params;
  }

  /**
   * Open a streaming Agent API request without the server's own tool calls.
   *
   * @param params Parameters for the Agent API call.
   * @returns Async stream of response events.
   */
  protected override async _createStream(params: Dict): Promise<ResponseStream> {
    const stream = await super._createStream(params);
    // The service only iterates the stream and closes it.
    return new _WithoutServerToolCalls(stream);
  }

  /**
   * Send the `fast` preset when no preset or reasoning is configured.
   *
   * A request that already sets `reasoning` or a preset, from the settings or
   * from `extra`, is left as it is. So is every request when
   * `useProviderThinkingDefault` is set. The first request for each model
   * logs the preset sent, or that the model runs at Perplexity's default.
   *
   * @param params The response params dict (modified in place).
   */
  override _maybeApplyThinkingDefault(params: Dict): void {
    if (
      "reasoning" in params ||
      "preset" in (params.extra_body ?? {}) ||
      assertGiven(this._settings.preset)
    ) {
      return;
    }
    this._applyThinkingDefault(params, assertGiven(this._settings.model) || "", _THINKING_DEFAULT, {
      canThink: true,
      provider: "Perplexity",
      settingsFields: "`preset` or `reasoning`",
    });
  }

  /**
   * Convert a completed response's usage into Pipecat's token usage.
   *
   * Perplexity reports tokens written to the prompt cache as
   * `cache_creation_input_tokens`.
   *
   * @param usage The usage reported with the completed response.
   * @returns The token usage to report.
   */
  protected override _tokenUsage(usage: ResponseUsage): LLMTokenUsage {
    const tokens = super._tokenUsage(usage);
    const details = usage.input_tokens_details as Dict | null | undefined;
    const cacheCreation = details ? details.cache_creation_input_tokens : null;
    if (cacheCreation) {
      tokens.cacheCreationInputTokens = cacheCreation;
    }
    return tokens;
  }
}
