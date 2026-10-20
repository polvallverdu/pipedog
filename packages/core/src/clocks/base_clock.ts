// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/clocks/base_clock.py

/**
 * Abstract base class for clock implementations.
 *
 * Provides a common interface for timing operations used in Pipecat
 * for synchronization, scheduling, and time-based processing.
 */
export abstract class BaseClock {
  /** Get the current time value (unit and reference depend on the implementation). */
  abstract getTime(): number;

  /** Start or initialize the clock. Call before `getTime()`. */
  abstract start(): void;
}
