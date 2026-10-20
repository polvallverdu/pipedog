// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_response.py

/** LLM response aggregator for collecting complete LLM responses. */

import {
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  type TextFrame,
} from "../../frames/frames.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface LLMFullResponseAggregatorOptions extends FrameProcessorOptions {}

/**
 * Aggregates complete LLM responses between start and end frames.
 *
 * This aggregator collects LLM text frames (tokens) received between
 * `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame` and provides the
 * complete response via an event handler.
 *
 * The aggregator provides an "on_completion" event that fires when a full
 * completion is available.
 *
 * @example
 * aggregator.eventHandler("on_completion", async (aggregator, completion: string, completed: boolean) => {
 *   // Handle the completion
 * });
 */
export class LLMFullResponseAggregator extends FrameProcessor {
  protected _aggregation = "";
  protected _started = false;

  /** Initialize the LLM full response aggregator. */
  constructor(options: LLMFullResponseAggregatorOptions = {}) {
    super(options);
    this._registerEventHandler("on_completion");
  }

  /**
   * Process incoming frames and aggregate LLM text content.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InterruptionFrame) {
      await this._callEventHandler("on_completion", this._aggregation, false);
      this._aggregation = "";
      this._started = false;
    } else if (frame instanceof LLMFullResponseStartFrame) {
      await this._handleLlmStart(frame);
    } else if (frame instanceof LLMFullResponseEndFrame) {
      await this._handleLlmEnd(frame);
    } else if (frame instanceof LLMTextFrame) {
      await this._handleLlmText(frame);
    }

    await this.pushFrame(frame, direction);
  }

  protected async _handleLlmStart(_: LLMFullResponseStartFrame): Promise<void> {
    this._started = true;
  }

  protected async _handleLlmEnd(_: LLMFullResponseEndFrame): Promise<void> {
    await this._callEventHandler("on_completion", this._aggregation, true);
    this._started = false;
    this._aggregation = "";
  }

  protected async _handleLlmText(frame: TextFrame): Promise<void> {
    if (!this._started) {
      return;
    }
    this._aggregation += frame.text;
  }
}
