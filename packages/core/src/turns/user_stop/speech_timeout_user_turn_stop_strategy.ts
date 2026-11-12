// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py

/** Speech timeout-based user turn stop strategy. */

import { CancelledError, sleep, type Task } from "@pipedog/asyncio";
import { VAD_STOP_SECS } from "../../audio/vad/vad_analyzer.ts";
import {
  type Frame,
  InterimTranscriptionFrame,
  STTMetadataFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { logger } from "../../utils/logger.ts";
import {
  BaseUserTurnStopStrategy,
  type BaseUserTurnStopStrategyOptions,
} from "./base_user_turn_stop_strategy.ts";

export interface SpeechTimeoutUserTurnStopStrategyOptions extends BaseUserTurnStopStrategyOptions {
  /**
   * Time to wait for the user to potentially say more after they pause
   * speaking. Defaults to 0.6 seconds.
   */
  userSpeechTimeout?: number;
  /**
   * Whether to require at least one transcript before triggering end-of-turn.
   * When true (default), turn-end fires only after the user-speech timer
   * expires *and* at least one transcript has been received. When false, the
   * strategy signals turn-end as soon as VAD reports end of speech and the
   * user-speech timer has elapsed — independent of transcripts. Set this to
   * false when local turn detection is the intended driver of the
   * conversation (e.g. with a realtime LLM service consuming audio directly),
   * so transcripts are off the latency critical path.
   * `LLMContextAggregatorPair` flips this for you when
   * `realtimeServiceMode: true`.
   */
  waitForTranscript?: boolean;
}

/**
 * User turn stop strategy using two independent timers after VAD stop.
 *
 * After the user stops speaking (detected by VAD), this strategy runs two
 * independent timers. The user turn stop is triggered only when both have
 * finished and at least one transcript has been received:
 *
 * - userSpeechTimeout: Policy floor — the window in which the user may
 *   resume speaking after a pause. Always runs to completion.
 * - sttTimeout: Safety net for STT latency — the P99 time for the STT
 *   service to return a final transcript after VAD stop, adjusted by the
 *   VAD stopSecs. Short-circuited when the STT service emits a finalized
 *   transcript (`TranscriptionFrame.finalized`), since finalization means
 *   STT has nothing more to send.
 *
 * Fallback: when a transcript arrives without a VAD stop event, the
 * userSpeechTimeout timer measures inactivity since the last transcript
 * (rearmed on each transcript). sttTimeout has no meaning here since it
 * is defined relative to VAD stop, and STT has already emitted a
 * transcript — so the stt wait is marked done immediately.
 */
export class SpeechTimeoutUserTurnStopStrategy extends BaseUserTurnStopStrategy {
  protected _userSpeechTimeout: number;
  protected _waitForTranscript: boolean;
  protected _sttTimeout = 0.0; // STT P99 latency from STTMetadataFrame
  protected _stopSecs = 0.0; // VAD stop_secs from VADUserStoppedSpeakingFrame
  protected _stopSecsWarned = false;

  protected _text = "";
  protected _vadUserSpeaking = false;
  protected _transcriptFinalized = false;
  protected _vadStopped = false; // Whether VAD reported a stop this turn

  protected _userSpeechTimeoutTask: Task<unknown> | null = null;
  protected _sttTimeoutTask: Task<unknown> | null = null;
  protected _userSpeechWaitDone = false;
  protected _sttWaitDone = false;

  constructor(options: SpeechTimeoutUserTurnStopStrategyOptions = {}) {
    super(options);
    this._userSpeechTimeout = options.userSpeechTimeout ?? 0.6;
    this._waitForTranscript = options.waitForTranscript ?? true;
  }

  /** Whether transcripts gate end-of-turn signalling. */
  get waitForTranscript(): boolean {
    return this._waitForTranscript;
  }

  set waitForTranscript(value: boolean) {
    this._waitForTranscript = value;
  }

  /**
   * Ready the strategy to detect the end of the turn now starting.
   *
   * `_vadUserSpeaking` is deliberately preserved: it reflects the live
   * physical VAD state, not turn-scoped bookkeeping. VAD only re-emits a
   * start after a stop, so clearing the flag for a turn that begins while
   * the user is still speaking would leave the strategy with no active VAD
   * reference, treating any transcript as a standalone utterance.
   */
  override async handleUserTurnStarted(): Promise<void> {
    await this._reset({ clearVadUserSpeaking: false });
  }

  /** Clear per-turn state once the turn has ended. */
  override async handleUserTurnStopped(): Promise<void> {
    await this._reset({ clearVadUserSpeaking: true });
  }

  /** Clear per-turn state, optionally resetting the live VAD flag. */
  protected async _reset(options: { clearVadUserSpeaking: boolean }): Promise<void> {
    this._text = "";
    if (options.clearVadUserSpeaking) {
      this._vadUserSpeaking = false;
    }
    await this._discardPendingEndOfTurn();
  }

  /**
   * Drop whatever progress toward an end-of-turn has been made so far.
   *
   * Runs at a turn boundary, and whenever VAD reports the user speaking
   * again — which makes earlier progress stale mid-turn.
   */
  protected async _discardPendingEndOfTurn(): Promise<void> {
    this._transcriptFinalized = false;
    this._vadStopped = false;
    this._userSpeechWaitDone = false;
    this._sttWaitDone = false;
    await this._cancelAllTasks();
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelAllTasks();
  }

  /**
   * Process an incoming frame to update strategy state.
   *
   * Updates internal transcription text and VAD state. The user end turn
   * will be triggered when appropriate based on the collected frames.
   *
   * @param frame The frame to be analyzed.
   */
  override async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof STTMetadataFrame) {
      this._sttTimeout = frame.ttfsP99Latency;
      this._stopSecsWarned = false;
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      logger.debug(`${this} VADUserStartedSpeakingFrame received`);
      await this._handleVadUserStartedSpeaking(frame);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      logger.debug(`${this} VADUserStoppedSpeakingFrame received`);
      await this._handleVadUserStoppedSpeaking(frame);
    } else if (frame instanceof TranscriptionFrame) {
      await this._handleTranscription(frame);
    } else if (frame instanceof InterimTranscriptionFrame) {
      // An interim means more transcription is still on the way, so an
      // earlier finalized transcript no longer covers all of the user's
      // speech.
      // Without this, a transcript finalized during a pause too short for
      // VAD to report a stop (and thus a new start, which is what normally
      // clears the flag) would leave the flag stale and skip the STT
      // safety net at the next VAD stop while the tail of the utterance is
      // still in flight. This can happen when the STT endpointer finalizes
      // on silences shorter than the VAD stop_secs — e.g. an aggressive
      // STT endpoint or a manually raised stop_secs.
      this._transcriptFinalized = false;
    }
  }

  /** Handle when the VAD indicates the user is speaking. */
  protected async _handleVadUserStartedSpeaking(
    _frame: VADUserStartedSpeakingFrame,
  ): Promise<void> {
    this._vadUserSpeaking = true;
    await this._discardPendingEndOfTurn();
  }

  /** Handle when the VAD indicates the user has stopped speaking. */
  protected async _handleVadUserStoppedSpeaking(frame: VADUserStoppedSpeakingFrame): Promise<void> {
    this._vadUserSpeaking = false;
    this._stopSecs = frame.stopSecs;
    this._vadStopped = true;

    if (!this._stopSecsWarned) {
      if (this._stopSecs !== VAD_STOP_SECS) {
        this._stopSecsWarned = true;
        logger.warning(
          `${this}: VAD stop_secs (${this._stopSecs}s) differs from the ` +
            `recommended default (${VAD_STOP_SECS}s). Built-in p99 latency ` +
            `values assume stop_secs=${VAD_STOP_SECS}. Re-run ` +
            "https://github.com/pipecat-ai/stt-benchmark with your settings " +
            "and pass the TTFS P99 latency result as ttfs_p99_latency to " +
            "your STT service.",
        );
      }
      if (this._sttTimeout > 0 && this._stopSecs >= this._sttTimeout) {
        this._stopSecsWarned = true;
        logger.warning(
          `${this}: VAD stop_secs (${this._stopSecs}s) >= STT p99 latency ` +
            `(${this._sttTimeout}s). STT wait timeout collapsed to 0s, which ` +
            "may cause delayed turn detection specified by the " +
            "user_turn_stop_timeout parameter in the LLMUserAggregatorParams.",
        );
      }
    }

    // userSpeechTimeout is the policy floor and always runs. A prior
    // fallback-mode run of the same timer is superseded here.
    await this._restartUserSpeechTimer();

    // sttTimeout is a safety net. Short-circuit it if the transcript is
    // already finalized, or if the VAD stop_secs already covered it.
    this._sttWaitDone = false;
    const effectiveSttWait = Math.max(0.0, this._sttTimeout - this._stopSecs);
    if (this._transcriptFinalized || effectiveSttWait <= 0) {
      this._sttWaitDone = true;
    } else {
      this._sttTimeoutTask = this.taskManager.createTask(
        () => this._sttTimeoutHandler(effectiveSttWait),
        `${this}::_stt_timeout_handler`,
      );
    }
  }

  /** Handle user transcription. */
  protected async _handleTranscription(frame: TranscriptionFrame): Promise<void> {
    this._text += frame.text;

    if (frame.finalized) {
      this._transcriptFinalized = true;
      // Short-circuit the sttTimeout safety net: STT has told us
      // there's nothing more coming.
      if (!this._sttWaitDone) {
        this._sttWaitDone = true;
        if (this._sttTimeoutTask) {
          await this.taskManager.cancelTask(this._sttTimeoutTask);
          this._sttTimeoutTask = null;
        }
      }
    }

    // If both waits are already done, the turn was waiting on text —
    // trigger now.
    if (this._userSpeechWaitDone && this._sttWaitDone) {
      await this._maybeReportUserTurnStopped();
      return;
    }

    // Fallback: transcript arrived without a VAD stop. Measure inactivity
    // since the last transcript with the user-speech timer. sttTimeout
    // has no meaning here (it's defined relative to VAD stop), so mark
    // the stt wait done immediately.
    if (!this._vadUserSpeaking && !this._vadStopped) {
      this._sttWaitDone = true;
      await this._restartUserSpeechTimer();
    }
  }

  /** Cancel any running user-speech timer and start a fresh one. */
  protected async _restartUserSpeechTimer(): Promise<void> {
    if (this._userSpeechTimeoutTask) {
      await this.taskManager.cancelTask(this._userSpeechTimeoutTask);
      this._userSpeechTimeoutTask = null;
    }
    this._userSpeechWaitDone = false;
    this._userSpeechTimeoutTask = this.taskManager.createTask(
      () => this._userSpeechTimeoutHandler(this._userSpeechTimeout),
      `${this}::_user_speech_timeout_handler`,
    );
  }

  /**
   * Wait userSpeechTimeout then attempt to trigger user turn stopped.
   *
   * @param timeout The timeout in seconds to wait.
   */
  protected async _userSpeechTimeoutHandler(timeout: number): Promise<void> {
    try {
      await sleep(timeout);
    } catch (e) {
      if (e instanceof CancelledError) return;
      throw e;
    } finally {
      this._userSpeechTimeoutTask = null;
    }

    this._userSpeechWaitDone = true;
    await this._maybeReportUserTurnStopped();
  }

  /**
   * Wait sttTimeout then attempt to trigger user turn stopped.
   *
   * @param timeout The timeout in seconds to wait.
   */
  protected async _sttTimeoutHandler(timeout: number): Promise<void> {
    try {
      await sleep(timeout);
    } catch (e) {
      if (e instanceof CancelledError) return;
      throw e;
    } finally {
      this._sttTimeoutTask = null;
    }

    this._sttWaitDone = true;
    await this._maybeReportUserTurnStopped();
  }

  /**
   * Trigger user turn stopped if all required conditions are met.
   *
   * Both timers must be done (stt is marked done immediately on the
   * fallback path and when finalization short-circuits the safety net),
   * the user must not be currently speaking, and — when
   * `waitForTranscript` is true — at least one transcript must have been
   * received.
   */
  protected async _maybeReportUserTurnStopped(): Promise<void> {
    if (this._vadUserSpeaking) {
      return;
    }

    if (this._waitForTranscript && !this._text) {
      return;
    }

    if (this._userSpeechWaitDone && this._sttWaitDone) {
      await this.reportUserTurnStopped();
    }
  }

  /** Cancel any running timer tasks and clear the handles. */
  protected async _cancelAllTasks(): Promise<void> {
    if (this._userSpeechTimeoutTask) {
      await this.taskManager.cancelTask(this._userSpeechTimeoutTask);
      this._userSpeechTimeoutTask = null;
    }
    if (this._sttTimeoutTask) {
      await this.taskManager.cancelTask(this._sttTimeoutTask);
      this._sttTimeoutTask = null;
    }
  }
}
