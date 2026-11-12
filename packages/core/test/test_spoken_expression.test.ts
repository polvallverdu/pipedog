// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_spoken_expression.py

/** Tests for telling the expression of the words a TTS service reports speaking. */

import { expect, test } from "bun:test";
import { ExpressionSpan } from "../src/expressive/formatter.ts";
import { SpokenExpression } from "../src/expressive/spoken.ts";
import { TextType } from "../src/frames/frames.ts";

const LAUGH: [TextType, string] = [TextType.EXPRESSION_SOUND, "laugh"];

const TEXT = "<<calm>> Hi. [[laugh]] Bye.";
const SPANS = [
  new ExpressionSpan({ start: 8, end: 13, delivery: ["calm"] }),
  new ExpressionSpan({ start: 13, end: 22, sound: LAUGH }),
  new ExpressionSpan({ start: 22, end: 27, delivery: ["calm", "emphasis"] }),
];

function spokenExpression(): SpokenExpression {
  const spoken = new SpokenExpression();
  spoken.add(TEXT, SPANS);
  return spoken;
}

test("test_a_word_is_given_its_delivery_and_the_sounds_before_it", () => {
  const spoken = spokenExpression();

  expect(spoken.spoken("Hi.")).toEqual([["calm"], []]);
  expect(spoken.spoken("[[laugh]] Bye.")).toEqual([["calm", "emphasis"], [LAUGH]]);
  expect(spoken.delivery).toEqual(["calm", "emphasis"]);
});

test("test_units_added_follow_one_another", () => {
  const spoken = spokenExpression();
  spoken.add(" Again.", [new ExpressionSpan({ start: 0, end: 7, delivery: [] })]);

  spoken.spoken("Bye.");

  expect(spoken.spoken("Again.")).toEqual([[], []]);
});

test("test_spoken_markup_stands_for_the_next_sound", () => {
  const spoken = spokenExpression();
  spoken.spoken("Hi.");

  expect(spoken.spokenMarkup()).toEqual(LAUGH);
  // Reported once, by its markup.
  expect(spoken.spoken("[[laugh]] Bye.")).toEqual([["calm", "emphasis"], []]);
});

test("test_spoken_markup_with_no_sound_before_the_next_words_isnt_spoken", () => {
  expect(spokenExpression().spokenMarkup()).toBeNull();
});

test("test_a_sound_after_the_last_word_is_left_for_what_follows", () => {
  const spoken = new SpokenExpression();
  // "Bye [[laugh]]!", spoken as one word that covers the tag.
  spoken.add("Bye [[laugh]]!", [
    new ExpressionSpan({ start: 0, end: 4, delivery: [] }),
    new ExpressionSpan({ start: 4, end: 13, sound: LAUGH }),
  ]);

  expect(spoken.spoken("Bye [[laugh]]!")).toEqual([[], []]);
  expect(spoken.spokenMarkup()).toEqual(LAUGH);
});

test("test_sounds_no_text_reported_are_unreported_at_the_end", () => {
  const spoken = new SpokenExpression();
  spoken.add("Bye [[laugh]]", [
    new ExpressionSpan({ start: 0, end: 4, delivery: [] }),
    new ExpressionSpan({ start: 4, end: 13, sound: LAUGH }),
  ]);

  spoken.spoken("Bye");

  expect(spoken.unreported()).toEqual([LAUGH]);
  expect(spoken.unreported()).toEqual([]);
});

test("test_text_spoken_before_any_was_added_has_no_delivery", () => {
  const spoken = new SpokenExpression();

  expect(spoken.spoken("Hi.")).toEqual([null, []]);
  expect(spoken.delivery).toBeNull();
});
