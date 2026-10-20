// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/network.py

/** Base class for network utilities, providing exponential backoff time calculation. */

/**
 * Calculate exponential backoff wait time.
 *
 * @param attempt Current attempt number (1-based)
 * @param minWait Minimum wait time in seconds
 * @param maxWait Maximum wait time in seconds
 * @param multiplier Base multiplier for exponential calculation
 * @returns Wait time in seconds
 */
export function exponentialBackoffTime(
  attempt: number,
  minWait = 4,
  maxWait = 10,
  multiplier = 1,
): number {
  const exp = 2 ** (attempt - 1) * multiplier;
  // Python raises OverflowError for huge exponents; JS yields Infinity/NaN.
  if (Number.isNaN(exp)) {
    return maxWait;
  }
  const result = Math.max(0, Math.min(exp, maxWait));
  return Math.max(minWait, result);
}

export interface QuickFailureResultOptions {
  isQuickFailure: boolean;
  shouldGiveUp: boolean;
}

/**
 * Outcome of recording one failed connection attempt.
 *
 * - `isQuickFailure`: Whether this attempt lasted less than the tracker's
 *   `minStableDuration`.
 * - `shouldGiveUp`: Whether `maxConsecutiveFailures` quick failures have now
 *   happened in a row and the caller should stop retrying.
 */
export class QuickFailureResult {
  isQuickFailure: boolean;
  shouldGiveUp: boolean;

  constructor(options: QuickFailureResultOptions) {
    this.isQuickFailure = options.isQuickFailure;
    this.shouldGiveUp = options.shouldGiveUp;
  }
}

export interface QuickFailureTrackerOptions {
  /**
   * Minimum time, in seconds, a connection must survive to be considered
   * stable rather than a quick failure.
   */
  minStableDuration?: number;
  /**
   * Number of consecutive quick failures after which `record()` reports that
   * the caller should give up.
   */
  maxConsecutiveFailures?: number;
}

/**
 * Detects a connection that keeps failing immediately after connecting.
 *
 * Exponential backoff alone doesn't help when a connection attempt succeeds
 * just enough to fail again right away (e.g. a server that accepts a
 * WebSocket handshake but then immediately rejects invalid credentials) —
 * waiting longer between attempts won't fix that, only stopping will.
 *
 * Call `record()` with how long each failed attempt lasted. Once
 * `maxConsecutiveFailures` attempts in a row each lasted under
 * `minStableDuration` seconds, the result's `shouldGiveUp` is true,
 * telling the caller to stop retrying instead of trying again.
 */
export class QuickFailureTracker {
  minStableDuration: number;
  maxConsecutiveFailures: number;
  count = 0;

  constructor(options: QuickFailureTrackerOptions = {}) {
    this.minStableDuration = options.minStableDuration ?? 5.0;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  /**
   * Record a failed connection attempt that lasted `duration` seconds.
   *
   * Increments the consecutive-failure streak if this attempt was a quick
   * failure, or resets it if the attempt was stable.
   *
   * @param duration How long the failed attempt lasted, in seconds.
   * @returns A `QuickFailureResult` describing this attempt and whether the
   *   caller should give up.
   */
  record(duration: number): QuickFailureResult {
    const isQuickFailure = duration < this.minStableDuration;
    if (isQuickFailure) {
      this.count += 1;
    } else {
      this.count = 0;
    }
    return new QuickFailureResult({
      isQuickFailure,
      shouldGiveUp: isQuickFailure && this.count >= this.maxConsecutiveFailures,
    });
  }

  /** Reset the consecutive-failure streak, e.g. on a fresh connect. */
  reset(): void {
    this.count = 0;
  }
}
