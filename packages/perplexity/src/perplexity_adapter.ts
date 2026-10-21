// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/perplexity_adapter.py

/**
 * Perplexity LLM adapter for Pipecat.
 *
 * Perplexity's API uses an OpenAI-compatible interface but enforces stricter
 * constraints on conversation history structure:
 *
 * 1. **Strict role alternation**: Messages must alternate between "user"/"tool"
 *    and "assistant" roles. Consecutive messages with the same role (e.g. two
 *    "user" messages in a row) are rejected with:
 *    `"messages must be an alternating sequence of user/tool and assistant messages"`
 *
 * 2. **No non-initial system messages**: "system" messages are only allowed at
 *    the start of the conversation. A system message after a non-system
 *    message causes: `"only the initial message can have the system role"`
 *
 * 3. **Last message must be user/tool**: The final message in the conversation
 *    must have role "user" or "tool". A trailing "assistant" message causes:
 *    `"the last message must have the user or tool role"`
 *
 * This adapter transforms the message list to satisfy all three constraints
 * before the messages are sent to Perplexity's API.
 */

import {
  type ChatCompletionMessageParam,
  OpenAILLMAdapter,
  type OpenAILLMInvocationParams,
  type OpenAILLMInvocationParamsOptions,
} from "@pipedog/core/adapters/services/open_ai_adapter";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";

/**
 * Adapter that transforms messages to satisfy Perplexity's API constraints.
 *
 * Perplexity's API is stricter than OpenAI about message structure. This
 * adapter extends `OpenAILLMAdapter` and applies message transformations to
 * ensure compliance with Perplexity's constraints (role alternation, no
 * non-initial system messages, last message must be user/tool).
 *
 * The transformations are applied in `getLlmInvocationParams` after the parent
 * adapter extracts messages from the LLM context (including any
 * `systemInstruction` prepend).
 */
export class PerplexityLLMAdapter extends OpenAILLMAdapter {
  /**
   * Get OpenAI-compatible invocation parameters with Perplexity message fixes
   * applied.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service
   *   settings or `runInference`. Forwarded to the parent adapter.
   * @param options.convertDeveloperToUser If true, convert "developer"-role
   *   messages to "user"-role messages. Forwarded to the parent adapter.
   * @returns Parameters for Perplexity's ChatCompletion API, with messages
   *   transformed to satisfy Perplexity's constraints.
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
   * Transform messages to satisfy Perplexity's API constraints.
   *
   * Applies three transformation steps in order:
   *
   * 1. **Convert non-initial system messages to user**: Any system message
   *    after the initial system message block is converted to role "user",
   *    since Perplexity rejects system messages after a non-system message.
   *
   * 2. **Merge consecutive same-role messages**: After the above conversions,
   *    adjacent messages with the same role are merged using list-of-dicts
   *    content format. This ensures strict role alternation (e.g. a converted
   *    system→user message adjacent to an existing user message gets merged).
   *
   * 3. **Remove trailing assistant messages**: If the last message is
   *    "assistant", remove it. OpenAI appears to silently ignore trailing
   *    assistant messages server-side, so removing them preserves equivalent
   *    behavior while satisfying Perplexity's "last message must be user/tool"
   *    constraint.
   *
   * Note: we intentionally do *not* convert a trailing system message to
   * "user". That would make the transformation unstable across calls:
   * Perplexity appears to have statefulness/caching within a conversation, so
   * a message that was sent as "user" in one call but becomes "system" in the
   * next (once more messages are appended) causes errors. If the context
   * consists entirely of system messages, the Perplexity API call will fail,
   * but that mistake will be caught right away.
   *
   * @param messages List of message dicts with "role" and "content" keys.
   * @returns Transformed list of message dicts satisfying Perplexity's
   *   constraints.
   */
  _transformMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    if (messages.length === 0) {
      return messages;
    }

    const msgs: Record<string, any>[] = structuredClone(messages);

    // Note: "developer" → "user" conversion is handled by the parent adapter
    // via the convertDeveloperToUser option.

    // Step 1: Convert non-initial system messages to "user".
    // Perplexity allows system messages at the start, but rejects them
    // after any non-system message.
    let inInitialSystemBlock = true;
    for (const msg of msgs) {
      if (msg.role === "system") {
        if (!inInitialSystemBlock) {
          msg.role = "user";
        }
      } else {
        inInitialSystemBlock = false;
      }
    }

    // Step 2: Merge consecutive same-role messages.
    // After system→user conversions above, we may have adjacent same-role
    // messages that violate Perplexity's strict alternation requirement.
    // Skip consecutive system messages at the start: Perplexity allows those.
    let i = 0;
    while (i < msgs.length - 1) {
      const current = msgs[i]!;
      const nextMsg = msgs[i + 1]!;
      if (current.role === "system" && nextMsg.role === "system") {
        // Perplexity allows multiple initial system messages, don't merge
        i += 1;
      } else if (current.role === nextMsg.role) {
        // Convert string content to list-of-dicts format for merging
        if (typeof current.content === "string") {
          current.content = [{ type: "text", text: current.content }];
        }
        if (typeof nextMsg.content === "string") {
          nextMsg.content = [{ type: "text", text: nextMsg.content }];
        }
        // Merge content from next message into current
        if (Array.isArray(current.content) && Array.isArray(nextMsg.content)) {
          current.content.push(...nextMsg.content);
        }
        msgs.splice(i + 1, 1);
      } else {
        i += 1;
      }
    }

    // Step 3: Remove trailing assistant messages.
    // Perplexity requires the last message to be "user" or "tool".
    // OpenAI appears to silently ignore trailing assistant messages
    // server-side, so removing them preserves equivalent behavior.
    while (msgs.length > 0 && msgs[msgs.length - 1]!.role === "assistant") {
      msgs.pop();
    }

    return msgs;
  }
}
