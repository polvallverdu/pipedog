// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/gemini_live_adapter.py

/** Gemini Live LLM adapter for Pipecat. */

import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
  NOT_GIVEN,
  type NotGiven,
} from "@pipedog/core/processors/aggregators/llm_context";
import {
  type ConvertedMessages,
  GeminiLLMAdapter,
  type GeminiLLMInvocationParams,
} from "./gemini_adapter.ts";

type Dict = Record<string, any>;

/** Options for `GeminiLiveLLMAdapter.getLlmInvocationParams()`. */
export interface GeminiLiveLLMInvocationParamsOptions {
  /** Optional system instruction from service settings. */
  systemInstruction?: string | null;
  /**
   * The service's init-provided tools, as `_serviceTools()` returns them: a
   * `ToolsSchema` or a provider-native tool list, or `null`.
   */
  serviceTools?: unknown;
}

/**
 * Gemini Live-specific adapter for Pipecat.
 *
 * Same as `GeminiLLMAdapter`, except that tool calls and their results are
 * converted to text, which is all Gemini Live's API accepts.
 */
export class GeminiLiveLLMAdapter extends GeminiLLMAdapter {
  /** The identifier used in LLMSpecificMessage instances for Gemini Live. */
  override get idForLlmSpecificMessages(): string {
    return "gemini-live";
  }

  /**
   * Get Gemini Live-specific LLM invocation parameters from a universal LLM
   * context.
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
   * @returns Dictionary of parameters for Gemini Live's API.
   */
  override async getLlmInvocationParams(
    context: LLMContext,
    options: GeminiLiveLLMInvocationParamsOptions = {},
  ): Promise<GeminiLLMInvocationParams> {
    const params = await super.getLlmInvocationParams(context, {
      systemInstruction: options.systemInstruction ?? null,
    });
    // Python `or`: an empty tool list also becomes NOT_GIVEN.
    const tools = this._realtimeSessionTools(context.tools, options.serviceTools ?? null);
    params.tools = (tools && tools.length > 0 ? tools : NOT_GIVEN) as unknown[] | NotGiven;
    return params;
  }

  /**
   * Restructure messages to ensure proper Gemini Live format and message
   * ordering.
   *
   * @param universalContextMessages Messages from the LLM context.
   * @param options.systemInstruction Optional system instruction from service
   *   settings, used to decide whether to extract an initial "developer"
   *   message.
   */
  protected override _fromUniversalContextMessages(
    universalContextMessages: LLMContextMessage[],
    options: { systemInstruction?: string | null } = {},
  ): ConvertedMessages {
    return super._fromUniversalContextMessages(
      GeminiLiveLLMAdapter._convertToolCallsToText(universalContextMessages),
      { systemInstruction: options.systemInstruction ?? null },
    );
  }

  /**
   * Convert tool calls and their results to text messages.
   *
   * Seeding a Gemini Live conversation with tool calls — on a reconnect or a
   * multi-worker handoff, say — fails with a 1007 error.
   *
   * @param messages Messages from the LLM context.
   * @returns The messages, with each tool call and result replaced by a text
   *   message describing it.
   */
  protected static _convertToolCallsToText(messages: LLMContextMessage[]): LLMContextMessage[] {
    const toolCallNames: Record<string, string> = {};
    const converted: LLMContextMessage[] = [];

    for (const message of messages) {
      if (message instanceof LLMSpecificMessage) {
        converted.push(message);
        continue;
      }

      const msg = message as Dict;
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const summaries: string[] = [];
        for (const toolCall of msg.tool_calls as Dict[]) {
          const fn = toolCall.function as Dict;
          toolCallNames[toolCall.id] = fn.name;
          summaries.push(`[Called function ${fn.name} with args ${fn.arguments}]`);
        }
        converted.push({ role: "assistant", content: summaries.join(" ") });
      } else if (msg.role === "tool") {
        // Same fallback name the Gemini adapter uses for a result whose
        // call isn't in the context.
        const callId: string = msg.tool_call_id ?? "";
        const name = Object.hasOwn(toolCallNames, callId)
          ? toolCallNames[callId]
          : "tool_call_result";
        converted.push({ role: "user", content: `[Function ${name} returned ${msg.content}]` });
      } else {
        converted.push(message);
      }
    }

    return converted;
  }
}
