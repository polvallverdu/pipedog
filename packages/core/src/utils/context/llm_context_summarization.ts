// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/llm_context_summarization.py

/**
 * Utility for context summarization in LLM services.
 *
 * This module provides reusable functionality for automatically compressing
 * conversation context when token limits are reached, enabling efficient
 * long-running conversations.
 *
 * The deprecated `LLMContextSummarizationConfig` is not ported; use
 * `LLMAutoContextSummarizationConfig` with a nested `LLMContextSummaryConfig`.
 */

import {
  type LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "../../processors/aggregators/llm_context.ts";
import type { LLMService } from "../../services/llm_service.ts";
import { logger } from "../logger.ts";

/** Fallback timeout (seconds) used when summarizationTimeout is null. */
export const DEFAULT_SUMMARIZATION_TIMEOUT = 120.0;

// Token estimation constants
/** Industry-standard heuristic: 1 token ≈ 4 characters. */
export const CHARS_PER_TOKEN = 4;
/** Estimated structural overhead per message. */
export const TOKEN_OVERHEAD_PER_MESSAGE = 10;
/** Rough estimate for image content. */
export const IMAGE_TOKEN_ESTIMATE = 500;
/** Keep summary at 80% of available space for safety. */
export const SUMMARY_TOKEN_BUFFER = 0.8;
/** Minimum tokens to allocate for summary. */
export const MIN_SUMMARY_TOKENS = 100;

export const DEFAULT_SUMMARIZATION_PROMPT = `You are summarizing a conversation between a user and an AI assistant.

Your task:
1. Create a concise summary that preserves:
   - Key facts, decisions, and agreements
   - Important context needed to continue the conversation
   - User preferences and requirements mentioned
   - Any unresolved questions or action items

2. Format:
   - Use clear, factual statements
   - Group related information
   - Prioritize information likely to be referenced later
   - Keep the summary concise to fit within the specified token budget

3. Omit:
   - Greetings and small talk
   - Redundant information
   - Tangential discussions that were resolved

The conversation transcript follows. Generate only the summary, no other text.`;

export interface LLMContextSummaryConfigOptions {
  /**
   * Maximum token size for the generated summary. This value is passed
   * directly to the LLM as the max_tokens parameter when generating the
   * summary. Should be sized appropriately to allow the summary plus recent
   * preserved messages to fit within reasonable context limits.
   */
  targetContextTokens?: number;
  /**
   * Number of recent messages to preserve uncompressed after each
   * summarization. These messages maintain immediate conversational context.
   */
  minMessagesAfterSummary?: number;
  /**
   * Custom prompt for the LLM to use when generating summaries. If null,
   * uses DEFAULT_SUMMARIZATION_PROMPT.
   */
  summarizationPrompt?: string | null;
  /**
   * Template for formatting the summary when injected into context. Must
   * contain `{summary}` as a placeholder for the generated summary text.
   * Allows applications to wrap the summary in custom delimiters (e.g., XML
   * tags) so that system prompts can distinguish summaries from live
   * conversation.
   */
  summaryMessageTemplate?: string;
  /**
   * Optional separate LLM service for generating summaries. When set,
   * summarization requests are sent to this service instead of the
   * pipeline's primary LLM. Useful for routing summarization to a
   * cheaper/faster model (e.g., Gemini Flash) while keeping an expensive
   * model for conversation. If null, uses the pipeline LLM.
   */
  llm?: LLMService | null;
  /**
   * Maximum time in seconds to wait for the LLM to generate a summary. If
   * the call exceeds this timeout, summarization is aborted with an error
   * and future summarizations are unblocked.
   */
  summarizationTimeout?: number;
}

/**
 * Configuration for summary generation parameters.
 *
 * Contains settings that control how a summary is generated. Used by both
 * automatic and manual summarization modes. See
 * `LLMContextSummaryConfigOptions` for the fields.
 */
export class LLMContextSummaryConfig {
  targetContextTokens: number;
  minMessagesAfterSummary: number;
  summarizationPrompt: string | null;
  summaryMessageTemplate: string;
  llm: LLMService | null;
  summarizationTimeout: number;

  /**
   * @throws Error If a parameter is out of range (upstream: ValueError).
   */
  constructor(options: LLMContextSummaryConfigOptions = {}) {
    this.targetContextTokens = options.targetContextTokens ?? 6000;
    this.minMessagesAfterSummary = options.minMessagesAfterSummary ?? 4;
    this.summarizationPrompt = options.summarizationPrompt ?? null;
    this.summaryMessageTemplate =
      options.summaryMessageTemplate ?? "Conversation summary: {summary}";
    this.llm = options.llm ?? null;
    this.summarizationTimeout = options.summarizationTimeout ?? DEFAULT_SUMMARIZATION_TIMEOUT;

    // Validate configuration parameters.
    if (this.targetContextTokens <= 0) {
      throw new Error("target_context_tokens must be positive");
    }
    if (this.minMessagesAfterSummary < 0) {
      throw new Error("min_messages_after_summary must be non-negative");
    }
  }

  /**
   * The summarization prompt to use: the custom prompt if set, otherwise the
   * default summarization prompt.
   */
  get summaryPrompt(): string {
    return this.summarizationPrompt || DEFAULT_SUMMARIZATION_PROMPT;
  }
}

export interface LLMAutoContextSummarizationConfigOptions {
  /**
   * Maximum allowed context size in tokens. When this limit is reached,
   * summarization is triggered to compress the context. The tokens are
   * calculated using the industry-standard approximation of 1 token ≈ 4
   * characters. This measures the context messages only: the LLM service's
   * `systemInstruction` is sent on every inference but is not part of the
   * context, and summarization cannot compress it. Size this limit against
   * the model's window minus the instruction. Set to null to disable
   * token-based triggering. Defaults to 8000.
   */
  maxContextTokens?: number | null;
  /**
   * Maximum number of new messages that can accumulate since the last
   * summary before triggering a new summarization. This ensures regular
   * compression even if token limits are not reached. Set to null to disable
   * message-count triggering. Defaults to 20.
   */
  maxUnsummarizedMessages?: number | null;
  /**
   * Configuration for summary generation parameters (prompt, token budget,
   * messages to keep). If not provided, uses default `LLMContextSummaryConfig`
   * values.
   */
  summaryConfig?: LLMContextSummaryConfig;
}

/**
 * Configuration for automatic context summarization.
 *
 * Controls when conversation context is automatically compressed and how
 * that summary is generated. Summarization is triggered when either the
 * token limit or the unsummarized message count threshold is exceeded.
 *
 * At least one of `maxContextTokens` and `maxUnsummarizedMessages` must be
 * set. Set the other to null to disable that threshold.
 */
export class LLMAutoContextSummarizationConfig {
  maxContextTokens: number | null;
  maxUnsummarizedMessages: number | null;
  summaryConfig: LLMContextSummaryConfig;

  /**
   * @throws Error If a parameter is out of range (upstream: ValueError).
   */
  constructor(options: LLMAutoContextSummarizationConfigOptions = {}) {
    this.maxContextTokens =
      options.maxContextTokens === undefined ? 8000 : options.maxContextTokens;
    this.maxUnsummarizedMessages =
      options.maxUnsummarizedMessages === undefined ? 20 : options.maxUnsummarizedMessages;
    this.summaryConfig = options.summaryConfig ?? new LLMContextSummaryConfig();

    // Validate configuration parameters.
    if (this.maxContextTokens === null && this.maxUnsummarizedMessages === null) {
      throw new Error(
        "At least one of max_context_tokens and max_unsummarized_messages must be set",
      );
    }
    if (this.maxContextTokens !== null && this.maxContextTokens <= 0) {
      throw new Error("max_context_tokens must be positive");
    }
    if (this.maxUnsummarizedMessages !== null && this.maxUnsummarizedMessages < 1) {
      throw new Error("max_unsummarized_messages must be at least 1");
    }

    // Auto-adjust targetContextTokens if it exceeds maxContextTokens
    if (
      this.maxContextTokens !== null &&
      this.summaryConfig.targetContextTokens > this.maxContextTokens
    ) {
      // Use 80% of maxContextTokens as a reasonable default
      this.summaryConfig.targetContextTokens = Math.trunc(this.maxContextTokens * 0.8);
    }
  }
}

export interface LLMMessagesToSummarizeOptions {
  /** Messages to include in the summary. */
  messages: LLMContextMessage[];
  /** Index of the last message being summarized. */
  lastSummarizedIndex: number;
}

/**
 * Result of the getMessagesToSummarize operation.
 *
 * - `messages`: Messages to include in the summary.
 * - `lastSummarizedIndex`: Index of the last message being summarized.
 */
export class LLMMessagesToSummarize {
  messages: LLMContextMessage[];
  lastSummarizedIndex: number;

  constructor(options: LLMMessagesToSummarizeOptions) {
    this.messages = options.messages;
    this.lastSummarizedIndex = options.lastSummarizedIndex;
  }
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A standard (OpenAI-format) message seen as a dict, as upstream reads it. */
function asDict(message: LLMContextMessage): Dict {
  return message as unknown as Dict;
}

function getString(dict: Dict, key: string, fallback: string): string {
  const value = dict[key];
  return value === undefined || value === null ? fallback : String(value);
}

/** Python's `json.loads(...)`, returning undefined instead of raising. */
function tryParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Utility providing context summarization capabilities for LLM processing.
 *
 * This utility enables automatic conversation context compression when token
 * limits are reached. It provides functionality for both aggregators
 * (which decide when to summarize) and LLM services (which generate summaries).
 *
 * Key features:
 * - Token estimation using character-count heuristics (chars / 4)
 * - Smart message selection (preserves system messages and recent context)
 * - Function call awareness (avoids summarizing incomplete tool interactions)
 * - Flexible transcript formatting for summarization
 * - Maximum summary token calculation with safety buffers
 *
 * @example
 * // Use the static methods directly on the class:
 * const tokens = LLMContextSummarizationUtil.estimateContextTokens(context);
 * const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 4);
 * const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(messages);
 *
 * Note: token estimation uses the industry-standard heuristic of 1 token ≈ 4 characters.
 */
export class LLMContextSummarizationUtil {
  /**
   * Estimate token count for text using character count heuristic.
   *
   * Uses the industry-standard approximation of 1 token ≈ 4 characters.
   * This works well across different content types (prose, code, etc.)
   * and languages.
   *
   * Note: for more accurate token counts, use the model's official tokenizer.
   * This is a rough estimate suitable for threshold checks and budgeting.
   *
   * @param text Text to estimate tokens for.
   * @returns Estimated token count (characters / 4, rounded down).
   */
  static estimateTokens(text: string | null | undefined): number {
    if (!text) {
      return 0;
    }
    // Count code points, as Python's len() does.
    let length = 0;
    for (const _ of text) length++;
    return Math.floor(length / CHARS_PER_TOKEN);
  }

  /**
   * Estimate total token count for a context.
   *
   * Calculates an approximate token count by analyzing all messages,
   * including text content, tool calls, and structural overhead.
   *
   * @param context LLM context to estimate.
   * @returns The estimated total token count, covering message content (text
   *   and images), tool calls and their arguments, tool results, and
   *   `TOKEN_OVERHEAD_PER_MESSAGE` of structural overhead per message.
   */
  static estimateContextTokens(context: LLMContext): number {
    let total = 0;

    for (const message of context.messages) {
      // LLMSpecificMessage holds service-specific data (e.g. thinking blocks,
      // thought signatures). Skipping them here for now.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      const msg = asDict(message);

      // Role and structure overhead
      total += TOKEN_OVERHEAD_PER_MESSAGE;

      // Message content
      const content = msg.content ?? "";
      if (typeof content === "string") {
        total += LLMContextSummarizationUtil.estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (isDict(item)) {
            const itemType = item.type ?? "";
            // Text content
            if (itemType === "text") {
              total += LLMContextSummarizationUtil.estimateTokens(getString(item, "text", ""));
            }
            // Image content
            else if (itemType === "image_url" || itemType === "image") {
              // Images are expensive, rough estimate
              total += IMAGE_TOKEN_ESTIMATE;
            }
          }
        }
      }

      // Tool calls
      if ("tool_calls" in msg) {
        const toolCalls = msg.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            if (isDict(toolCall)) {
              const func = toolCall.function ?? {};
              if (isDict(func)) {
                total += LLMContextSummarizationUtil.estimateTokens(
                  getString(func, "name", "") + getString(func, "arguments", ""),
                );
              }
            }
          }
        }
      }

      // Tool call ID
      if ("tool_call_id" in msg) {
        total += TOKEN_OVERHEAD_PER_MESSAGE;
      }
    }

    return total;
  }

  /**
   * Return true if a tool message content represents an unresolved call.
   *
   * A tool message is considered pending (unresolved) when its content is
   * the synchronous `"IN_PROGRESS"` sentinel or the async
   * `{"type": "async_tool", "status": "started"}` marker — both indicate
   * that the actual result has not yet been written back to the context.
   *
   * @param content The `content` field of a tool-role context message.
   * @returns True if the tool call should be treated as still in progress.
   */
  protected static _isToolMessagePending(content: string): boolean {
    if (content === "IN_PROGRESS") {
      return true;
    }
    const parsed = tryParseJson(content);
    if (isDict(parsed) && parsed.type === "async_tool" && parsed.status === "started") {
      return true;
    }
    return false;
  }

  /**
   * Find the earliest message index with incomplete function calls.
   *
   * Scans messages from `startIdx` up to (but not including) `summaryEnd`
   * to identify tool calls whose responses either don't exist yet, fall in
   * the kept portion of the context (>= summaryEnd), or are still marked as
   * `IN_PROGRESS` (async calls whose results have not yet arrived).
   *
   * This prevents summarizing tool call requests when their responses would
   * remain in the kept context as orphans, which the OpenAI API rejects,
   * and avoids summarizing async function calls before their results arrive.
   *
   * @param messages List of messages to check.
   * @param startIdx Index to start checking from.
   * @param summaryEnd Exclusive upper bound for the scan (the first kept
   *   message index). Only tool responses within this range count as
   *   completing a call; responses beyond it are treated as absent, leaving
   *   the call "in progress".
   * @returns Index of first message with function call in progress, or -1 if
   *   all function calls are complete within the scanned range.
   */
  protected static _getEarliestFunctionCallNotResolvedInRange(
    messages: readonly LLMContextMessage[],
    startIdx: number,
    summaryEnd: number,
  ): number {
    // Track tool call IDs mapped to their message index
    const pendingToolCalls = new Map<string, number>();

    for (let i = startIdx; i < summaryEnd; i++) {
      const message = messages[i] as LLMContextMessage;
      // LLMSpecificMessage instances (e.g. thinking blocks) never carry
      // tool_call or tool_call_id fields, so they cannot affect the
      // pending-call tracking.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      const msg = asDict(message);

      const role = msg.role;

      // Check for tool calls in assistant messages
      if (role === "assistant" && "tool_calls" in msg) {
        const toolCalls = msg.tool_calls ?? [];
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            if (isDict(toolCall)) {
              const toolCallId = toolCall.id;
              if (toolCallId) {
                pendingToolCalls.set(String(toolCallId), i);
              }
            }
          }
        }
      }

      // Check for tool results — treat IN_PROGRESS and async "started"
      // messages as still pending so they are not summarized away before
      // their results arrive.
      if (role === "tool") {
        const toolCallId = msg.tool_call_id;
        if (toolCallId && pendingToolCalls.has(String(toolCallId))) {
          let content = msg.content ?? "";
          if (typeof content !== "string") {
            content = "";
          }
          if (!LLMContextSummarizationUtil._isToolMessagePending(content as string)) {
            pendingToolCalls.delete(String(toolCallId));
          }
        }
      }

      // Check for async tool completion — a developer message with
      // {"type": "async_tool", "status": "finished"} signals that the
      // async result has arrived and the call is now resolved.
      if (role === "developer") {
        const content = msg.content ?? "";
        if (typeof content !== "string") {
          continue;
        }
        const parsed = tryParseJson(content);
        if (isDict(parsed) && parsed.type === "async_tool" && parsed.status === "finished") {
          const toolCallId = parsed.tool_call_id;
          if (toolCallId && pendingToolCalls.has(String(toolCallId))) {
            pendingToolCalls.delete(String(toolCallId));
          }
        }
      }
    }

    // If we have pending tool calls, return the earliest index
    if (pendingToolCalls.size > 0) {
      return Math.min(...pendingToolCalls.values());
    }

    return -1;
  }

  /**
   * Determine which messages should be included in summarization.
   *
   * Intelligently selects messages for summarization while preserving:
   * - The first system message (defines assistant behavior)
   * - The last N messages (maintains immediate conversation context)
   * - Incomplete function call sequences (preserves tool interaction integrity)
   *
   * @param context The LLM context containing all messages.
   * @param minMessagesToKeep Number of recent messages to exclude from summarization.
   * @returns LLMMessagesToSummarize containing the messages to summarize and
   *   the index of the last message included.
   */
  static getMessagesToSummarize(
    context: LLMContext,
    minMessagesToKeep: number,
  ): LLMMessagesToSummarize {
    const messages = context.messages;
    if (messages.length <= minMessagesToKeep) {
      return new LLMMessagesToSummarize({ messages: [], lastSummarizedIndex: -1 });
    }

    // Check if the first message is a system message (initial system prompt).
    // Only messages[0] is treated as the system message to preserve — system
    // messages at other positions are mid-conversation injections and should
    // be included in the summarization range.
    const firstMsg = messages.length > 0 ? messages[0] : undefined;
    const firstIsSystem =
      firstMsg !== undefined &&
      !(firstMsg instanceof LLMSpecificMessage) &&
      asDict(firstMsg).role === "system";

    // Start summarization after the initial system message if present
    const summaryStart = firstIsSystem ? 1 : 0;

    // Get messages to keep (last N messages)
    let summaryEnd = messages.length - minMessagesToKeep;

    if (summaryStart >= summaryEnd) {
      return new LLMMessagesToSummarize({ messages: [], lastSummarizedIndex: -1 });
    }

    // Check for function calls in progress in the range we want to summarize
    const functionCallStart =
      LLMContextSummarizationUtil._getEarliestFunctionCallNotResolvedInRange(
        messages,
        summaryStart,
        summaryEnd,
      );
    if (functionCallStart >= 0 && functionCallStart < summaryEnd) {
      // Stop summarization before the function call
      logger.debug(
        `ContextSummarization: Found function call in progress at index ${functionCallStart}, ` +
          `stopping summary before it (was going to summarize up to ${summaryEnd})`,
      );
      // Count how many messages we're skipping
      const skippedMessages = summaryEnd - functionCallStart;
      summaryEnd = functionCallStart;
      if (skippedMessages > 0) {
        logger.info(
          `ContextSummarization: Skipping ${skippedMessages} messages with ` +
            "function calls in progress (will summarize after results are available)",
        );
      }
    }

    if (summaryStart >= summaryEnd) {
      return new LLMMessagesToSummarize({ messages: [], lastSummarizedIndex: -1 });
    }

    const messagesToSummarize = messages.slice(summaryStart, summaryEnd);
    const lastSummarizedIndex = summaryEnd - 1;

    return new LLMMessagesToSummarize({
      messages: messagesToSummarize,
      lastSummarizedIndex,
    });
  }

  /**
   * Format messages as a transcript for summarization.
   *
   * @param messages Messages to format.
   * @returns Formatted transcript string.
   */
  static formatMessagesForSummary(messages: readonly LLMContextMessage[]): string {
    const transcriptParts: string[] = [];

    for (const message of messages) {
      // LLMSpecificMessage holds service-specific internal data (e.g.
      // Anthropic thinking blocks, Gemini thought signatures). This data is
      // not meaningful as plain text for a summarization transcript, and the
      // summarizer LLM would not know how to interpret it. The
      // conversational content of those turns is already captured by the
      // accompanying standard assistant message.
      if (message instanceof LLMSpecificMessage) {
        continue;
      }
      const msg = asDict(message);

      const role = getString(msg, "role", "unknown");
      const content = msg.content === undefined ? "" : msg.content;

      // Handle different content types
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const item of content) {
          if (isDict(item) && item.type === "text") {
            textParts.push(getString(item, "text", ""));
          }
        }
        text = textParts.join(" ");
      } else {
        // Python's str(): a null content reads "None", as upstream formats it.
        text = content === null || content === undefined ? "None" : String(content);
      }

      if (text) {
        // Capitalize role for readability
        const formattedRole = role.toUpperCase();
        transcriptParts.push(`${formattedRole}: ${text}`);
      }

      // Include tool calls if present
      if ("tool_calls" in msg) {
        const toolCalls = msg.tool_calls ?? [];
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            if (isDict(toolCall)) {
              const func = toolCall.function ?? {};
              if (isDict(func)) {
                const name = getString(func, "name", "unknown");
                const args = getString(func, "arguments", "");
                transcriptParts.push(`TOOL_CALL: ${name}(${args})`);
              }
            }
          }
        }
      }

      // Include tool results
      if (role === "tool") {
        const toolCallId = getString(msg, "tool_call_id", "unknown");
        transcriptParts.push(`TOOL_RESULT[${toolCallId}]: ${text}`);
      }
    }

    return transcriptParts.join("\n\n");
  }
}
