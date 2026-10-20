// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/context/word_timestamp_tracker.py

/** Timestamps for the words a TTS service speaks. */

import { secondsToNanoseconds } from "../time.ts";

export interface WordTimestampOptions {
  /** The word. */
  word: string;
  /** Seconds from the start of the word's audio. */
  timestamp: number;
  /** The audio context the word belongs to. */
  contextId: string | null;
  /** Whether the word carries its own spacing. */
  includesInterFrameSpaces?: boolean;
}

/**
 * A word a TTS provider reported, and when it is spoken.
 *
 * - `word`: the word.
 * - `timestamp`: seconds from the start of the word's audio.
 * - `contextId`: the audio context the word belongs to.
 * - `includesInterFrameSpaces`: whether the word carries its own spacing.
 */
export class WordTimestamp {
  word: string;
  timestamp: number;
  contextId: string | null;
  includesInterFrameSpaces: boolean;

  constructor(options: WordTimestampOptions) {
    this.word = options.word;
    this.timestamp = options.timestamp;
    this.contextId = options.contextId;
    this.includesInterFrameSpaces = options.includesInterFrameSpaces ?? false;
  }
}

/**
 * Turns word times reported from the start of their audio into PTS.
 *
 * Timing starts when a context's audio starts playing, or after the last word
 * if that is later, so words keep their order across contexts. Words reported
 * before then are cached and handed back by `start`.
 *
 * `lastPts` is the PTS of the last word frame, and `uninterruptibleLastPts`
 * that of the last uninterruptible one. `replyLastPts` is that of the last
 * word since `startReply`.
 */
export class WordTimestampTracker {
  protected _baseline: number | null = null;
  protected _cached: WordTimestamp[] = [];
  protected _replyStartPts = 0;
  lastPts = 0;
  uninterruptibleLastPts = 0;

  /** Whether words are being timed. */
  get started(): boolean {
    return this._baseline !== null;
  }

  /** The PTS of the reply's last word, or `null` if the reply timed no words. */
  get replyLastPts(): number | null {
    return this.lastPts !== this._replyStartPts ? this.lastPts : null;
  }

  /** Note where a reply's words start, for `replyLastPts`. */
  startReply(): void {
    this._replyStartPts = this.lastPts;
  }

  /**
   * Start timing words, if not started yet.
   *
   * @param now The current clock time, in nanoseconds.
   * @returns The words cached until now, to time in order.
   */
  start(now: number): WordTimestamp[] {
    if (this._baseline !== null) {
      return [];
    }
    this._baseline = Math.max(this.lastPts, now);
    const cached = this._cached;
    this._cached = [];
    return cached;
  }

  /**
   * Hold a word until timing starts.
   *
   * @param word The word reported before timing started.
   */
  cache(word: WordTimestamp): void {
    this._cached.push(word);
  }

  /**
   * Get the PTS of a word.
   *
   * @param timestamp Seconds from the start of the word's audio.
   * @returns The word's PTS, in nanoseconds.
   */
  pts(timestamp: number): number {
    if (this._baseline === null) {
      throw new Error("WordTimestampTracker.pts() called before start()");
    }
    return this._baseline + secondsToNanoseconds(timestamp);
  }

  /** Stop timing words and drop the cached ones. */
  reset(): void {
    this._baseline = null;
    this._cached = [];
  }
}
