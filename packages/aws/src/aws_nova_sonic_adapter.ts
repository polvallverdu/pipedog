// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/aws_nova_sonic_adapter.py

/** AWS Nova Sonic LLM adapter for Pipecat. */

import { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

type Dict = Record<string, any>;

/**
 * Roles supported in AWS Nova Sonic conversations.
 *
 * - `SYSTEM`: System-level messages (not used in conversation history).
 * - `USER`: Messages sent by the user.
 * - `ASSISTANT`: Messages sent by the assistant.
 * - `TOOL`: Messages sent by tools (not used in conversation history).
 */
export const Role = {
  SYSTEM: "SYSTEM",
  USER: "USER",
  ASSISTANT: "ASSISTANT",
  TOOL: "TOOL",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export interface AWSNovaSonicConversationHistoryMessageOptions {
  /** The role of the message sender (USER or ASSISTANT only). */
  role: Role;
  /** The text content of the message. */
  text: string;
}

/** A single message in AWS Nova Sonic conversation history. */
export class AWSNovaSonicConversationHistoryMessage {
  role: Role; // only USER and ASSISTANT
  text: string;

  constructor(options: AWSNovaSonicConversationHistoryMessageOptions) {
    this.role = options.role;
    this.text = options.text;
  }
}

/**
 * Context-based parameters for invoking AWS Nova Sonic LLM API.
 *
 * This is a placeholder until support for universal LLMContext machinery is added for AWS Nova Sonic.
 */
export interface AWSNovaSonicLLMInvocationParams {
  system_instruction: string | null;
  messages: AWSNovaSonicConversationHistoryMessage[];
  tools: Dict[];
}

/** Options for `AWSNovaSonicLLMAdapter.getLlmInvocationParams()`. */
export interface AWSNovaSonicLLMInvocationParamsOptions {
  /** Optional system instruction from service settings. */
  systemInstruction?: string | null;
  /**
   * The service's init-provided tools, as `_serviceTools()` returns them: a
   * `ToolsSchema` or a provider-native tool list, or `null`.
   */
  serviceTools?: unknown;
}

/** Container for messages converted from universal context. */
export class ConvertedMessages {
  messages: AWSNovaSonicConversationHistoryMessage[];
  systemInstruction: string | null;

  constructor(options: {
    messages: AWSNovaSonicConversationHistoryMessage[];
    systemInstruction?: string | null;
  }) {
    this.messages = options.messages;
    this.systemInstruction = options.systemInstruction ?? null;
  }
}

/**
 * Adapter for AWS Nova Sonic language models.
 *
 * Converts Pipecat's standard function schemas into AWS Nova Sonic's
 * specific function-calling format, enabling tool use with Nova Sonic models.
 */
export class AWSNovaSonicLLMAdapter extends BaseLLMAdapter<AWSNovaSonicLLMInvocationParams> {
  static ConvertedMessages = ConvertedMessages;

  protected _systemInstruction: string | null = null;

  /** Get the identifier used in LLMSpecificMessage instances for AWS Nova Sonic. */
  override get idForLlmSpecificMessages(): string {
    return "aws-nova-sonic";
  }

  /**
   * Get AWS Nova Sonic-specific LLM invocation parameters from a universal LLM context.
   *
   * The `tools` returned are the set the session should carry: the context's
   * own when it has any, else the init-provided ones. Built-in tools ride
   * along with whichever set is in use, and are the set when there is
   * neither.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction Optional system instruction from service settings.
   * @param options.serviceTools The service's init-provided tools.
   * @returns Dictionary of parameters for invoking AWS Nova Sonic's LLM API.
   */
  override async getLlmInvocationParams(
    context: LLMContext,
    options: AWSNovaSonicLLMInvocationParamsOptions = {},
  ): Promise<AWSNovaSonicLLMInvocationParams> {
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
        []) as Dict[],
    };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging about AWS Nova Sonic.
   *
   * This is a placeholder until support for universal LLMContext machinery is added for AWS Nova Sonic.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging about AWS Nova Sonic.
   */
  override getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    return this._fromUniversalContextMessages(this.getMessages(context)).messages.map((m) => ({
      role: m.role,
      text: m.text,
    }));
  }

  protected _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
  ): ConvertedMessages {
    let systemInstruction: string | null = null;
    const messages: AWSNovaSonicConversationHistoryMessage[] = [];

    // Bail if there are no messages
    if (universalContextMessages.length === 0) {
      return new ConvertedMessages({ messages: [] });
    }

    // NOTE: This adapter does not yet handle `LLMSpecificMessage` —
    // those are filtered out below (the role-extraction and conversion
    // logic only applies to standard message dicts). If/when this
    // adapter grows a per-provider passthrough like the Anthropic
    // adapter has, LLMSpecific items can flow through.
    const ucm: Dict[] = universalContextMessages
      .filter((m) => !(m instanceof LLMSpecificMessage))
      .map((m) => structuredClone(m) as Dict);

    // If we have a "system" message as our first message,
    // pull that out into "instruction"
    if (ucm.length > 0 && (ucm[0] as Dict).role === "system") {
      this._warnContextSystemMessage();
      const system = ucm.shift() as Dict;
      const content = system.content;
      if (typeof content === "string") {
        systemInstruction = content;
      } else if (Array.isArray(content)) {
        systemInstruction = (content[0] as Dict | undefined)?.text ?? null;
      }
      if (systemInstruction) {
        this._systemInstruction = systemInstruction;
      }
    }

    // Convert any remaining "system"/"developer" messages to "user",
    // as Nova Sonic only supports "user" and "assistant" in history.
    for (const msg of ucm) {
      if (msg.role === "system" || msg.role === "developer") {
        msg.role = "user";
      }
    }

    // Process remaining messages to fill out conversation history.
    for (const universalContextMessage of ucm) {
      const message = this._fromUniversalContextMessage(universalContextMessage);
      if (message) {
        messages.push(message);
      }
    }

    return new ConvertedMessages({ messages, systemInstruction });
  }

  /**
   * Convert standard message format to Nova Sonic format.
   *
   * @param message Standard message dictionary to convert.
   * @returns Nova Sonic conversation history message, or null if not convertible.
   */
  protected _fromUniversalContextMessage(
    message: Dict,
  ): AWSNovaSonicConversationHistoryMessage | null {
    const role = message.role;
    if (role === "user" || role === "assistant") {
      let content = message.content;
      if (Array.isArray(content)) {
        const textParts: unknown[] = [];
        for (const c of content as Dict[]) {
          if (c.type === "text") {
            textParts.push(c.text);
          } else {
            logger.error(
              `Unhandled content type in context message: ${c.type} - ${pyJsonDumps(message)}`,
            );
          }
        }
        content = textParts.filter((t) => t).join(" ");
      }
      // There won't be content if this is an assistant tool call entry.
      // We're ignoring those since they can't be loaded into AWS Nova Sonic conversation
      // history
      if (content) {
        return new AWSNovaSonicConversationHistoryMessage({
          role: Role[(role as string).toUpperCase() as "USER" | "ASSISTANT"],
          text: content as string,
        });
      }
    }
    // NOTE: we're ignoring messages with role "tool" since they can't be loaded into AWS Nova
    // Sonic conversation history
    return null;
  }

  /**
   * Convert a function schema to AWS Nova Sonic format.
   *
   * @param fn The function schema to convert.
   * @returns Dictionary in AWS Nova Sonic function format with toolSpec structure.
   */
  static _toAwsNovaSonicFunctionFormat(fn: FunctionSchema): Dict {
    return {
      toolSpec: {
        name: fn.name,
        description: fn.description,
        inputSchema: {
          json: pyJsonDumps({
            type: "object",
            properties: fn.properties,
            required: fn.required,
          }),
        },
      },
    };
  }

  /**
   * Convert tools schema to AWS Nova Sonic function-calling format.
   *
   * @param toolsSchema The tools schema containing function definitions to convert.
   * @returns List of dictionaries in AWS Nova Sonic function format.
   */
  override toProviderToolsFormat(toolsSchema: ToolsSchema): Dict[] {
    const functionsSchema = toolsSchema.standardTools;
    return functionsSchema.map((func) =>
      AWSNovaSonicLLMAdapter._toAwsNovaSonicFunctionFormat(func),
    );
  }
}
