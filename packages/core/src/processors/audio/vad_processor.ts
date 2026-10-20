// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/audio/vad_processor.py

/**
 * Voice Activity Detection processor for detecting speech in audio streams.
 *
 * This module provides a VADProcessor that wraps a VADController to process
 * audio frames and push VAD-related frames into the pipeline.
 */

import type { VADAnalyzer } from "../../audio/vad/vad_analyzer.ts";
import { VADController } from "../../audio/vad/vad_controller.ts";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  StartFrame,
  UserSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../frame_processor.ts";

export interface VADProcessorOptions extends FrameProcessorOptions {
  /** The VADAnalyzer instance for processing audio. */
  vadAnalyzer: VADAnalyzer;
  /**
   * Minimum interval in seconds between UserSpeakingFrame pushes. Defaults
   * to 0.2.
   */
  speechActivityPeriod?: number;
  /**
   * Timeout in seconds to force speech stop when no audio frames are
   * received while in SPEAKING state. Set to 0 to disable. Defaults to 1.0.
   */
  audioIdleTimeout?: number;
}

/**
 * Processes audio frames through voice activity detection.
 *
 * This processor wraps a VADController to detect speech in audio streams
 * and push VAD frames into the pipeline:
 *
 * - `VADUserStartedSpeakingFrame`: pushed when speech begins.
 * - `VADUserStoppedSpeakingFrame`: pushed when speech ends.
 * - `UserSpeakingFrame`: pushed periodically while speech is detected.
 *
 * @example
 * const vadProcessor = new VADProcessor({ vadAnalyzer: new SileroVADAnalyzer() });
 */
export class VADProcessor extends FrameProcessor {
  protected _vadController: VADController;

  /**
   * Initialize the VAD processor.
   *
   * @param options.vadAnalyzer The VADAnalyzer instance for processing audio.
   * @param options.speechActivityPeriod Minimum interval in seconds between
   *   UserSpeakingFrame pushes. Defaults to 0.2.
   * @param options.audioIdleTimeout Timeout in seconds to force speech stop
   *   when no audio frames are received while in SPEAKING state. Set to 0 to
   *   disable. Defaults to 1.0. Other options are passed to the parent class.
   */
  constructor(options: VADProcessorOptions) {
    super(options);
    const vadAnalyzer = options.vadAnalyzer;
    this._vadController = new VADController(vadAnalyzer, {
      speechActivityPeriod: options.speechActivityPeriod ?? 0.2,
      audioIdleTimeout: options.audioIdleTimeout ?? 1.0,
    });

    // Push VAD frames when speech events are detected. Upstream reads the
    // params through the controller's analyzer, which is this same instance.
    this._vadController.addEventHandler("on_speech_started", async () => {
      logger.debug(`${this}: User started speaking`);
      await this.broadcastFrame(VADUserStartedSpeakingFrame, {
        startSecs: vadAnalyzer.params.startSecs,
      });
    });

    this._vadController.addEventHandler("on_speech_stopped", async () => {
      logger.debug(`${this}: User stopped speaking`);
      await this.broadcastFrame(VADUserStoppedSpeakingFrame, {
        stopSecs: vadAnalyzer.params.stopSecs,
      });
    });

    this._vadController.addEventHandler("on_speech_activity", async () => {
      await this.broadcastFrame(UserSpeakingFrame);
    });

    // Wire up frame pushing from controller to processor
    this._vadController.addEventHandler(
      "on_push_frame",
      async (_controller: unknown, frame: Frame, direction: FrameDirection) => {
        await this.pushFrame(frame, direction);
      },
    );

    this._vadController.addEventHandler(
      "on_broadcast_frame",
      async (_controller: unknown, frameCls: new (options: object) => Frame, kwargs?: object) => {
        await this.broadcastFrame(frameCls, kwargs ?? {});
      },
    );
  }

  /**
   * Set up the processor.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._vadController.setup(setup);
  }

  /** Clean up VAD controller resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._vadController.cleanup();
  }

  /**
   * Process a frame through VAD and forward it.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Forward the frame first, then let VAD controller process. This ensures:
    // 1. StartFrame reaches downstream before SpeechControlParamsFrame is broadcast
    // 2. Audio flows through immediately while VAD detection happens after
    await this.pushFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this._vadController.start();
    } else if (frame instanceof EndFrame || frame instanceof CancelFrame) {
      await this._vadController.stop();
    }

    // Let the VAD controller handle the frame
    await this._vadController.processFrame(frame);
  }
}
