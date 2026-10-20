// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/llm_turn_completion_user_turn_stop_strategy.py

/** User turn stop strategy gated on the LLM's turn-completion verdict. */

import { type Frame, LLMUpdateSettingsFrame, StartFrame } from "../../frames/frames.ts";
import { LLMSettings } from "../../services/settings.ts";
import type { ProcessFrameResult } from "../types.ts";
import { UserTurnCompletionConfig } from "../user_turn_completion_mixin.ts";
import type { BaseUserTurnStopStrategyOptions } from "./base_user_turn_stop_strategy.ts";
import { ExternalUserTurnCompletionStopStrategy } from "./external_user_turn_completion_stop_strategy.ts";

export interface LLMTurnCompletionUserTurnStopStrategyOptions
  extends BaseUserTurnStopStrategyOptions {
  /**
   * Configuration applied to the LLM via the `filterIncompleteUserTurns`
   * setting on `StartFrame`. Defaults to `new UserTurnCompletionConfig()`.
   */
  config?: UserTurnCompletionConfig | null;
}

/**
 * LLM-gated stop strategy.
 *
 * Extends `ExternalUserTurnCompletionStopStrategy` with the LLM-specific setup
 * needed for the marker-based completion protocol: on `StartFrame`, pushes an
 * `LLMUpdateSettingsFrame` downstream that enables `filterIncompleteUserTurns`
 * on the LLM and seeds the `UserTurnCompletionConfig`. The update is marked
 * `reachInactiveServices` so that every LLM behind an `LLMSwitcher` is
 * configured, not only the one active at startup.
 *
 * Finalization itself is inherited: when the LLM service's
 * `UserTurnCompletionLLMServiceMixin` detects a `●` marker, it broadcasts a
 * `UserTurnInferenceCompletedFrame` and the base class fires
 * `on_user_turn_stopped`. On `incomplete_short` / `incomplete_long` markers
 * the mixin re-prompts internally and no completion frame is emitted, so the
 * public stop event stays deferred.
 *
 * Install alongside one or more `deferred(...)`-wrapped detector strategies
 * that drive `on_user_turn_inference_triggered` but leave finalization to
 * this strategy.
 */
export class LLMTurnCompletionUserTurnStopStrategy extends ExternalUserTurnCompletionStopStrategy {
  protected _config: UserTurnCompletionConfig;

  constructor(options: LLMTurnCompletionUserTurnStopStrategyOptions = {}) {
    super(options);
    this._config = options.config ?? new UserTurnCompletionConfig();
  }

  /** Return the configured `UserTurnCompletionConfig`. */
  get config(): UserTurnCompletionConfig {
    return this._config;
  }

  /** Configure the LLM on start and delegate completion handling to the base. */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof StartFrame) {
      await this._configureLlm();
    }
    return await super.processFrame(frame);
  }

  protected async _configureLlm(): Promise<void> {
    await this.pushFrame(
      new LLMUpdateSettingsFrame({
        delta: new LLMSettings({
          filterIncompleteUserTurns: true,
          userTurnCompletionConfig: this._config,
        }),
        reachInactiveServices: true,
      }),
    );
  }
}
