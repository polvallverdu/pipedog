// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/adapters/llm/services/open_ai_live_adapter.py

/** OpenAI Live LLM adapter for Pipecat. */

import { BaseLLMAdapter } from "@pipedog/core/adapters/llm/base_llm_adapter";
import type { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import {
  type LLMContext,
  LLMSpecificMessage,
  type NotGiven,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { isGiven } from "@pipedog/core/utils/types";
import * as events from "./live/events.ts";
import { OpenAIResponsesLLMAdapter } from "./open_ai_responses_adapter.ts";

type Dict = Record<string, any>;

/**
 * Session configuration derived from a universal `LLMContext`.
 *
 * - `instructions`: System instructions for the live model, or `null`.
 * - `input`: Prior text-only messages to seed the session with.
 * - `tools`: Function tools in Responses API format, for the backend model.
 * - `tool_choice`: Tool choice in Responses API format, or `null`.
 */
export interface OpenAILiveLLMInvocationParams {
  instructions: string | null;
  input: events.InputItem[];
  tools: Record<string, unknown>[];
  tool_choice: unknown | null;
}

/** Options for `OpenAILiveLLMAdapter.getLlmInvocationParams`. */
export interface OpenAILiveLLMInvocationParamsOptions {
  /** System instruction from the service settings. */
  systemInstruction?: string | null;
}

/**
 * Converts a universal `LLMContext` into OpenAI Live session configuration.
 *
 * The live model takes a system instruction and a text-only conversation
 * history at session start; tools belong to the backend (Responses) model
 * and use the Responses API tool format.
 */
export class OpenAILiveLLMAdapter extends BaseLLMAdapter<OpenAILiveLLMInvocationParams> {
  protected _responsesAdapter: OpenAIResponsesLLMAdapter;
  protected _warnedInputTruncated: boolean;

  /** Initialize the adapter. */
  constructor() {
    super();
    this._responsesAdapter = new OpenAIResponsesLLMAdapter();
    this._warnedInputTruncated = false;
  }

  /** The identifier used in LLMSpecificMessage instances for OpenAI Live. */
  get idForLlmSpecificMessages(): string {
    return "openai-live";
  }

  /**
   * Derive session configuration from a universal LLM context.
   *
   * A leading `system` message becomes the live model's instructions
   * (`systemInstruction` from the service settings wins if both are set).
   * The remaining messages become the startup `input` history.
   *
   * @param context The LLM context containing messages, tools, etc.
   * @param options.systemInstruction System instruction from the service settings.
   * @returns The session configuration values.
   */
  async getLlmInvocationParams(
    context: LLMContext,
    options: OpenAILiveLLMInvocationParamsOptions = {},
  ): Promise<OpenAILiveLLMInvocationParams> {
    // LLMSpecificMessages are opaque provider payloads with no place in a
    // text-only history.
    const messages = this.getMessages(context).filter(
      (m) => !(m instanceof LLMSpecificMessage),
    ) as Dict[];

    let systemFromContext: string | null = null;
    if (messages.length > 0 && (messages[0] as Dict).role === "system") {
      systemFromContext = OpenAILiveLLMAdapter._textContent(messages.shift() as Dict);
    }
    const instructions = this._resolveSystemInstruction(
      systemFromContext,
      options.systemInstruction ?? null,
      { discardContextSystem: true },
    );

    // NOTE: LLMContext's tools are guaranteed to be a ToolsSchema (or NOT_GIVEN)
    const tools = this.fromStandardTools(context.tools);
    return {
      instructions,
      input: this._toInputItems(messages),
      // `from_standard_tools(...) or []`: NOT_GIVEN and null are falsy upstream.
      tools: (tools != null && isGiven(tools) && tools.length > 0 ? tools : []) as Record<
        string,
        unknown
      >[],
      tool_choice: OpenAILiveLLMAdapter._toToolChoice(context.toolChoice),
    };
  }

  /**
   * Get messages from a universal LLM context in a format ready for logging.
   *
   * Binary data (images, audio) is replaced with short placeholders.
   *
   * @param context The LLM context containing messages.
   * @returns List of messages in a format ready for logging.
   */
  getMessagesForLogging(context: LLMContext): Record<string, unknown>[] {
    return this.getMessages(context, { truncateLargeValues: true }) as Record<string, unknown>[];
  }

  /**
   * Convert tool schemas to the Responses API tool format used by the backend
   * model.
   *
   * The Live session schema rejects the Responses-only `strict` field, so it
   * is dropped from function tools.
   *
   * @param toolsSchema The tools schema containing functions to convert.
   * @returns List of tool definitions.
   */
  toProviderToolsFormat(toolsSchema: ToolsSchema): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [];
    for (const original of this._responsesAdapter.toProviderToolsFormat(toolsSchema)) {
      const tool: Dict = { ...original };
      if (tool.type === "function") {
        delete tool.strict;
      }
      tools.push(tool);
    }
    return tools;
  }

  /**
   * Convert standard messages to the text-only startup `input` history.
   *
   * Tool calls, tool results and non-text content have no representation
   * there and are skipped. System messages become developer messages, the
   * role the startup history accepts. At most `events.MAX_INPUT_ITEMS` items
   * are kept, dropping the oldest.
   */
  protected _toInputItems(messages: Dict[]): events.InputItem[] {
    let items: events.InputItem[] = [];
    for (const message of messages) {
      const role = message.role;
      const text = OpenAILiveLLMAdapter._textContent(message);
      if ((role === "system" || role === "developer") && text) {
        items.push(
          new events.InputItem({
            role: "developer",
            content: [new events.InputTextContent({ text })],
          }),
        );
      } else if (role === "user" && text) {
        items.push(
          new events.InputItem({ role: "user", content: [new events.InputTextContent({ text })] }),
        );
      } else if (
        role === "assistant" &&
        text &&
        !(message.tool_calls && message.tool_calls.length > 0)
      ) {
        items.push(
          new events.InputItem({
            role: "assistant",
            content: [new events.OutputTextContent({ text })],
          }),
        );
      } else {
        logger.debug(
          `Skipping context message with no startup-history representation: role=${pyRepr(role)}`,
        );
      }
    }

    if (items.length > events.MAX_INPUT_ITEMS) {
      if (!this._warnedInputTruncated) {
        this._warnedInputTruncated = true;
        logger.warning(
          `Context has ${items.length} text messages but the OpenAI Live API accepts ` +
            `at most ${events.MAX_INPUT_ITEMS} startup messages; keeping the most recent.`,
        );
      }
      items = items.slice(-events.MAX_INPUT_ITEMS);
    }
    return items;
  }

  /** Return a message's text content, joining text parts of list content. */
  protected static _textContent(message: Dict): string {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (part: unknown) =>
            part !== null &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            (part as Dict).type === "text" &&
            (part as Dict).text,
        )
        .map((part: Dict) => part.text ?? "")
        .join(" ");
    }
    return "";
  }

  /**
   * Convert a context tool choice to the Responses API shape.
   *
   * The context stores the chat-completions form, whose named-function
   * variant nests the name (`{"type": "function", "function": {"name": …}}`);
   * the Responses API takes it flat (`{"type": "function", "name": …}`).
   */
  protected static _toToolChoice(toolChoice: unknown | NotGiven): unknown | null {
    if (!isGiven(toolChoice) || toolChoice == null) {
      return null;
    }
    if (
      typeof toolChoice === "object" &&
      !Array.isArray(toolChoice) &&
      (toolChoice as Dict).function !== null &&
      typeof (toolChoice as Dict).function === "object" &&
      !Array.isArray((toolChoice as Dict).function)
    ) {
      return { type: "function", name: (toolChoice as Dict).function.name ?? null };
    }
    return toolChoice;
  }
}

/** Python's `repr()` for the values a message role can hold (a string or None). */
function pyRepr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") {
    // Python picks double quotes when the string has a ' and no ".
    const escaped = value.replace(/\\/g, "\\\\");
    if (value.includes("'") && !value.includes('"')) return `"${escaped}"`;
    return `'${escaped.replace(/'/g, "\\'")}'`;
  }
  return pyJsonDumps(value);
}
