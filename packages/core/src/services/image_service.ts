// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/image_service.py

/**
 * Image generation service implementation.
 *
 * Provides base functionality for AI-powered image generation services that
 * convert text prompts into images.
 */

import { type Frame, TextFrame } from "../frames/frames.ts";
import type { FrameDirection } from "../processors/frame_processor.ts";
import { AIService, type AIServiceOptions } from "./ai_service.ts";
import { ImageGenSettings } from "./settings.ts";

export interface ImageGenServiceOptions extends AIServiceOptions {
  /** The runtime-updatable settings for the image generation service. */
  settings?: ImageGenSettings | null;
}

/**
 * Base class for image generation services.
 *
 * Processes TextFrames by using their content as prompts for image
 * generation. Subclasses must implement the `runImageGen` method to provide
 * actual image generation functionality using their specific AI service.
 */
export abstract class ImageGenService extends AIService {
  /**
   * Initialize the image generation service.
   *
   * @param options.settings The runtime-updatable settings for the image
   *   generation service. Other options are passed to the parent AIService.
   */
  constructor(options: ImageGenServiceOptions = {}) {
    super({
      ...options,
      settings:
        options.settings ||
        // Here in case subclass doesn't implement more specific settings
        // (which hopefully should be rare)
        new ImageGenSettings(),
    });
  }

  // Renders the image. Returns an Image object.
  /**
   * Generate an image from a text prompt.
   *
   * This method must be implemented by subclasses to provide actual image
   * generation functionality using their specific AI service.
   *
   * @param prompt The text prompt to generate an image from.
   * @returns An async generator yielding frames containing the generated
   *   image (typically ImageRawFrame or URLImageRawFrame).
   */
  abstract runImageGen(prompt: string): AsyncGenerator<Frame | null, void, unknown>;

  /**
   * Process frames for image generation.
   *
   * TextFrames are used as prompts for image generation, while other frames
   * are passed through unchanged.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame processing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      await this.pushFrame(frame, direction);
      await this.startProcessingMetrics();
      await this.processGenerator(this.runImageGen(frame.text));
      await this.stopProcessingMetrics();
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}
