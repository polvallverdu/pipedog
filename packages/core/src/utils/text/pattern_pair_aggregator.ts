// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/pattern_pair_aggregator.py

/**
 * Pattern pair aggregator for processing structured content in streaming text.
 *
 * This module provides an aggregator that identifies and processes content between
 * pattern pairs (like XML tags or custom delimiters) in streaming text, with
 * support for custom handlers and configurable actions for when a pattern is found.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "../logger.ts";
import { longestTrailingPartialMatch } from "../string.ts";
import { Aggregation, TextType } from "./base_text_aggregator.ts";
import {
  SimpleTextAggregator,
  type SimpleTextAggregatorOptions,
} from "./simple_text_aggregator.ts";

/**
 * Actions to take when a pattern pair is matched.
 *
 * - `REMOVE`: The text along with its delimiters will be removed from the streaming text.
 *   Sentence aggregation will continue on as if this text did not exist.
 * - `KEEP`: The delimiters will be removed, but the content between them will be kept.
 *   Sentence aggregation will continue on with the internal text included.
 * - `AGGREGATE`: The delimiters will be removed and the content between will be treated
 *   as a separate aggregation. Any text before the start of the pattern will be
 *   returned early, whether or not a complete sentence was found. Then the pattern
 *   will be returned. Then the aggregation will continue on sentence matching after
 *   the closing delimiter is found. The content between the delimiters is not
 *   aggregated by sentence. It is aggregated as one single block of text.
 */
export const MatchAction = {
  REMOVE: "remove",
  KEEP: "keep",
  AGGREGATE: "aggregate",
} as const;
export type MatchAction = (typeof MatchAction)[keyof typeof MatchAction];

export interface PatternMatchOptions {
  /** The text content between the start and end patterns. */
  content: string;
  /**
   * The type of the matched pattern pair. It should be representative of the
   * content type (e.g., 'sentence', 'code', 'speaker', 'custom').
   */
  type: string;
  /** The complete text including start and end patterns. */
  fullMatch: string;
}

/**
 * Represents a matched pattern pair with its content.
 *
 * A PatternMatch object is created when a complete pattern pair is found
 * in the text. It contains information about which pattern was matched,
 * the full matched text (including start and end patterns), and the
 * content between the patterns.
 */
export class PatternMatch extends Aggregation {
  fullMatch: string;

  /** Initialize a pattern match. */
  constructor(options: PatternMatchOptions) {
    super({ text: options.content, type: options.type });
    this.fullMatch = options.fullMatch;
  }

  /**
   * Return a string representation of the pattern match.
   *
   * @returns A descriptive string showing the pattern type and content.
   */
  override toString(): string {
    return `PatternMatch(type=${this.type}, text=${this.text}, full_match=${this.fullMatch})`;
  }
}

/** A registered pattern pair. */
interface PatternInfo {
  start: string;
  end: string;
  type: string;
  action: MatchAction;
}

/** Handler called when a pattern pair is matched. */
export type PatternMatchHandler = (match: PatternMatch) => Promise<void> | void;

/** Python `re.escape`. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Python `str.count`: non-overlapping occurrences of `sub` in `text`. */
function countOccurrences(text: string, sub: string): number {
  if (!sub) return text.length + 1;
  let count = 0;
  let index = text.indexOf(sub);
  while (index !== -1) {
    count++;
    index = text.indexOf(sub, index + sub.length);
  }
  return count;
}

function patternRegex(start: string, end: string): RegExp {
  // The .*? is non-greedy to handle nested patterns
  return new RegExp(`${escapeRegex(start)}(.*?)${escapeRegex(end)}`, "gs");
}

export interface PatternPairAggregatorOptions extends SimpleTextAggregatorOptions {}

/**
 * Aggregator that identifies and processes content between pattern pairs.
 *
 * This aggregator buffers text until it can identify complete pattern pairs
 * (defined by start and end patterns), processes the content between these
 * patterns using registered handlers. By default, its aggregation method
 * returns text at sentence boundaries, and remove the content found between
 * any matched patterns. However, matched patterns can also be configured to
 * returned as a separate aggregation object containing the content between
 * their start and end patterns or left in, so that only the delimiters are
 * removed and a callback can be triggered.
 *
 * This aggregator is particularly useful for processing structured content in
 * streaming text, such as XML tags, markdown formatting, or custom delimiters.
 *
 * The aggregator ensures that patterns spanning multiple text chunks are
 * correctly identified.
 */
export class PatternPairAggregator extends SimpleTextAggregator {
  protected _patterns = new Map<string, PatternInfo>();
  protected _handlers = new Map<string, PatternMatchHandler>();
  // Track where we last checked for complete patterns
  protected _lastProcessedPosition = 0;

  /**
   * Initialize the pattern pair aggregator.
   *
   * Creates an empty aggregator with no patterns or handlers registered.
   * Text buffering and pattern detection will begin when text is aggregated.
   *
   * @param options Additional arguments passed to SimpleTextAggregator (e.g. aggregationType).
   */
  constructor(options: PatternPairAggregatorOptions = {}) {
    super(options);
  }

  /**
   * Get the currently aggregated text.
   *
   * @returns The text that has been accumulated in the buffer.
   */
  override get text(): Aggregation {
    const patternStart = this._matchStartOfPattern(this._text);
    const strippedText = this._text.trim();
    const type = patternStart ? (patternStart[1].type ?? TextType.SENTENCE) : TextType.SENTENCE;
    return new Aggregation({ text: strippedText, type });
  }

  /**
   * Add a pattern pair to detect in the text.
   *
   * Registers a new pattern pair with a unique identifier. The aggregator
   * will look for text that starts with the start pattern and ends with
   * the end pattern, and treat the content between them as a match.
   *
   * @param type Identifier for this pattern pair. Should be unique and ideally descriptive.
   *   (e.g., 'code', 'speaker', 'custom'). type can not be 'sentence' or 'word' as
   *   those are reserved for the default behavior.
   * @param startPattern Pattern that marks the beginning of content.
   * @param endPattern Pattern that marks the end of content.
   * @param action What to do when a complete pattern is matched.
   *
   *   - `MatchAction.REMOVE`: Remove the matched pattern from the text.
   *   - `MatchAction.KEEP`: Keep the matched pattern in the text and treat it as
   *     normal text. This allows you to register handlers for the pattern without
   *     affecting the aggregation logic.
   *   - `MatchAction.AGGREGATE`: Return the matched pattern as a separate aggregation object.
   * @returns Self for method chaining.
   * @throws Error If `type` is reserved (upstream: ValueError).
   */
  addPattern(
    type: string,
    startPattern: string,
    endPattern: string,
    action: MatchAction = MatchAction.REMOVE,
  ): this {
    if (type === TextType.SENTENCE || type === TextType.WORD || type === TextType.TOKEN) {
      throw new Error(
        `The text type '${type}' is reserved for default behavior and can not be used for custom patterns.`,
      );
    }
    this._patterns.set(type, { start: startPattern, end: endPattern, type, action });
    return this;
  }

  /**
   * Register a handler for when a pattern pair is matched.
   *
   * The handler will be called whenever a complete match for the
   * specified type is found in the text.
   *
   * @param type The type of the pattern pair to trigger the handler.
   * @param handler Async function to call when pattern is matched.
   *   The function should accept a PatternMatch object.
   * @returns Self for method chaining.
   */
  onPatternMatch(type: string, handler: PatternMatchHandler): this {
    this._handlers.set(type, handler);
    return this;
  }

  /**
   * Process newly complete pattern pairs in the text.
   *
   * Searches for pattern pairs that have been completed since lastProcessedPosition,
   * calls the appropriate handlers, and optionally removes the matches.
   *
   * @param text The text to process for pattern matches.
   * @param lastProcessedPosition The position in text that was already processed.
   *   Only patterns that end at or after this position will be processed.
   * @returns Tuple of [allMatches, processedText] where:
   *
   *   - allMatches is a list of all pattern matches found. Note: There really should only ever be 1.
   *   - processedText is the text after processing patterns. If no patterns are
   *     found, it will be the same as input text.
   */
  protected async _processCompletePatterns(
    text: string,
    lastProcessedPosition = 0,
  ): Promise<[PatternMatch[], string]> {
    const allMatches: PatternMatch[] = [];
    let processedText = text;

    for (const [type, patternInfo] of this._patterns) {
      const action = patternInfo.action;

      // Create regex to match from start pattern to end pattern, and find all
      // matches (converted to a list for safe iteration).
      const matches = [...processedText.matchAll(patternRegex(patternInfo.start, patternInfo.end))];

      for (const match of matches) {
        const content = match[1] as string; // Content between patterns
        const fullMatch = match[0]; // Full match including patterns

        // Create pattern match object
        const patternMatch = new PatternMatch({ content: content.trim(), type, fullMatch });

        // Check if this pattern was already processed
        const alreadyProcessed = (match.index ?? 0) + fullMatch.length <= lastProcessedPosition;

        // Only call handler for newly completed patterns
        const handler = this._handlers.get(type);
        if (!alreadyProcessed && handler) {
          try {
            await handler(patternMatch);
          } catch (e) {
            rethrowIfCancelled(e);
            logger.error(
              `Error in pattern handler for ${type}: ${e instanceof Error ? e.message : e}`,
            );
          }
        }

        // Handle pattern based on action
        if (action === MatchAction.REMOVE) {
          // Remove patterns are only removed once (when newly completed)
          if (!alreadyProcessed) {
            processedText = processedText.replace(fullMatch, () => "");
          }
        } else {
          // KEEP/AGGREGATE patterns stay in allMatches
          allMatches.push(patternMatch);
        }
      }
    }

    return [allMatches, processedText];
  }

  /**
   * Check if text contains incomplete pattern pairs.
   *
   * Determines whether the text contains any start patterns without
   * matching end patterns, which would indicate incomplete content.
   *
   * @param text The text to check for incomplete patterns.
   * @returns A tuple of [startIndex, patternInfo] if an incomplete pattern is found,
   *   or null if no patterns are found or all patterns are complete.
   */
  protected _matchStartOfPattern(text: string): [number, PatternInfo] | null {
    for (const patternInfo of this._patterns.values()) {
      const start = patternInfo.start;
      const end = patternInfo.end;

      // Count occurrences
      const startCount = countOccurrences(text, start);
      const endCount = countOccurrences(text, end);

      // If there are more starts than ends, we have incomplete patterns
      // Again, this is written generically but there only ever should
      // be one pattern active at a time, so the counts should be 0 or 1.
      // Which is why we base the return on the first found.
      if (startCount > endCount) {
        const startIndex = text.indexOf(start);
        return [startIndex, patternInfo];
      }
    }

    return null;
  }

  /**
   * Aggregate text and process pattern pairs.
   *
   * Processes the input text character-by-character, handles pattern pairs,
   * and uses the parent's lookahead logic for sentence detection when no
   * patterns are active.
   *
   * In TOKEN mode, pattern detection still works but non-pattern text is
   * yielded as TOKEN aggregations instead of waiting for sentence boundaries.
   * Text ending in a partial start delimiter (e.g. `<thin` of `<think>`) is
   * held back until a later chunk determines whether it begins a pattern, so
   * a delimiter split across chunks is still recognized.
   *
   * @param text Text to aggregate.
   * @returns PatternMatch objects as patterns complete or sentences are detected.
   */
  override async *aggregate(text: string): AsyncGenerator<PatternMatch> {
    // Process text character by character
    for (const char of text) {
      this._text += char;

      // Process any newly complete patterns in the buffer
      // Only patterns that complete after _lastProcessedPosition will trigger handlers
      const [patterns, processedText] = await this._processCompletePatterns(
        this._text,
        this._lastProcessedPosition,
      );

      // Update the last processed position to prevent re-processing patterns
      // This tracks where in the buffer we've already called handlers, so we
      // only trigger handlers once when a pattern completes
      this._lastProcessedPosition = this._text.length;

      this._text = processedText;

      if (patterns.length > 0) {
        const first = patterns[0] as PatternMatch;
        if (patterns.length > 1) {
          logger.warning(
            `Multiple patterns matched: ${JSON.stringify(patterns.map((p) => p.type))}. Only the first pattern will be returned.`,
          );
        }
        // If the pattern found is set to be aggregated, return it
        const action = this._patterns.get(first.type)?.action ?? MatchAction.REMOVE;
        if (action === MatchAction.AGGREGATE) {
          this._text = "";
          yield first;
          continue;
        }
      }

      // Check if we have incomplete patterns
      const patternStart = this._matchStartOfPattern(this._text);
      if (patternStart !== null) {
        // If the start pattern is at the beginning or should not be separately aggregated, continue
        if (
          patternStart[0] === 0 ||
          (patternStart[1].action ?? MatchAction.REMOVE) !== MatchAction.AGGREGATE
        ) {
          continue;
        }
        // For AGGREGATE patterns: yield any text before the pattern starts
        // This ensures text doesn't get stuck in the buffer waiting for sentence
        // boundaries when a pattern begins (e.g., "Here is code <code>..." yields "Here is code")
        const result = this._text.slice(0, patternStart[0]);
        this._text = this._text.slice(patternStart[0]);
        const aggType =
          this._aggregationType === TextType.TOKEN ? TextType.TOKEN : TextType.SENTENCE;
        yield new PatternMatch({ content: result.trim(), type: aggType, fullMatch: result });
        continue;
      }

      if (this._aggregationType !== TextType.TOKEN) {
        // Use parent's lookahead logic for sentence detection
        const aggregation = await super._checkSentenceWithLookahead(char);
        if (aggregation) {
          // Convert to PatternMatch for consistency with return type
          yield new PatternMatch({
            content: aggregation.text,
            type: aggregation.type,
            fullMatch: aggregation.text,
          });
        }
      }
    }

    // In TOKEN mode, yield any accumulated text after processing all chars,
    // but only if there's no incomplete pattern being buffered. A trailing
    // partial start delimiter (e.g. "<thin" of "<think>") is held back so a
    // delimiter split across chunks isn't leaked as plain text; it's
    // retained in the buffer to be completed by the next chunk.
    if (this._aggregationType === TextType.TOKEN && this._text) {
      if (this._matchStartOfPattern(this._text) === null) {
        const heldBack = longestTrailingPartialMatch(
          this._text,
          [...this._patterns.values()].map((pattern) => pattern.start),
        );
        const yieldLength = this._text.length - heldBack;
        if (yieldLength > 0) {
          const content = this._text.slice(0, yieldLength);
          this._text = this._text.slice(yieldLength);
          this._lastProcessedPosition = this._text.length;
          yield new PatternMatch({ content, type: TextType.TOKEN, fullMatch: content });
        }
      }
    }
  }

  /**
   * Flush any remaining text in the buffer.
   *
   * Degrades incomplete pattern state the same way a closed pair's
   * action would, without knowing whether the pair would ever have
   * closed:
   *
   * - REMOVE and AGGREGATE: an unclosed start delimiter and everything
   *   from it onward is dropped (their content is either stripped or
   *   treated as a side channel once closed, so it's never spoken
   *   incomplete). The pattern handler is not invoked. Text before the
   *   earliest such unclosed start delimiter is kept.
   * - KEEP: a closed KEEP pair is spoken verbatim, delimiters included
   *   (see `aggregate`), so an unclosed one degrades to the same
   *   thing rather than being dropped.
   *
   * If the buffer ends with a proper prefix of a REMOVE/AGGREGATE start
   * delimiter (the stream cut off mid-delimiter), that trailing partial
   * text is trimmed too. This accepts an inherent ambiguity: a legitimate
   * trailing character sequence that happens to match a delimiter prefix
   * (e.g. a stray `<`) is trimmed the same way.
   *
   * @returns Any remaining text with incomplete REMOVE/AGGREGATE pattern
   *   content dropped, or null if there is nothing left to return.
   */
  override async flush(): Promise<Aggregation | null> {
    const cutIndex = this._findEarliestDroppableStart(this._text);
    let resultText = cutIndex === null ? this._text : this._text.slice(0, cutIndex);
    resultText = this._trimTrailingPartialStart(resultText);

    await this.reset();

    const stripped = resultText.trim();
    if (!stripped) {
      return null;
    }
    const aggType = this._aggregationType === TextType.TOKEN ? TextType.TOKEN : TextType.SENTENCE;
    return new PatternMatch({ content: stripped, type: aggType, fullMatch: resultText });
  }

  /**
   * Find the earliest unmatched start delimiter that flush() should cut at.
   *
   * For each registered pattern, replicates the same left-to-right,
   * non-overlapping pairing that `_processCompletePatterns` uses
   * (earliest start paired with earliest following end) to determine
   * which start-delimiter occurrences are still unmatched. Only
   * REMOVE/AGGREGATE patterns' unmatched starts are candidates: KEEP
   * patterns are excluded because unclosed KEEP content is kept, not cut.
   *
   * @param text The buffered text to scan.
   * @returns The index of the earliest droppable unmatched start delimiter,
   *   or null if there isn't one.
   */
  protected _findEarliestDroppableStart(text: string): number | null {
    let earliest: number | null = null;

    for (const patternInfo of this._patterns.values()) {
      if ((patternInfo.action ?? MatchAction.REMOVE) === MatchAction.KEEP) {
        continue;
      }

      const start = patternInfo.start;
      const matchedSpans: [number, number][] = [
        ...text.matchAll(patternRegex(start, patternInfo.end)),
      ].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);

      let searchFrom = 0;
      while (true) {
        const index = text.indexOf(start, searchFrom);
        if (index === -1) {
          break;
        }

        const span = matchedSpans.find((s) => s[0] <= index && index < s[1]);
        if (span !== undefined) {
          // This occurrence belongs to a completed match; skip past
          // it entirely so a start nested inside its content isn't
          // mistaken for an unmatched one.
          searchFrom = span[1];
          continue;
        }

        if (earliest === null || index < earliest) {
          earliest = index;
        }
        break;
      }
    }

    return earliest;
  }

  /**
   * Trim a trailing partial REMOVE/AGGREGATE start delimiter, if any.
   *
   * The stream can end mid-delimiter (e.g. buffered text ending in
   * `<te` of `<test>`). That partial text isn't a complete start
   * delimiter, so `_findEarliestDroppableStart` won't catch it,
   * but it also isn't safe to speak. KEEP patterns are excluded since a
   * KEEP delimiter is kept whether or not it's complete.
   *
   * @param text The text to check for a trailing partial delimiter.
   * @returns The text with a trailing partial start delimiter removed, or the
   *   original text if there isn't one.
   */
  protected _trimTrailingPartialStart(text: string): string {
    let maxTrim = 0;

    for (const patternInfo of this._patterns.values()) {
      if ((patternInfo.action ?? MatchAction.REMOVE) === MatchAction.KEEP) {
        continue;
      }

      const start = patternInfo.start;
      for (let length = Math.min(start.length - 1, text.length); length > 0; length--) {
        if (text.endsWith(start.slice(0, length))) {
          maxTrim = Math.max(maxTrim, length);
          break;
        }
      }
    }

    return maxTrim ? text.slice(0, -maxTrim) : text;
  }

  /**
   * Handle interruptions by clearing the buffer and pattern state.
   *
   * Called when an interruption occurs in the processing pipeline,
   * to reset the state and discard any partially aggregated text.
   */
  override async handleInterruption(): Promise<void> {
    await super.handleInterruption();
    this._lastProcessedPosition = 0;
    // Pattern and handler state persists across interruptions
  }

  /**
   * Clear the internally aggregated text.
   *
   * Resets the aggregator to its initial state, discarding any
   * buffered text and clearing pattern tracking state.
   */
  override async reset(): Promise<void> {
    await super.reset();
    this._lastProcessedPosition = 0;
    // Pattern and handler state persists across resets
  }
}
