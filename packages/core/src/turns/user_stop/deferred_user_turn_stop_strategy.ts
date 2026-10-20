// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/deferred_user_turn_stop_strategy.py

/** Wrapper that defers a stop strategy's finalization to another strategy. */

import type { Frame } from "../../frames/frames.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import type { EventHandlerFn } from "../../utils/base_object.ts";
import type { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStopStrategy,
  type BaseUserTurnStopStrategyOptions,
} from "./base_user_turn_stop_strategy.ts";

/**
 * Wraps a stop strategy and suppresses its `on_user_turn_stopped` event.
 *
 * Event subscriptions added to the wrapper are forwarded directly to
 * the inner strategy, except for `on_user_turn_stopped`, which is
 * dropped. The inner strategy's frame-side and inference-triggered
 * events therefore reach external listeners (the controller, etc.)
 * unchanged; finalization is left to another strategy in the chain
 * such as `LLMTurnCompletionUserTurnStopStrategy`.
 *
 * Use the `deferred` helper for ergonomic construction:
 *
 * @example
 * stop: [
 *   deferred(new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer })),
 *   new LLMTurnCompletionUserTurnStopStrategy(),
 * ]
 */
export class DeferredUserTurnStopStrategy extends BaseUserTurnStopStrategy {
  protected _inner: BaseUserTurnStopStrategy;

  /**
   * @param inner The strategy whose finalization should be deferred.
   * @param options Additional options forwarded to the base class.
   */
  constructor(inner: BaseUserTurnStopStrategy, options: BaseUserTurnStopStrategyOptions = {}) {
    super(options);
    this._inner = inner;
  }

  /** Return the wrapped strategy. */
  get inner(): BaseUserTurnStopStrategy {
    return this._inner;
  }

  /**
   * Report what the inner strategy does with proposals.
   *
   * Frame processing is forwarded, so a proposal reaches the inner strategy
   * and is resolved there. Deferring finalization changes when the turn ends,
   * not who decides it.
   */
  override get resolvesProposedTurnStopFrames(): boolean {
    return this._inner.resolvesProposedTurnStopFrames;
  }

  /**
   * Forward event subscriptions to the inner strategy.
   *
   * `on_user_turn_stopped` is silently dropped — that's the whole point of
   * the wrapper. Every other event handler is attached to the inner strategy
   * directly, so the inner's events reach the listener without any per-event
   * proxy method on the wrapper.
   */
  override addEventHandler(eventName: string, handler: EventHandlerFn<this>): void {
    if (eventName === "on_user_turn_stopped") {
      return;
    }
    this._inner.addEventHandler(eventName, handler as EventHandlerFn);
  }

  /** Set up the inner strategy. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._inner.setup(setup);
  }

  /** Clean up the inner strategy. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._inner.cleanup();
  }

  /** Forward the turn-started callback to the inner strategy. */
  override async handleUserTurnStarted(): Promise<void> {
    await this._inner.handleUserTurnStarted();
  }

  /** Forward the turn-stopped callback to the inner strategy. */
  override async handleUserTurnStopped(): Promise<void> {
    await this._inner.handleUserTurnStopped();
  }

  /** Forward frame processing to the inner strategy. */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult | null> {
    return await this._inner.processFrame(frame);
  }
}

/**
 * Defer this stop strategy's finalization to another strategy.
 *
 * Wraps `strategy` in a `DeferredUserTurnStopStrategy`: the inner strategy
 * continues to drive inference-triggered events, but its
 * `on_user_turn_stopped` event is suppressed. Use when another strategy in
 * the chain (e.g. `LLMTurnCompletionUserTurnStopStrategy`) owns finalization.
 *
 * @example
 * stop: [
 *   deferred(new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer })),
 *   new LLMTurnCompletionUserTurnStopStrategy(),
 * ]
 *
 * @param strategy The stop strategy to defer.
 * @returns A wrapper that exposes the inner strategy's behavior with
 *   finalization suppressed.
 */
export function deferred(strategy: BaseUserTurnStopStrategy): DeferredUserTurnStopStrategy {
  return new DeferredUserTurnStopStrategy(strategy);
}
