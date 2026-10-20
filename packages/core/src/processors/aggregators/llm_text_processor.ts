// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_text_processor.py

/**
 * LLM text processor module for processing and aggregating raw LLM output text.
 *
 * This processor will convert LLMTextFrames into AggregatedTextFrames based on
 * the configured text aggregator. Using the customizable aggregator, it
 * provides functionality to handle or manipulate LLM text frames before they
 * are sent to other components such as TTS services or context aggregators. It
 * can be used to pre-aggregate and categorize, modify, or filter direct output
 * tokens from the LLM.
 */

import {
  AggregatedTextFrame,
  EndFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMTextFrame,
} from "../../frames/frames.ts";
import type { BaseTextAggregator } from "../../utils/text/base_text_aggregator.ts";
import { PatternMatch } from "../../utils/text/pattern_pair_aggregator.ts";
import { SimpleTextAggregator } from "../../utils/text/simple_text_aggregator.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface LLMTextProcessorOptions extends FrameProcessorOptions {
  /**
   * An optional text aggregator to use for processing LLM text frames. By
   * default, a SimpleTextAggregator aggregating by sentence will be used.
   */
  textAggregator?: BaseTextAggregator | null;
}

/**
 * A processor for handling or manipulating LLM text frames before they are processed further.
 *
 * This processor will convert LLMTextFrames into AggregatedTextFrames based on
 * the configured text aggregator. Using the customizable aggregator, it
 * provides functionality to handle or manipulate LLM text frames before they
 * are sent to other components such as TTS services or context aggregators. It
 * can be used to pre-aggregate and categorize, modify, or filter direct output
 * tokens from the LLM.
 */
export class LLMTextProcessor extends FrameProcessor {
  protected _textAggregator: BaseTextAggregator;

  /**
   * Initialize the LLM text processor.
   *
   * TODO: Allow transformations per text type or all (and deprecate the TTS filters).
   */
  constructor(options: LLMTextProcessorOptions = {}) {
    super(options);
    this._textAggregator = options.textAggregator || new SimpleTextAggregator();
  }

  /**
   * Process an LLMTextFrames using the aggregator to generate AggregatedTextFrames.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof InterruptionFrame) {
      await this._handleInterruption(frame);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof LLMTextFrame) {
      await this._handleLlmText(frame);
    } else if (frame instanceof LLMFullResponseEndFrame) {
      await this._handleLlmEnd(frame.skipTts);
      await this.pushFrame(frame, direction);
    } else if (frame instanceof EndFrame) {
      await this._handleLlmEnd();
      await this.pushFrame(frame, direction);
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Handle interruptions by resetting the text aggregator. */
  protected async _handleInterruption(_: InterruptionFrame): Promise<void> {
    await this._textAggregator.handleInterruption();
  }

  /** Reset the internal state of the text processor and its aggregator. */
  async reset(): Promise<void> {
    await this._textAggregator.reset();
  }

  protected async _handleLlmText(inFrame: LLMTextFrame): Promise<void> {
    for await (const aggregation of this._textAggregator.aggregate(inFrame.text)) {
      const outFrame = new AggregatedTextFrame({
        text: aggregation.text,
        textType: aggregation.type,
        rawText: aggregation instanceof PatternMatch ? aggregation.fullMatch : aggregation.text,
      });
      outFrame.appendToContext = true;
      outFrame.skipTts = inFrame.skipTts;
      await this.pushFrame(outFrame);
    }
  }

  protected async _handleLlmEnd(skipTts: boolean | null = null): Promise<void> {
    // Flush any remaining text
    const remaining = await this._textAggregator.flush();
    if (remaining) {
      const outFrame = new AggregatedTextFrame({
        text: remaining.text,
        textType: remaining.type,
        rawText: remaining instanceof PatternMatch ? remaining.fullMatch : remaining.text,
      });
      outFrame.skipTts = skipTts;
      await this.pushFrame(outFrame);
    }
  }
}
