// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/vad/vad_controller.py

/**
 * Voice Activity Detection controller for managing speech state transitions.
 *
 * Provides a controller that wraps a VADAnalyzer to track speech state and
 * emit events when speech starts, stops, or is actively detected.
 */

import { monotonic, sleep, type Task, time } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  SpeechControlParamsFrame,
  VADParamsUpdateFrame,
} from "../../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { BaseObject } from "../../utils/base_object.ts";
import { logger } from "../../utils/logger.ts";
import { type VADAnalyzer, VADState } from "./vad_analyzer.ts";

export interface VADControllerOptions {
  /**
   * Minimum interval in seconds between `on_speech_activity` events.
   * Defaults to 0.2.
   */
  speechActivityPeriod?: number;
  /**
   * Timeout in seconds to force speech stop when no audio frames are
   * received while in SPEAKING state. This handles cases like mic mute
   * mid-speech. Set to 0 to disable. Defaults to 1.0.
   */
  audioIdleTimeout?: number;
}

/**
 * Manages voice activity detection state and emits speech events.
 *
 * Wraps a `VADAnalyzer` to process audio and trigger events based on speech
 * state transitions. Tracks whether the user is speaking, quiet, or
 * transitioning between states.
 *
 * Event handlers available:
 *
 * - on_speech_started: Called when speech begins.
 * - on_speech_stopped: Called when speech ends, including forced stop when
 *   the audio stream goes idle (no frames received while speaking).
 * - on_speech_activity: Called periodically while speech is detected.
 * - on_push_frame: Called when the controller wants to push a frame.
 * - on_broadcast_frame: Called when the controller wants to broadcast a frame.
 *
 * @example
 * vadController.eventHandler("on_speech_started", async (controller) => { ... });
 * vadController.eventHandler("on_speech_stopped", async (controller) => { ... });
 * vadController.eventHandler("on_speech_activity", async (controller) => { ... });
 * vadController.eventHandler("on_push_frame", async (controller, frame, direction) => { ... });
 * vadController.eventHandler("on_broadcast_frame", async (controller, frameCls, options) => { ... });
 */
export class VADController extends BaseObject {
  protected _vadAnalyzer: VADAnalyzer;
  protected _vadState: VADState = VADState.QUIET;

  // Last time a on_speech_activity was triggered.
  protected _speechActivityTime = 0;
  // How often a on_speech_activity event should be triggered (value should
  // be greater than the audio chunks to have any effect).
  protected _speechActivityPeriod: number;

  // Audio idle detection: force speech stop when no audio arrives while in
  // SPEAKING state (e.g. user mutes mic mid-speech).
  protected _lastAudioTime = 0.0;
  protected _audioIdleTimeout: number;
  protected _audioIdleTask: Task<unknown> | null = null;

  /**
   * Initialize the VAD controller.
   *
   * @param vadAnalyzer The `VADAnalyzer` instance for processing audio.
   * @param options Speech activity period and audio idle timeout.
   */
  constructor(vadAnalyzer: VADAnalyzer, options: VADControllerOptions = {}) {
    super();
    this._vadAnalyzer = vadAnalyzer;
    this._taskManager = null;
    this._speechActivityPeriod = options.speechActivityPeriod ?? 0.2;
    this._audioIdleTimeout = options.audioIdleTimeout ?? 1.0;

    this._registerEventHandler("on_speech_started", true);
    this._registerEventHandler("on_speech_stopped", true);
    this._registerEventHandler("on_speech_activity", true);
    this._registerEventHandler("on_push_frame", true);
    this._registerEventHandler("on_broadcast_frame", true);
  }

  /**
   * Set up the controller.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);
    this._lastAudioTime = monotonic();
    this._vadAnalyzer.setSampleRate(setup.audioInSampleRate);
  }

  /**
   * Process a frame and handle VAD-related events.
   *
   * Handles `InputAudioRawFrame` to analyze audio for voice activity, and
   * `VADParamsUpdateFrame` to reconfigure the analyzer.
   *
   * @param frame The frame to process.
   */
  async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof InputAudioRawFrame) {
      await this._handleAudio(frame);
    } else if (frame instanceof VADParamsUpdateFrame) {
      this._vadAnalyzer.setParams(frame.params);
      await this.broadcastFrame(SpeechControlParamsFrame, { vadParams: frame.params });
    }
  }

  /**
   * Announce the analyzer's params and start the idle timer.
   *
   * Paired with `stop()`.
   */
  async start(): Promise<void> {
    // Broadcast initial VAD params so other services (e.g. STT) can use them
    await this.broadcastFrame(SpeechControlParamsFrame, { vadParams: this._vadAnalyzer.params });

    if (this._audioIdleTimeout > 0 && !this._audioIdleTask) {
      this._audioIdleTask = this.createTask(() => this._audioIdleHandler(), "_audioIdleHandler");
    }
  }

  /**
   * Stop the idle timer, leaving the analyzer alone.
   *
   * Called at session end so the timer can't report silence that only means
   * the session is over. The analyzer may be shared, so releasing it waits
   * for `cleanup()`.
   */
  async stop(): Promise<void> {
    if (this._audioIdleTask && this._taskManager) {
      await this._taskManager.cancelTask(this._audioIdleTask);
      this._audioIdleTask = null;
    }
  }

  /**
   * Clean up resources.
   *
   * This method should be called when the object is no longer needed. It
   * waits for all currently executing event handler tasks to finish before
   * returning.
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this.stop();
    if (this._vadAnalyzer) {
      await this._vadAnalyzer.cleanup();
    }
  }

  /**
   * Process an audio chunk and emit speech events as needed.
   *
   * Analyzes the audio for voice activity and triggers `on_speech_started`,
   * `on_speech_stopped`, or `on_speech_activity` events based on state
   * changes.
   *
   * @param frame Audio frame to process.
   */
  protected async _handleAudio(frame: InputAudioRawFrame): Promise<void> {
    this._lastAudioTime = monotonic();

    this._vadState = await this._handleVad(frame.audio, this._vadState);

    if (this._vadState === VADState.SPEAKING) {
      await this._maybeSpeechActivity();
    }
  }

  /** Handle Voice Activity Detection results and trigger appropriate events. */
  protected async _handleVad(audio: Uint8Array, vadState: VADState): Promise<VADState> {
    const newVadState = await this._vadAnalyzer.analyzeAudio(audio);
    if (
      newVadState !== vadState &&
      newVadState !== VADState.STARTING &&
      newVadState !== VADState.STOPPING
    ) {
      if (newVadState === VADState.SPEAKING) {
        await this._callEventHandler("on_speech_started");
      } else if (newVadState === VADState.QUIET) {
        await this._callEventHandler("on_speech_stopped");
      }

      vadState = newVadState;
    }
    return vadState;
  }

  /**
   * Monitor for an idle audio stream while in SPEAKING state.
   *
   * When no audio frames arrive for `audioIdleTimeout` seconds (e.g. user
   * mutes mic mid-speech), forces a transition to QUIET and emits
   * `on_speech_stopped`.
   */
  protected async _audioIdleHandler(): Promise<void> {
    while (true) {
      const deadline = this._lastAudioTime + this._audioIdleTimeout;
      const remaining = deadline - monotonic();
      if (remaining > 0) {
        // Audio is still recent; sleep only for the remaining window.
        await sleep(remaining);
        continue;
      }

      if (this._vadState === VADState.SPEAKING) {
        logger.warning(`${this}: no audio received while speaking, forcing speech stop`);
        this._vadState = VADState.QUIET;
        await this._callEventHandler("on_speech_stopped");
      }

      // Wait for the next potential idle window.
      await sleep(this._audioIdleTimeout);
    }
  }

  /** Handle user speaking frame. */
  protected async _maybeSpeechActivity(): Promise<void> {
    const diffTime = time() - this._speechActivityTime;
    if (diffTime >= this._speechActivityPeriod) {
      this._speechActivityTime = time();
      await this._callEventHandler("on_speech_activity");
    }
  }

  /**
   * Request a frame to be pushed through the pipeline.
   *
   * This emits an on_push_frame event that must be handled by a processor to
   * actually push the frame into the pipeline.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this._callEventHandler("on_push_frame", frame, direction);
  }

  /**
   * Request a frame to be broadcast upstream and downstream.
   *
   * This emits an on_broadcast_frame event that must be handled by a
   * processor to actually broadcast the frame in the pipeline.
   *
   * @param frameCls The class of the frame to broadcast.
   * @param options Arguments to pass to the frame constructor.
   */
  async broadcastFrame<O>(frameCls: new (options: O) => Frame, options?: O): Promise<void> {
    await this._callEventHandler("on_broadcast_frame", frameCls, options);
  }
}
