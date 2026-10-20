// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_types.py

/** Tests for the given / not-given helpers in utils/types. */

import { expect, test } from "bun:test";
import { assertGiven, NOT_GIVEN, requireGiven } from "../src/utils/types.ts";

// Upstream raises RuntimeError / ValueError; the port throws plain Error for both.

test("test_assert_given_returns_the_value_including_none", () => {
  expect(assertGiven("voice")).toBe("voice");
  expect(assertGiven(null)).toBeNull();
});

test("test_assert_given_rejects_not_given", () => {
  expect(() => assertGiven(NOT_GIVEN)).toThrow(Error);
});

test("test_require_given_returns_a_value", () => {
  expect(requireGiven("en_US-lessac-medium", "Piper TTS voice")).toBe("en_US-lessac-medium");
});

test("test_require_given_rejects_not_given", () => {
  expect(() => requireGiven(NOT_GIVEN, "Piper TTS voice")).toThrow(Error);
});

test.each([
  ["none", null],
  ["blank", ""],
])("test_require_given_rejects_missing_and_blank_with_the_given_name[%s]", (_id, value) => {
  expect(() => requireGiven(value, "Piper TTS voice")).toThrow(
    /^Piper TTS voice must be specified$/,
  );
});

test("test_require_given_only_treats_the_empty_string_as_blank", () => {
  expect(requireGiven(0, "speed")).toBe(0);
  expect(requireGiven(false, "flag")).toBe(false);
});
