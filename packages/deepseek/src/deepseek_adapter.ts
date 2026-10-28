// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/deepseek_adapter.py

/**
 * DeepSeek LLM adapter for Pipecat.
 *
 * DeepSeek's API is OpenAI-compatible, but in thinking mode it requires every
 * assistant message of the current turn to carry a `reasoning_content` field
 * once a tool call is involved, and rejects the request with a 400 otherwise.
 * Pipecat does not keep a model's reasoning in the context, so this adapter
 * supplies an empty `reasoning_content` on assistant messages that lack one.
 * DeepSeek accepts the empty field on any assistant message and ignores it when
 * thinking is disabled, so it is applied uniformly rather than per turn.
 */

import {
  type ChatCompletionMessageParam,
  OpenAILLMAdapter,
  type OpenAILLMInvocationParams,
  type OpenAILLMInvocationParamsOptions,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

/**
 * Adapter that shapes messages to satisfy DeepSeek's thinking-mode rules.
 *
 * Extends `OpenAILLMAdapter` and adds an empty `reasoning_content` to every
 * assistant message that has none, so requests are accepted in thinking mode
 * after a tool call.
 */
export class DeepSeekLLMAdapter extends OpenAILLMAdapter {
  /**
   * Get OpenAI-compatible invocation parameters with DeepSeek message fixes
   * applied.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service
   *   settings or `runInference`. Forwarded to the parent adapter.
   * @param options.convertDeveloperToUser If true, convert "developer"-role
   *   messages to "user"-role messages. Forwarded to the parent adapter.
   * @returns Parameters for DeepSeek's ChatCompletion API, with
   *   `reasoning_content` present on every assistant message.
   */
  override async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAILLMInvocationParamsOptions,
  ): Promise<OpenAILLMInvocationParams> {
    const params = await super.getLlmInvocationParams(context, {
      systemInstruction: options.systemInstruction,
      convertDeveloperToUser: options.convertDeveloperToUser,
    });
    params.messages = this._addReasoningContent([...params.messages]);
    return params;
  }

  /**
   * Return the messages with `reasoning_content` on every assistant message.
   *
   * Assistant messages that already carry the field are left as they are.
   * Message dicts are shared with the source `LLMContext`, so a stamped
   * message is a copy rather than a mutation.
   *
   * @param messages List of OpenAI-shaped message dicts.
   * @returns The message list, with copies of the assistant messages that
   *   needed the field.
   */
  _addReasoningContent(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];
    for (const message of messages) {
      let msg = message as Record<string, unknown>;
      if (msg.role === "assistant" && !("reasoning_content" in msg)) {
        msg = { ...msg, reasoning_content: "" };
      }
      result.push(msg);
    }
    return result;
  }
}
