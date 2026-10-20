// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/tracing/turn_trace_observer.py

/**
 * Turn trace observer for OpenTelemetry tracing in Pipecat.
 *
 * This module provides an observer that creates trace spans for each
 * conversation turn, integrating with the turn tracking system to provide
 * hierarchical tracing of conversation flows.
 *
 * Porting notes: upstream gets the tracer in `__init__`. Core imports
 * OpenTelemetry asynchronously, so an observer built before that import
 * finished gets its tracer on first use instead (`_getTracer()`).
 */

import { StartFrame } from "../../frames/frames.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  type FramePushed,
} from "../../observers/base_observer.ts";
import type { TurnTrackingObserver } from "../../observers/turn_tracking_observer.ts";
import type { UserBotLatencyObserver } from "../../observers/user_bot_latency_observer.ts";
import { logger } from "../logger.ts";
import {
  getOpenTelemetry,
  isTracingAvailable,
  type OtelAttributeValue,
  type OtelSpan,
  type OtelSpanContext,
  type OtelTracer,
} from "./setup.ts";
import { TracingContext } from "./tracing_context.ts";

export interface TurnTraceObserverOptions extends BaseObserverOptions {
  /** The turn tracking observer to monitor. */
  turnTracker: TurnTrackingObserver;
  /** The latency tracking observer for user-bot latency. */
  latencyTracker: UserBotLatencyObserver;
  /** Optional conversation ID for grouping turns. */
  conversationId?: string | null;
  /** Additional attributes to add to spans. */
  additionalSpanAttributes?: Record<string, OtelAttributeValue> | null;
  /** Pipeline-scoped tracing context for span hierarchy. */
  tracingContext?: TracingContext | null;
}

/**
 * Observer that creates trace spans for each conversation turn.
 *
 * This observer uses TurnTrackingObserver to track turns and creates
 * OpenTelemetry spans for each turn. Service spans (STT, LLM, TTS)
 * become children of the turn spans.
 *
 * If conversation tracing is enabled, turns become children of a
 * conversation span that encapsulates the entire session.
 */
export class TurnTraceObserver extends BaseObserver {
  protected _turnTracker: TurnTrackingObserver;
  protected _latencyTracker: UserBotLatencyObserver;
  protected _tracingContext: TracingContext;
  protected _currentSpan: OtelSpan | null = null;
  protected _currentTurnNumber = 0;
  protected _traceContextMap = new Map<number, OtelSpanContext>();
  protected _tracer: OtelTracer | null;

  // Conversation tracking properties
  protected _conversationSpan: OtelSpan | null = null;
  protected _conversationId: string | null;
  protected _additionalSpanAttributes: Record<string, OtelAttributeValue>;

  /** Initialize the turn trace observer. */
  constructor(options: TurnTraceObserverOptions) {
    super(options);
    this._turnTracker = options.turnTracker;
    this._latencyTracker = options.latencyTracker;
    this._tracingContext = options.tracingContext || new TracingContext();
    this._tracer = getOpenTelemetry()?.api.trace.getTracer("pipecat.turn") ?? null;

    this._conversationId = options.conversationId ?? null;
    this._additionalSpanAttributes = options.additionalSpanAttributes || {};

    this._turnTracker.eventHandler(
      "on_turn_started",
      async (_tracker: unknown, turnNumber: number) => {
        await this._handleTurnStarted(turnNumber);
      },
    );

    this._turnTracker.eventHandler(
      "on_turn_ended",
      async (_tracker: unknown, turnNumber: number, duration: number, wasInterrupted: boolean) => {
        await this._handleTurnEnded(turnNumber, duration, wasInterrupted);
      },
    );

    this._latencyTracker.eventHandler(
      "on_latency_measured",
      async (_tracker: unknown, latencySeconds: number) => {
        await this._handleLatencyMeasured(latencySeconds);
      },
    );
  }

  /**
   * The turn tracer, resolved on first use if OpenTelemetry was not available
   * yet when the observer was built (core imports it asynchronously).
   */
  protected _getTracer(): OtelTracer | null {
    this._tracer ??= getOpenTelemetry()?.api.trace.getTracer("pipecat.turn") ?? null;
    return this._tracer;
  }

  /**
   * Handle latency measurement events.
   *
   * Called when the latency tracker measures user-to-bot latency.
   * Adds the latency as an attribute to the current turn span.
   *
   * @param latencySeconds The measured latency in seconds.
   */
  protected async _handleLatencyMeasured(latencySeconds: number): Promise<void> {
    if (this._currentSpan && isTracingAvailable()) {
      this._currentSpan.setAttribute("turn.user_bot_latency_seconds", latencySeconds);
      logger.debug(
        `Turn ${this._currentTurnNumber} user-bot latency: ${latencySeconds.toFixed(3)}s`,
      );
    }
  }

  /**
   * Process a frame without modifying it.
   *
   * Handles StartFrame to begin conversation tracing early, ensuring
   * that any spans created before Turn 1 (e.g., from flow initialization)
   * are properly attached to the conversation trace.
   *
   * @param data The frame push event data.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.frame instanceof StartFrame && !this._conversationSpan) {
      this.startConversationTracing(this._conversationId);
    }
  }

  /**
   * Start a new conversation span.
   *
   * @param conversationId Optional custom ID for the conversation. If null, a UUID will be generated.
   */
  startConversationTracing(conversationId: string | null = null): void {
    const tracer = this._getTracer();
    if (!isTracingAvailable() || !tracer) {
      return;
    }

    // Generate a conversation ID if not provided
    if (conversationId === null) {
      conversationId = TracingContext.generateConversationId();
      logger.debug(`Generated new conversation ID: ${conversationId}`);
    }

    this._conversationId = conversationId;

    // Create a new span for this conversation
    const conversationSpan = tracer.startSpan("conversation");
    this._conversationSpan = conversationSpan;

    // Set span attributes
    conversationSpan.setAttribute("conversation.id", conversationId);
    conversationSpan.setAttribute("conversation.type", "voice");
    // Set custom otel attributes if provided
    for (const [k, v] of Object.entries(this._additionalSpanAttributes || {})) {
      conversationSpan.setAttribute(k, v);
    }

    // Update the tracing context
    this._tracingContext.setConversationContext(conversationSpan.spanContext(), conversationId);

    logger.debug(`Started tracing for Conversation ${conversationId}`);
  }

  /** End the current conversation span and ensure the last turn is closed. */
  endConversationTracing(): void {
    if (!isTracingAvailable()) {
      return;
    }

    // First, ensure any active turn is closed properly
    if (this._currentSpan) {
      // If we have an active turn span, end it with a standard duration
      logger.debug(`Ending Turn ${this._currentTurnNumber} due to conversation end`);
      this._currentSpan.setAttribute("turn.was_interrupted", true);
      this._currentSpan.setAttribute("turn.ended_by_conversation_end", true);
      this._currentSpan.end();
      this._currentSpan = null;

      // Clear the turn context
      this._tracingContext.setTurnContext(null);
    }

    // Now end the conversation span if it exists
    if (this._conversationSpan) {
      // End the span
      this._conversationSpan.end();
      this._conversationSpan = null;

      // Clear the conversation context
      this._tracingContext.setConversationContext(null);

      logger.debug(`Ended tracing for Conversation ${this._conversationId}`);
      this._conversationId = null;
    }
  }

  /** Handle a turn start event by creating a new span. */
  protected async _handleTurnStarted(turnNumber: number): Promise<void> {
    const tracer = this._getTracer();
    if (!isTracingAvailable() || !tracer) {
      return;
    }

    if (turnNumber === 1 && !this._conversationSpan) {
      this.startConversationTracing(this._conversationId);
    }

    // Get the parent context - conversation if available, otherwise use root context
    let parentContext = null;
    if (this._conversationSpan) {
      parentContext = this._tracingContext.getConversationContext();
    }

    // Create a new span for this turn
    const currentSpan = tracer.startSpan("turn", undefined, parentContext ?? undefined);
    this._currentSpan = currentSpan;
    this._currentTurnNumber = turnNumber;

    // Set span attributes
    currentSpan.setAttribute("turn.number", turnNumber);
    currentSpan.setAttribute("turn.type", "conversation");

    // Add conversation ID attribute if available
    if (this._conversationId) {
      currentSpan.setAttribute("conversation.id", this._conversationId);
    }

    // Store the span context so services can become children of this span
    this._traceContextMap.set(turnNumber, currentSpan.spanContext());

    // Update the tracing context so services can access this span
    this._tracingContext.setTurnContext(currentSpan.spanContext());

    logger.debug(`Started tracing for Turn ${turnNumber}`);
  }

  /** Handle a turn end event by ending the current span. */
  protected async _handleTurnEnded(
    turnNumber: number,
    duration: number,
    wasInterrupted: boolean,
  ): Promise<void> {
    if (!isTracingAvailable() || !this._currentSpan) {
      return;
    }

    // Only end the span if it matches the current turn
    if (turnNumber === this._currentTurnNumber) {
      // Set additional attributes
      this._currentSpan.setAttribute("turn.duration_seconds", duration);
      this._currentSpan.setAttribute("turn.was_interrupted", wasInterrupted);

      // End the span
      this._currentSpan.end();
      this._currentSpan = null;

      // Clear the turn context
      this._tracingContext.setTurnContext(null);

      logger.debug(`Ended tracing for Turn ${turnNumber}`);
    }
  }

  /**
   * Get the span context for the current turn.
   *
   * This can be used by services to create child spans.
   *
   * @returns The current turn's span context or null if not available.
   */
  getCurrentTurnContext(): OtelSpanContext | null {
    if (!isTracingAvailable() || !this._currentSpan) {
      return null;
    }

    return this._currentSpan.spanContext();
  }

  /**
   * Get the span context for a specific turn.
   *
   * This can be used by services to create child spans.
   *
   * @param turnNumber The turn number to get context for.
   * @returns The specified turn's span context or null if not available.
   */
  getTurnContext(turnNumber: number): OtelSpanContext | null {
    if (!isTracingAvailable()) {
      return null;
    }

    return this._traceContextMap.get(turnNumber) ?? null;
  }
}
