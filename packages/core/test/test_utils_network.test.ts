// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_network.py

import { describe, expect, test } from "bun:test";

import { exponentialBackoffTime } from "../src/utils/network.ts";

describe("TestUtilsNetwork", () => {
  test("test_exponential_backoff_time", async () => {
    // min_wait=4, max_wait=10, multiplier=1
    expect(exponentialBackoffTime(1, 4, 10, 1)).toBe(4);
    expect(exponentialBackoffTime(2, 4, 10, 1)).toBe(4);
    expect(exponentialBackoffTime(3, 4, 10, 1)).toBe(4);
    expect(exponentialBackoffTime(4, 4, 10, 1)).toBe(8);
    expect(exponentialBackoffTime(5, 4, 10, 1)).toBe(10);
    expect(exponentialBackoffTime(6, 4, 10, 1)).toBe(10);
    // min_wait=1, max_wait=10, multiplier=1
    expect(exponentialBackoffTime(1, 1, 10, 1)).toBe(1);
    expect(exponentialBackoffTime(2, 1, 10, 1)).toBe(2);
    expect(exponentialBackoffTime(3, 1, 10, 1)).toBe(4);
    expect(exponentialBackoffTime(4, 1, 10, 1)).toBe(8);
    expect(exponentialBackoffTime(5, 1, 10, 1)).toBe(10);
    expect(exponentialBackoffTime(6, 1, 10, 1)).toBe(10);
    // min_wait=1, max_wait=20, multiplier=2
    expect(exponentialBackoffTime(1, 1, 20, 2)).toBe(2);
    expect(exponentialBackoffTime(2, 1, 20, 2)).toBe(4);
    expect(exponentialBackoffTime(3, 1, 20, 2)).toBe(8);
    expect(exponentialBackoffTime(4, 1, 20, 2)).toBe(16);
    expect(exponentialBackoffTime(5, 1, 20, 2)).toBe(20);
    expect(exponentialBackoffTime(6, 1, 20, 2)).toBe(20);
  });
});
