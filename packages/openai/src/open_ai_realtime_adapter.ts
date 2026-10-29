// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/open_ai_realtime_adapter.py

/** OpenAI Realtime LLM adapter for Pipecat. */

import { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { AdapterType, type ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import * as events from "./realtime/events.ts";

type Dict = Record<string, any>;

/**
 * Context-based parameters for invoking OpenAI Realtime API.
 *
 * This is a placeholder until support for universal LLMContext machinery is
 * added for OpenAI Realtime.
 */
export interface OpenAIRealtimeLLMInvocationParams {
  system_instruction: string | null;
  messages: events.ConversationItem[];
  tools: Record<string, unknown>[];
}

/** Options for `OpenAIRealtimeLLMAdapter.getLlmInvocationParams`. */
export interface OpenAIRealtimeLLMInvocationParamsOptions {
  /** Optional system instruction from service settings. */
  systemInstruction?: string | null;
  /**
   * The service's init-provided tools, as `_serviceTools()` returns them: a
   * `ToolsSchema` or a provider-native tool list, or `null`.
   */
  serviceTools?: unknown;
}

/** Container for OpenAI-formatted messages converted from universal context. */
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
 * LLM adapter for OpenAI Realtime API function calling.
 *
 * Converts Pipecat's tool schemas into the specific format required by
 * OpenAI's Realtime API for function calling capabilities.
 */
export class OpenAIRealtimeLLMAdapter extends BaseLLMAdapter<OpenAIRealtimeLLMInvocationParams> {
  /** Container for OpenAI-formatted messages converted from universal context. */
  static ConvertedMessages = ConvertedMessages;

  /** The identifier used in LLMSpecificMessage instances for OpenAI Realtime. */
  get idForLlmSpecificMessages(): string {
    return "openai-realtime";
  }

  /**
   * Get OpenAI Realtime-specific LLM invocation parameters from a universal
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
   * @returns Dictionary of parameters for invoking OpenAI Realtime's API.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAIRealtimeLLMInvocationParamsOptions = {},
  ): Promise<OpenAIRealtimeLLMInvocationParams> {
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
   * Get messages from a universal LLM context in a format ready for logging
   * about OpenAI Realtime.
   *
   * Binary data (images, audio) is replaced with short placeholders.
   *
   * This is a placeholder until support for universal LLMContext machinery is
   * added for OpenAI Realtime.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about OpenAI Realtime.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    return this.getMessages(context, { truncateLargeValues: true }) as Record<string, unknown>[];
  }

  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
  ): ConvertedMessages {
    // We can't load a long conversation history into the openai realtime api yet. (The API/model
    // forgets that it can do audio, if you do a series of `conversation.item.create` calls.) So
    // our general strategy until this is fixed is just to put everything into a first "user"
    // message as a single input.

    if (universalContextMessages.length === 0) {
      return new ConvertedMessages({ messages: [] });
    }

    // NOTE: This adapter does not yet handle `LLMSpecificMessage` — those
    // are filtered out below. Other adapters (e.g. Anthropic) dispatch
    // LLMSpecific items through a per-provider passthrough. For OpenAI
    // Realtime, the strategy here packs a multi-message history into a
    // single text message (see comment further down), which doesn't
    // compose with opaque per-provider payloads. If/when this adapter
    // adopts the per-message strategy, LLMSpecific items can flow
    // through `_fromUniversalContextMessage` like in other adapters.
    const messages: Dict[] = universalContextMessages
      .filter((m) => !(m instanceof LLMSpecificMessage))
      .map((m) => structuredClone(m) as Dict);
    let systemInstruction: string | null = null;

    // If we have a "system" message as our first message,
    // pull that out into session "instructions"
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

    // If we have just a single "user" item, we can just send it normally
    if (messages.length === 1 && (messages[0] as Dict).role === "user") {
      return new ConvertedMessages({
        messages: [this._fromUniversalContextMessage(messages[0] as LLMContextMessage)],
        systemInstruction,
      });
    }

    // Otherwise, let's pack everything into a single "user" message with a bit of
    // explanation for the LLM
    const introText = `
        This is a previously saved conversation. Please treat this conversation history as a
        starting point for the current conversation.`;

    const trailingText = `
        This is the end of the previously saved conversation. Please continue the conversation
        from here. If the last message is a user instruction or question, act on that instruction
        or answer the question. If the last message is an assistant response, simple say that you
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

  protected _fromUniversalContextMessage(message: LLMContextMessage): events.ConversationItem {
    // NOTE: `LLMSpecificMessage` is not yet handled here — see the
    // corresponding note in `_fromUniversalContextMessages`.
    const msg = message as Dict;
    if (msg.role === "user") {
      let content = msg.content;
      if (Array.isArray(content)) {
        content = "";
        for (const c of (msg.content ?? []) as Dict[]) {
          if (c.type === "text") {
            content += ` ${c.text}`;
          } else {
            logger.error(
              `Unhandled content type in context message: ${c.type} - ${JSON.stringify(msg)}`,
            );
          }
        }
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
   * Convert a function schema to OpenAI Realtime format.
   *
   * @param func The function schema to convert.
   * @returns Dictionary in OpenAI Realtime function format.
   */
  protected static _toOpenaiRealtimeFunctionFormat(func: FunctionSchema): Record<string, unknown> {
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
   * Convert tool schemas to OpenAI Realtime function-calling format.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns List of function definitions in OpenAI Realtime format.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Record<string, unknown>[] {
    const functionsSchema = toolsSchema.standardTools;
    const formattedStandardTools = functionsSchema.map((func) =>
      OpenAIRealtimeLLMAdapter._toOpenaiRealtimeFunctionFormat(func),
    );
    let customOpenaiTools: Record<string, unknown>[] = [];
    if (toolsSchema.customTools) {
      customOpenaiTools = toolsSchema.customTools[AdapterType.OPENAI] ?? [];
    }
    return [...formattedStandardTools, ...customOpenaiTools];
  }
}
