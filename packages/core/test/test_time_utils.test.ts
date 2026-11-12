// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_time_utils.py

import { describe, expect, test } from "bun:test";

import { nanosecondsToStr } from "../src/utils/time.ts";

describe("TestNanosecondsToStr", () => {
  test("test_zero", () => {
    expect(nanosecondsToStr(0)).toEqual("0:00:00.000000");
  });

  test("test_keeps_exact_microseconds", () => {
    // Values that float seconds can't represent exactly.
    expect(nanosecondsToStr(2_300_000_000)).toEqual("0:00:02.300000");
    expect(nanosecondsToStr(1_000_001_000)).toEqual("0:00:01.000001");
    expect(nanosecondsToStr(3_600_000_001_000)).toEqual("1:00:00.000001");
  });

  test("test_truncates_sub_microsecond_part", () => {
    expect(nanosecondsToStr(1_234_567_891)).toEqual("0:00:01.234567");
    expect(nanosecondsToStr(999)).toEqual("0:00:00.000000");
  });

  test("test_hours_minutes_seconds", () => {
    const ns = (2 * 3600 + 5 * 60 + 7) * 1_000_000_000 + 89_000;
    expect(nanosecondsToStr(ns)).toEqual("2:05:07.000089");
  });

  test("test_long_durations", () => {
    expect(nanosecondsToStr(100 * 3600 * 1_000_000_000)).toEqual("100:00:00.000000");
  });
});
