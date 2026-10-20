// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_word_timestamp_utils.py

import { describe, expect, test } from "bun:test";

import { mergePunctTokens } from "../src/utils/text/word_timestamp_utils.ts";

describe("TestMergePunctTokens", () => {
  test("test_empty_list", () => {
    expect(mergePunctTokens([])).toEqual([]);
  });

  test("test_all_alnum_words_pass_through", () => {
    const input: [string, number][] = [
      ["hello", 0.0],
      ["world", 1.0],
    ];
    expect(mergePunctTokens(input)).toEqual([
      ["hello", 0.0],
      ["world", 1.0],
    ]);
  });

  test("test_trailing_space_merged_and_stripped", () => {
    const input: [string, number][] = [
      ["I", 0.0],
      [" ", 0.2],
    ];
    expect(mergePunctTokens(input)).toEqual([["I", 0.0]]);
  });

  test("test_comma_space_merged_and_stripped", () => {
    const input: [string, number][] = [
      ["questions", 1.0],
      [", ", 1.2],
      ["explain", 1.4],
    ];
    expect(mergePunctTokens(input)).toEqual([
      ["questions,", 1.0],
      ["explain", 1.4],
    ]);
  });

  test("test_leading_space_with_no_preceding_word_discarded", () => {
    const input: [string, number][] = [
      [" ", 0.0],
      ["hello", 0.5],
    ];
    expect(mergePunctTokens(input)).toEqual([["hello", 0.5]]);
  });

  test("test_leading_empty_string_discarded", () => {
    const input: [string, number][] = [
      ["", 0.0],
      ["hello", 0.5],
    ];
    expect(mergePunctTokens(input)).toEqual([["hello", 0.5]]);
  });

  test("test_multiple_consecutive_punct_tokens_merged_and_stripped", () => {
    const input: [string, number][] = [
      ["word", 0.0],
      [",", 0.1],
      [" ", 0.2],
      ["next", 0.3],
    ];
    expect(mergePunctTokens(input)).toEqual([
      ["word,", 0.0],
      ["next", 0.3],
    ]);
  });

  test("test_timestamp_of_preceding_word_is_kept", () => {
    // Merged punct tokens adopt the preceding word's timestamp.
    const input: [string, number][] = [
      ["hello", 2.5],
      [",", 2.7],
    ];
    const result = mergePunctTokens(input);
    expect(result).toEqual([["hello,", 2.5]]);
  });

  test("test_xml_tag_only_token_is_treated_as_punct", () => {
    // A token that is only an XML tag (no alnum chars) merges into the preceding word.
    const input: [string, number][] = [
      ["word", 0.0],
      ["<break/>", 0.1],
      ["next", 0.3],
    ];
    expect(mergePunctTokens(input)).toEqual([
      ["word<break/>", 0.0],
      ["next", 0.3],
    ]);
  });

  test("test_xml_tag_with_alnum_content_passes_through", () => {
    // A token like '<spell>123</spell>' has alnum chars after stripping tags.
    const input: [string, number][] = [
      ["<spell>123</spell>", 0.0],
      ["and", 0.5],
    ];
    expect(mergePunctTokens(input)).toEqual([
      ["<spell>123</spell>", 0.0],
      ["and", 0.5],
    ]);
  });

  test("test_inworld_style_full_stream", () => {
    // Full Inworld-style raw stream produces expected merged and stripped output.
    const raw: [string, number][] = [
      ["", 0.0],
      ["I", 0.1],
      [" ", 0.2],
      ["can", 0.3],
      [" ", 0.4],
      ["answer", 0.5],
      [" ", 0.6],
      ["questions", 0.7],
      [", ", 0.8],
      ["explain", 0.9],
      [" ", 1.0],
      ["things", 1.1],
      [".", 1.2],
    ];
    const expected: [string, number][] = [
      ["I", 0.1],
      ["can", 0.3],
      ["answer", 0.5],
      ["questions,", 0.7],
      ["explain", 0.9],
      ["things.", 1.1],
    ];
    expect(mergePunctTokens(raw)).toEqual(expected);
  });

  test("test_only_punct_tokens_returns_empty", () => {
    // A list containing only punct/space tokens produces an empty result.
    const input: [string, number][] = [
      [" ", 0.0],
      [",", 0.1],
      [".", 0.2],
    ];
    expect(mergePunctTokens(input)).toEqual([]);
  });
});
