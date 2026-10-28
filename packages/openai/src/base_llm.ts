// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/base_llm.py

/**
 * Base LLM service implementation for services that use the AsyncOpenAI client.
 *
 * Porting notes:
 * - The client is `OpenAI` from the official `openai` JS SDK, which talks
 *   through `fetch` and runs on every runtime. Subclasses for
 *   OpenAI-compatible providers override `createClient()`.
 * - The SDK's `NOT_GIVEN` sentinel is `undefined` (`OPENAI_NOT_GIVEN`), which
 *   leaves a field out of the request body. The store-mode settings hold it
 *   for the sampling fields that are unset, as upstream does.
 * - Upstream builds the client with an httpx client carrying connection limits
 *   (`DefaultAsyncHttpxClient(limits=connection_limits(...))`). `fetch` has no
 *   such object, so the SDK's own fetch is used.
 * - The JS SDK has no `extra_body` request option: it sends unknown params
 *   as-is. `extra_body` (from `_mergeExtraBody()` or `Settings.extra`) is
 *   merged into the request JSON just before sending, like the Python client.
 * - `APIStatusError` / `APITimeoutError` are `APIError` (with `status`) and
 *   `APIConnectionTimeoutError` in the JS SDK.
 * - Deprecated APIs are not ported: `BaseOpenAILLMService.InputParams` and the
 *   `model` / `params` constructor options.
 */

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
} from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  OPENAI_NOT_GIVEN,
  type OpenAILLMAdapter,
  type OpenAILLMInvocationParams,
  type OpenAINotGiven,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import {
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  BadRequestError,
  UnprocessableEntityError,
} from "openai";

/** A streamed chat completion chunk (`openai.types.chat.ChatCompletionChunk`). */
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
/** A chat completion's usage (`openai.types.CompletionUsage`). */
export type CompletionUsage = OpenAI.CompletionUsage;
/** The async stream of chunks returned by a streaming chat completion. */
export type ChatCompletionStream = AsyncIterable<ChatCompletionChunk> & {
  controller?: AbortController;
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OpenAILLMSettingsOptions extends LLMSettingsOptions {
  /** Maximum completion tokens to generate. */
  maxCompletionTokens?: number | null | NotGiven | OpenAINotGiven;
}

/**
 * Settings for BaseOpenAILLMService.
 *
 * - `maxCompletionTokens`: maximum completion tokens to generate.
 *
 * Upstream overrides the inherited sampling fields (`frequencyPenalty`,
 * `presencePenalty`, `seed`, `temperature`, `topP`, `maxTokens`) to also
 * accept the OpenAI SDK's sentinel, which the service stores there so those
 * fields can be passed through unchanged to the client. The SDK's sentinel is
 * `undefined` here, which TypeScript can't add to an inherited field's type;
 * the service writes it with `setOpenAINotGiven()`.
 */
export class OpenAILLMSettings extends LLMSettings {
  maxCompletionTokens: number | null | NotGiven | OpenAINotGiven = NOT_GIVEN;

  constructor(options: OpenAILLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** The settings fields that hold the OpenAI SDK's sentinel when unset. */
const OPENAI_SENTINEL_FIELDS = [
  "frequencyPenalty",
  "presencePenalty",
  "seed",
  "temperature",
  "topP",
  "maxTokens",
  "maxCompletionTokens",
] as const;

/**
 * Store the OpenAI SDK's "not given" sentinel (`OPENAI_NOT_GIVEN`) in the
 * given settings fields, so they are left out of requests.
 *
 * Options objects can't carry it (an `undefined` option means "not given" to
 * Pipecat), so services set it after building their default settings.
 *
 * @param settings Store-mode settings to update in place.
 * @param fields The fields to set. Defaults to every OpenAI sampling field.
 */
export function setOpenAINotGiven(
  settings: OpenAILLMSettings,
  fields: readonly (typeof OPENAI_SENTINEL_FIELDS)[number][] = OPENAI_SENTINEL_FIELDS,
): void {
  const self = settings as unknown as Record<string, unknown>;
  for (const name of fields) {
    self[name] = OPENAI_NOT_GIVEN;
  }
}

/**
 * OpenAI models that predate strict JSON schema replies: gpt-3.5, gpt-4 and
 * gpt-4-turbo, the first gpt-4o snapshot, chatgpt-4o and the o1 previews.
 */
export const OPENAI_MODEL_WITHOUT_RESPONSE_SCHEMA =
  /^(gpt-3\.5|gpt-4($|-)|gpt-4o-2024-05-13|chatgpt-4o|o1-mini|o1-preview)/;

/** Options for `BaseOpenAILLMService.createClient()`. */
export interface OpenAIClientOptions {
  /** OpenAI API key. If null, the SDK reads `OPENAI_API_KEY`. */
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

export interface BaseOpenAILLMServiceOptions extends LLMServiceOptions, OpenAIClientOptions {
  /** Service tier to use (e.g., "auto", "flex", "priority"). */
  serviceTier?: string | null;
  /**
   * Runtime-updatable settings. When provided, its given fields override the
   * service's defaults.
   */
  settings?: OpenAILLMSettings | null;
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

/**
 * Base class for all services that use the AsyncOpenAI client.
 *
 * This service consumes LLMContextFrame frames, which contain a reference to
 * an LLMContext object. The context defines what is sent to the LLM for
 * completion, including user, assistant, and system messages, as well as tool
 * choices and function call configurations.
 */
// The adapter's invocation params are a typed interface, which the generic
// constraint (`BaseLLMAdapter<Record<string, unknown>>`) doesn't accept as is.
type OpenAIAdapter = OpenAILLMAdapter & BaseLLMAdapter;

export class BaseOpenAILLMService extends LLMService<OpenAIAdapter> {
  static Settings: typeof OpenAILLMSettings = OpenAILLMSettings;
  declare protected _settings: OpenAILLMSettings;

  /**
   * Set by services for providers other than OpenAI. Without a key the OpenAI
   * client falls back to OPENAI_API_KEY and would send it to that provider.
   */
  static _requiresApiKey = false;

  /**
   * Whether this service's API supports the "developer" message role.
   *
   * OpenAI's native API supports it, but some OpenAI-compatible services
   * (e.g. Cerebras) do not. Subclasses that don't support it should set this
   * to `false`, which causes the adapter to convert "developer" messages to
   * "user" messages before sending them to the API.
   */
  static supportsDeveloperRole = true;

  /**
   * Whether the API can enforce a response schema. OpenAI-compatible services
   * whose API cannot should set this to `false`.
   */
  static override supportsResponseSchema = true;

  protected _serviceTier: string | null;
  protected _retryTimeoutSecs: number | null;
  protected _retryOnTimeout: boolean | null;
  protected _fullModelName = "";
  protected _client: OpenAI;

  /**
   * Initialize the BaseOpenAILLMService.
   *
   * @param options.apiKey OpenAI API key. If null, uses environment variable.
   * @param options.baseUrl Custom base URL for OpenAI API. If null, uses default.
   * @param options.organization OpenAI organization ID.
   * @param options.project OpenAI project ID.
   * @param options.defaultHeaders Additional HTTP headers to include in requests.
   * @param options.serviceTier Service tier to use (e.g., "auto", "flex", "priority").
   * @param options.settings Runtime-updatable settings.
   * @param options.retryTimeoutSecs How long an inference may go without
   *   producing output before it is abandoned and re-issued, when
   *   `retryOnTimeout` is set. Defaults to 5.0 seconds.
   * @param options.retryOnTimeout Whether to re-issue the request once if the
   *   first attempt produces no output within `retryTimeoutSecs`. The retry
   *   is unbounded.
   *   Other options are passed to the parent LLMService.
   * @throws Error If the service is for a provider other than OpenAI and
   *   `apiKey` is empty (upstream: ValueError).
   */
  constructor(options: BaseOpenAILLMServiceOptions = {}) {
    const cls = new.target as typeof BaseOpenAILLMService;
    if (cls._requiresApiKey && !options.apiKey) {
      throw new Error(`${cls.name} requires an api_key.`);
    }

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "gpt-4.1",
      systemInstruction: null,
      topK: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      extra: {},
    });
    setOpenAINotGiven(defaultSettings);

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    this._serviceTier = options.serviceTier ?? null;
    this._retryTimeoutSecs =
      options.retryTimeoutSecs === undefined ? 5.0 : options.retryTimeoutSecs;
    this._retryOnTimeout = options.retryOnTimeout === undefined ? false : options.retryOnTimeout;
    this._client = this.createClient(options);

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
   *   Other options are the service's constructor options, which subclasses
   *   may read.
   * @returns Configured AsyncOpenAI client instance.
   */
  createClient(options: OpenAIClientOptions = {}): OpenAI {
    return new OpenAI({
      apiKey: options.apiKey ?? undefined,
      baseURL: options.baseUrl ?? undefined,
      organization: options.organization ?? null,
      project: options.project ?? null,
      defaultHeaders: options.defaultHeaders ?? undefined,
    });
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as OpenAI service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set the full AI model name.
   *
   * @param fullModelName The full name of the AI model to use.
   */
  setFullModelName(fullModelName: string): void {
    this._fullModelName = fullModelName;
  }

  /**
   * Get the current full model name.
   *
   * @returns The full name of the AI model being used.
   */
  getFullModelName(): string {
    return this._fullModelName;
  }

  /** Whether this service's API supports the "developer" message role. */
  get supportsDeveloperRole(): boolean {
    return (this.constructor as typeof BaseOpenAILLMService).supportsDeveloperRole;
  }

  /**
   * Turn request parameters into the JSON body to send: `extra_body` is
   * merged in over the other fields, as the Python client does.
   */
  protected _requestBody(params: Record<string, any>): Record<string, any> {
    const { extra_body: extraBody, ...rest } = params;
    return { ...rest, ...(extraBody ?? {}) };
  }

  /**
   * Get streaming chat completions from OpenAI API with optional timeout and retry.
   *
   * @param context Context to use for the chat completion. Contains messages,
   *   tools, and tool choice.
   * @returns Async stream of chat completion chunks.
   */
  async getChatCompletions(context: LLMContext): Promise<ChatCompletionStream> {
    const adapter = this.getLlmAdapter();
    this._logLlmResponse(context);

    const paramsFromContext = await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
      convertDeveloperToUser: !this.supportsDeveloperRole,
    });

    const params = this.buildChatCompletionParams(paramsFromContext);
    const create = (): Promise<ChatCompletionStream> =>
      abortable(
        this._client.chat.completions.create(this._requestBody(params) as any, {
          signal: currentSignal(),
        }) as unknown as PromiseLike<ChatCompletionStream>,
      );

    if (this._retryOnTimeout) {
      try {
        const chunks = await waitFor(() => create(), this._retryTimeoutSecs);
        return chunks;
      } catch (e) {
        if (e instanceof TimeoutError || e instanceof APIConnectionTimeoutError) {
          // Retry, this time without a timeout so we get a response
          logger.debug(`${this}: Retrying chat completion due to timeout`);
          const chunks = await create();
          return chunks;
        }
        throw e;
      }
    } else {
      const chunks = await create();
      return chunks;
    }
  }

  /**
   * Build parameters for chat completion request.
   *
   * Subclasses can override this to customize parameters for different
   * providers.
   *
   * @param paramsFromContext Parameters, derived from the LLM context, to use
   *   for the chat completion. Contains messages, tools, and tool choice.
   * @returns Dictionary of parameters for the chat completion request.
   */
  buildChatCompletionParams(paramsFromContext: OpenAILLMInvocationParams): Record<string, any> {
    const params: Record<string, any> = {
      model: this._settings.model,
      stream: true,
      stream_options: { include_usage: true },
      frequency_penalty: this._settings.frequencyPenalty,
      presence_penalty: this._settings.presencePenalty,
      seed: this._settings.seed,
      temperature: this._settings.temperature,
      top_p: this._settings.topP,
      max_tokens: this._settings.maxTokens,
      max_completion_tokens: this._settings.maxCompletionTokens,
      service_tier: this._serviceTier !== null ? this._serviceTier : OPENAI_NOT_GIVEN,
    };

    // Messages, tools, tool_choice
    Object.assign(params, paramsFromContext);

    Object.assign(params, this._settings.extra);

    return params;
  }

  /**
   * Add provider-specific fields to a request's `extra_body`.
   *
   * The OpenAI client rejects keyword arguments it doesn't know, so fields
   * specific to an OpenAI-compatible provider travel in `extra_body`, which
   * the client merges into the request JSON as-is.
   *
   * @param params Request parameters, updated in place. An `extra_body`
   *   already there, supplied through `Settings.extra`, wins key by key,
   *   matching how `extra` overrides every other request parameter. It is
   *   copied rather than modified.
   * @param fields Fields to add. Unset and null values are omitted.
   */
  static _mergeExtraBody(params: Record<string, any>, fields: Record<string, unknown>): void {
    const extraBody: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (isGiven(value) && value !== null && value !== undefined) {
        extraBody[name] = value;
      }
    }
    Object.assign(extraBody, params.extra_body || {});
    if (Object.keys(extraBody).length > 0) {
      params.extra_body = extraBody;
    }
  }

  /**
   * Whether a model can enforce a response schema.
   *
   * OpenAI models before gpt-4o-mini and gpt-4o-2024-08-06 cannot.
   *
   * @param model The model name.
   */
  static override modelSupportsResponseSchema(model: string): boolean {
    return !OPENAI_MODEL_WITHOUT_RESPONSE_SCHEMA.test(model);
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the
   * given LLM context.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Optional maximum number of tokens to generate. If
   *   provided, overrides the service's default max_tokens /
   *   max_completion_tokens setting.
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
    const maxTokens = options.maxTokens ?? null;
    const effectiveInstruction =
      options.systemInstruction || assertGiven(this._settings.systemInstruction);
    const adapter = this.getLlmAdapter();
    const invocationParams = await adapter.getLlmInvocationParams(context, {
      systemInstruction: effectiveInstruction,
      convertDeveloperToUser: !this.supportsDeveloperRole,
    });

    // Build params using the same method as streaming completions
    const params = this.buildChatCompletionParams(invocationParams);

    // Override for non-streaming
    params.stream = false;
    delete params.stream_options;

    // Override max_tokens if provided
    if (maxTokens !== null) {
      // Use max_completion_tokens for newer models, fallback to max_tokens
      if ("max_completion_tokens" in params) {
        params.max_completion_tokens = maxTokens;
      } else {
        params.max_tokens = maxTokens;
      }
    }

    const responseSchema = this._checkResponseSchema(options.responseSchema);
    if (responseSchema !== null) {
      params.response_format = {
        type: "json_schema",
        json_schema: { name: "response", schema: responseSchema, strict: true },
      };
    }

    // LLM completion
    const response = (await abortable(
      this._client.chat.completions.create(this._requestBody(params) as any, {
        signal: currentSignal(),
      }),
    )) as OpenAI.Chat.Completions.ChatCompletion;

    return response.choices[0]?.message.content ?? null;
  }

  /**
   * Convert a chat completion's usage into Pipecat's token usage.
   *
   * Follows OpenAI's convention, where `completion_tokens` includes the
   * reasoning tokens reported in `completion_tokens_details`. Providers that
   * report reasoning elsewhere, or apart from `completion_tokens`, override
   * this.
   *
   * @param usage The usage reported with the completion.
   * @returns The token usage to report.
   */
  protected _tokenUsage(usage: CompletionUsage): LLMTokenUsage {
    const promptDetails = usage.prompt_tokens_details as
      | (Record<string, unknown> & { cached_tokens?: number | null })
      | null
      | undefined;
    const cachedTokens = promptDetails ? (promptDetails.cached_tokens ?? null) : null;
    // Tokens written into the prompt cache, billed above the input rate.
    // Providers without prompt caching omit the field, which reads as "not
    // reported" rather than zero.
    const cacheWriteTokens = promptDetails
      ? ((promptDetails.cache_write_tokens as number | null | undefined) ?? null)
      : null;
    const reasoningTokens = usage.completion_tokens_details
      ? (usage.completion_tokens_details.reasoning_tokens ?? null)
      : null;
    return new LLMTokenUsage({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheReadInputTokens: cachedTokens,
      cacheCreationInputTokens: cacheWriteTokens,
      reasoningTokens: reasoningTokens,
    });
  }

  protected async _processContext(context: LLMContext): Promise<void> {
    const functionsList: string[] = [];
    const argumentsList: string[] = [];
    const toolIdList: string[] = [];
    let funcIdx = 0;
    let functionName = "";
    let args = "";
    let toolCallId = "";

    await this.startTtfbMetrics();

    // Generate chat completions from LLMContext
    const chunkStream = await this.getChatCompletions(context);

    // Ensure the stream and its async iterator are closed on
    // cancellation/exception to release the HTTP connection. Each chunk is
    // awaited as a cancellation point, since the SDK's iterator is a foreign
    // await.
    const chunkIter = chunkStream[Symbol.asyncIterator]();

    // Providers differ in how often they send usage: some once at the end,
    // others a cumulative snapshot on every chunk. Holding the latest and
    // reporting it after the stream keeps that to one report per completion.
    let tokenUsage: LLMTokenUsage | null = null;

    try {
      try {
        while (true) {
          const next = await abortable(chunkIter.next());
          if (next.done) break;
          const chunk = next.value;

          if (chunk.usage) {
            tokenUsage = this._tokenUsage(chunk.usage);
          }

          if (chunk.model && this.getFullModelName() !== chunk.model) {
            this.setFullModelName(chunk.model);
          }

          if (chunk.choices === null || chunk.choices === undefined || chunk.choices.length === 0) {
            continue;
          }

          await this.stopTtfbMetrics();

          const delta = chunk.choices[0]?.delta as
            | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
                audio?: Record<string, unknown> | null;
              })
            | null
            | undefined;
          if (!delta) {
            continue;
          }

          if (delta.tool_calls && delta.tool_calls.length > 0) {
            // A turn that only calls tools produces no answer text, so the
            // call itself is what the caller gets and TTFAT ends here rather
            // than going unmeasured.
            await this.stopTtfatMetrics();

            // We're streaming the LLM response to enable the fastest response
            // times. For text, we just yield each chunk as we receive it and
            // count on consumers to do whatever coalescing they need (eg. to
            // pass full sentences to TTS)
            //
            // If the LLM is a function call, we'll do some coalescing here. If
            // the response contains a function name, we'll yield a frame to
            // tell consumers that they can start preparing to call the
            // function with that name. We accumulate all the arguments for the
            // rest of the streamed response, then when the response is done,
            // we package up all the arguments and the function name and yield
            // a frame containing the function name and the arguments.

            const toolCall = delta.tool_calls[0]!;
            if (toolCall.index !== funcIdx) {
              functionsList.push(functionName);
              argumentsList.push(args || "{}");
              toolIdList.push(toolCallId);
              functionName = "";
              args = "";
              toolCallId = "";
              funcIdx += 1;
            }
            if (toolCall.function?.name) {
              functionName += toolCall.function.name;
              toolCallId = toolCall.id as string;
            }
            if (toolCall.function?.arguments) {
              // Keep iterating through the response to collect all the argument fragments
              args += toolCall.function.arguments;
            }
          } else if (delta.content) {
            await this._pushLlmText(delta.content);
          }

          // When gpt-4o-audio / gpt-4o-mini-audio is used for llm or stt+llm
          // we need to get LLMTextFrame for the transcript
          else if (delta.audio?.transcript) {
            await this.pushFrame(new LLMTextFrame({ text: delta.audio.transcript as string }));
          }
        }
      } finally {
        // Close the iterator first, then abort the request to release HTTP
        // resources.
        try {
          await chunkIter.return?.();
        } catch (e) {
          rethrowIfCancelled(e);
        }
        chunkStream.controller?.abort();
      }
    } finally {
      // Report even if the response is interrupted or cancelled mid-stream.
      if (tokenUsage) {
        await this.startLlmUsageMetrics(tokenUsage);
      }
    }

    // if we got a function name and arguments, check to see if it's a function
    // with a registered handler. If so, run the registered callback, save the
    // result to the context, and re-prompt to get a chat answer. If we don't
    // have a registered handler, raise an exception.
    if (functionName) {
      // added to the list as last function name and arguments not added to the list
      functionsList.push(functionName);
      argumentsList.push(args || "{}");
      toolIdList.push(toolCallId);

      const functionCalls: FunctionCallFromLLM[] = [];

      for (let i = 0; i < functionsList.length; i++) {
        const name = functionsList[i]!;
        const rawArguments = argumentsList[i]!;
        const toolId = toolIdList[i]!;
        let parsedArguments: unknown;
        try {
          parsedArguments = pyJsonLoads(rawArguments);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this}: Failed to parse function call arguments: ${rawArguments}`);
          continue;
        }
        functionCalls.push(
          new FunctionCallFromLLM({
            context,
            toolCallId: toolId,
            functionName: name,
            arguments: parsedArguments as Record<string, unknown>,
          }),
        );
      }

      await this.runFunctionCalls(functionCalls);
    }
  }

  /**
   * Process frames for LLM completion requests.
   *
   * Handles LLMContextFrame to trigger LLM completions.
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
        } else if (e instanceof LLMContextConversionError) {
          await this.pushError(e.message, { exception: e });
          // A conversion failure (e.g. an unsupported file MIME type, corrupt
          // base64 data) can't reach the API at all, but is just as much
          // evidence of an invalid file as a rejection from OpenAI itself, so
          // it gets the same best-effort cleanup.
          frame.context.removeInvalidFileMessage();
        } else {
          // Only the payload-shaped errors (bad request, unprocessable
          // content, payload too large — the latter has no dedicated OpenAI
          // exception class, so match its status code) are grounds to remove
          // a pending file message on a best-effort basis. The rest of the
          // 4xx range — auth, permissions, not-found, rate limiting — says
          // nothing about whether our request (or its file) was bad, and
          // removing the file there would discard it for no benefit: the file
          // isn't what needs fixing before the next retry can succeed. When a
          // message is removed as a result of this error, the fault lay in
          // application-supplied content and the context is repaired, so the
          // error is pushed as APPLICATION instead of letting the rejection
          // classify as permanent and cost the service its usability.
          const removed =
            (e instanceof BadRequestError ||
              e instanceof UnprocessableEntityError ||
              (e instanceof APIError && e.status === 413)) &&
            frame.context.removeInvalidFileMessage();
          await this.pushError(`Error during completion: ${errorMessage(e)}`, {
            exception: e,
            category: removed ? ErrorCategory.APPLICATION : null,
          });
        }
      } finally {
        await this.stopProcessingMetrics();
        await this.pushFrame(new LLMFullResponseEndFrame());
      }
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

// @traced_llm on `_process_context`.
{
  const proto = BaseOpenAILLMService.prototype as unknown as Record<string, unknown>;
  proto._processContext = tracedLlm(proto._processContext);
}
