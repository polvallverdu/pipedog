// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/external_user_turn_stop_strategy.py

/** User turn stop strategy driven by another component in the pipeline. */

import { Event, type Task, TimeoutError, waitFor } from "@pipecat-ts/asyncio";
import {
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { logger } from "../../utils/logger.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStopStrategy,
  type BaseUserTurnStopStrategyOptions,
} from "./base_user_turn_stop_strategy.ts";

export interface ExternalUserTurnStopStrategyOptions extends BaseUserTurnStopStrategyOptions {
  /**
   * A short delay (seconds) used internally to handle consecutive or slightly
   * delayed transcriptions.
   */
  timeout?: number;
  /**
   * When true (default), turn-stop signaling waits for transcript text to
   * arrive after the external stop signal. When false, the strategy signals
   * turn-stop as soon as that signal arrives — independent of transcripts.
   * Set this to false when local turn detection is the intended driver of the
   * conversation (e.g. with a realtime LLM service consuming audio directly),
   * so transcripts are off the latency critical path.
   * `LLMContextAggregatorPair` flips this for you when
   * `realtimeServiceMode: true`.
   */
  waitForTranscript?: boolean;
}

/**
 * User turn stop strategy driven by another component in the pipeline.
 *
 * The end-of-turn counterpart to `ExternalUserTurnStartStrategy`, taking the
 * same two signals:
 *
 * - `ProposedUserStoppedSpeakingFrame` — a service proposing that the turn has
 *   ended. This strategy decides, and emits the `UserStoppedSpeakingFrame`
 *   itself. It may also hold the turn open past the proposal, which is what
 *   `waitForTranscript` does.
 *
 * - `UserStoppedSpeakingFrame` — the turn end was already decided and
 *   announced elsewhere, typically by a shared `UserTurnProcessor`. This
 *   strategy adopts that decision and emits nothing.
 *
 * To shift the timing further, subclass this strategy and override
 * `BaseUserTurnStopStrategy.triggerUserTurnStopped`, which both paths reach
 * once they decide the turn is over. Its `enableUserSpeakingFrames` option
 * already carries whichever path got there, so pass it through when the
 * override eventually finalizes.
 */
export class ExternalUserTurnStopStrategy extends BaseUserTurnStopStrategy {
  protected _timeout: number;
  protected _waitForTranscript: boolean;
  protected _text = "";
  protected _userSpeaking = false;
  protected _seenInterimResults = false;
  protected _turnAnnouncedElsewhere = false;
  protected _turnOpen = false;
  protected _event = new Event();
  protected _task: Task<unknown> | null = null;

  constructor(options: ExternalUserTurnStopStrategyOptions = {}) {
    super(options);
    this._timeout = options.timeout ?? 0.5;
    this._waitForTranscript = options.waitForTranscript ?? true;
  }

  /** Whether this strategy resolves proposals into turn stops. */
  override get resolvesProposedTurnStopFrames(): boolean {
    return true;
  }

  /** Whether turn-stop signaling waits for transcript text. */
  get waitForTranscript(): boolean {
    return this._waitForTranscript;
  }

  set waitForTranscript(value: boolean) {
    this._waitForTranscript = value;
  }

  /** Ready the strategy to detect the end of the turn now starting. */
  override async handleUserTurnStarted(): Promise<void> {
    await this._reset();
    this._turnOpen = true;
  }

  /** Clear per-turn state once the turn has ended. */
  override async handleUserTurnStopped(): Promise<void> {
    await this._reset();
    this._turnOpen = false;
  }

  /** Clear per-turn state. Runs at both turn boundaries. */
  protected async _reset(): Promise<void> {
    this._text = "";
    this._userSpeaking = false;
    this._seenInterimResults = false;
    this._turnAnnouncedElsewhere = false;
    this._event.clear();
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._task = this.createTask(() => this._taskHandler(), `${this}::_task_handler`);
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._task) {
      await this.taskManager.cancelTask(this._task);
      this._task = null;
    }
  }

  /**
   * Process an incoming frame to update strategy state.
   *
   * Updates internal transcription text and speaking state. The user end
   * turn will be triggered when appropriate based on the collected frames.
   *
   * @param frame The frame to be analyzed.
   * @returns Always returns CONTINUE so subsequent stop strategies are evaluated.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof ProposedUserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking({ announcedElsewhere: false });
    } else if (frame instanceof ProposedUserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking({ announcedElsewhere: false });
    } else if (frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking({ announcedElsewhere: true });
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      await this._handleUserStoppedSpeaking({ announcedElsewhere: true });
    } else if (frame instanceof InterimTranscriptionFrame) {
      await this._handleInterimTranscription(frame);
    } else if (frame instanceof TranscriptionFrame) {
      await this._handleTranscription(frame);
    }

    return ProcessFrameResult.CONTINUE;
  }

  /** Handle the external signal that the user is speaking. */
  protected async _handleUserStartedSpeaking(options: {
    announcedElsewhere: boolean;
  }): Promise<void> {
    this._userSpeaking = true;
    this._turnAnnouncedElsewhere = options.announcedElsewhere;
  }

  /** Handle the external signal that the user has stopped speaking. */
  protected async _handleUserStoppedSpeaking(options: {
    announcedElsewhere: boolean;
  }): Promise<void> {
    this._userSpeaking = false;
    this._turnAnnouncedElsewhere = options.announcedElsewhere;
    await this._maybeTriggerUserTurnStopped();
  }

  protected async _handleInterimTranscription(_frame: InterimTranscriptionFrame): Promise<void> {
    this._seenInterimResults = true;
  }

  /** Handle user transcription. */
  protected async _handleTranscription(frame: TranscriptionFrame): Promise<void> {
    this._text += frame.text;
    // We just got a final result, so let's reset interim results.
    this._seenInterimResults = false;
    // Reset aggregation timer.
    this._event.set();
  }

  /**
   * Asynchronously monitor transcriptions and trigger user end turn when ready.
   *
   * If transcription text exists and the user is not currently speaking,
   * triggers the user end turn. Handles multiple or delayed transcriptions
   * gracefully.
   */
  protected async _taskHandler(): Promise<void> {
    while (true) {
      try {
        await waitFor(() => this._event.wait(), this._timeout);
        this._event.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        // Note: with waitForTranscript off (realtime mode) this fires on
        // every tick. The _turnOpen check protects against unnecessarily
        // triggering over and over (harmless, since the controller drops
        // repeated triggers, but noisy).
        if (this._turnOpen) {
          await this._maybeTriggerUserTurnStopped();
        }
      }
    }
  }

  /**
   * End the turn, emitting the turn frame unless it was already announced.
   *
   * Reads the flag rather than taking it as an argument: finalization can
   * land here from the transcript timeout above, long after the signal that
   * set it.
   */
  protected async _triggerUserTurnStopped(): Promise<void> {
    if (this._turnAnnouncedElsewhere) {
      logger.debug(`${this}: adopting a user turn stop decided elsewhere`);
    } else {
      logger.debug(`${this}: resolving a proposed user turn stop`);
    }
    await this.triggerUserTurnStopped({
      enableUserSpeakingFrames: this._turnAnnouncedElsewhere ? false : null,
    });
  }

  protected async _maybeTriggerUserTurnStopped(): Promise<void> {
    if (this._userSpeaking) {
      return;
    }
    if (!this._waitForTranscript) {
      // Fire as soon as the external stop signal arrives —
      // transcripts (if any) are off the latency critical path.
      await this._triggerUserTurnStopped();
      return;
    }
    if (!this._seenInterimResults && this._text) {
      await this._triggerUserTurnStopped();
    }
  }
}
