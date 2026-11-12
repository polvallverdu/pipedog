// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/llm_text_processor.py

/**
 * LLM text processor module for aggregating raw LLM output text.
 *
 * This processor converts LLMTextFrames into AggregatedTextFrames using the
 * configured text aggregator. Text transforms can optionally be registered on
 * it; by default the aggregations are pushed on as the aggregator produced
 * them. Because the aggregated frames reach every consumer downstream, a
 * transform registered here changes what the TTS speaks, what the context
 * records and what clients display, whereas one registered on a TTS service
 * changes the text for the synthesizer only.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import {
  AggregatedTextFrame,
  EndFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMTextFrame,
  TTSStoppedFrame,
} from "../../frames/frames.ts";
import { ErrorCategory } from "../../utils/errors.ts";
import type {
  Aggregation,
  BaseTextAggregator,
  TextType,
} from "../../utils/text/base_text_aggregator.ts";
import { PatternMatch } from "../../utils/text/pattern_pair_aggregator.ts";
import { SimpleTextAggregator } from "../../utils/text/simple_text_aggregator.ts";
import type { TextTransform } from "../../utils/text/transforms/text_transform.ts";
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
  /**
   * Optional callables to rewrite aggregations with, as `[textType | "*", transform]`
   * pairs. None by default. A rewrite reaches everything downstream: the TTS, the
   * context and the client.
   */
  textTransforms?: Array<[TextType | string, TextTransform]> | null;
}

/**
 * Aggregates LLM text frames before they are processed further.
 *
 * This processor converts LLMTextFrames into AggregatedTextFrames based on the
 * configured text aggregator. By default it leaves the text alone; the frames
 * it pushes carry the aggregations as the aggregator produced them.
 *
 * Text transforms can be registered to rewrite the aggregations on their way
 * through. The frames feed the TTS service, the context aggregator and client
 * output alike, so a transform registered here changes the text for all of
 * them, which suits a habit the LLM keeps repeating (emoji, stage directions),
 * a name it should not use, or a pattern to redact. To change only what is
 * spoken, register the transform on the TTS service instead.
 *
 * A transform is an async callable `(text, textType) => text`, registered for
 * one text type or `"*"` for all. A transform whose output is only whitespace
 * drops the aggregation, so nothing is spoken or added to the context for it.
 *
 * @example
 * ```ts
 * // Aggregates by sentence, nothing rewritten.
 * const llmTextProcessor = new LLMTextProcessor();
 *
 * // Rewrites what everyone sees: the voice, the context and the client.
 * const llmTextProcessor = new LLMTextProcessor({ textTransforms: [["*", stripEmoji]] });
 *
 * // Rewrites what the voice says only.
 * const tts = new CartesiaTTSService({ textTransforms: [["*", stripMarkdown]] });
 * ```
 */
export class LLMTextProcessor extends FrameProcessor {
  protected _textAggregator: BaseTextAggregator;
  protected _textTransforms: Array<[TextType | string, TextTransform]>;
  protected _skipTts: boolean | null = null;

  /** Initialize the LLM text processor. */
  constructor(options: LLMTextProcessorOptions = {}) {
    super(options);
    this._textAggregator = options.textAggregator ?? new SimpleTextAggregator();
    this._textTransforms = options.textTransforms ?? [];
    this._skipTts = null;
  }

  /**
   * Transform aggregated text of a specific type.
   *
   * @param transformFunction The function to apply. It takes the text and its
   *   type and returns the transformed text, e.g.
   *   `async (text: string, textType: string) => string`.
   * @param textType The type of text to transform. Defaults to "*", every type.
   */
  addTextTransformer(transformFunction: TextTransform, textType: TextType | string = "*"): void {
    this._textTransforms.push([textType, transformFunction]);
  }

  /**
   * Remove a text transformer for a specific text type.
   *
   * @param transformFunction The function to remove.
   * @param textType The type of text the transformer was registered for.
   */
  removeTextTransformer(transformFunction: TextTransform, textType: TextType | string = "*"): void {
    this._textTransforms = this._textTransforms.filter(
      ([transformType, func]) => !(transformType === textType && func === transformFunction),
    );
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
    } else if (frame instanceof TTSStoppedFrame) {
      // A speech-to-speech service stops its speech before it ends the
      // response. The text still held was spoken, so it goes out ahead of
      // the stop: text behind it would reach the output transport after
      // the bot stopped speaking.
      await this._handleLlmEnd(this._skipTts);
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
    this._skipTts = inFrame.skipTts;
    for await (const aggregation of this._textAggregator.aggregate(inFrame.text)) {
      const outFrame = await this._aggregatedTextFrame(aggregation);
      if (outFrame) {
        outFrame.appendToContext = true;
        outFrame.skipTts = inFrame.skipTts;
        await this.pushFrame(outFrame);
      }
    }
  }

  protected async _handleLlmEnd(skipTts: boolean | null = null): Promise<void> {
    // Flush any remaining text
    const remaining = await this._textAggregator.flush();
    if (remaining) {
      const outFrame = await this._aggregatedTextFrame(remaining);
      if (outFrame) {
        outFrame.skipTts = skipTts;
        await this.pushFrame(outFrame);
      }
    }
  }

  /** Build the frame for an aggregation, or null when a registered transform dropped it. */
  protected async _aggregatedTextFrame(
    aggregation: Aggregation,
  ): Promise<AggregatedTextFrame | null> {
    const text = await this._transformText(aggregation.text, aggregation.type);
    if (text === null) {
      return null;
    }
    return new AggregatedTextFrame({
      text,
      textType: aggregation.type,
      rawText: LLMTextProcessor._rawText(aggregation, text),
    });
  }

  /**
   * Run the transforms registered for `textType` on the text.
   *
   * @returns The transformed text, or null when it should be dropped: a
   *   transform left nothing but whitespace, or one failed.
   */
  protected async _transformText(
    text: string,
    textType: TextType | string,
  ): Promise<string | null> {
    let transformedText = text;
    try {
      for (const [transformType, transform] of this._textTransforms) {
        if (transformType === textType || transformType === "*") {
          transformedText = await transform(transformedText, textType);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      // The failure came from the application's transform. Passing the text on
      // untransformed isn't safe, as a transform may exist to remove something,
      // so the aggregation is dropped.
      await this.pushError(
        `Error transforming LLM text [${transformedText}]: ${e instanceof Error ? e.message : String(e)}`,
        { exception: e, category: ErrorCategory.APPLICATION },
      );
      return null;
    }
    if (transformedText !== text && !transformedText.trim()) {
      return null;
    }
    return transformedText;
  }

  /** The text the context records: a pattern match keeps its delimiters. */
  protected static _rawText(aggregation: Aggregation, text: string): string {
    if (!(aggregation instanceof PatternMatch)) {
      return text;
    }
    if (text === aggregation.text) {
      return aggregation.fullMatch;
    }
    // Splice the rewritten content back between the delimiters. The content is
    // the first occurrence of itself in the full match.
    const start = aggregation.fullMatch.indexOf(aggregation.text);
    if (start < 0) {
      return text;
    }
    const end = start + aggregation.text.length;
    return aggregation.fullMatch.slice(0, start) + text + aggregation.fullMatch.slice(end);
  }
}
