// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/external_user_turn_completion_stop_strategy.py

/** User turn stop strategy that finalizes on `UserTurnInferenceCompletedFrame`. */

import { type Frame, UserTurnInferenceCompletedFrame } from "../../frames/frames.ts";
import { ProcessFrameResult } from "../types.ts";
import { BaseUserTurnStopStrategy } from "./base_user_turn_stop_strategy.ts";

/**
 * Finalize the user turn whenever a `UserTurnInferenceCompletedFrame` arrives.
 *
 * Generic stop strategy for pipelines where some external component
 * (LLM with completion markers, STT with built-in turn detection, a
 * dedicated end-of-turn classifier, custom user code, etc.) judges
 * when a turn is semantically complete and emits
 * `UserTurnInferenceCompletedFrame`.
 *
 * Pair this with one or more `deferred(...)`-wrapped detector
 * strategies that drive `on_user_turn_inference_triggered` but
 * leave finalization to this strategy:
 *
 * @example
 * stop: [
 *   deferred(new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer })),
 *   new ExternalUserTurnCompletionStopStrategy(),
 * ]
 *
 * For LLM-completion-marker gating specifically, use the subclass
 * `LLMTurnCompletionUserTurnStopStrategy` instead, which additionally pushes
 * the `LLMUpdateSettingsFrame` that enables the marker protocol on the LLM.
 *
 * A completion resolves with some latency (e.g. the LLM `●` arrives
 * after the inference finishes), so the user may have resumed speaking
 * in the meantime. The controller drops a finalization that arrives
 * while the user is speaking, so a stale completion does not end the
 * turn (and talk over the user); the turn stays open for the next
 * inference to re-evaluate. That check lives in the controller, which
 * holds the authoritative user-speaking state.
 *
 * If the producer never emits `UserTurnInferenceCompletedFrame`, the
 * controller's `userTurnStopTimeout` watchdog finalizes the turn after no
 * activity. Tune that timeout if your producer can take longer than the
 * default to respond.
 */
export class ExternalUserTurnCompletionStopStrategy extends BaseUserTurnStopStrategy {
  /** Fire `on_user_turn_stopped` whenever `UserTurnInferenceCompletedFrame` is seen. */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof UserTurnInferenceCompletedFrame) {
      await this.triggerUserTurnFinalized();
    }
    return ProcessFrameResult.CONTINUE;
  }
}
