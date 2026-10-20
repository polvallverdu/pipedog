// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/markup_utils.py

/**
 * Shared XML/SSML markup utilities for text matching and cursor advancement.
 *
 * Two notions of "what is markup" live here, and they differ on a single point
 * -- a `'<'` with no later `'>'`:
 *
 * - `stripMarkup` treats it as an open tag and swallows the rest of the
 *   string. Correct for a *fragment* that may have been cut mid-tag, such as a
 *   single token from a TTS word-timestamp stream.
 * - `stripCompleteMarkup` treats it as content. Correct for a *complete*
 *   text, where a lone `'<'` is real (`"5 < 10"`, `"<3"`).
 *
 * Every markup decision in the word-timestamp path routes through one of the
 * two, so the callers can't disagree about which characters are a tag.
 *
 * Positions are UTF-16 code unit offsets, as everywhere in JavaScript.
 */

/**
 * Yield `[rawIndex, char]` for each character of `text` outside markup.
 *
 * The fragment-tolerant definition of markup -- anything between '<' and '>',
 * syntax-based and tag-name independent -- shared by `stripMarkup` and
 * `rawOffsetAfterCleanChars` so the two can't disagree. An unclosed '<'
 * swallows the rest of the string.
 */
function* iterCleanChars(text: string): Generator<[number, string]> {
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inTag) {
      if (ch === ">") {
        inTag = false;
      }
    } else if (ch === "<") {
      inTag = true;
    } else {
      yield [i, ch];
    }
  }
}

/**
 * Remove XML/SSML-like markup from a possibly-truncated text fragment.
 *
 * Syntax-based, not tag-name based: treats anything between '<' and '>' as
 * markup and preserves text outside it. An unclosed '<' swallows the rest of
 * `text`, matching how a raw word-timestamp token can arrive mid-tag.
 *
 * For a *complete* text, use `stripCompleteMarkup` instead.
 *
 * Used by `TextSegmentMap` to match a word against a segment, where the
 * incoming word may be a fragment of a still-open tag.
 */
export function stripMarkup(text: string): string {
  let out = "";
  for (const [, ch] of iterCleanChars(text)) out += ch;
  return out;
}

/**
 * Matched '<...>' pairs in a complete text.
 *
 * The definition of markup for a static text, shared by `stripCompleteMarkup`
 * and `splitMarkupRuns` so the two can't disagree about which characters a
 * segment split may treat as a tag.
 */
const COMPLETE_MARKUP_RE = /<[^>]+>/g;

/**
 * Remove well-formed '<...>' markup from a complete, static text.
 *
 * Unlike `stripMarkup`, only strips matched '<...>' pairs -- a lone '<' with
 * no later '>' is left in place as real content rather than swallowing the
 * rest of `text`, since there is no streamed fragment here that could be
 * mid-tag.
 *
 * Used by `TextSegment.isTransformed`, by `alnumOnly`, and by
 * `WordCompletionTracker` to default `userFacingText` to a tag-free string.
 */
export function stripCompleteMarkup(text: string): string {
  return text.replace(COMPLETE_MARKUP_RE, "");
}

/**
 * Return the raw offset into `text` just past its `n`-th markup-stripped char.
 *
 * Inverse of `stripMarkup` for a prefix: where `stripMarkup` collects every
 * non-markup char, this finds the raw index one past the `n`-th of them --
 * converting a match measured in markup-stripped space back to a raw offset.
 * Returns `text.length` when `text` has fewer than `n` non-markup chars.
 */
export function rawOffsetAfterCleanChars(text: string, n: number): number {
  if (n <= 0) {
    return 0;
  }
  let seen = 0;
  for (const [i] of iterCleanChars(text)) {
    seen += 1;
    if (seen === n) {
      return i + 1;
    }
  }
  return text.length;
}

/**
 * Split `text` into alternating runs of tagged and untagged words.
 *
 * A word is considered tagged if it overlaps a complete `'<...>'` pair. A lone
 * `'<'` is treated as content, not as the start of a tag (see
 * `stripCompleteMarkup`). Consecutive words with the same classification form
 * a single run, so whitespace inside a tag such as `<phoneme alphabet="ipa">`
 * never splits the words it spans across runs.
 *
 * Text with no markup yields a single run, unchanged.
 *
 * Used by `TextSegmentMap` when it builds its segments, to give a tag one of
 * its own.
 *
 * @example
 * splitMarkupRuns("I love to count <spell>1234</spell>.");
 * // -> ["I love to count ", "<spell>1234</spell>."]
 */
export function splitMarkupRuns(text: string): string[] {
  const tagSpans: [number, number][] = [];
  for (const m of text.matchAll(COMPLETE_MARKUP_RE)) {
    tagSpans.push([m.index, m.index + m[0].length]);
  }
  if (tagSpans.length === 0) {
    return text ? [text] : [];
  }

  const runs: string[] = [];
  let runIsTagged: boolean | null = null;
  let pos = 0;

  for (const token of text.split(/(\s+)/)) {
    if (!token) {
      continue;
    }
    const start = pos;
    const end = pos + token.length;
    pos = end;
    const isTagged = tagSpans.some(([tagStart, tagEnd]) => tagStart < end && start < tagEnd);
    if (isTagged === runIsTagged) {
      runs[runs.length - 1] += token;
    } else {
      runs.push(token);
      runIsTagged = isTagged;
    }
  }

  return runs;
}
