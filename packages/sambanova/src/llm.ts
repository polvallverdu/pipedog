// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/sambanova/llm.py

/**
 * SambaNova LLM service implementation using OpenAI-compatible interface.
 *
 * Porting notes:
 * - The deprecated `model` constructor option is not ported (use `settings`).
 * - Upstream closes the stream with `async with chunk_stream`. Here the
 *   stream's async iterator is closed (`return()`) and its request aborted
 *   (`controller.abort()`), as in BaseOpenAILLMService. Each chunk is awaited
 *   as a cancellation point, since the SDK's iterator is a foreign await.
 */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
import type { OpenAILLMInvocationParams } from "@pipedog/core/adapters/services/open_ai_adapter";
import { FunctionCallFromLLM } from "@pipedog/core/frames/frames";
import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import { tracedLlm } from "@pipedog/core/utils/tracing/service_decorators";
import { type OpenAIClientOptions, OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService, type OpenAILLMServiceOptions } from "@pipedog/openai/llm";

/** Settings for SambaNovaLLMService. */
export class SambaNovaLLMSettings extends OpenAILLMSettings {}

export interface SambaNovaLLMServiceOptions extends OpenAILLMServiceOptions {
  /** The API key for accessing SambaNova API. */
  apiKey: string;
  /** The base URL for SambaNova API. Defaults to `"https://api.sambanova.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: SambaNovaLLMSettings | null;
}

/**
 * A service for interacting with SambaNova using the OpenAI-compatible
 * interface.
 *
 * This service extends OpenAILLMService to connect to SambaNova's API endpoint
 * while maintaining full compatibility with OpenAI's interface and
 * functionality.
 */
export class SambaNovaLLMService extends OpenAILLMService {
  // SambaNova doesn't support the "developer" message role.
  // This value is used by BaseOpenAILLMService when calling the adapter.
  static override supportsDeveloperRole = false;

  static override Settings: typeof SambaNovaLLMSettings = SambaNovaLLMSettings;
  declare protected _settings: SambaNovaLLMSettings;
  static override _requiresApiKey = true;

  /**
   * Initialize SambaNova LLM service.
   *
   * @param options.apiKey The API key for accessing SambaNova API.
   * @param options.baseUrl The base URL for SambaNova API. Defaults to
   *   "https://api.sambanova.ai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "Meta-Llama-3.3-70B-Instruct").
   *   Other options are passed to OpenAILLMService.
   */
  constructor(options: SambaNovaLLMServiceOptions) {
    const cls = new.target as typeof SambaNovaLLMService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({ model: "Meta-Llama-3.3-70B-Instruct" });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.sambanova.ai/v1",
      settings: defaultSettings,
    });
  }

  /**
   * Create OpenAI-compatible client for SambaNova API endpoint.
   *
   * @param options.apiKey API key for authentication.
   * @param options.baseUrl Base URL for the API endpoint.
   *   Other options are passed to the parent createClient().
   * @returns Configured OpenAI-compatible client instance.
   */
  override createClient(
    options: OpenAIClientOptions = {},
  ): ReturnType<OpenAILLMService["createClient"]> {
    logger.debug(`Creating SambaNova client with API ${options.baseUrl}`);
    return super.createClient(options);
  }

  /**
   * Build parameters for SambaNova chat completion request.
   *
   * SambaNova doesn't support OpenAI's `service_tier`.
   *
   * @param paramsFromContext Parameters, derived from the LLM context, to use
   *   for the chat completion. Contains messages, tools, and tool choice.
   * @returns Dictionary of parameters for the chat completion request.
   */
  override buildChatCompletionParams(
    paramsFromContext: OpenAILLMInvocationParams,
  ): Record<string, any> {
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
    };

    // Messages, tools, tool_choice
    Object.assign(params, paramsFromContext);

    Object.assign(params, this._settings.extra);

    return params;
  }

  /**
   * Process OpenAI LLM context and stream chat completion chunks.
   *
   * This method handles the streaming response from SambaNova API, including
   * function call processing and text frame generation. It includes special
   * handling for SambaNova's API limitations with tool call indexing.
   *
   * @param context OpenAI LLM context containing conversation state and tools.
   */
  protected override async _processContext(context: LLMContext): Promise<void> {
    const functionsList: string[] = [];
    const argumentsList: string[] = [];
    const toolIdList: string[] = [];
    let funcIdx = 0;
    let functionName = "";
    let args = "";
    let toolCallId = "";

    await this.startTtfbMetrics();

    const chunkStream = await this.getChatCompletions(context);

    // Providers differ in how often they send usage: some once at the end,
    // others a cumulative snapshot on every chunk. Holding the latest and
    // reporting it after the stream keeps that to one report per completion.
    let tokenUsage: LLMTokenUsage | null = null;

    try {
      // Ensure the stream is closed on cancellation/exception. Without this,
      // a CancelledError during iteration leaves the underlying socket open.
      const chunkIter = chunkStream[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await abortable(chunkIter.next());
          if (next.done) break;
          const chunk = next.value;

          if (chunk.usage) {
            const promptTokensDetails = chunk.usage.prompt_tokens_details as
              | (Record<string, unknown> & { cached_tokens?: number | null })
              | null
              | undefined;
            const cachedTokens = promptTokensDetails
              ? (promptTokensDetails.cached_tokens ?? null)
              : null;
            // Tokens written into the prompt cache, billed above the input
            // rate. Providers without prompt caching omit the field, which
            // reads as "not reported" rather than zero.
            const cacheWriteTokens = promptTokensDetails
              ? ((promptTokensDetails.cache_write_tokens as number | null | undefined) ?? null)
              : null;
            const completionTokensDetails = chunk.usage.completion_tokens_details;
            const reasoningTokens = completionTokensDetails
              ? (completionTokensDetails.reasoning_tokens ?? null)
              : null;
            tokenUsage = new LLMTokenUsage({
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              cacheReadInputTokens: cachedTokens,
              cacheCreationInputTokens: cacheWriteTokens,
              reasoningTokens: reasoningTokens,
            });
          }

          if (chunk.choices === null || chunk.choices === undefined || chunk.choices.length === 0) {
            continue;
          }

          await this.stopTtfbMetrics();

          const delta = chunk.choices[0]?.delta as
            | (Record<string, any> & {
                tool_calls?: any[] | null;
                content?: string | null;
                audio?: Record<string, unknown> | null;
              })
            | null
            | undefined;
          if (!delta) {
            continue;
          }

          if (delta.tool_calls && delta.tool_calls.length > 0) {
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
              argumentsList.push(args);
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
            await this._pushLlmText(delta.audio.transcript as string);
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
    if (functionName && args) {
      // added to the list as last function name and arguments not added to the list
      functionsList.push(functionName);
      argumentsList.push(args);
      toolIdList.push(toolCallId);

      const functionCalls: FunctionCallFromLLM[] = [];

      for (let i = 0; i < functionsList.length; i++) {
        const name = functionsList[i]!;
        const rawArguments = argumentsList[i]!;
        const toolId = toolIdList[i]!;
        // This allows compatibility until SambaNova API introduces indexing in tool calls.
        if (rawArguments.length < 1) {
          continue;
        }

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
}

// @traced_llm on `_process_context`.
{
  const proto = SambaNovaLLMService.prototype as unknown as Record<string, unknown>;
  proto._processContext = tracedLlm(proto._processContext);
}
