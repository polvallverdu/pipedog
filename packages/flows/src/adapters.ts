// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/flows/adapters.py

/**
 * LLM adapter for conversation-summary generation and formatting.
 *
 * This module provides the LLMAdapter class used by the flow manager to:
 *
 * - Format a generated summary as a context message
 * - Generate a summary via out-of-band LLM inference
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  LLMContext,
  type LLMContextMessage,
  type LLMStandardMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

/** The part of an LLM service (or `LLMSwitcher`) summary generation uses. */
export interface SummaryInferenceLLM {
  runInference(
    context: LLMContext,
    options?: { systemInstruction?: string | null },
  ): Promise<string | null>;
}

/** Helpers for generating and formatting conversation summaries. */
export class LLMAdapter {
  /**
   * Format a summary as a developer message.
   *
   * Summary messages use the LLMContextMessage format (OpenAI-style), as
   * summarization triggers an LLMMessagesUpdateFrame.
   *
   * @param summary The generated summary text.
   * @returns A developer message containing the summary.
   */
  formatSummaryMessage(summary: string): LLMStandardMessage {
    return { role: "developer", content: `Here's a summary of the conversation:\n${summary}` };
  }

  /**
   * Generate a summary by running a direct one-shot, out-of-band inference with the LLM.
   *
   * @param llm LLM service instance containing client/credentials.
   * @param summaryPrompt Prompt text to guide summary generation.
   * @param context Context object containing conversation history for the summary.
   * @returns Generated summary text, or null if generation fails.
   */
  async generateSummary(
    llm: SummaryInferenceLLM,
    summaryPrompt: string,
    context: LLMContext,
  ): Promise<string | null> {
    try {
      const messages = context.getMessages();

      // DIVERGENCE: upstream interpolates the Python repr of the message list;
      // here it is the JSON of the list.
      const promptMessages: LLMContextMessage[] = [
        {
          role: "developer",
          content: `Conversation history: ${pyJsonDumps(messages)}`,
        },
      ];

      const summaryContext = new LLMContext({ messages: promptMessages });

      return await llm.runInference(summaryContext, { systemInstruction: summaryPrompt });
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Summary generation failed: ${e instanceof Error ? e.message : String(e)}`, e);
      return null;
    }
  }
}
