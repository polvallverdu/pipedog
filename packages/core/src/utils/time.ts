// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
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
  // Integer arithmetic: float seconds can't represent most microsecond values exactly.
  const totalMicroseconds = Math.floor(Math.trunc(nanoseconds) / 1_000);
  const [hours, rem1] = divmod(totalMicroseconds, 3_600_000_000);
  const [minutes, rem2] = divmod(rem1, 60_000_000);
  const [seconds, microseconds] = divmod(rem2, 1_000_000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(microseconds).padStart(6, "0")}`;
}

/** Python's `divmod` on integers (floor division, remainder with the divisor's sign). */
function divmod(a: number, b: number): [number, number] {
  const q = Math.floor(a / b);
  return [q, a - q * b];
}
