// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/word_timestamp_utils.py

/** Utilities for normalizing word-timestamp streams from TTS services. */

const TAG_RE = /<[^>]+>/g;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/**
 * Merge punctuation/space-only tokens into the preceding word.
 *
 * Some TTS services (e.g. Inworld) emit spaces and punctuation as separate
 * word-timestamp tokens rather than attaching them to the adjacent word.
 * This function collapses those tokens so downstream consumers always receive
 * words with trailing punctuation already attached — identical to the format
 * produced by ElevenLabs or Cartesia.
 *
 * A token is considered punct/space-only when its text contains no alphanumeric
 * characters after stripping XML/HTML tags. Such tokens are appended to the
 * preceding word's text and their timestamp is discarded (the preceding word's
 * timestamp is kept). Leading punct/space tokens with no preceding word are
 * silently discarded. Every output token is stripped of leading and trailing
 * whitespace (spaces, tabs, newlines).
 *
 * @param wordTimes Raw list of `[word, timestamp]` pairs from the TTS service.
 * @returns Merged list where every entry contains at least one alphanumeric
 *   character and has no leading or trailing whitespace.
 *
 * @example
 * mergePunctTokens([["questions", 1.0], [", ", 1.2], ["explain", 1.4]]);
 * // → [["questions,", 1.0], ["explain", 1.4]]
 */
export function mergePunctTokens(
  wordTimes: readonly (readonly [string, number])[],
): [string, number][] {
  const merged: [string, number][] = [];
  for (const [word, ts] of wordTimes) {
    const stripped = word.replace(TAG_RE, "");
    const hasAlnum = ALNUM_RE.test(stripped);
    if (!hasAlnum) {
      const last = merged[merged.length - 1];
      if (last) {
        const [prevWord, prevTs] = last;
        merged[merged.length - 1] = [prevWord + word, prevTs];
      }
      // else: leading punct/space with no preceding word → discard
    } else {
      merged.push([word, ts]);
    }
  }
  return merged.map(([word, ts]) => [word.trim(), ts]);
}
