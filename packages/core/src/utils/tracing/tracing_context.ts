// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/tracing/tracing_context.py

/**
 * Pipeline-scoped tracing context for OpenTelemetry tracing in Pipecat.
 *
 * This module provides a per-pipeline tracing context that holds the current
 * conversation and turn span contexts. Each PipelineWorker creates its own
 * TracingContext, ensuring concurrent pipelines do not interfere with each
 * other.
 */

import { getOpenTelemetry, type OtelContext, type OtelSpanContext } from "./setup.ts";

/** Wrap a span context in a non-recording span and put it in a context. */
function contextWithSpanContext(spanContext: OtelSpanContext): OtelContext | null {
  const otel = getOpenTelemetry();
  if (!otel) return null;
  const nonRecordingSpan = otel.api.trace.wrapSpanContext(spanContext);
  return otel.api.trace.setSpan(otel.api.context.active(), nonRecordingSpan);
}

/**
 * Pipeline-scoped tracing context.
 *
 * Holds the current conversation and turn span contexts for a single pipeline.
 * Created by PipelineWorker, passed to TurnTraceObserver (writer) and services
 * (readers) via StartFrame.
 */
export class TracingContext {
  protected _conversationContext: OtelContext | null = null;
  protected _turnContext: OtelContext | null = null;
  protected _conversationId: string | null = null;

  /**
   * Set the current conversation context.
   *
   * @param spanContext The span context for the current conversation or null to clear it.
   * @param conversationId Optional ID for the conversation.
   */
  setConversationContext(
    spanContext: OtelSpanContext | null,
    conversationId: string | null = null,
  ): void {
    if (getOpenTelemetry() === null) {
      return;
    }

    this._conversationId = conversationId;

    if (spanContext) {
      this._conversationContext = contextWithSpanContext(spanContext);
    } else {
      this._conversationContext = null;
    }
  }

  /**
   * Get the OpenTelemetry context for the current conversation.
   *
   * @returns The current conversation context or null if not available.
   */
  getConversationContext(): OtelContext | null {
    return this._conversationContext;
  }

  /**
   * Set the current turn context.
   *
   * @param spanContext The span context for the current turn or null to clear it.
   */
  setTurnContext(spanContext: OtelSpanContext | null): void {
    if (getOpenTelemetry() === null) {
      return;
    }

    if (spanContext) {
      this._turnContext = contextWithSpanContext(spanContext);
    } else {
      this._turnContext = null;
    }
  }

  /**
   * Get the OpenTelemetry context for the current turn.
   *
   * @returns The current turn context or null if not available.
   */
  getTurnContext(): OtelContext | null {
    return this._turnContext;
  }

  /** The ID for the current conversation, or null if not available. */
  get conversationId(): string | null {
    return this._conversationId;
  }

  /**
   * Generate a new conversation ID.
   *
   * @returns A new randomly generated UUID string.
   */
  static generateConversationId(): string {
    return crypto.randomUUID();
  }
}
