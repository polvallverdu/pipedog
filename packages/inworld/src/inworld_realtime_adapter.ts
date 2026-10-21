// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/services/inworld_realtime_adapter.py

/**
 * Inworld Realtime LLM adapter for Pipecat.
 *
 * Converts Pipecat's tool schemas and context into the format required by
 * Inworld's Realtime API.
 */

import { BaseLLMAdapter } from "@pipedog/core/adapters/base_llm_adapter";
import type { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import type { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import * as events from "./realtime/events.ts";

type Dict = Record<string, any>;

/**
 * Context-based parameters for invoking Inworld Realtime API.
 *
 * - `system_instruction`: system prompt/instructions for the session.
 * - `messages`: list of conversation items formatted for Inworld Realtime.
 * - `tools`: list of tool definitions.
 */
export interface InworldRealtimeLLMInvocationParams {
  system_instruction: string | null;
  messages: events.ConversationItem[];
  tools: Record<string, unknown>[];
}

/** Options for `InworldRealtimeLLMAdapter.getLlmInvocationParams`. */
export interface InworldRealtimeLLMInvocationParamsOptions {
  /** Optional system instruction from service settings. */
  systemInstruction?: string | null;
  /**
   * The service's init-provided tools, as `_serviceTools()` returns them: a
   * `ToolsSchema` or a provider-native tool list, or `null`.
   */
  serviceTools?: unknown;
}

/** Container for Inworld-formatted messages converted from universal context. */
export class ConvertedMessages {
  messages: events.ConversationItem[];
  systemInstruction: string | null;

  constructor(options: {
    messages: events.ConversationItem[];
    systemInstruction?: string | null;
  }) {
    this.messages = options.messages;
    this.systemInstruction = options.systemInstruction ?? null;
  }
}

/**
 * LLM adapter for Inworld Realtime API.
 *
 * Converts Pipecat's universal context and tool schemas into the specific
 * format required by Inworld's Realtime API.
 */
export class InworldRealtimeLLMAdapter extends BaseLLMAdapter<InworldRealtimeLLMInvocationParams> {
  /** Container for Inworld-formatted messages converted from universal context. */
  static ConvertedMessages = ConvertedMessages;

  /** The identifier used in LLMSpecificMessage instances for Inworld Realtime. */
  get idForLlmSpecificMessages(): string {
    return "inworld-realtime";
  }

  /**
   * Get Inworld Realtime-specific LLM invocation parameters from a universal
   * LLM context.
   *
   * The `tools` returned are the set the session should carry: the context's
   * own when it has any, else the init-provided ones. Built-in tools ride
   * along with whichever set is in use, and are the set when there is
   * neither.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service settings.
   * @param options.serviceTools The service's init-provided tools, as
   *   `_serviceTools()` returns them: a `ToolsSchema` or a provider-native
   *   tool list, or `null`.
   * @returns Dictionary of parameters for invoking Inworld's Realtime API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: InworldRealtimeLLMInvocationParamsOptions = {},
  ): Promise<InworldRealtimeLLMInvocationParams> {
    const messages = this._fromUniversalContextMessages(this.getMessages(context));
    const effectiveSystem = this._resolveSystemInstruction(
      messages.systemInstruction,
      options.systemInstruction ?? null,
      { discardContextSystem: true },
    );
    return {
      system_instruction: effectiveSystem,
      messages: messages.messages,
      tools: (this._realtimeSessionTools(context.tools, options.serviceTools ?? null) ??
        []) as Record<string, unknown>[],
    };
  }

  /**
   * Get messages from context in a format safe for logging.
   *
   * Binary data (images, audio) is replaced with short placeholders.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages with sensitive data redacted.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    return this.getMessages(context, { truncateLargeValues: true }) as Record<string, unknown>[];
  }

  /**
   * Convert universal context messages to Inworld Realtime format.
   *
   * Similar to OpenAI Realtime, we pack conversation history into a single
   * user message since the realtime API doesn't support loading long histories.
   *
   * @param universalContextMessages List of messages in universal format.
   * @returns ConvertedMessages with Inworld-formatted messages and system instruction.
   */
  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
  ): ConvertedMessages {
    if (universalContextMessages.length === 0) {
      return new ConvertedMessages({ messages: [] });
    }

    // NOTE: This adapter does not yet handle `LLMSpecificMessage` —
    // those are filtered out below. Other adapters (e.g. Anthropic)
    // dispatch LLMSpecific items through a per-provider passthrough.
    // The pack-into-single-text-message strategy here doesn't compose
    // with opaque per-provider payloads.
    const messages: Dict[] = universalContextMessages
      .filter((m) => !(m instanceof LLMSpecificMessage))
      .map((m) => structuredClone(m) as Dict);
    let systemInstruction: string | null = null;

    // Extract system message as session instructions
    if (messages.length > 0 && (messages[0] as Dict).role === "system") {
      this._warnContextSystemMessage();
      const system = messages.shift() as Dict;
      const content = system.content;
      if (typeof content === "string") {
        systemInstruction = content;
      } else if (Array.isArray(content)) {
        systemInstruction = (content[0] as Dict).text ?? null;
      }
      if (messages.length === 0) {
        return new ConvertedMessages({ messages: [], systemInstruction });
      }
    }

    // Convert any remaining "system"/"developer" messages to "user"
    for (const msg of messages) {
      if (msg.role === "system" || msg.role === "developer") {
        msg.role = "user";
      }
    }

    // Single user message can be sent normally
    if (messages.length === 1 && (messages[0] as Dict).role === "user") {
      return new ConvertedMessages({
        messages: [this._fromUniversalContextMessage(messages[0] as LLMContextMessage)],
        systemInstruction,
      });
    }

    // Pack multiple messages into a single user message
    const introText = `
        This is a previously saved conversation. Please treat this conversation history as a
        starting point for the current conversation.`;

    const trailingText = `
        This is the end of the previously saved conversation. Please continue the conversation
        from here. If the last message is a user instruction or question, act on that instruction
        or answer the question. If the last message is an assistant response, simply say that you
        are ready to continue the conversation.`;

    return new ConvertedMessages({
      messages: [
        new events.ConversationItem({
          role: "user",
          type: "message",
          content: [
            new events.ItemContent({
              type: "input_text",
              // `json.dumps(messages, indent=2, ensure_ascii=False)`.
              // `pyJsonDumps` has no `indent`; `JSON.stringify` matches it for
              // context messages except for integral floats (`1.0` → `1`).
              text: [introText, JSON.stringify(messages, null, 2), trailingText].join("\n\n"),
            }),
          ],
        }),
      ],
      systemInstruction,
    });
  }

  /**
   * Convert a single universal context message to Inworld format.
   *
   * @param message Message in universal format.
   * @returns ConversationItem formatted for Inworld Realtime API.
   */
  protected _fromUniversalContextMessage(message: LLMContextMessage): events.ConversationItem {
    // NOTE: `LLMSpecificMessage` is not yet handled here — see the
    // corresponding note in `_fromUniversalContextMessages`.
    const msg = message as Dict;
    if (msg.role === "user") {
      let content = msg.content;
      if (Array.isArray(content)) {
        const textParts: unknown[] = [];
        for (const c of content as Dict[]) {
          if (c.type === "text") {
            textParts.push(c.text);
          } else {
            logger.error(
              `Unhandled content type in context message: ${c.type} - ${JSON.stringify(msg)}`,
            );
          }
        }
        content = textParts
          .filter((t) => Boolean(t))
          .join(" ")
          .trim();
      }
      return new events.ConversationItem({
        role: "user",
        type: "message",
        content: [new events.ItemContent({ type: "input_text", text: content })],
      });
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0] as Dict;
      return new events.ConversationItem({
        type: "function_call",
        callId: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }

    throw new Error(
      `Unhandled message type in _fromUniversalContextMessage: ${JSON.stringify(msg)}`,
    );
  }

  /**
   * Convert a function schema to Inworld Realtime function format.
   *
   * @param func The function schema to convert.
   * @returns Dictionary in Inworld Realtime function format.
   */
  protected static _toInworldFunctionFormat(func: FunctionSchema): Record<string, unknown> {
    return {
      type: "function",
      name: func.name,
      description: func.description,
      parameters: {
        type: "object",
        properties: func.properties,
        required: func.required,
      },
    };
  }

  /**
   * Convert tool schemas to Inworld Realtime format.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns List of tool definitions in Inworld Realtime format.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Record<string, unknown>[] {
    const functionsSchema = toolsSchema.standardTools;
    return functionsSchema.map((func) => InworldRealtimeLLMAdapter._toInworldFunctionFormat(func));
  }
}
