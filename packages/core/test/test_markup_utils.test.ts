// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_markup_utils.py

import { describe, expect, test } from "bun:test";

import { alnumOnly, hasAlnum } from "../src/utils/text/alnum_utils.ts";
import {
  rawOffsetAfterCleanChars,
  splitMarkupRuns,
  stripCompleteMarkup,
  stripMarkup,
} from "../src/utils/text/markup_utils.ts";

describe("TestStripMarkupHelpers", () => {
  // The markup-stripping primitives behind TextSegmentMap._markup_hop.

  test("test_strip_markup_removes_tags", () => {
    expect(stripMarkup("<b>hi</b> there")).toEqual("hi there");
  });

  test("test_strip_markup_preserves_non_markup", () => {
    expect(stripMarkup("1234-5678")).toEqual("1234-5678");
  });

  test("test_strip_markup_unclosed_tag_swallows_rest", () => {
    // A '<' with no closing '>' consumes to the end (how a mid-tag fragment reads).
    expect(stripMarkup("keep <phoneme attr")).toEqual("keep ");
  });

  test("test_strip_markup_stray_gt_is_kept", () => {
    expect(stripMarkup("a > b")).toEqual("a > b");
  });

  test("test_raw_len_maps_clean_prefix_to_raw_offset", () => {
    // "hello" (5 clean chars) ends just before "</speak>" at raw index 12.
    expect(rawOffsetAfterCleanChars("<speak>hello</speak>", 5)).toEqual(12);
  });

  test("test_raw_len_identity_without_markup", () => {
    expect(rawOffsetAfterCleanChars("1234-5678", 9)).toEqual(9);
  });

  test("test_raw_len_zero_or_negative_is_zero", () => {
    expect(rawOffsetAfterCleanChars("<b>x</b>", 0)).toEqual(0);
  });

  test("test_raw_len_beyond_available_returns_full_length", () => {
    expect(rawOffsetAfterCleanChars("<b>x</b>", 99)).toEqual("<b>x</b>".length);
  });

  test("test_raw_len_agrees_with_strip_markup", () => {
    // Consuming len(strip_markup(t)) clean chars must land exactly at the raw
    // offset just past the last clean char: t[:pos] must strip down to the
    // same clean text (nothing missing), and t[pos] must be either past the
    // end of t or the start of trailing markup (nothing extra).
    for (const t of ["<speak>hello</speak>", "1234-5678", "<a>x</a><b>y</b>", "plain"]) {
      const clean = stripMarkup(t);
      const pos = rawOffsetAfterCleanChars(t, clean.length);
      expect(stripMarkup(t.slice(0, pos))).toEqual(clean);
      expect(pos === t.length || t[pos] === "<").toBe(true);
    }
  });
});

describe("TestStripCompleteMarkupHelper", () => {
  // strip_complete_markup() is used on complete texts where, unlike
  // strip_markup(), a lone unmatched '<' is real content rather than a truncated tag.

  test("test_strip_complete_markup_removes_well_formed_tags", () => {
    expect(stripCompleteMarkup("<b>hi</b> there")).toEqual("hi there");
  });

  test("test_strip_complete_markup_keeps_unmatched_angle_bracket", () => {
    expect(stripCompleteMarkup("5 < 10")).toEqual("5 < 10");
  });

  test("test_strip_complete_markup_keeps_emoticon", () => {
    expect(stripCompleteMarkup("I love you <3 always")).toEqual("I love you <3 always");
  });
});

describe("TestSplitMarkupRuns", () => {
  // split_markup_runs() gives a tag its own run so TextSegmentMap._build can
  // give it its own segment, keeping the atomic span down to the tagged words.

  test("test_no_markup_yields_single_run", () => {
    expect(splitMarkupRuns("just plain text")).toEqual(["just plain text"]);
  });

  test("test_empty_text_yields_no_runs", () => {
    expect(splitMarkupRuns("")).toEqual([]);
  });

  test("test_tag_is_split_from_surrounding_text", () => {
    expect(splitMarkupRuns("I love to count <spell>1234</spell>.")).toEqual([
      "I love to count ",
      "<spell>1234</spell>.",
    ]);
  });

  test("test_whitespace_inside_a_tag_does_not_split_it", () => {
    expect(splitMarkupRuns('say <phoneme alphabet="ipa">Siobhan</phoneme> now')).toEqual([
      "say ",
      '<phoneme alphabet="ipa">Siobhan</phoneme>',
      " now",
    ]);
  });

  test("test_lone_angle_bracket_is_content", () => {
    expect(splitMarkupRuns("5 < 10 always")).toEqual(["5 < 10 always"]);
  });

  test("test_runs_concatenate_back_to_the_input", () => {
    for (const text of [
      "I love to count <spell>1234</spell>.",
      'say <phoneme alphabet="ipa">Siobhan</phoneme> now',
      "<break/>hello",
      "plain",
    ]) {
      expect(splitMarkupRuns(text).join("")).toEqual(text);
    }
  });
});

describe("TestHasAlnum", () => {
  // has_alnum() is the predicate form of alnum_only(), markup included.

  test("test_agrees_with_alnum_only", () => {
    for (const text of [
      "hello",
      "",
      "   ",
      "<break/>",
      "<b>hi</b>",
      "!!!",
      "😊",
      "5 < 10",
      "1234",
    ]) {
      expect(hasAlnum(text), text).toEqual(Boolean(alnumOnly(text)));
    }
  });

  test("test_tag_name_is_not_content", () => {
    expect(hasAlnum("<break/>")).toBe(false);
  });
});
