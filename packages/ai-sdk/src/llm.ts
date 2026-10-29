// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * LLM service that runs any Vercel AI SDK language model.
 *
 * The AI SDK (`ai`) gives one interface to many providers (`@ai-sdk/openai`,
 * `@ai-sdk/google`, `@ai-sdk/anthropic`, Ollama and community providers, the
 * AI Gateway). `AISDKLLMService` streams a model's reply with `streamText()`
 * and behaves like pipedog's native LLM services: it consumes
 * `LLMContextFrame`s and pushes `LLMFullResponseStartFrame`, `LLMTextFrame`s
 * and `LLMFullResponseEndFrame`.
 *
 * Tools are sent without `execute` functions, so the AI SDK returns the
 * model's tool calls and pipedog's own function-call machinery
 * (`registerFunction`, `FunctionSchema` handlers, direct functions) runs them
 * and re-prompts the model with the results, as with every other LLM service.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
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
import { LLMService, type LLMServiceOptions } from "@pipedog/core/services/llm_service";
import { LLMSettings, type LLMSettingsOptions } from "@pipedog/core/services/settings";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { isTimeoutException } from "@pipedog/core/utils/http";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  Output,
  streamText,
  type ToolSet,
} from "ai";
import {
  AISDKLLMAdapter,
  type AISDKLLMInvocationParams,
  type AISDKProviderMetadataMessage,
  type ProviderOptions,
} from "./ai_sdk_adapter.ts";

export interface AISDKLLMSettingsOptions extends LLMSettingsOptions {
  /** Sequences that stop generation. */
  stopSequences?: string[] | null | NotGiven;
  /**
   * Provider-specific options, keyed by provider (the AI SDK's
   * `providerOptions`), e.g. `{ google: { thinkingConfig: { thinkingBudget: 0 } } }`.
   */
  providerOptions?: ProviderOptions | null | NotGiven;
}

/**
 * Settings for AISDKLLMService.
 *
 * The common sampling fields map to the AI SDK's call settings:
 * `temperature`, `maxTokens` (`maxOutputTokens`), `topP`, `topK`,
 * `frequencyPenalty`, `presencePenalty` and `seed`. `null` leaves a field to
 * the provider's default.
 *
 * - `stopSequences`: sequences that stop generation.
 * - `providerOptions`: provider-specific options, keyed by provider.
 * - `extra`: merged into the `streamText()` call as is.
 * - `model`: the model ID. Changing it at runtime switches models only when
 *   the service can build a model from an ID (see `AISDKLLMServiceOptions.provider`).
 */
export class AISDKLLMSettings extends LLMSettings {
  stopSequences: string[] | null | NotGiven = NOT_GIVEN;
  providerOptions: ProviderOptions | null | NotGiven = NOT_GIVEN;

  constructor(options: AISDKLLMSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AISDKLLMServiceOptions extends LLMServiceOptions {
  /**
   * The AI SDK language model, e.g. `openai("gpt-4.1-mini")`,
   * `google("gemini-2.5-flash")`, `anthropic("claude-sonnet-4-5")`, or a
   * model ID string for the AI SDK's global provider (the AI Gateway by
   * default).
   */
  model: LanguageModel;
  /**
   * Builds a model from a model ID, e.g. the provider instance (`google`,
   * `openai`, `createOllama(...)`). With it, changing `settings.model` at
   * runtime (`LLMUpdateSettingsFrame`) switches the model.
   */
  provider?: ((modelId: string) => LanguageModel) | null;
  /** Runtime-updatable settings. Given fields override the defaults. */
  settings?: AISDKLLMSettings | null;
  /**
   * AI SDK tools sent on every request alongside the context's tools, such
   * as provider-defined tools (`google.tools.googleSearch({})`,
   * `openai.tools.webSearch({})`). Your own functions belong in the
   * context's `ToolsSchema`, so pipedog runs them.
   */
  tools?: ToolSet | null;
  /** Maximum retries of a failed request (the AI SDK's `maxRetries`). Defaults to 2. */
  maxRetries?: number | null;
  /** Additional HTTP headers sent with each request. */
  headers?: Record<string, string> | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A given, non-null settings value, or undefined (which the AI SDK omits). */
function given<T>(value: T | null | NotGiven): T | undefined {
  return isGiven(value) && value !== null ? (value as T) : undefined;
}

/** The ID of a language model (a string model is its own ID). */
function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * LLM service for any Vercel AI SDK language model.
 *
 * @example
 * import { google } from "@ai-sdk/google";
 * import { AISDKLLMService } from "@pipedog/ai-sdk";
 *
 * const llm = new AISDKLLMService({
 *   model: google("gemini-2.5-flash"),
 *   settings: new AISDKLLMService.Settings({
 *     systemInstruction: "You are a helpful voice assistant.",
 *     temperature: 0.7,
 *   }),
 * });
 */
export class AISDKLLMService extends LLMService<AISDKLLMAdapter> {
  static Settings: typeof AISDKLLMSettings = AISDKLLMSettings;
  static override adapterClass = AISDKLLMAdapter;
  static override supportsResponseSchema = true;
  declare protected _settings: AISDKLLMSettings;

  protected _languageModel: LanguageModel;
  protected _provider: ((modelId: string) => LanguageModel) | null;
  protected _tools: ToolSet | null;
  protected _maxRetries: number | null;
  protected _headers: Record<string, string> | null;
  protected _warnedModelChange = false;

  /**
   * @param options.model The AI SDK language model.
   * @param options.provider Builds a model from an ID, for runtime model changes.
   * @param options.settings Runtime-updatable settings.
   * @param options.tools AI SDK tools (e.g. provider-defined) sent on every request.
   * @param options.maxRetries Maximum retries of a failed request.
   * @param options.headers Additional HTTP headers.
   *   Other options are passed to the parent LLMService.
   */
  constructor(options: AISDKLLMServiceOptions) {
    const cls = new.target as typeof AISDKLLMService;
    const defaultSettings = new cls.Settings({
      model: modelIdOf(options.model),
      systemInstruction: null,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      stopSequences: null,
      providerOptions: null,
      filterIncompleteUserTurns: false,
      userTurnCompletionConfig: null,
      extra: {},
    });
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });
    this._provider = options.provider ?? null;
    this._languageModel = this._modelFor(assertGiven(this._settings.model), options.model);
    this._tools = options.tools ?? null;
    this._maxRetries = options.maxRetries ?? null;
    this._headers = options.headers ?? null;

    if (this._settings.systemInstruction) {
      logger.debug(`${this}: Using system instruction: ${this._settings.systemInstruction}`);
    }
  }

  /** The AI SDK language model this service runs. */
  get languageModel(): LanguageModel {
    return this._languageModel;
  }

  /**
   * Switch to another AI SDK language model, from any provider.
   *
   * @param model The model to use from the next inference on.
   */
  setLanguageModel(model: LanguageModel): void {
    this._languageModel = model;
    this._settings.model = modelIdOf(model);
  }

  /**
   * The model to use for a model ID: the given model when the ID is its own,
   * else one built by the provider, else the ID itself when the model was
   * given as a string (the AI SDK's global provider).
   */
  protected _modelFor(modelId: string | null, current: LanguageModel): LanguageModel {
    if (modelId === null || modelId === modelIdOf(current)) return current;
    if (this._provider !== null) return this._provider(modelId);
    if (typeof current === "string") return modelId;
    if (!this._warnedModelChange) {
      this._warnedModelChange = true;
      logger.warning(
        `${this}: can't switch to model ${modelId} without a \`provider\`; ` +
          `keeping ${modelIdOf(current)}. Pass \`provider\` or call setLanguageModel().`,
      );
    }
    this._settings.model = modelIdOf(current);
    return current;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True: TTFB, processing time and token usage are reported.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  protected override async _updateSettings(delta: LLMSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if ("model" in changed) {
      this._languageModel = this._modelFor(
        given(this._settings.model as string | null | NotGiven) ?? null,
        this._languageModel,
      );
    }
    return changed;
  }

  /**
   * Build the AI SDK call options shared by streaming and one-shot calls.
   *
   * Subclasses can override this to add or change options.
   *
   * @param params The context's instructions, messages, tools and tool choice.
   * @returns Options for `streamText()` / `generateText()`.
   */
  buildCallOptions(params: AISDKLLMInvocationParams): Record<string, any> {
    const s = this._settings;
    const tools =
      params.tools || this._tools ? { ...(this._tools ?? {}), ...(params.tools ?? {}) } : undefined;
    const options: Record<string, any> = {
      model: this._languageModel,
      instructions: params.instructions,
      messages: params.messages,
      tools,
      toolChoice: tools ? params.toolChoice : undefined,
      temperature: given(s.temperature),
      maxOutputTokens: given(s.maxTokens),
      topP: given(s.topP),
      topK: given(s.topK),
      frequencyPenalty: given(s.frequencyPenalty),
      presencePenalty: given(s.presencePenalty),
      seed: given(s.seed),
      stopSequences: given(s.stopSequences),
      providerOptions: given(s.providerOptions),
      maxRetries: this._maxRetries ?? undefined,
      headers: this._headers ?? undefined,
    };
    Object.assign(options, s.extra);
    for (const key of Object.keys(options)) {
      if (options[key] === undefined) delete options[key];
    }
    return options;
  }

  /**
   * Convert the AI SDK's usage into Pipecat's token usage.
   *
   * @param usage The usage reported for the response.
   * @returns The token usage to report.
   */
  protected _tokenUsage(usage: LanguageModelUsage): LLMTokenUsage {
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;
    return new LLMTokenUsage({
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
      cacheReadInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
      cacheCreationInputTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    });
  }

  /**
   * Run a one-shot, out-of-band (i.e. out-of-pipeline) inference with the
   * given LLM context.
   *
   * @param context The LLM context containing conversation history.
   * @param options.maxTokens Maximum number of tokens to generate, overriding
   *   the `maxTokens` setting.
   * @param options.systemInstruction System instruction for this inference,
   *   overriding the service's.
   * @param options.responseSchema JSON schema the reply must follow. The AI SDK
   *   asks the provider to enforce it (or falls back to JSON mode), so the
   *   reply is JSON text.
   * @returns The LLM's response, or null if it generated none.
   */
  override async runInference(
    context: LLMContext,
    options: {
      maxTokens?: number | null;
      systemInstruction?: string | null;
      responseSchema?: Record<string, unknown> | null;
    } = {},
  ): Promise<string | null> {
    const systemInstruction =
      options.systemInstruction || assertGiven(this._settings.systemInstruction);
    const params = await this.getLlmAdapter().getLlmInvocationParams(context, {
      systemInstruction,
    });
    const callOptions = this.buildCallOptions(params);
    if (options.maxTokens !== undefined && options.maxTokens !== null) {
      callOptions.maxOutputTokens = options.maxTokens;
    }
    const responseSchema = this._checkResponseSchema(options.responseSchema);
    if (responseSchema !== null) {
      callOptions.output = Output.object({
        schema: jsonSchema(responseSchema as Parameters<typeof jsonSchema>[0]),
      });
    }
    const result = await abortable(
      generateText({
        ...callOptions,
        abortSignal: currentSignal(),
      } as unknown as Parameters<typeof generateText>[0]),
    );
    return result.text || null;
  }

  protected async _processContext(context: LLMContext): Promise<void> {
    const adapter = this.getLlmAdapter();
    this._logLlmResponse(context);

    await this.startTtfbMetrics();

    const params = await adapter.getLlmInvocationParams(context, {
      systemInstruction: assertGiven(this._settings.systemInstruction),
    });

    const result = streamText({
      ...this.buildCallOptions(params),
      abortSignal: currentSignal(),
      // Errors arrive as stream parts and are raised below; the default
      // handler would also print them to the console.
      onError: () => {},
    } as unknown as Parameters<typeof streamText>[0]);

    const functionCalls: FunctionCallFromLLM[] = [];
    let tokenUsage: LLMTokenUsage | null = null;
    let text = "";
    let textMetadata: ProviderOptions | null = null;
    let inThought = false;

    // Each part is awaited as a cancellation point, since the AI SDK's stream
    // is a foreign await. Cancelling the task (an interruption) aborts the
    // request through `abortSignal`.
    const iterator = result.fullStream[Symbol.asyncIterator]();
    try {
      try {
        while (true) {
          const next = await abortable(iterator.next());
          if (next.done) break;
          const part = next.value;
          switch (part.type) {
            case "text-delta":
              await this.stopTtfbMetrics();
              if (part.text) {
                text += part.text;
                await this._pushLlmText(part.text);
              }
              if (part.providerMetadata) textMetadata = part.providerMetadata;
              break;
            case "text-start":
            case "text-end":
              if (part.providerMetadata) textMetadata = part.providerMetadata;
              break;
            case "reasoning-start":
              await this.stopTtfbMetrics();
              inThought = true;
              await this.pushFrame(
                new LLMThoughtStartFrame({
                  appendToContext: true,
                  llm: adapter.idForLlmSpecificMessages,
                }),
              );
              break;
            case "reasoning-delta":
              if (part.text) await this.pushFrame(new LLMThoughtTextFrame({ text: part.text }));
              break;
            case "reasoning-end":
              if (inThought) {
                inThought = false;
                await this.pushFrame(
                  new LLMThoughtEndFrame({ signature: part.providerMetadata ?? null }),
                );
              }
              break;
            case "tool-input-start":
              await this.stopTtfbMetrics();
              break;
            case "tool-call": {
              await this.stopTtfbMetrics();
              // A turn that only calls tools produces no answer text, so the
              // call itself is what the caller gets and TTFAT ends here.
              await this.stopTtfatMetrics();
              if (part.providerExecuted) break;
              const call = this._functionCallFromPart(context, part);
              if (call !== null) functionCalls.push(call);
              if (part.providerMetadata) {
                await this._saveProviderMetadata(part.providerMetadata, {
                  tool_call_id: part.toolCallId,
                });
              }
              break;
            }
            case "finish-step":
              if (part.response?.modelId) {
                logger.trace(`${this}: response from model ${part.response.modelId}`);
              }
              break;
            case "finish":
              tokenUsage = this._tokenUsage(part.totalUsage);
              break;
            case "error":
              throw part.error;
            default:
              break;
          }
        }
      } finally {
        if (inThought) {
          await this.pushFrame(new LLMThoughtEndFrame());
        }
        try {
          await iterator.return?.();
        } catch (e) {
          rethrowIfCancelled(e);
        }
      }
    } finally {
      // Report even if the response is interrupted or cancelled mid-stream.
      if (tokenUsage) {
        await this.startLlmUsageMetrics(tokenUsage);
      }
    }

    if (text && textMetadata) {
      await this._saveProviderMetadata(textMetadata, { text });
    }

    if (functionCalls.length > 0) {
      await this.runFunctionCalls(functionCalls);
    }
  }

  /** Build the function call for a streamed tool call, or null if its input is unusable. */
  protected _functionCallFromPart(
    context: LLMContext,
    part: { toolCallId: string; toolName: string; input: unknown },
  ): FunctionCallFromLLM | null {
    let args: unknown = part.input;
    if (typeof args === "string") {
      try {
        args = args.trim() ? pyJsonLoads(args) : {};
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`${this}: Failed to parse function call arguments: ${args}`);
        return null;
      }
    }
    if (args === null || args === undefined) args = {};
    return new FunctionCallFromLLM({
      context,
      toolCallId: part.toolCallId,
      functionName: part.toolName,
      arguments: args as Record<string, unknown>,
    });
  }

  /**
   * Keep provider metadata that came with the output in the context, so it is
   * sent back with that output on later turns (e.g. Gemini thought signatures).
   */
  protected async _saveProviderMetadata(
    providerMetadata: ProviderOptions,
    bookmark: AISDKProviderMetadataMessage["bookmark"],
  ): Promise<void> {
    const message: AISDKProviderMetadataMessage = {
      type: "provider_metadata",
      providerMetadata,
      bookmark,
    };
    await this.pushFrame(
      new LLMMessagesAppendFrame({
        messages: [this.getLlmAdapter().createLlmSpecificMessage(message)],
      }),
    );
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
          frame.context.removeInvalidFileMessage();
        } else {
          // Only payload-shaped rejections (bad request, payload too large,
          // unprocessable content) are grounds to drop a pending file
          // message; when one is removed the context is repaired, so the
          // error is an application error rather than a permanent one.
          const status = APICallError.isInstance(e) ? e.statusCode : undefined;
          const removed =
            (status === 400 || status === 413 || status === 422) &&
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

// @traced_llm on `_processContext`, as the native LLM services.
{
  const proto = AISDKLLMService.prototype as unknown as Record<string, unknown>;
  proto._processContext = tracedLlm(proto._processContext);
}
