// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/base_text_aggregator.py

/**
 * Base text aggregator interface for Pipecat text processing.
 *
 * This module defines the abstract base class for text aggregators that
 * accumulate and process text tokens, typically used by TTS services to
 * determine when aggregated text should be sent for speech synthesis.
 *
 * The deprecated `AggregationType` alias of `TextType` is not ported.
 */

import { resolveSentenceTokenizerLanguage } from "../string.ts";

/**
 * Built-in text types.
 *
 * `BACKCHANNEL` is a short acknowledgment the bot says while the user talks,
 * such as "Mm-hmm.". Text can also have a type of its own, such as `"code"`.
 *
 * `EXPRESSION_SOUND` and `EXPRESSION_PAUSE` are part of expressive
 * conversation (alpha): a sound or a silence an LLM writes into its reply,
 * which isn't spoken as words. The text is the sound's name, as written in
 * its tag, or the pause's duration in milliseconds.
 */
export const TextType = {
  BACKCHANNEL: "backchannel",
  EXPRESSION_SOUND: "expression_sound",
  EXPRESSION_PAUSE: "expression_pause",
  SENTENCE: "sentence",
  TOKEN: "token",
  WORD: "word",
} as const;
export type TextType = (typeof TextType)[keyof typeof TextType];

const TEXT_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(TextType));

export interface AggregationOptions {
  /** The aggregated text content. */
  text: string;
  /**
   * What the text represents: a `TextType` such as a sentence or a word, or a
   * custom type such as `"code"`.
   */
  type: string;
}

/**
 * Data class representing aggregated text and its type.
 *
 * An Aggregation object is created whenever a stream of text is aggregated by
 * a text aggregator. It contains the aggregated text and a type saying what
 * the text represents.
 *
 * - `text`: The aggregated text content.
 * - `type`: What the text represents: a `TextType` such as a sentence or
 *   a word, or a custom type such as `"code"`.
 */
export class Aggregation {
  text: string;
  type: string;

  constructor(options: AggregationOptions) {
    this.text = options.text;
    this.type = options.type;
  }

  /**
   * Return a string representation of the aggregation.
   *
   * @returns A descriptive string showing the type and text of the aggregation.
   */
  toString(): string {
    return `Aggregation by ${this.type}: ${this.text}`;
  }
}

export interface BaseTextAggregatorOptions {
  /**
   * The aggregation strategy to use. SENTENCE buffers text until sentence
   * boundaries are detected, TOKEN passes text through immediately, and WORD
   * buffers until word boundaries.
   */
  aggregationType?: TextType;
  /** Language code for sentence detection. */
  language?: string | null;
}

/**
 * Base class for text aggregators in the Pipecat framework.
 *
 * Text aggregators are usually used by the TTS service to aggregate LLM tokens
 * and decide when the aggregated text should be pushed to the TTS service.
 *
 * Text aggregators can also be used to manipulate text while it's being
 * aggregated (e.g. reasoning blocks can be removed).
 *
 * Subclasses must implement all abstract methods to define specific aggregation
 * logic, text manipulation behavior, and state management for interruptions.
 */
export abstract class BaseTextAggregator {
  protected _aggregationType: TextType;
  protected _language: string;

  /**
   * Initialize the base text aggregator.
   *
   * @throws Error If `aggregationType` is not a `TextType` (upstream: ValueError).
   */
  constructor(options: BaseTextAggregatorOptions = {}) {
    const aggregationType = options.aggregationType ?? TextType.SENTENCE;
    if (!TEXT_TYPE_VALUES.has(aggregationType)) {
      throw new Error(`'${aggregationType}' is not a valid TextType`);
    }
    this._aggregationType = aggregationType;
    this._language = resolveSentenceTokenizerLanguage(options.language ?? null);
  }

  /** The normalized language code used for sentence detection. */
  get language(): string {
    return this._language;
  }

  /**
   * Select a sentence tokenizer without discarding buffered text.
   *
   * @param language Language code. Call between generations to keep one
   *   language for all text within a generation.
   */
  setLanguage(language: string | null): void {
    this._language = resolveSentenceTokenizerLanguage(language);
  }

  /** The aggregation type for this aggregator. */
  get aggregationType(): TextType {
    return this._aggregationType;
  }

  /**
   * The currently aggregated text.
   *
   * Subclasses must implement this property to return the text that has
   * been accumulated so far in their internal buffer or storage.
   */
  abstract get text(): Aggregation;

  /**
   * Aggregate the specified text and yield completed aggregations.
   *
   * This method processes the input text character-by-character internally
   * and yields Aggregation objects as they complete.
   *
   * Subclasses should implement their specific logic for:
   *
   * - How to process text character-by-character
   * - When to consider the aggregated text ready for processing
   * - What criteria determine text completion (e.g., sentence boundaries)
   * - When a completion occurs, yield an Aggregation object containing the
   *   aggregated text (stripped of leading/trailing whitespace) and its type
   *
   * @param text The text to be aggregated.
   * @returns An async iterable of Aggregation objects as they complete. Each
   *   Aggregation consists of the aggregated text (stripped of
   *   leading/trailing whitespace) and a type saying what it represents: a
   *   `TextType` such as a sentence or a word, or a custom type such as
   *   `"code"`.
   */
  abstract aggregate(text: string): AsyncIterable<Aggregation>;

  /**
   * Flush any pending aggregation.
   *
   * This method is called at the end of a stream (e.g., when receiving
   * LLMFullResponseEndFrame) to return any text that was buffered.
   *
   * @returns An Aggregation object if there is pending text, or null if there
   *   is no pending text.
   */
  abstract flush(): Promise<Aggregation | null>;

  /**
   * Handle interruptions in the text aggregation process.
   *
   * When an interruption occurs it is possible that we might want to discard
   * the aggregated text or do some internal modifications to the aggregated text.
   *
   * Subclasses should implement this method to define how they respond to
   * interruptions, such as clearing buffers, resetting state, or preserving
   * partial content.
   */
  abstract handleInterruption(): Promise<void>;

  /**
   * Clear the internally aggregated text and reset to initial state.
   *
   * Subclasses should implement this method to return the aggregator to its
   * initial state, discarding any previously accumulated text content and
   * resetting any internal tracking variables.
   */
  abstract reset(): Promise<void>;
}
