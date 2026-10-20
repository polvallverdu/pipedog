// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/time.py

/**
 * Time utilities: ISO8601 formatting, nanosecond conversions, and
 * human-readable time strings.
 */

/** The current UTC time as an ISO8601 string with millisecond precision. */
export function timeNowIso8601(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

/** Convert seconds to (integer) nanoseconds. */
export function secondsToNanoseconds(seconds: number): number {
  return Math.trunc(seconds * 1_000_000_000);
}

/** Convert nanoseconds to seconds. */
export function nanosecondsToSeconds(nanoseconds: number): number {
  return nanoseconds / 1_000_000_000;
}

/** Convert nanoseconds to an "H:MM:SS.microseconds" string. */
export function nanosecondsToStr(nanoseconds: number): string {
  const totalSeconds = nanosecondsToSeconds(nanoseconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const microseconds = Math.trunc((totalSeconds - Math.trunc(totalSeconds)) * 1_000_000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(microseconds).padStart(6, "0")}`;
}
