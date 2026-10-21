// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/mistral_adapter.py

/**
 * Mistral LLM adapter for Pipecat.
 *
 * Mistral's API uses an OpenAI-compatible interface but imposes three
 * conversation-history constraints that OpenAI does not:
 *
 * 1. **Tool messages must be followed by an assistant message.** A "tool" role
 *    message that isn't followed by an "assistant" message is rejected.
 *
 * 2. **Only the initial contiguous system block is permitted.** A "system"
 *    message appearing after any non-system message must be converted to
 *    "user".
 *
 * 3. **A trailing assistant message requires `prefix: true`.** When the
 *    conversation ends on an assistant message, Mistral expects the `prefix`
 *    flag set so it can continue from that partial reply.
 *
 * This adapter extends `OpenAILLMAdapter` and applies those three fixups
 * before the messages reach `buildChatCompletionParams`.
 */

import {
  type ChatCompletionMessageParam,
  OpenAILLMAdapter,
  type OpenAILLMInvocationParams,
  type OpenAILLMInvocationParamsOptions,
} from "@pipedog/core/adapters/services/open_ai_adapter";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

/**
 * Adapter that transforms messages to satisfy Mistral's API constraints.
 *
 * Mistral accepts the OpenAI chat-completions schema but enforces extra rules
 * on conversation history. This adapter extends `OpenAILLMAdapter` and
 * rewrites the messages produced by the parent to comply with those rules
 * before the request is built.
 */
export class MistralLLMAdapter extends OpenAILLMAdapter {
  /**
   * Get OpenAI-compatible invocation parameters with Mistral message fixes
   * applied.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service
   *   settings or `runInference`. Forwarded to the parent adapter.
   * @param options.convertDeveloperToUser If true, convert "developer"-role
   *   messages to "user"-role messages. Forwarded to the parent adapter.
   * @returns Parameters for Mistral's ChatCompletion API, with messages
   *   transformed to satisfy Mistral's constraints.
   */
  override async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAILLMInvocationParamsOptions,
  ): Promise<OpenAILLMInvocationParams> {
    const params = await super.getLlmInvocationParams(context, {
      systemInstruction: options.systemInstruction,
      convertDeveloperToUser: options.convertDeveloperToUser,
    });
    params.messages = this._transformMessages([...params.messages]);
    return params;
  }

  /**
   * Transform messages to satisfy Mistral's API constraints.
   *
   * Applies three transformation steps in order:
   *
   * 1. **Insert assistant messages after tool messages**: Any "tool" message
   *    not followed by an "assistant" message gets a minimal
   *    `{ role: "assistant", content: " " }` inserted after it.
   *
   * 2. **Convert non-initial system messages to user**: System messages after
   *    the initial contiguous system block are converted to "user", since
   *    Mistral only accepts system messages at the start of a conversation.
   *
   * 3. **Set prefix on trailing assistant message**: If the final message is
   *    an assistant message without a `prefix` field, set `prefix: true` so
   *    Mistral will continue the partial reply.
   *
   * @param messages List of OpenAI-shaped message dicts.
   * @returns Transformed list of messages satisfying Mistral's constraints.
   */
  _transformMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    if (messages.length === 0) {
      return messages;
    }

    // Work on copies: we mutate "role" and attach Mistral's non-standard
    // "prefix" field.
    const msgs: Record<string, any>[] = structuredClone(messages.map((m) => ({ ...m })));

    // Step 1: ensure every "tool" message is followed by an "assistant".
    const insertAt: number[] = [];
    msgs.forEach((msg, i) => {
      if (msg.role === "tool") {
        const isLast = i === msgs.length - 1;
        if (isLast || msgs[i + 1]!.role !== "assistant") {
          insertAt.push(i + 1);
        }
      }
    });
    for (const idx of insertAt.reverse()) {
      msgs.splice(idx, 0, { role: "assistant", content: " " });
    }

    // Step 2: convert non-initial system messages to "user".
    // Mistral rejects system messages after any non-system message.
    let firstNonSystem = msgs.findIndex((m) => m.role !== "system");
    if (firstNonSystem === -1) firstNonSystem = msgs.length;
    for (let i = firstNonSystem; i < msgs.length; i++) {
      if (msgs[i]!.role === "system") {
        msgs[i]!.role = "user";
      }
    }

    // Step 3: set prefix on a trailing assistant message so Mistral will
    // continue it rather than rejecting the turn.
    const last = msgs[msgs.length - 1]!;
    if (last.role === "assistant" && !("prefix" in last)) {
      last.prefix = true;
    }

    return msgs;
  }
}
