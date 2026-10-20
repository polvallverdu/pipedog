// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_word_timestamp_tracker.py

/** Tests for WordTimestampTracker. */

import { expect, test } from "bun:test";

import {
  WordTimestamp,
  WordTimestampTracker,
} from "../src/utils/context/word_timestamp_tracker.ts";

const SECOND = 1_000_000_000;

function word(text: string, timestamp: number): WordTimestamp {
  return new WordTimestamp({
    word: text,
    timestamp,
    contextId: "ctx",
    includesInterFrameSpaces: false,
  });
}

test("test_words_are_timed_from_when_timing_starts", () => {
  // A word's PTS is the start time plus its time in the audio.
  const tracker = new WordTimestampTracker();
  expect(tracker.started).toBe(false);
  tracker.start(10 * SECOND);

  expect(tracker.started).toBe(true);
  expect(tracker.pts(0.5)).toBe(10 * SECOND + Math.floor(SECOND / 2));
});

test("test_timing_starts_after_the_last_word_if_it_is_later", () => {
  // Words of the next context come after the last word still to play.
  const tracker = new WordTimestampTracker();
  tracker.lastPts = 12 * SECOND;
  tracker.start(10 * SECOND);

  expect(tracker.pts(0)).toBe(12 * SECOND);
});

test("test_start_hands_back_cached_words_once", () => {
  // Words reported before timing starts come back in order, only the first time.
  const tracker = new WordTimestampTracker();
  const first = word("Hello", 0.0);
  const second = word("there", 0.4);
  tracker.cache(first);
  tracker.cache(second);

  expect(tracker.start(10 * SECOND)).toEqual([first, second]);
  expect(tracker.start(20 * SECOND)).toEqual([]);
  expect(tracker.pts(0)).toBe(10 * SECOND);
});

test("test_reset_stops_timing_and_drops_cached_words", () => {
  // After a reset, timing starts again and earlier cached words are gone.
  const tracker = new WordTimestampTracker();
  tracker.start(10 * SECOND);
  tracker.cache(word("stale", 0.0));
  tracker.reset();

  expect(tracker.started).toBe(false);
  expect(tracker.start(20 * SECOND)).toEqual([]);
  expect(tracker.pts(0)).toBe(20 * SECOND);
});

test("test_reply_last_pts_counts_only_the_replys_own_words", () => {
  // A reply that times no words has no last word, even after an earlier reply's.
  const tracker = new WordTimestampTracker();
  tracker.startReply();
  expect(tracker.replyLastPts).toBeNull();

  tracker.lastPts = 2 * SECOND;
  expect(tracker.replyLastPts).toBe(2 * SECOND);

  tracker.startReply();
  expect(tracker.replyLastPts).toBeNull();
});
