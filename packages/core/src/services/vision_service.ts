// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/vision_service.py

/**
 * Vision service implementation.
 *
 * Provides base classes and implementations for computer vision services that
 * can analyze images and generate textual descriptions or answers to questions
 * about visual content.
 */

import { type Frame, UserImageRawFrame } from "../frames/frames.ts";
import type { FrameDirection } from "../processors/frame_processor.ts";
import { AIService, type AIServiceOptions } from "./ai_service.ts";
import { VisionSettings } from "./settings.ts";

export interface VisionServiceOptions extends AIServiceOptions {
  /** The runtime-updatable settings for the vision service. */
  settings?: VisionSettings | null;
}

/**
 * Base class for vision services.
 *
 * Provides common functionality for vision services that process images and
 * generate textual responses. Handles image frame processing and integrates
 * with the AI service infrastructure for metrics and lifecycle management.
 */
export abstract class VisionService extends AIService {
  declare protected _settings: VisionSettings;
  protected _describeText: string | null;

  /**
   * Initialize the vision service.
   *
   * @param options.settings The runtime-updatable settings for the vision
   *   service. Other options are passed to the parent AIService.
   */
  constructor(options: VisionServiceOptions = {}) {
    super({
      ...options,
      settings:
        options.settings ??
        // Here in case subclass doesn't implement more specific settings
        // (which hopefully should be rare)
        new VisionSettings(),
    });
    this._describeText = null;
  }

  /**
   * Process the given vision image and generate results.
   *
   * This method must be implemented by subclasses to provide actual computer
   * vision functionality such as image description, object detection, or
   * visual question answering.
   *
   * @param frame The image frame to process.
   * @returns Frames containing the vision analysis results, typically
   *   TextFrame objects with descriptions or answers.
   */
  abstract runVision(frame: UserImageRawFrame): AsyncGenerator<Frame | null, void>;

  /**
   * Process frames, handling vision image frames for analysis.
   *
   * Automatically processes UserImageRawFrame objects by calling runVision and
   * handles metrics tracking. Other frames are passed through unchanged.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof UserImageRawFrame && frame.text) {
      await this.startProcessingMetrics();
      await this.processGenerator(this.runVision(frame));
      await this.stopProcessingMetrics();
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}
