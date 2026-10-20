// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/clocks/system_clock.py

import { monotonicNs } from "@pipecat-ts/asyncio";
import { BaseClock } from "./base_clock.ts";

/**
 * A monotonic clock implementation using system time.
 *
 * Not affected by system clock adjustments, suitable for measuring elapsed
 * time in real-time applications.
 */
export class SystemClock extends BaseClock {
  #time = 0;

  /** Elapsed nanoseconds since `start()`, or 0 if not started. */
  getTime(): number {
    return this.#time > 0 ? monotonicNs() - this.#time : 0;
  }

  /** Start the clock and begin time measurement. */
  start(): void {
    this.#time = monotonicNs();
  }
}
