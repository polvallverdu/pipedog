// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tagged_llm_text_parser.py

/** Unit tests for TaggedLLMTextParser. */

import { expect, test } from "bun:test";

import {
  type TaggedLLMTextParsedOutputChunk,
  TaggedLLMTextParsedOutputChunkKind,
  TaggedLLMTextParser,
} from "../src/utils/text/tagged_llm_text_parser.ts";

const START = TaggedLLMTextParsedOutputChunkKind.THOUGHT_START;
const THOUGHT = TaggedLLMTextParsedOutputChunkKind.THOUGHT_TEXT;
const END = TaggedLLMTextParsedOutputChunkKind.THOUGHT_END;
const TEXT = TaggedLLMTextParsedOutputChunkKind.TEXT;

type Pair = [TaggedLLMTextParsedOutputChunkKind, string];

function _pairs(chunks: TaggedLLMTextParsedOutputChunk[]): Pair[] {
  return chunks.map((chunk) => [chunk.kind, chunk.text]);
}

/** Feed texts through a parser, merging consecutive text of the same kind. */
function _parse(texts: string[], flush = true): Pair[] {
  const parser = new TaggedLLMTextParser("<think>", "</think>");
  const chunks = texts.flatMap((text) => parser.parseNextChunk(text));
  chunks.push(...(flush ? parser.flush() : parser.reset()));
  const merged: Pair[] = [];
  for (const [kind, text] of _pairs(chunks)) {
    const last = merged[merged.length - 1];
    if (last && (kind === THOUGHT || kind === TEXT) && last[0] === kind) {
      merged[merged.length - 1] = [kind, last[1] + text];
    } else {
      merged.push([kind, text]);
    }
  }
  return merged;
}

test("test_thought_split_across_chunks", () => {
  const texts = ["<th", "ink", ">Let me", " check.</", "think", ">", "Hello", "!"];
  expect(_parse(texts)).toEqual([
    [START, ""],
    [THOUGHT, "Let me check."],
    [END, ""],
    [TEXT, "Hello!"],
  ]);
});

test("test_every_split_point_of_the_tags", () => {
  const text = "<think>Hmm.</think>Hi";
  for (let i = 1; i < text.length; i++) {
    expect(_parse([text.slice(0, i), text.slice(i)]), `split at ${i}`).toEqual([
      [START, ""],
      [THOUGHT, "Hmm."],
      [END, ""],
      [TEXT, "Hi"],
    ]);
  }
});

test("test_whitespace_before_the_thought_is_allowed", () => {
  expect(_parse(["\n", "<think>Hmm.</think>Hi"])).toEqual([
    [START, ""],
    [THOUGHT, "Hmm."],
    [END, ""],
    [TEXT, "Hi"],
  ]);
});

test("test_whitespace_after_the_thought_is_dropped_across_chunks", () => {
  expect(_parse(["<think>Hmm.</think>", "\n", "\n ", "Hi there", "\n"])).toEqual([
    [START, ""],
    [THOUGHT, "Hmm."],
    [END, ""],
    [TEXT, "Hi there\n"],
  ]);
});

test("test_text_without_a_thought_passes_through_unchanged", () => {
  expect(_parse([" Hel", "lo <think>", "</think>"])).toEqual([[TEXT, " Hello <think></think>"]]);
});

test("test_text_that_rules_out_the_tag_is_not_held_back", () => {
  const parser = new TaggedLLMTextParser("<think>", "</think>");
  expect(parser.parseNextChunk("<th")).toEqual([]);
  expect(_pairs(parser.parseNextChunk("e"))).toEqual([[TEXT, "<the"]]);
  expect(_pairs(parser.parseNextChunk("re"))).toEqual([[TEXT, "re"]]);
});

test("test_partial_tag_is_flushed_at_the_end", () => {
  expect(_parse(["<"])).toEqual([[TEXT, "<"]]);
});

test("test_thought_left_open_is_closed_at_the_end", () => {
  expect(_parse(["<think>Hmm", "</thi"])).toEqual([
    [START, ""],
    [THOUGHT, "Hmm</thi"],
    [END, ""],
  ]);
});

test("test_text_cut_short_is_not_flushed", () => {
  // Inside a thought, the last "</think>".length - 1 characters are held back.
  expect(_parse(["<think>Let me check.", "</thi"], false)).toEqual([
    [START, ""],
    [THOUGHT, "Let me chec"],
    [END, ""],
  ]);
  expect(_parse(["<thi"], false)).toEqual([]);
});

test("test_flush_readies_the_parser_for_the_next_text", () => {
  const parser = new TaggedLLMTextParser("<thinking>", "</thinking>");
  for (const text of ["<thinking>One.</thinking>", "<thinking>Two.</thinking>"]) {
    const chunks = [...parser.parseNextChunk(text), ...parser.flush()];
    expect(chunks.map((chunk) => chunk.kind)).toEqual([START, THOUGHT, END]);
  }
  expect(parser.flush()).toEqual([]);
});
