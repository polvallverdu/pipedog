// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py

/** User turn stop strategy based on turn detection analyzers. */

import { CancelledError, sleep, type Task, time } from "@pipecat-ts/asyncio";
import { type BaseTurnAnalyzer, EndOfTurnState } from "../../audio/turn/base_turn_analyzer.ts";
import { VAD_STOP_SECS } from "../../audio/vad/vad_analyzer.ts";
import {
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  MetricsFrame,
  SpeechControlParamsFrame,
  STTMetadataFrame,
  StartFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import type { MetricsData } from "../../metrics/metrics.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { logger } from "../../utils/logger.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStopStrategy,
  type BaseUserTurnStopStrategyOptions,
} from "./base_user_turn_stop_strategy.ts";

export interface TurnAnalyzerUserTurnStopStrategyOptions extends BaseUserTurnStopStrategyOptions {
  /** The turn detection analyzer instance to detect end of user turn. */
  turnAnalyzer: BaseTurnAnalyzer;
  /**
   * Whether to require a transcript before triggering end-of-turn. When true
   * (default), turn-end fires only after the turn analyzer reports COMPLETE
   * *and* either a finalized transcript arrives or the STT safety-net timeout
   * elapses with text in hand. When false, the strategy signals turn-end as
   * soon as the turn analyzer reports COMPLETE — independent of transcripts.
   * Set this to false when local turn detection is the intended driver of
   * the conversation (e.g. with a realtime LLM service consuming audio
   * directly), so transcripts are off the latency critical path.
   * `LLMContextAggregatorPair` flips this for you when
   * `realtimeServiceMode: true`.
   */
  waitForTranscript?: boolean;
}

/**
 * User turn stop strategy that uses a turn detection model to determine if the
 * user is done speaking.
 *
 * This strategy feeds audio, VAD, and transcription frames to a turn
 * detection model (`BaseTurnAnalyzer`) that predicts when the user has
 * finished their turn. Once the model indicates the turn is complete, the
 * strategy waits for a final transcription before triggering the end of
 * the user's turn.
 *
 * For services that support finalization (`TranscriptionFrame.finalized`),
 * the turn can be triggered immediately once the finalized transcript is
 * received. Otherwise, an STT timeout is used as a fallback: the turn is
 * released once `ttfsP99Latency` has elapsed since the end of the user's
 * speech (as reported by VAD, discounting its `stopSecs` silence window).
 */
export class TurnAnalyzerUserTurnStopStrategy extends BaseUserTurnStopStrategy {
  protected _turnAnalyzer: BaseTurnAnalyzer;
  protected _waitForTranscript: boolean;
  protected _sttTimeout = 0.0; // STT P99 latency from STTMetadataFrame
  protected _stopSecs = 0.0; // VAD stop_secs from VADUserStoppedSpeakingFrame

  protected _stopSecsWarned = false;

  protected _text = "";
  protected _turnComplete = false;
  protected _vadUserSpeaking = false;
  protected _vadStopped = false; // Whether VAD reported a stop this turn
  protected _transcriptFinalized = false;
  protected _timeoutTask: Task<unknown> | null = null;
  protected _timeoutExpired = false;

  constructor(options: TurnAnalyzerUserTurnStopStrategyOptions) {
    super(options);
    this._turnAnalyzer = options.turnAnalyzer;
    this._waitForTranscript = options.waitForTranscript ?? true;
  }

  /** Whether transcripts gate end-of-turn signalling. */
  get waitForTranscript(): boolean {
    return this._waitForTranscript;
  }

  set waitForTranscript(value: boolean) {
    this._waitForTranscript = value;
  }

  /** Ready the strategy to detect the end of the turn now starting. */
  override async handleUserTurnStarted(): Promise<void> {
    await this._reset();
  }

  /**
   * Clear the analyzer's buffered speech when the turn ends.
   *
   * Beyond the usual per-turn reset, drop the analyzer's buffered speech
   * state so a stale silence timer can't fire a phantom end-of-turn after
   * an externally-ended turn (for example a forced stop while a mute
   * strategy held audio back). The analyzer already clears itself on its
   * own COMPLETE, so the clear is a no-op on the normal path; the
   * pre-speech buffer refills continuously before the next turn starts.
   */
  override async handleUserTurnStopped(): Promise<void> {
    await this._reset();
    this._turnAnalyzer.clear();
  }

  /**
   * Clear turn-scoped state. Runs at both turn boundaries.
   *
   * `_vadUserSpeaking` is deliberately left alone: whether the user is
   * speaking belongs to the user rather than to the turn, and VAD reports it
   * only on transitions. Clearing it at a turn start VAD didn't drive — a
   * turn begun from a transcript, mid-utterance — would leave it wrong until
   * the user next stops.
   */
  protected async _reset(): Promise<void> {
    this._text = "";
    await this._discardPendingEndOfTurn();
  }

  /**
   * Drop any end-of-turn conclusion reached so far.
   *
   * Runs at a turn boundary, and whenever VAD reports the user speaking
   * again — which makes an earlier conclusion stale mid-turn.
   */
  protected async _discardPendingEndOfTurn(): Promise<void> {
    this._turnComplete = false;
    this._transcriptFinalized = false;
    this._timeoutExpired = false;
    this._vadStopped = false;
    if (this._timeoutTask) {
      await this.taskManager.cancelTask(this._timeoutTask);
      this._timeoutTask = null;
    }
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._turnAnalyzer.setSampleRate(setup.audioInSampleRate);
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._turnAnalyzer.cleanup();
    if (this._timeoutTask) {
      await this.taskManager.cancelTask(this._timeoutTask);
      this._timeoutTask = null;
    }
  }

  /**
   * Process an incoming frame to update the turn analyzer and strategy state.
   *
   * @param frame The frame to be analyzed.
   * @returns Always returns CONTINUE so subsequent stop strategies are evaluated.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    await super.processFrame(frame);

    if (frame instanceof StartFrame) {
      await this._start(frame);
    } else if (frame instanceof STTMetadataFrame) {
      this._sttTimeout = frame.ttfsP99Latency;
      this._stopSecsWarned = false;
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      await this._handleVadUserStartedSpeaking(frame);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._handleVadUserStoppedSpeaking(frame);
    } else if (frame instanceof InputAudioRawFrame) {
      await this._handleInputAudio(frame);
    } else if (frame instanceof TranscriptionFrame) {
      await this._handleTranscription(frame);
    } else if (frame instanceof InterimTranscriptionFrame) {
      // An interim means more transcription is still on the way, so an
      // earlier finalized transcript no longer covers all of the user's
      // speech.
      // Without this, a transcript finalized during a pause too short for
      // VAD to report a stop (and thus a new start, which is what normally
      // clears the flag) would leave the flag stale and trigger the turn
      // immediately at the next VAD stop while the tail of the utterance
      // is still in flight. This can happen when the STT endpointer
      // finalizes on silences shorter than the VAD stop_secs — e.g. an
      // aggressive STT endpoint or a manually raised stop_secs.
      this._transcriptFinalized = false;
    }

    return ProcessFrameResult.CONTINUE;
  }

  /** Process the start frame to configure the turn analyzer. */
  protected async _start(_frame: StartFrame): Promise<void> {
    await this.broadcastFrame(SpeechControlParamsFrame, {
      turnParams: this._turnAnalyzer.params,
    });
  }

  /** Handle input audio to check if the turn is completed. */
  protected async _handleInputAudio(frame: InputAudioRawFrame): Promise<void> {
    const state = this._turnAnalyzer.appendAudio(frame.audio, this._vadUserSpeaking);

    // Streaming analyzers (e.g. KrispVivaTurn) detect turn completion
    // frame-by-frame inside appendAudio, so COMPLETE is returned here
    // rather than in analyzeEndOfTurn. Batch analyzers (BaseSmartTurn)
    // return COMPLETE here only on a silence timeout. In either case we
    // consume and push metrics immediately while they're fresh.
    if (state === EndOfTurnState.COMPLETE) {
      const [, prediction] = await this._turnAnalyzer.analyzeEndOfTurn();
      await this._handlePredictionResult(prediction);
      this._turnComplete = true;
      await this._maybeTriggerUserTurnStopped();
    }
  }

  /** Handle when the VAD indicates the user is speaking. */
  protected async _handleVadUserStartedSpeaking(frame: VADUserStartedSpeakingFrame): Promise<void> {
    // Sync Smart Turn pre-speech buffering with VAD start delay
    this._turnAnalyzer.updateVadStartSecs(frame.startSecs);
    this._vadUserSpeaking = true;
    await this._discardPendingEndOfTurn();
  }

  /** Handle when the VAD indicates the user has stopped speaking. */
  protected async _handleVadUserStoppedSpeaking(frame: VADUserStoppedSpeakingFrame): Promise<void> {
    this._vadUserSpeaking = false;
    this._stopSecs = frame.stopSecs;
    this._vadStopped = true;

    // The STT p99 budget is measured from when the user actually stopped
    // speaking, which VAD only reports stop_secs later. Anchoring the
    // safety net to that absolute deadline keeps the wait fixed no matter
    // how long end-of-turn analysis (e.g. ML inference) takes before the
    // timer is armed.
    const sttDeadline = frame.timestamp - frame.stopSecs + this._sttTimeout;

    const [state, prediction] = await this._turnAnalyzer.analyzeEndOfTurn();
    await this._handlePredictionResult(prediction);

    // The user stopped speaking and the turn is complete, we now need to
    // wait for transcriptions.
    this._turnComplete = state === EndOfTurnState.COMPLETE;

    const timeout = Math.max(0, sttDeadline - time());

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

    this._timeoutTask = this.taskManager.createTask(
      () => this._timeoutHandler(timeout),
      `${this}::_timeout_handler`,
    );

    // A finalized transcript (or COMPLETE itself, when waitForTranscript
    // is false) may already have satisfied the trigger conditions while the
    // analyzer was running. The analyzer's verdict is only known now, so
    // re-check here rather than wait out the safety-net timer.
    await this._maybeTriggerUserTurnStopped();
  }

  /** Handle user transcription. */
  protected async _handleTranscription(frame: TranscriptionFrame): Promise<void> {
    // We don't really care about the content.
    this._text = frame.text;
    if (frame.finalized) {
      this._transcriptFinalized = true;
      // For finalized transcripts, trigger immediately if turn is complete
      await this._maybeTriggerUserTurnStopped();
    } else if (this._timeoutExpired && this._turnComplete) {
      // The p99 timeout already elapsed without a transcript. Now that
      // we have one, trigger the turn stop immediately. This handles the
      // case where the transcript is slower to arrive than the p99 timeout,
      // trigger the user turn to stop immediately.
      await this.triggerUserTurnStopped();
      return;
    }

    // Fallback: handle transcripts when no VAD stop was received.
    // This handles edge cases where transcripts arrive without VAD firing.
    // In fallback mode, reset timeout on each transcript to wait for inactivity.
    if (!this._vadUserSpeaking && !this._vadStopped) {
      // Cancel existing fallback timeout if any
      if (this._timeoutTask) {
        await this.taskManager.cancelTask(this._timeoutTask);
      }
      // Without VAD/turn analyzer data, assume turn is complete
      this._turnComplete = true;
      const timeout = Math.max(0, this._sttTimeout - this._stopSecs);
      this._timeoutTask = this.taskManager.createTask(
        () => this._timeoutHandler(timeout),
        `${this}::_timeout_handler`,
      );
    }
  }

  /** Handle a prediction result event from the turn analyzer. */
  protected async _handlePredictionResult(result: MetricsData | null | undefined): Promise<void> {
    if (result) {
      await this.pushFrame(new MetricsFrame({ data: [result] }));
    }
  }

  /**
   * Wait for the timeout then trigger user turn stopped if conditions met.
   *
   * @param timeout The timeout in seconds to wait.
   */
  protected async _timeoutHandler(timeout: number): Promise<void> {
    try {
      await sleep(timeout);
    } catch (e) {
      if (e instanceof CancelledError) return;
      throw e;
    } finally {
      this._timeoutTask = null;
    }

    this._timeoutExpired = true;
    await this._maybeTriggerUserTurnStopped();
  }

  /**
   * Trigger user turn stopped if conditions are met.
   *
   * Conditions:
   * - Turn analyzer indicates turn is complete
   * - When `waitForTranscript` is true (default): we have transcription text
   *   *and* either the safety-net timeout has elapsed or a finalized
   *   transcript arrived.
   * - When `waitForTranscript` is false: fire as soon as the turn analyzer
   *   reports COMPLETE — independent of transcripts.
   */
  protected async _maybeTriggerUserTurnStopped(): Promise<void> {
    if (!this._turnComplete) {
      return;
    }

    if (!this._waitForTranscript) {
      // Turn-end is driven by the analyzer; transcripts are bookkeeping.
      if (this._timeoutTask) {
        await this.taskManager.cancelTask(this._timeoutTask);
        this._timeoutTask = null;
      }
      await this.triggerUserTurnStopped();
      return;
    }

    if (!this._text) {
      return;
    }

    // For finalized transcripts, trigger immediately
    if (this._transcriptFinalized) {
      // Cancel any remaining timeout since we're triggering now
      if (this._timeoutTask) {
        await this.taskManager.cancelTask(this._timeoutTask);
        this._timeoutTask = null;
      }
      await this.triggerUserTurnStopped();
      return;
    }

    // For non-finalized, only trigger if timeout task has completed
    if (this._timeoutTask === null) {
      await this.triggerUserTurnStopped();
    }
  }
}
