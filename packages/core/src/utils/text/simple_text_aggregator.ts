// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/simple_text_aggregator.py

/**
 * Simple text aggregator for basic sentence-boundary text processing.
 *
 * This module provides a straightforward text aggregator that accumulates text
 * until it finds an end-of-sentence marker, making it suitable for basic TTS
 * text processing scenarios.
 */

import { matchEndofsentence, SENTENCE_ENDING_PUNCTUATION } from "../string.ts";
import {
  Aggregation,
  BaseTextAggregator,
  type BaseTextAggregatorOptions,
  TextType,
} from "./base_text_aggregator.ts";

/**
 * Track lookahead across chunks for early emission and a word-end retry.
 *
 * Clear boundaries can emit at the first character; unresolved ones wait for
 * a complete word. For example, "Hello. N" can emit without waiting for "Next ".
 * Waiting for word completion added up to 297 ms in our Anthropic sample.
 *
 * Unresolved boundaries retry only when the following word ends. In "Albert I.
 * Douglas", checking the partial word "Do" could mistake it for a sentence
 * starter and split after the initial.
 */
const _LookaheadState = {
  IDLE: 1,
  AWAITING_CHARACTER: 2,
  AWAITING_WORD: 3,
  IN_WORD: 4,
} as const;
type _LookaheadState = (typeof _LookaheadState)[keyof typeof _LookaheadState];

const SPACE_RE = /^\s+$/u;
const ALNUM_RE = /^[\p{L}\p{N}]+$/u;

/** Python `str.isspace()` for a single character. */
function isSpace(char: string): boolean {
  return SPACE_RE.test(char);
}

/** Python `str.isalnum()` for a single character. */
function isAlnum(char: string): boolean {
  return ALNUM_RE.test(char);
}

/** Python `str.strip(" ")`: strip only ASCII spaces. */
export function _stripSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start++;
  while (end > start && text[end - 1] === " ") end--;
  return text.slice(start, end);
}

export interface SimpleTextAggregatorOptions extends BaseTextAggregatorOptions {}

/**
 * Simple text aggregator that accumulates text until sentence boundaries.
 *
 * This aggregator provides basic functionality for accumulating text tokens
 * and releasing them when an end-of-sentence marker is detected. It's the
 * most straightforward implementation of text aggregation for TTS processing.
 */
export class SimpleTextAggregator extends BaseTextAggregator {
  protected _text: string;
  protected _lookaheadState: _LookaheadState;

  /**
   * Initialize the simple text aggregator.
   *
   * Creates an empty text buffer ready to begin accumulating text tokens.
   *
   * @param options Additional arguments passed to BaseTextAggregator (e.g. aggregationType).
   */
  constructor(options: SimpleTextAggregatorOptions = {}) {
    super(options);
    this._text = "";
    this._lookaheadState = _LookaheadState.IDLE;
  }

  /**
   * Get the currently aggregated text.
   *
   * @returns The text that has been accumulated in the buffer.
   */
  get text(): Aggregation {
    return new Aggregation({ text: _stripSpaces(this._text), type: TextType.SENTENCE });
  }

  /**
   * Aggregate text and yield completed aggregations.
   *
   * In SENTENCE mode, processes the input text character-by-character. When
   * sentence-ending punctuation is detected, it waits for non-whitespace
   * lookahead before calling the sentence tokenizer.
   *
   * In TOKEN mode, yields the text immediately without buffering.
   *
   * @param text Text to aggregate.
   * @returns Aggregation objects (sentences in SENTENCE mode, tokens in TOKEN mode).
   */
  async *aggregate(text: string): AsyncGenerator<Aggregation> {
    if (this._aggregationType === TextType.TOKEN) {
      if (text) {
        yield new Aggregation({ text, type: TextType.TOKEN });
      }
      return;
    }

    // Process text character by character
    for (const char of text) {
      this._text += char;

      // Check for sentence with lookahead
      const result = await this._checkSentenceWithLookahead(char);
      if (result) {
        yield result;
      }
    }
  }

  /**
   * Check a possible sentence ending using text that arrives after it.
   *
   * `char` is already appended to `this._text`. Punctuation starts a
   * candidate, but the tokenizer decides whether it actually ends a sentence:
   *
   * - `Hello.` or `Hello. `: keep buffering until meaningful text follows.
   * - `Hello. N`: check immediately and emit `Hello.`. In contrast,
   *   `Dr. N` and `$29.9` stay buffered as an abbreviation and a decimal.
   * - `...you and I. D`: if unresolved, retry when the word `Did` ends.
   *   Don't check intermediate prefixes: `Do` in `Albert I. Douglas`
   *   could be mistaken for a sentence starter.
   * - `...you and I. Did?`: the question mark ends the lookahead word and
   *   starts a new candidate. First check the earlier period without `?`;
   *   then wait for lookahead after `?`.
   *
   * A confirmed boundary emits only the prefix; the following text stays in
   * the buffer. After a word-end retry, stop checking that candidate even if
   * unresolved. At response end, `flush` returns any remaining text.
   *
   * Subclasses can call this via super for tag or pattern handling.
   *
   * @param char The character just appended to the aggregation buffer.
   * @returns Aggregation if a sentence boundary is confirmed, otherwise null.
   */
  protected async _checkSentenceWithLookahead(char: string): Promise<Aggregation | null> {
    const isPunctuation = SENTENCE_ENDING_PUNCTUATION.has(char);
    let result: Aggregation | null = null;

    // The state machine requests a check at the first lookahead character
    // or the following word's end, not at every character in between.
    if (this._advanceLookahead(char, { isPunctuation })) {
      // For "...I. Did?", check "...I. Did" for the earlier boundary.
      // Including "?" could make the terminal-punctuation fallback accept
      // the whole buffer. This temporary slice does not discard the "?".
      const candidate = isPunctuation ? this._text.slice(0, -char.length) : this._text;
      const eosMarker = matchEndofsentence(candidate, { language: this.language });
      if (eosMarker) {
        result = new Aggregation({
          text: _stripSpaces(this._text.slice(0, eosMarker)),
          type: TextType.SENTENCE,
        });
        // Keep the lookahead text for the next sentence ("N" in "Hello. N").
        this._text = this._text.slice(eosMarker);
        this._lookaheadState = _LookaheadState.IDLE;
      }
    }

    // A trailing "?" in "...I. Did?" needs its own lookahead, whether or not
    // the retry above found a boundary at the earlier period.
    if (isPunctuation) {
      this._lookaheadState = _LookaheadState.AWAITING_CHARACTER;
    }

    return result;
  }

  /**
   * Advance the pending candidate and decide whether to check its boundary.
   *
   * Check once at the first non-whitespace character, then once more when
   * the following word ends. Opening quotes or symbols do not start a word.
   *
   * If the first tokenizer check finds no boundary:
   *
   *     'I. '      -> AWAITING_CHARACTER
   *     'I. "'     -> AWAITING_WORD (check at the quote)
   *     'I. "D'    -> IN_WORD (no check)
   *     'I. "Did ' -> IDLE (retry at the word-ending space)
   *
   * The caller performs the tokenizer check when this method returns true.
   *
   * @param char The most recently appended character.
   * @param options.isPunctuation Whether the character is sentence-ending punctuation.
   * @returns Whether the buffered text is ready for a tokenizer check.
   */
  protected _advanceLookahead(char: string, options: { isPunctuation: boolean }): boolean {
    const { isPunctuation } = options;
    switch (this._lookaheadState) {
      case _LookaheadState.IDLE:
        return false;

      case _LookaheadState.AWAITING_CHARACTER:
        if (isSpace(char) || isPunctuation) {
          return false;
        }
        this._lookaheadState = isAlnum(char)
          ? _LookaheadState.IN_WORD
          : _LookaheadState.AWAITING_WORD;
        // Ordinary boundaries such as "Hello. N" can emit immediately.
        return true;

      case _LookaheadState.AWAITING_WORD:
        if (isAlnum(char)) {
          this._lookaheadState = _LookaheadState.IN_WORD;
        }
        return false;

      case _LookaheadState.IN_WORD:
        // Never retry at a partial prefix such as "Do" inside "Douglas".
        if (isSpace(char) || isPunctuation) {
          this._lookaheadState = _LookaheadState.IDLE;
          return true;
        }
        return false;
    }
    return false;
  }

  /**
   * Flush any remaining text in the buffer.
   *
   * Returns any text remaining in the buffer. This is called at the end
   * of a stream to ensure all text is processed. In TOKEN mode, returns
   * null since tokens are yielded immediately.
   *
   * @returns Any remaining text as a sentence, or null if buffer is empty or in TOKEN mode.
   */
  async flush(): Promise<Aggregation | null> {
    if (this._aggregationType === TextType.TOKEN) {
      return null;
    }

    if (this._text) {
      // Return whatever we have in the buffer
      const result = this._text;
      await this.reset();
      return new Aggregation({ text: _stripSpaces(result), type: TextType.SENTENCE });
    }
    return null;
  }

  /**
   * Handle interruptions by clearing the text buffer.
   *
   * Called when an interruption occurs in the processing pipeline,
   * discarding any partially accumulated text.
   */
  async handleInterruption(): Promise<void> {
    this._text = "";
    this._lookaheadState = _LookaheadState.IDLE;
  }

  /**
   * Clear the internally aggregated text.
   *
   * Resets the aggregator to its initial empty state, discarding
   * any accumulated text content.
   */
  async reset(): Promise<void> {
    this._text = "";
    this._lookaheadState = _LookaheadState.IDLE;
  }
}
