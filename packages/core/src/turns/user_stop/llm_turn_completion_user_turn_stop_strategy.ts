// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/llm_turn_completion_user_turn_stop_strategy.py

/** User turn stop strategy that decides on the LLM's turn-completion marker. */

import { sleep, type Task } from "@pipedog/asyncio";
import {
  type Frame,
  LLMContextFrame,
  LLMMessagesAppendFrame,
  LLMUpdateSettingsFrame,
  ProposedUserStartedSpeakingFrame,
  StartFrame,
  UserStartedSpeakingFrame,
  UserTurnCompletionFrame,
  UserTurnResponseCancelFrame,
  VADUserStartedSpeakingFrame,
} from "../../frames/frames.ts";
import { LLMSettings } from "../../services/settings.ts";
import { logger } from "../../utils/logger.ts";
import { UserTurnCompletionConfig } from "../user_turn_completion_mixin.ts";
import {
  BaseUserTurnStopStrategy,
  type BaseUserTurnStopStrategyOptions,
} from "./base_user_turn_stop_strategy.ts";

export interface LLMTurnCompletionUserTurnStopStrategyOptions
  extends BaseUserTurnStopStrategyOptions {
  /**
   * Markers, instructions, timeouts and re-prompts applied to the LLM.
   * Defaults to `new UserTurnCompletionConfig()`.
   */
  config?: UserTurnCompletionConfig | null;
}

/**
 * Decides the user is done only when the LLM marks the turn complete.
 *
 * Turns on turn-completion markers in the LLM, which then starts every
 * response with ● (the turn is complete), ◐ (the user will continue shortly)
 * or ○ (the user needs more time), and reports each marker as a
 * `UserTurnCompletionFrame`. The settings update reaches every LLM behind an
 * `LLMSwitcher`, not only the active one.
 *
 * The strategy waits for the turn's inference rather than listening to the
 * user, so it needs other stop strategies to decide the user stopped: once
 * they have decided, the inference runs, as
 * `FilterIncompleteUserTurnStrategies` sets up. It decides the user is done on
 * that inference's ●, on a tool call, or on a response with no marker. ◐ and
 * ○ leave the turn open. If the user then stays quiet for the configured
 * timeout, the strategy decides the user is done and asks the LLM to
 * re-engage them, and the controller's turn stop timeout waits for that
 * decision. Another inference answering the user in the meantime, such as one
 * for words transcribed after the turn's inference, cancels the re-prompt.
 * When the user speaks again, it waits for the next inference instead.
 *
 * An eager end of turn answers the turn speculatively, and the strategy
 * decides on that answer too. ◐ or ○ withdraws it, and the committed turn
 * brings an inference of its own.
 */
export class LLMTurnCompletionUserTurnStopStrategy extends BaseUserTurnStopStrategy {
  protected _config: UserTurnCompletionConfig;
  // The inference whose marker this strategy decides on.
  protected _awaited: LLMContextFrame | null = null;
  protected _repromptTask: Task<unknown> | null = null;

  constructor(options: LLMTurnCompletionUserTurnStopStrategyOptions = {}) {
    super(options);
    this._config = options.config ?? new UserTurnCompletionConfig();
  }

  /** Return the configured `UserTurnCompletionConfig`. */
  get config(): UserTurnCompletionConfig {
    return this._config;
  }

  /** Whether a re-prompt is scheduled, which decides when it fires. */
  override get decisionScheduled(): boolean {
    return this._repromptTask !== null;
  }

  /** Decides on the LLM's marker, which only the turn's inference produces. */
  override get waitsForInference(): boolean {
    return true;
  }

  /** Cancel any pending re-prompt. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelReprompt();
  }

  /** Forget the previous turn's inference and cancel any pending re-prompt. */
  override async handleUserTurnStarted(): Promise<void> {
    this._awaited = null;
    await this._cancelReprompt();
  }

  /** Forget this turn's inference, keeping a pending re-prompt. */
  override async handleUserTurnStopped(): Promise<void> {
    this._awaited = null;
  }

  /**
   * Configure the LLM on start, and follow the turn's inference and the user.
   *
   * @param frame The frame to be analyzed.
   */
  override async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof StartFrame) {
      await this._configureLlm();
    } else if (frame instanceof LLMContextFrame) {
      // An inference answering the user makes a pending re-prompt redundant.
      this._awaited = frame;
      await this._cancelReprompt();
    } else if (frame instanceof UserTurnCompletionFrame) {
      await this._handleReport(frame);
    } else if (frame instanceof UserTurnResponseCancelFrame) {
      // The answer it was waiting for is gone.
      this._awaited = null;
    } else if (
      frame instanceof VADUserStartedSpeakingFrame ||
      frame instanceof UserStartedSpeakingFrame ||
      frame instanceof ProposedUserStartedSpeakingFrame
    ) {
      await this._handleUserStartedSpeaking();
    }
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

  protected async _handleUserStartedSpeaking(): Promise<void> {
    // The user speaking again clears the decisions, and the next inference
    // brings its own marker. The user doesn't need re-engaging either.
    this._awaited = null;
    await this._cancelReprompt();
  }

  protected async _handleReport(report: UserTurnCompletionFrame): Promise<void> {
    if (this._awaited === null || report.contextFrameId !== this._awaited.id) {
      // Another inference is answering the user, so a pending re-prompt would
      // answer them twice.
      await this._cancelReprompt();
      return;
    }

    const speculation = this._awaited.speculation;
    this._awaited = null;
    const incomplete = report.kind === "short" || report.kind === "long";
    if (incomplete && speculation) {
      await this.cancelUserTurnSpeculation();
    } else if (incomplete) {
      await this._startReprompt(report.kind as string);
    } else {
      await this._cancelReprompt();
      await this.reportUserTurnStopped();
    }
  }

  protected async _startReprompt(kind: string): Promise<void> {
    await this._cancelReprompt();
    let timeout: number;
    let prompt: string;
    if (kind === "short") {
      timeout = this._config.incompleteShortTimeout;
      prompt = this._config.shortPrompt;
    } else {
      timeout = this._config.incompleteLongTimeout;
      prompt = this._config.longPrompt;
    }
    this._repromptTask = this.createTask(
      () => this._repromptHandler(timeout, prompt),
      `${this}::_reprompt_handler`,
    );
  }

  /** End the turn the user went quiet in, and ask the LLM to re-engage them. */
  protected async _repromptHandler(timeout: number, prompt: string): Promise<void> {
    await sleep(timeout);
    this._repromptTask = null;
    logger.debug(`${this}: user quiet for ${timeout}s after an incomplete turn, re-prompting`);
    await this.reportUserTurnStopped();
    // The turn end runs an inference of its own for words transcribed after
    // the turn's inference, and that inference answers the user instead.
    if (!this._awaited) {
      await this.pushFrame(
        new LLMMessagesAppendFrame({
          messages: [{ role: "developer", content: prompt }],
          runLlm: true,
        }),
      );
    }
  }

  protected async _cancelReprompt(): Promise<void> {
    if (this._repromptTask) {
      const task = this._repromptTask;
      this._repromptTask = null;
      await this.cancelTask(task);
    }
  }
}
