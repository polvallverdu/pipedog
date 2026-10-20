// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_context_summarizer.py

/** This module defines a summarizer for managing LLM context summarization. */

import { rethrowIfCancelled, TimeoutError, waitFor } from "@pipedog/asyncio";
import {
  type Frame,
  InterruptionFrame,
  LLMContextSummaryRequestFrame,
  LLMContextSummaryResultFrame,
  LLMFullResponseStartFrame,
  LLMSummarizeContextFrame,
} from "../../frames/frames.ts";
import type { LLMService } from "../../services/llm_service.ts";
import { BaseObject } from "../../utils/base_object.ts";
import {
  DEFAULT_SUMMARIZATION_TIMEOUT,
  LLMAutoContextSummarizationConfig,
  LLMContextSummarizationUtil,
  type LLMContextSummaryConfig,
} from "../../utils/context/llm_context_summarization.ts";
import { logger } from "../../utils/logger.ts";
import type { FrameProcessorSetup } from "../frame_processor.ts";
import { type LLMContext, type LLMContextMessage, LLMSpecificMessage } from "./llm_context.ts";

export interface SummaryAppliedEventOptions {
  /** Number of messages before summarization. */
  originalMessageCount: number;
  /** Number of messages after summarization. */
  newMessageCount: number;
  /** Number of messages that were compressed into the summary. */
  summarizedMessageCount: number;
  /** Number of recent messages preserved uncompressed. */
  preservedMessageCount: number;
}

/**
 * Event data emitted when context summarization completes successfully.
 *
 * - `originalMessageCount`: Number of messages before summarization.
 * - `newMessageCount`: Number of messages after summarization.
 * - `summarizedMessageCount`: Number of messages that were compressed into the summary.
 * - `preservedMessageCount`: Number of recent messages preserved uncompressed.
 */
export class SummaryAppliedEvent {
  originalMessageCount: number;
  newMessageCount: number;
  summarizedMessageCount: number;
  preservedMessageCount: number;

  constructor(options: SummaryAppliedEventOptions) {
    this.originalMessageCount = options.originalMessageCount;
    this.newMessageCount = options.newMessageCount;
    this.summarizedMessageCount = options.summarizedMessageCount;
    this.preservedMessageCount = options.preservedMessageCount;
  }
}

export interface LLMContextSummarizerOptions {
  /** The LLM context to monitor and summarize. */
  context: LLMContext;
  /**
   * Auto-summarization configuration controlling both trigger thresholds and
   * default summary generation parameters. If null, uses default
   * `LLMAutoContextSummarizationConfig` values.
   */
  config?: LLMAutoContextSummarizationConfig | null;
  /**
   * Whether to automatically trigger summarization when thresholds are
   * reached. When false, summarization only happens when an
   * `LLMSummarizeContextFrame` is pushed into the pipeline. Defaults to true.
   */
  autoTrigger?: boolean;
}

// `LLMService._generateSummary` is protected; the summarizer calls it directly
// on a dedicated LLM, as upstream does.
interface SummaryGenerator {
  _generateSummary(frame: LLMContextSummaryRequestFrame): Promise<[string, number]>;
}

/**
 * Summarizer for managing LLM context summarization.
 *
 * This class manages context summarization, either automatically when token
 * or message limits are reached, or on-demand when an
 * `LLMSummarizeContextFrame` is received. It monitors the LLM context size,
 * triggers summarization requests, and applies the results to compress
 * conversation history.
 *
 * When `autoTrigger` is true (the default), summarization is triggered
 * automatically based on the configured thresholds in
 * `LLMAutoContextSummarizationConfig`. When `autoTrigger` is false, threshold
 * checks are skipped and summarization only happens when an
 * `LLMSummarizeContextFrame` is explicitly pushed into the pipeline.
 *
 * Both modes can coexist: set `autoTrigger: true` and also push
 * `LLMSummarizeContextFrame` at any time to force an immediate summarization
 * (subject to the `_summarizationInProgress` guard).
 *
 * Event handlers available:
 *
 * - on_request_summarization: Emitted when summarization should be triggered.
 *   The aggregator should broadcast this frame to the LLM service.
 * - on_summary_applied: Emitted after a summary has been successfully applied
 *   to the context. Receives a SummaryAppliedEvent with metrics about the
 *   compression.
 *
 * @example
 * summarizer.eventHandler("on_request_summarization", async (summarizer, frame: LLMContextSummaryRequestFrame) => {
 *   await aggregator.broadcastFrame(LLMContextSummaryRequestFrame, {
 *     requestId: frame.requestId,
 *     context: frame.context,
 *     // ...
 *   });
 * });
 *
 * summarizer.eventHandler("on_summary_applied", async (summarizer, event: SummaryAppliedEvent) => {
 *   logger.info(`Compressed ${event.originalMessageCount} -> ${event.newMessageCount} messages`);
 * });
 */
export class LLMContextSummarizer extends BaseObject {
  protected _context: LLMContext;
  protected _autoConfig: LLMAutoContextSummarizationConfig;
  protected _autoTrigger: boolean;

  protected _summarizationInProgress = false;
  protected _pendingSummaryRequestId: string | null = null;

  // The summary message injected by the last applied summary, tracked by
  // identity so the message-count trigger can exclude it only while it is
  // still at the head of the context.
  protected _summaryMessage: LLMContextMessage | null = null;

  /** Initialize the context summarizer. */
  constructor(options: LLMContextSummarizerOptions) {
    super();

    this._context = options.context;
    this._autoConfig = options.config || new LLMAutoContextSummarizationConfig();
    this._autoTrigger = options.autoTrigger ?? true;

    this._registerEventHandler("on_request_summarization", true);
    this._registerEventHandler("on_summary_applied");
  }

  /**
   * Return 1 if the first message is a system message, else 0.
   *
   * Mirrors the messages[0] system-message check used elsewhere when
   * selecting messages to summarize and when reconstructing the context after
   * a summary, so the message count stays consistent with what those steps
   * actually preserve.
   *
   * @param messages The context messages to check.
   * @returns 1 if `messages[0]` is a system message, otherwise 0.
   */
  protected static _leadingSystemMessageCount(messages: LLMContextMessage[]): number {
    const first = messages[0];
    if (first !== undefined && !(first instanceof LLMSpecificMessage) && first.role === "system") {
      return 1;
    }
    return 0;
  }

  /**
   * Count the conversation messages added since the last applied summary.
   *
   * Excludes the leading system message, if present, and the summary message
   * injected by the last summary while it still sits directly after it. Both
   * are computed from the current context so that replacing the messages (for
   * example, resetting the conversation) resets the count as well.
   *
   * @returns The number of messages that count toward `maxUnsummarizedMessages`.
   */
  protected _messagesSinceSummary(): number {
    const messages = this._context.messages;
    let excluded = LLMContextSummarizer._leadingSystemMessageCount(messages);
    if (
      this._summaryMessage !== null &&
      messages.length > excluded &&
      messages[excluded] === this._summaryMessage
    ) {
      excluded += 1;
    }
    return messages.length - excluded;
  }

  /**
   * Set up the summarizer.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup | unknown): Promise<void> {
    await super.setup((setup as FrameProcessorSetup).taskManager);
  }

  /** Cleanup the summarizer. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._clearSummarizationState();
  }

  /**
   * Process an incoming frame to detect when summarization is needed.
   *
   * @param frame The frame to be processed.
   */
  async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof LLMFullResponseStartFrame) {
      await this._handleLlmResponseStart(frame);
    } else if (frame instanceof LLMSummarizeContextFrame) {
      await this._handleManualSummarizationRequest(frame);
    } else if (frame instanceof LLMContextSummaryResultFrame) {
      await this._handleSummaryResult(frame);
    } else if (frame instanceof InterruptionFrame) {
      await this._handleInterruption();
    }
  }

  /**
   * Handle LLM response start to check if summarization is needed.
   *
   * @param frame The LLM response start frame.
   */
  protected async _handleLlmResponseStart(_frame: LLMFullResponseStartFrame): Promise<void> {
    if (this._shouldSummarize()) {
      await this._requestSummarization();
    }
  }

  /**
   * Handle an explicit on-demand summarization request.
   *
   * Reuses the same `_requestSummarization()` code path as auto mode, so
   * bookkeeping (`_summarizationInProgress`, `_pendingSummaryRequestId`) is
   * always updated correctly.
   *
   * @param frame The manual summarization request frame, optionally carrying
   *   a per-request LLMContextSummaryConfig.
   */
  protected async _handleManualSummarizationRequest(
    frame: LLMSummarizeContextFrame,
  ): Promise<void> {
    if (this._summarizationInProgress) {
      logger.debug(`${this}: Summarization already in progress, ignoring manual request`);
      return;
    }
    await this._requestSummarization(frame.config);
  }

  /** Handle interruption by canceling summarization in progress. */
  protected async _handleInterruption(): Promise<void> {
    // Reset summarization state to allow new requests. This is necessary
    // because the request frame (LLMContextSummaryRequestFrame) may have been
    // cancelled during interruption. We preserve _pendingSummaryRequestId to
    // handle the response frame (LLMContextSummaryResultFrame), which is
    // uninterruptible and will still be delivered.
    this._summarizationInProgress = false;
  }

  /** Cancel pending summarization. */
  protected async _clearSummarizationState(): Promise<void> {
    if (this._summarizationInProgress) {
      logger.debug(`${this}: Clearing pending summarization`);
      this._summarizationInProgress = false;
      this._pendingSummaryRequestId = null;
    }
  }

  /**
   * Determine if context summarization should be triggered.
   *
   * Evaluates whether the current context has reached either the token
   * threshold or message count threshold that warrants compression. Either
   * threshold can be null to disable that check; at least one must be set
   * (enforced at config construction time).
   *
   * @returns True when `autoTrigger` is enabled, no summarization is in
   *   progress, and either the token count exceeds `maxContextTokens` or the
   *   message count since the last summary exceeds `maxUnsummarizedMessages`
   *   (whichever of the two is set).
   */
  protected _shouldSummarize(): boolean {
    logger.trace(`${this}: Checking if context summarization is needed`);

    if (!this._autoTrigger) {
      return false;
    }

    if (this._summarizationInProgress) {
      logger.debug(`${this}: Summarization already in progress`);
      return false;
    }

    // Estimate tokens in context
    const totalTokens = LLMContextSummarizationUtil.estimateContextTokens(this._context);
    const numMessages = this._context.messages.length;

    // Check if we've reached the token limit
    const tokenLimit = this._autoConfig.maxContextTokens;
    const tokenLimitExceeded = tokenLimit !== null && totalTokens >= tokenLimit;

    // Check if we've exceeded max unsummarized messages
    const messagesSinceSummary = this._messagesSinceSummary();
    const messageThreshold = this._autoConfig.maxUnsummarizedMessages;
    const messageThresholdExceeded =
      messageThreshold !== null && messagesSinceSummary >= messageThreshold;

    logger.trace(
      `${this}: Context has ${numMessages} messages, ` +
        `~${totalTokens} tokens (limit: ${tokenLimit !== null ? tokenLimit : "disabled"}), ` +
        `${messagesSinceSummary} messages since last summary ` +
        `(message threshold: ${messageThreshold !== null ? messageThreshold : "disabled"})`,
    );

    // Trigger if either limit is exceeded
    if (!tokenLimitExceeded && !messageThresholdExceeded) {
      logger.trace(
        `${this}: Neither token limit nor message threshold exceeded, skipping summarization`,
      );
      return false;
    }

    const reason: string[] = [];
    if (tokenLimitExceeded) {
      reason.push(`~${totalTokens} tokens (>=${tokenLimit} limit)`);
    }
    if (messageThresholdExceeded) {
      reason.push(`${messagesSinceSummary} messages (>=${messageThreshold} threshold)`);
    }

    logger.debug(`${this}: ✓ Summarization needed - ${reason.join(", ")}`);
    return true;
  }

  /**
   * Request context summarization from LLM service.
   *
   * Creates a summarization request frame and either handles it directly
   * using a dedicated LLM (if configured) or emits it via event handler for
   * the pipeline's primary LLM. Tracks the request ID to match async
   * responses and prevent race conditions.
   *
   * @param configOverride Optional per-request summary configuration. If
   *   provided, overrides the default summary generation settings from
   *   `this._autoConfig.summaryConfig`.
   */
  protected async _requestSummarization(
    configOverride: LLMContextSummaryConfig | null = null,
  ): Promise<void> {
    // Generate unique request ID
    const requestId = crypto.randomUUID();
    const summaryConfig = configOverride || this._autoConfig.summaryConfig;

    // Mark summarization in progress
    this._summarizationInProgress = true;
    this._pendingSummaryRequestId = requestId;

    logger.debug(`${this}: Sending summarization request (request_id=${requestId})`);

    // Create the request frame
    const requestFrame = new LLMContextSummaryRequestFrame({
      requestId,
      context: this._context,
      minMessagesToKeep: summaryConfig.minMessagesAfterSummary,
      targetContextTokens: summaryConfig.targetContextTokens,
      summarizationPrompt: summaryConfig.summaryPrompt,
      summarizationTimeout: summaryConfig.summarizationTimeout,
    });

    if (summaryConfig.llm) {
      // Use dedicated LLM directly — no need to involve the pipeline
      const llm = summaryConfig.llm;
      this.taskManager.createTask(
        () => this._generateSummaryWithDedicatedLlm(llm, requestFrame),
        `${this}-dedicated-llm-summary`,
      );
    } else {
      // Emit event for aggregator to broadcast to the pipeline LLM
      await this._callEventHandler("on_request_summarization", requestFrame);
    }
  }

  /**
   * Generate summary using a dedicated LLM service.
   *
   * Calls the dedicated LLM's `_generateSummary` directly and feeds the
   * result back through `_handleSummaryResult`, bypassing the pipeline.
   *
   * @param llm The dedicated LLM service to use for summarization.
   * @param frame The summarization request frame.
   */
  protected async _generateSummaryWithDedicatedLlm(
    llm: LLMService,
    frame: LLMContextSummaryRequestFrame,
  ): Promise<void> {
    // Python `or`: a 0 timeout also falls back to the default.
    const timeout = frame.summarizationTimeout || DEFAULT_SUMMARIZATION_TIMEOUT;

    let resultFrame: LLMContextSummaryResultFrame;
    try {
      const generator = llm as unknown as SummaryGenerator;
      const [summary, lastIndex] = await waitFor(() => generator._generateSummary(frame), timeout);
      resultFrame = new LLMContextSummaryResultFrame({
        requestId: frame.requestId,
        summary,
        lastSummarizedIndex: lastIndex,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      let error: string;
      if (e instanceof TimeoutError) {
        error = `Context summarization timed out after ${timeout}s`;
      } else {
        error = `Error generating context summary: ${e instanceof Error ? e.message : String(e)}`;
      }
      logger.error(`${this}: ${error}`);
      resultFrame = new LLMContextSummaryResultFrame({
        requestId: frame.requestId,
        summary: "",
        lastSummarizedIndex: -1,
        error,
      });
    }

    await this._handleSummaryResult(resultFrame);
  }

  /**
   * Handle context summarization result from LLM service.
   *
   * Processes the summary result by validating the request ID, checking for
   * errors, validating context state, and applying the summary.
   *
   * @param frame The summary result frame containing the generated summary.
   */
  protected async _handleSummaryResult(frame: LLMContextSummaryResultFrame): Promise<void> {
    logger.debug(`${this}: Received summary result (request_id=${frame.requestId})`);

    // Check if this is the result we're waiting for. Both auto and manual
    // summarization set _pendingSummaryRequestId via _requestSummarization(),
    // so this check always applies.
    if (frame.requestId !== this._pendingSummaryRequestId) {
      logger.debug(`${this}: Ignoring stale summary result (request_id=${frame.requestId})`);
      return;
    }

    // Clear pending state
    await this._clearSummarizationState();

    // Check for errors
    if (frame.error) {
      logger.error(`${this}: Context summarization failed: ${frame.error}`);
      return;
    }

    // Validate context state
    if (!this._validateSummaryContext(frame.lastSummarizedIndex)) {
      logger.warning(`${this}: Context state changed, skipping summary application`);
      return;
    }

    // Apply summary
    await this._applySummary(frame.summary, frame.lastSummarizedIndex);
  }

  /**
   * Validate that context state is still valid for applying summary.
   *
   * @param lastSummarizedIndex The index of the last summarized message.
   * @returns True if the context state is still consistent with the summary.
   */
  protected _validateSummaryContext(lastSummarizedIndex: number): boolean {
    if (lastSummarizedIndex < 0) {
      return false;
    }

    // Check if we still have enough messages
    if (lastSummarizedIndex >= this._context.messages.length) {
      return false;
    }

    const minKeep = this._autoConfig.summaryConfig.minMessagesAfterSummary;
    const remaining = this._context.messages.length - 1 - lastSummarizedIndex;
    if (remaining < minKeep) {
      return false;
    }

    return true;
  }

  /**
   * Apply summary to compress the conversation context.
   *
   * Reconstructs the context with:
   * [first_system_message] + [summary_message] + [recent_messages]
   *
   * @param summary The generated summary text.
   * @param lastSummarizedIndex Index of the last message that was summarized.
   */
  protected async _applySummary(summary: string, lastSummarizedIndex: number): Promise<void> {
    const config = this._autoConfig.summaryConfig;
    const messages = this._context.messages;

    // Preserve the first message if it is a system message (initial system
    // prompt). Only messages[0] is treated as the system preamble — system
    // messages at other positions are mid-conversation injections and are not
    // preserved separately (they will be part of the summary or the recent
    // messages).
    const numSystemPreserved = LLMContextSummarizer._leadingSystemMessageCount(messages);
    const firstSystemMsg = numSystemPreserved ? messages[0] : null;

    // Get recent messages to keep
    const recentMessages = messages.slice(lastSummarizedIndex + 1);

    // Create summary message as a user message (the summary is context
    // provided *to* the assistant, not something the assistant said)
    const summaryContent = formatSummaryTemplate(config.summaryMessageTemplate, summary);
    const summaryMessage: LLMContextMessage = { role: "user", content: summaryContent };

    // Reconstruct context
    const newMessages: LLMContextMessage[] = [];
    if (firstSystemMsg) {
      newMessages.push(firstSystemMsg);
    }
    newMessages.push(summaryMessage);
    newMessages.push(...recentMessages);

    // Update context
    const originalMessageCount = messages.length;
    this._context.setMessages(newMessages);

    this._summaryMessage = summaryMessage;

    // Messages actually summarized = index range minus the preserved system message
    const summarizedCount = lastSummarizedIndex + 1 - numSystemPreserved;

    logger.info(
      `${this}: Applied context summary, compressed ${summarizedCount} messages ` +
        `into summary. Context now has ${newMessages.length} messages (was ${originalMessageCount})`,
    );

    // Emit event for observability
    const event = new SummaryAppliedEvent({
      originalMessageCount,
      newMessageCount: newMessages.length,
      summarizedMessageCount: summarizedCount,
      preservedMessageCount: recentMessages.length + numSystemPreserved,
    });
    await this._callEventHandler("on_summary_applied", event);
  }
}

/**
 * Python `template.format(summary=summary)`: replaces `{summary}` and
 * unescapes doubled braces.
 */
function formatSummaryTemplate(template: string, summary: string): string {
  return template.replace(/\{\{|\}\}|\{summary\}/g, (m) =>
    m === "{{" ? "{" : m === "}}" ? "}" : summary,
  );
}
