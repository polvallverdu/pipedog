// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/skip_tags_aggregator.py

/**
 * Skip tags aggregator for preventing sentence boundaries within tagged content.
 *
 * This module provides a text aggregator that prevents end-of-sentence matching
 * between specified start/end tag pairs, ensuring that tagged content is processed
 * as a unit regardless of internal punctuation.
 */

import { longestTrailingPartialMatch, parseStartEndTags, type StartEndTags } from "../string.ts";
import { Aggregation, TextType } from "./base_text_aggregator.ts";
import {
  SimpleTextAggregator,
  type SimpleTextAggregatorOptions,
} from "./simple_text_aggregator.ts";

export interface SkipTagsAggregatorOptions extends SimpleTextAggregatorOptions {
  /**
   * Sequence of StartEndTags defining the tag pairs that should prevent
   * sentence boundary detection.
   */
  tags: readonly StartEndTags[];
}

/**
 * Aggregator that prevents end of sentence matching between start/end tags.
 *
 * This aggregator buffers text until it finds an end of sentence or a start
 * tag. If a start tag is found the aggregator will keep aggregating text
 * unconditionally until the corresponding end tag is found. It's particularly
 * useful for processing content with custom delimiters that should prevent
 * text from being considered for end of sentence matching.
 *
 * The aggregator ensures that tags spanning multiple text chunks are correctly
 * identified and that content within tags is never split at sentence boundaries.
 */
export class SkipTagsAggregator extends SimpleTextAggregator {
  protected _tags: readonly StartEndTags[];
  protected _currentTag: StartEndTags | null;
  protected _currentTagIndex: number;

  /**
   * Initialize the skip tags aggregator.
   *
   * @param options.tags Tag pairs that should prevent sentence boundary detection.
   *   Other options are passed to SimpleTextAggregator (e.g. aggregationType).
   */
  constructor(options: SkipTagsAggregatorOptions) {
    super(options);
    this._tags = options.tags;
    this._currentTag = null;
    this._currentTagIndex = 0;
  }

  /**
   * Aggregate text while respecting tag boundaries.
   *
   * Processes the input text character-by-character, updates tag state, and
   * uses the parent's lookahead logic for sentence detection when not
   * inside tags.
   *
   * In TOKEN mode, text is passed through immediately unless we're inside
   * a tag, in which case we buffer until the closing tag is found. Text
   * ending in a partial start tag (e.g. `<spe` of `<spell>`) is held
   * back until a later chunk determines whether it begins a tag, so a tag
   * split across chunks is still recognized.
   *
   * @param text Text to aggregate.
   * @returns Aggregation objects containing text up to a sentence boundary,
   *   marked as SENTENCE type (or TOKEN type in TOKEN mode).
   */
  override async *aggregate(text: string): AsyncGenerator<Aggregation> {
    if (this._aggregationType === TextType.TOKEN) {
      // In TOKEN mode, process chars for tag tracking but yield the
      // full input as a single token when not inside a tag.
      for (const char of text) {
        this._text += char;

        // Update tag state
        [this._currentTag, this._currentTagIndex] = parseStartEndTags(
          this._text,
          this._tags,
          this._currentTag,
          this._currentTagIndex,
        );
      }

      // After processing all chars: if not inside a tag, yield accumulated text.
      // A trailing partial start tag (e.g. "<spe" of "<spell>") is held back
      // so a tag split across chunks isn't leaked as plain text; it's retained
      // in the buffer to be completed by the next chunk. The tag-scan index
      // resets to 0 so the retained partial tag is rescanned once complete.
      if (!this._currentTag && this._text) {
        const heldBack = longestTrailingPartialMatch(
          this._text,
          this._tags.map(([start]) => start),
        );
        const yieldLength = this._text.length - heldBack;
        if (yieldLength > 0) {
          const content = this._text.slice(0, yieldLength);
          this._text = this._text.slice(yieldLength);
          this._currentTagIndex = 0;
          yield new Aggregation({ text: content, type: TextType.TOKEN });
        }
      }
      return;
    }

    // Process text character by character
    for (const char of text) {
      this._text += char;

      // Update tag state
      [this._currentTag, this._currentTagIndex] = parseStartEndTags(
        this._text,
        this._tags,
        this._currentTag,
        this._currentTagIndex,
      );

      // If inside tags, don't check for sentences
      if (this._currentTag) {
        continue;
      }

      // Otherwise, use parent's lookahead logic for sentence detection
      const result = await super._checkSentenceWithLookahead(char);
      if (result) {
        yield result;
      }
    }
  }

  /**
   * Flush any remaining text in the buffer.
   *
   * In SENTENCE mode, returns the buffered text as-is: tags are
   * pass-through markers, so content is spoken whether or not a start
   * tag's closing tag ever arrived. In TOKEN mode, returns any text
   * still buffered behind an unclosed tag instead of discarding it.
   *
   * @returns Any remaining text, or null if the buffer is empty.
   */
  override async flush(): Promise<Aggregation | null> {
    if (this._aggregationType === TextType.TOKEN) {
      if (this._text) {
        const result = this._text;
        await this.reset();
        return new Aggregation({ text: result, type: TextType.TOKEN });
      }
      return null;
    }
    return await super.flush();
  }

  /**
   * Handle interruptions by clearing the buffer and tag state.
   *
   * Called when an interruption occurs in the processing pipeline,
   * to reset the state and discard any partially aggregated text.
   */
  override async handleInterruption(): Promise<void> {
    await super.handleInterruption();
    this._currentTag = null;
    this._currentTagIndex = 0;
  }

  /**
   * Clear the internally aggregated text and tag state.
   *
   * Resets the aggregator to its initial state, discarding any
   * buffered text.
   */
  override async reset(): Promise<void> {
    await super.reset();
    this._currentTag = null;
    this._currentTagIndex = 0;
  }
}
