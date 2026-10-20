// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_word_completion_tracker.py

import { describe, expect, test } from "bun:test";

import { TextSegmentMap } from "../src/utils/context/text_segment_map.ts";
import { WordCompletionTracker } from "../src/utils/context/word_completion_tracker.ts";
import { alnumOnly } from "../src/utils/text/alnum_utils.ts";

describe("TestWordCompletionTrackerBasic", () => {
  test("test_not_complete_before_any_words", () => {
    const tracker = new WordCompletionTracker("Hello world");
    expect(tracker.isComplete).toBeFalsy();
  });

  test("test_complete_after_all_words", () => {
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("world");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_add_word_and_check_complete_return_value", () => {
    // add_word_and_check_complete returns True exactly when the tracker becomes complete.
    const tracker = new WordCompletionTracker("Hi there");
    expect(tracker.addWordAndCheckComplete("Hi")).toBeFalsy();
    expect(tracker.addWordAndCheckComplete("there")).toBeTruthy();
  });

  test("test_single_word", () => {
    const tracker = new WordCompletionTracker("Hello");
    expect(tracker.addWordAndCheckComplete("Hello")).toBeTruthy();
  });

  test("test_complete_stays_true_after_extra_words", () => {
    // Extra words after completion force-complete (no-op remaining) and stay complete.
    const tracker = new WordCompletionTracker("Hi");
    tracker.addWordAndCheckComplete("Hi");
    const result = tracker.addWordAndCheckComplete("extra");
    expect(result).toBeTruthy();
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_late_word_after_completion_does_not_overflow_to_next_slot", () => {
    // A duplicate or late word-timestamp event arriving once the frame's TTS
    // text is fully consumed must be dropped outright.
    //
    // Routing it as overflow instead would hand it to the next slot, duplicating
    // the word into the following sentence's transcript. The return value alone
    // does not distinguish the two paths -- both report complete -- so the
    // overflow and frame-word outputs are what pin this.
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.addWordAndCheckComplete("extra")).toBeTruthy();
    expect(tracker.getOverflowWord(), "late word must not leak to the next slot").toBeNull();
    expect(tracker.getWordForFrame()).toBeNull();
  });
});

describe("TestWordCompletionTrackerNormalization", () => {
  test("test_punctuation_ignored_in_expected", () => {
    // Punctuation in the source text is stripped before comparison.
    //
    // Also asserts each word actually belonged and was consumed normally
    // (rather than the second word silently force-completing the tracker) --
    // force-complete also leaves ``is_complete`` True, so it alone would not
    // catch a regression here.
    const tracker = new WordCompletionTracker("Hello, world!");
    expect(tracker.wordBelongsHere("Hello")).toBeTruthy();
    tracker.addWordAndCheckComplete("Hello");
    expect(tracker.getWordForFrame()).toEqual("Hello");
    expect(tracker.wordBelongsHere("world")).toBeTruthy();
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getWordForFrame()).toEqual("world");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_word_after_unrepeated_comma_belongs_and_is_consumed", () => {
    // A word immediately following punctuation the TTS provider didn't
    // repeat as its own token (e.g. Inworld reporting "Yeah" then "I" for
    // "Yeah, I can do that.") must be recognised and consumed normally, not
    // dropped via force-complete.
    const tracker = new WordCompletionTracker("Yeah, I can do that.");
    for (const word of ["Yeah", "I", "can", "do"]) {
      expect(tracker.wordBelongsHere(word), `'${word}' should belong here`).toBeTruthy();
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
      expect(tracker.getWordForFrame()).toEqual(word);
    }
    expect(tracker.wordBelongsHere("that")).toBeTruthy();
    expect(tracker.addWordAndCheckComplete("that")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("that");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_repeated_mark_is_kept_without_an_llm_text", () => {
    // The mark is this frame's text when no span is recorded to carry it.
    //
    // A provider may report the comma of "Yeah," with the *following* word
    // instead. With an ``llm_text`` that repeat is trimmed, because the span
    // attributed to "Yeah" already ends in it. Without one nothing records
    // spans, and the frame word is the provider's own token -- which never
    // carried the comma -- so trimming here would delete it outright.
    const tracker = new WordCompletionTracker("Yeah, I can");
    const words = [];
    for (const word of ["Yeah", ", I", " can"]) {
      tracker.addWordAndCheckComplete(word);
      words.push(tracker.getWordForFrame());
    }
    expect(words).toEqual(["Yeah", ", I", "can"]);
  });

  test("test_repeated_mark_is_trimmed_with_an_llm_text", () => {
    // The same stream, where the recorded span does carry the mark.
    const text = "Yeah, I can";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    const spans = [];
    for (const word of ["Yeah", ", I", " can"]) {
      tracker.addWordAndCheckComplete(word);
      spans.push(tracker.getLlmConsumed());
    }
    expect(spans, "the comma is recorded once").toEqual(["Yeah,", "I", "can"]);
  });

  test("test_punctuation_ignored_in_words", () => {
    // Punctuation attached to TTS word tokens is also stripped.
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello,");
    tracker.addWordAndCheckComplete("world!");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_case_insensitive", () => {
    const tracker = new WordCompletionTracker("HELLO WORLD");
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_spaces_ignored", () => {
    // Spaces in expected or received text do not count towards char totals.
    const tracker = new WordCompletionTracker("a b c");
    // Normalized expected: "abc" (3 chars)
    tracker.addWordAndCheckComplete("a");
    tracker.addWordAndCheckComplete("b");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("c");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_numbers_kept", () => {
    // Digits are treated as regular alphanumeric characters.
    const tracker = new WordCompletionTracker("Room 42");
    tracker.addWordAndCheckComplete("Room");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("42");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_mixed_punctuation_and_numbers", () => {
    const tracker = new WordCompletionTracker("It costs $9.99!");
    // Normalized expected: "itcosts999"
    tracker.addWordAndCheckComplete("It");
    tracker.addWordAndCheckComplete("costs");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("$9.99!");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_special_characters_only_in_expected", () => {
    // If the expected text normalizes to empty, the tracker is immediately complete.
    const tracker = new WordCompletionTracker("...");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_emoji_only_expected_accepts_emoji_word_without_warning", () => {
    // Emoji-only frame is already complete (normalizes to ''), but a TTS word event
    // for the emoji must still be accepted gracefully and return True without a warning.
    const tracker = new WordCompletionTracker("😊");
    expect(tracker.isComplete).toBeTruthy();
    const result = tracker.addWordAndCheckComplete("😊");
    expect(result).toBeTruthy();
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_special_characters_only_in_word", () => {
    // A word token that normalizes to empty and is absent from the expected text
    // triggers force-complete; one that is present in the expected text is consumed
    // normally and contributes nothing to the alnum count.
    // "---" is not in "hello" → force-complete
    const tracker = new WordCompletionTracker("hello");
    tracker.addWordAndCheckComplete("---");
    expect(tracker.isComplete).toBeTruthy();
    expect(tracker.getOverflowWord()).toEqual("---");
    // "..." IS in "hello..." so it belongs here and contributes 0 alnum chars
    const tracker2 = new WordCompletionTracker("hello...");
    tracker2.addWordAndCheckComplete("..."); // belongs, but no alnum chars → incomplete
    expect(tracker2.isComplete).toBeFalsy();
    tracker2.addWordAndCheckComplete("hello");
    expect(tracker2.isComplete).toBeTruthy();
  });

  test("test_ssml_tags_stripped_in_word", () => {
    // SSML tags like <spell>...</spell> in TTS word tokens are stripped before comparison.
    const tracker = new WordCompletionTracker("1234-5678");
    // Cartesia returns something like "<spell>1234-5678</spell>" as a word token
    expect(tracker.addWordAndCheckComplete("<spell>1234-5678</spell>")).toBeTruthy();
  });

  test("test_ssml_tags_do_not_inflate_char_count", () => {
    // Tag names must not count as alphanumeric chars, preventing premature completion.
    const tracker = new WordCompletionTracker("ab");
    // Without tag stripping "spell" (5 chars) would push received count over threshold.
    tracker.addWordAndCheckComplete("<spell>a</spell>");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("b");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_ssml_tags_in_expected_text", () => {
    // Tags in the expected text are also stripped.
    const tracker = new WordCompletionTracker("<speak>hello</speak>");
    expect(tracker.addWordAndCheckComplete("hello")).toBeTruthy();
  });

  test("test_curly_apostrophe_in_llm_text_matches_straight_apostrophe_in_tts_word", () => {
    // LLM curly apostrophe must still match when the TTS reports a straight one.
    const llm = "you’re welcome"; // U+2019 RIGHT SINGLE QUOTATION MARK
    const tracker = new WordCompletionTracker(llm, { llmText: llm });
    expect(tracker.wordBelongsHere("you're")).toBeTruthy(); // ASCII apostrophe
    tracker.addWordAndCheckComplete("you're");
    // The frame word is the token the provider reported; the LLM span keeps the
    // original typography, which is what reaches the conversation context.
    expect(tracker.getWordForFrame()).toEqual("you're");
    expect(tracker.getLlmConsumed()).toEqual("you’re");
    tracker.addWordAndCheckComplete("welcome");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_curly_apostrophe_in_tts_word_matches_straight_apostrophe_in_llm_text", () => {
    // LLM straight apostrophe must still match when the TTS reports a curly one.
    const llm = "you're welcome"; // ASCII apostrophe
    const tracker = new WordCompletionTracker(llm, { llmText: llm });
    expect(tracker.wordBelongsHere("you’re")).toBeTruthy(); // U+2019
    tracker.addWordAndCheckComplete("you’re");
    expect(tracker.getWordForFrame()).toEqual("you’re");
    expect(tracker.getLlmConsumed()).toEqual("you're");
    tracker.addWordAndCheckComplete("welcome");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_typographic_mismatch_does_not_collapse_the_rest_of_the_sentence", () => {
    // A normalized apostrophe must not force-complete the slot mid-sentence.
    const text = "I don’t think so";
    const tracker = new WordCompletionTracker(text, { userFacingText: text });
    for (const word of ["I", "don't", "think"]) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete("so")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("so");
  });

  test("test_en_dash_reported_as_hyphen", () => {
    // A provider reporting an ASCII hyphen matches an en dash in the source.
    const text = "the 2020–2021 report";
    const tracker = new WordCompletionTracker(text, { userFacingText: text });
    tracker.addWordAndCheckComplete("the");
    expect(tracker.wordBelongsHere("2020-2021")).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerReset", () => {
  test("test_reset_clears_progress", () => {
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.isComplete).toBeTruthy();
    tracker.reset();
    expect(tracker.isComplete).toBeFalsy();
  });

  test("test_reset_allows_reuse", () => {
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello");
    tracker.addWordAndCheckComplete("world");
    tracker.reset();
    tracker.addWordAndCheckComplete("Hello");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("world");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_reset_preserves_expected_text", () => {
    // reset() only clears received chars; the expected text is unchanged.
    const tracker = new WordCompletionTracker("Hi");
    tracker.addWordAndCheckComplete("Hi");
    tracker.reset();
    // Re-adding the same word should complete again
    expect(tracker.addWordAndCheckComplete("Hi")).toBeTruthy();
  });

  test("test_reset_clears_raw_pos_cursor", () => {
    // reset() resets the llm_text cursor so raw_consumed is correct after replay.
    const raw = "<card>4111</card>";
    const tracker = new WordCompletionTracker("4111", { llmText: raw });
    expect(tracker.addWordAndCheckComplete("4111")).toBeTruthy();
    expect(tracker.getLlmConsumed()).toEqual("<card>4111</card>");
    tracker.reset();
    // Cursor restarts from position 0 after reset.
    expect(tracker.addWordAndCheckComplete("4111")).toBeTruthy();
    expect(tracker.getLlmConsumed()).toEqual("<card>4111</card>");
  });

  test("test_reset_clears_expected_raw_pos_cursor", () => {
    // reset() resets the expected_raw cursor so force-complete uses full text again.
    const tracker = new WordCompletionTracker("number is");
    tracker.addWordAndCheckComplete("number");
    // Partially advanced: remaining = " is"
    tracker.addWordAndCheckComplete("4111"); // force-complete
    expect(tracker.getWordForFrame()).toEqual("is");
    tracker.reset();
    // After reset the cursor is back at 0, so force-complete sees the full text.
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getWordForFrame()).toEqual("number is");
  });
});

describe("TestWordCompletionTrackerEdgeCases", () => {
  test("test_empty_expected_text", () => {
    // An empty expected string is complete from the start.
    const tracker = new WordCompletionTracker("");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_empty_word_adds_nothing", () => {
    const tracker = new WordCompletionTracker("hello");
    tracker.addWordAndCheckComplete("");
    expect(tracker.isComplete).toBeFalsy();
  });

  test("test_partial_word_completion", () => {
    // Chars accumulate; completion happens mid-add_word_and_check_complete if count is reached.
    const tracker = new WordCompletionTracker("ab");
    // "ab" normalizes to 2 chars; one word covering both at once
    expect(tracker.addWordAndCheckComplete("ab")).toBeTruthy();
  });

  test("test_word_with_extra_chars_completes", () => {
    // A single verbose token can satisfy a longer expected text.
    const tracker = new WordCompletionTracker("Hi");
    expect(tracker.addWordAndCheckComplete("Hieveryone")).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerRealisticSentences", () => {
  // Sentence as it would appear in an AggregatedTextFrame from the LLM.
  const SENTENCE =
    "You're welcome! If you have any more questions or need further examples, feel free to ask. Have a great day! 😊";
  // Words as a TTS word-timestamp service typically returns them:
  // punctuation attached to the adjacent word, emoji absent (unspeakable).

  const TTS_WORDS = [
    "You're",
    "welcome!",
    "If",
    "you",
    "have",
    "any",
    "more",
    "questions",
    "or",
    "need",
    "further",
    "examples,",
    "feel",
    "free",
    "to",
    "ask.",
    "Have",
    "a",
    "great",
    "day!",
  ];

  test("test_completes_after_all_tts_words", () => {
    // Feeding every TTS word in order must complete the tracker.
    const tracker = new WordCompletionTracker(SENTENCE);
    const results = TTS_WORDS.map((w) => tracker.addWordAndCheckComplete(w));
    expect(results.at(-1)!, "tracker should be complete after the last word").toBeTruthy();
  });

  test("test_not_complete_before_last_word", () => {
    // Tracker must not report complete before the final word is added.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS.slice(0, -1)) {
      expect(tracker.isComplete, `should not be complete after '${word}'`).toBeFalsy();
    }
  });

  test("test_last_word_triggers_completion", () => {
    // Only the last add_word_and_check_complete call should return True.
    const tracker = new WordCompletionTracker(SENTENCE);
    const intermediate = TTS_WORDS.slice(0, -1).map((w) => tracker.addWordAndCheckComplete(w));
    expect(intermediate.some(Boolean)).toBeFalsy();
    expect(tracker.addWordAndCheckComplete(TTS_WORDS.at(-1)!)).toBeTruthy();
  });

  test("test_emoji_in_expected_does_not_block_completion", () => {
    // The 😊 at the end normalizes to '' so it adds no required chars.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_chunked_delivery_two_words_per_call", () => {
    // Some TTS providers return multiple words in one timestamp event.
    const tracker = new WordCompletionTracker(SENTENCE);
    const pairs = Array.from({ length: TTS_WORDS.length - 1 - 0 }, (_, i) => i + 0).map(
      (i) => `${TTS_WORDS[i]} ${TTS_WORDS[i + 1]}`,
    );
    // If word count is odd the last word is left alone.
    if (TTS_WORDS.length % 2) {
      pairs.push(TTS_WORDS.at(-1)!);
    }
    for (const chunk of pairs) {
      tracker.addWordAndCheckComplete(chunk);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_reset_and_replay", () => {
    // After reset the same tracker can complete the same sentence again.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
    tracker.reset();
    expect(tracker.isComplete).toBeFalsy();
    for (const word of TTS_WORDS) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_mid_sentence_is_not_complete", () => {
    // Spot-check several points through the sentence.
    const tracker = new WordCompletionTracker(SENTENCE);
    const checkpoints = new Set([4, 9, 14]); // after 5th, 10th, 15th word (0-indexed)
    for (const [i, word] of TTS_WORDS.slice(0, -1).entries()) {
      tracker.addWordAndCheckComplete(word);
      if (checkpoints.has(i)) {
        expect(tracker.isComplete, `should not be complete after ${i + 1} words`).toBeFalsy();
      }
    }
  });

  test("test_short_sentence_word_by_word", () => {
    // Smaller realistic sentence: each word added individually.
    const sentence = "Of course! Here's a simple Python example.";
    const words = ["Of", "course!", "Here's", "a", "simple", "Python", "example."];
    const tracker = new WordCompletionTracker(sentence);
    for (const word of words.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(words.at(-1)!)).toBeTruthy();
  });

  test("test_sentence_with_numbers", () => {
    // Numbers are alphanumeric and must be counted in both directions.
    const sentence = "There are 3 options available for you.";
    const words = ["There", "are", "3", "options", "available", "for", "you."];
    const tracker = new WordCompletionTracker(sentence);
    for (const word of words.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(words.at(-1)!)).toBeTruthy();
  });

  test("test_credit_card_sentence_with_raw_consumed", () => {
    // Test that get_raw_consumed returns 'code:' after completing the sentence and all words.
    const sentence = "Here is a sample credit card number and a simple Python code:";
    const words = [
      "Here",
      "is",
      "a",
      "sample",
      "credit",
      "card",
      "number",
      "and",
      "a",
      "simple",
      "Python",
      "code:",
    ];
    // Provide llm_text parameter so get_llm_consumed() works
    const tracker = new WordCompletionTracker(sentence, { llmText: sentence });
    // Add all words except the last one
    for (const word of words.slice(0, -1)) {
      const result = tracker.addWordAndCheckComplete(word);
      expect(result, `Should not be complete after adding '${word}'`).toBeFalsy();
    }
    // Add the final word - should complete the tracker
    const result = tracker.addWordAndCheckComplete(words.at(-1)!);
    expect(result, "Should be complete after adding the last word").toBeTruthy();
    expect(tracker.isComplete).toBeTruthy();
    // get_raw_consumed should return "code:" for the last word
    expect(tracker.getLlmConsumed()).toEqual("code:");
  });

  test("test_maori_culture_sentence", () => {
    // Test completion with Māori culture sentence - last word should be 'culture.'
    const sentence =
      "The indigenous Māori people are a significant part of the population and culture.";
    const words = [
      "The",
      "indigenous",
      "Māori",
      "people",
      "are",
      "a",
      "significant",
      "part",
      "of",
      "the",
      "population",
      "and",
      "culture.",
    ];
    const tracker = new WordCompletionTracker(sentence, { llmText: sentence });
    // Add all words except the last one - should not complete
    for (const word of words.slice(0, -1)) {
      const result = tracker.addWordAndCheckComplete(word);
      expect(result, `Should not be complete after adding '${word}'`).toBeFalsy();
    }
    // Add the final word "culture." - should complete the tracker
    const result = tracker.addWordAndCheckComplete(words.at(-1)!);
    expect(result, "Should be complete after adding 'culture.'").toBeTruthy();
    expect(tracker.isComplete).toBeTruthy();
    // get_raw_consumed should return "culture." for the last word
    expect(tracker.getWordForFrame()).toEqual("culture.");
    expect(tracker.getLlmConsumed()).toEqual("culture.");
  });

  test("test_geography_sentence_frame_word_and_raw_consumed_validation", () => {
    // Test geography sentence word by word, validating _frame_word and _raw_consumed match expected values.
    //
    // Sentence: 'Here are some key facts: **Geography:** - It consists mainly of two large islands:
    // the North Island and the South Island, as well as many smaller islands.'
    //
    // This test validates that the received word, _frame_word, and _raw_consumed are exactly
    // what we expect for each word addition, especially in special cases with punctuation.
    const sentence =
      "Here are some key facts: **Geography:** - It consists mainly of two large islands: the North Island and the South Island, as well as many smaller islands.";
    const llmText = `<geography>${sentence}</geography>`;
    const words = [
      "Here",
      "are",
      "some",
      "key",
      "facts:",
      "**Geography:**",
      "-",
      "It",
      "consists",
      "mainly",
      "of",
      "two",
      "large",
      "islands:",
      "the",
      "North",
      "Island",
      "and",
      "the",
      "South",
      "Island,",
      "as",
      "well",
      "as",
      "many",
      "smaller",
      "islands.",
    ];
    // Expected _frame_word for each word (should match the input word exactly)
    const expectedFrameWords = [
      "Here",
      "are",
      "some",
      "key",
      "facts:",
      "**Geography:**",
      "-",
      "It",
      "consists",
      "mainly",
      "of",
      "two",
      "large",
      "islands:",
      "the",
      "North",
      "Island",
      "and",
      "the",
      "South",
      "Island,",
      "as",
      "well",
      "as",
      "many",
      "smaller",
      "islands.",
    ];
    // Expected _llm_consumed for each word (spans from llm_text)
    const expectedRawConsumed = [
      "<geography>Here",
      "are",
      "some",
      "key",
      "facts:",
      "**Geography:**",
      "-",
      "It",
      "consists",
      "mainly",
      "of",
      "two",
      "large",
      "islands:",
      "the",
      "North",
      "Island",
      "and",
      "the",
      "South",
      "Island,",
      "as",
      "well",
      "as",
      "many",
      "smaller",
      "islands.</geography>",
    ];
    const tracker = new WordCompletionTracker(sentence, { llmText: llmText });
    for (const [i, word] of words.entries()) {
      const isComplete = tracker.addWordAndCheckComplete(word);
      // Test 1: Validate _frame_word matches expected
      const actualFrameWord = tracker.getWordForFrame();
      const expectedFrameWord = expectedFrameWords[i];
      expect(
        actualFrameWord,
        `Word ${i + 1} '${word}': expected _frame_word '${expectedFrameWord}', got '${actualFrameWord}'`,
      ).toEqual(expectedFrameWord);
      // Test 2: Validate _raw_consumed matches expected
      const actualRawConsumed = tracker.getLlmConsumed();
      const expectedRaw = expectedRawConsumed[i];
      expect(
        actualRawConsumed,
        `Word ${i + 1} '${word}': expected _raw_consumed '${expectedRaw}', got '${actualRawConsumed}'`,
      ).toEqual(expectedRaw);
      // Test 3: Validate completion status
      if (i === words.length - 1) {
        expect(isComplete, `Should be complete after final word '${word}'`).toBeTruthy();
      } else {
        expect(
          isComplete,
          `Should not be complete after word '${word}' (position ${i + 1})`,
        ).toBeFalsy();
      }
    }
    // Test special punctuation cases individually
    const specialCases = [
      ["**Geography:**", "**Geography:**"],
      ["facts:", "facts:"],
      ["islands:", "islands:"],
      ["Island,", "Island,"],
      ["islands.", "islands."],
    ];
    for (const [word, expectedFrame] of specialCases) {
      const trackerSpecial = new WordCompletionTracker(word, {
        llmText: `<test>${word}</test>`,
      });
      expect(
        trackerSpecial.addWordAndCheckComplete(word),
        `Special case '${word}': should complete on its only/last word`,
      ).toBeTruthy();
      const actualFrame = trackerSpecial.getWordForFrame();
      expect(
        actualFrame,
        `Special case '${word}': expected _frame_word '${expectedFrame}', got '${actualFrame}'`,
      ).toEqual(expectedFrame);
      const actualRaw = trackerSpecial.getLlmConsumed();
      const expectedRawSpecial = `<test>${word}</test>`;
      expect(
        actualRaw,
        `Special case '${word}': expected _raw_consumed '${expectedRawSpecial}', got '${actualRaw}'`,
      ).toEqual(expectedRawSpecial);
    }
  });
});

describe("TestWordCompletionTrackerWordBelongsHere", () => {
  test("test_belongs_when_word_is_prefix_of_remaining", () => {
    // word_belongs_here returns True when word alnum chars match the start of remaining.
    const tracker = new WordCompletionTracker("4111 1111 1111 1111");
    expect(tracker.wordBelongsHere("4111")).toBeTruthy();
  });

  test("test_does_not_belong_when_word_mismatches_remaining", () => {
    // word_belongs_here returns False when the word is clearly from a different slot.
    const tracker = new WordCompletionTracker("number is");
    // '4' does not match 'n' (start of "numberis")
    expect(tracker.wordBelongsHere("4111")).toBeFalsy();
  });

  test("test_punctuation_present_in_expected_belongs", () => {
    // Punctuation that appears in the remaining expected text belongs here.
    const tracker = new WordCompletionTracker("hello, world");
    tracker.addWordAndCheckComplete("hello");
    // remaining expected = ", world" — comma is present, so it belongs
    expect(tracker.wordBelongsHere(",")).toBeTruthy();
  });

  test("test_punctuation_absent_from_expected_does_not_belong", () => {
    // Punctuation absent from the remaining expected text does not belong here.
    const tracker = new WordCompletionTracker("hello");
    // "..." and "," are not in "hello", so they don't belong
    expect(tracker.wordBelongsHere("...")).toBeFalsy();
    expect(tracker.wordBelongsHere(",")).toBeFalsy();
  });

  test("test_empty_word_always_belongs", () => {
    // An empty word token always belongs (empty string is a substring of any text).
    const tracker = new WordCompletionTracker("hello");
    expect(tracker.wordBelongsHere("")).toBeTruthy();
  });

  test("test_emoji_in_expected_belongs", () => {
    // An emoji present in the remaining expected text belongs to this frame.
    const tracker = new WordCompletionTracker("Hello 😊");
    tracker.addWordAndCheckComplete("Hello");
    expect(tracker.wordBelongsHere("😊")).toBeTruthy();
  });

  test("test_emoji_absent_from_expected_does_not_belong", () => {
    // An emoji not in the remaining expected text is routed to the next frame.
    const tracker = new WordCompletionTracker("Hello world");
    tracker.addWordAndCheckComplete("Hello");
    // 😊 is not in "Hello world", so it doesn't belong here
    expect(tracker.wordBelongsHere("😊")).toBeFalsy();
  });

  test("test_belongs_when_partial_prefix_matches", () => {
    // Partial token (fewer chars than remaining) still passes if it is a prefix.
    const tracker = new WordCompletionTracker("hello world");
    // remaining = "helloworld", word = "hel" — prefix matches
    expect(tracker.wordBelongsHere("hel")).toBeTruthy();
  });

  test("test_does_not_belong_when_no_remaining", () => {
    // word_belongs_here returns False when the tracker is already complete.
    const tracker = new WordCompletionTracker("hi");
    tracker.addWordAndCheckComplete("hi");
    expect(tracker.wordBelongsHere("extra")).toBeFalsy();
  });

  test("test_belongs_advances_correctly_after_partial_consumption", () => {
    // Remaining expected text shifts as words are consumed.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    // remaining is now "world"
    expect(tracker.wordBelongsHere("world")).toBeTruthy();
    expect(tracker.wordBelongsHere("hello")).toBeFalsy();
  });
});

describe("TestWordCompletionTrackerOverflow", () => {
  // Words that span the boundary of two AggregatedTextFrames.
  test("test_word_straddles_frame_boundary", () => {
    // A word token that spans two frames splits at the alnum boundary.
    const tracker = new WordCompletionTracker("hello");
    const result = tracker.addWordAndCheckComplete("helloworld");
    expect(result).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("hello");
    expect(tracker.getOverflowWord()).toEqual("world");
  });

  test("test_no_overflow_when_word_fits_exactly", () => {
    // A word that exactly fills remaining slots produces no overflow.
    const tracker = new WordCompletionTracker("hello");
    expect(tracker.addWordAndCheckComplete("hello")).toBeTruthy();
    expect(tracker.getOverflowWord()).toBeNull();
    expect(tracker.getWordForFrame()).toEqual("hello");
  });

  test("test_overflow_split_preserves_non_alnum_suffix", () => {
    // The raw overflow word retains non-alnum chars after the split point.
    const tracker = new WordCompletionTracker("1111");
    // "1111And" — 4 alnum chars for this frame, "And" as raw overflow
    const result = tracker.addWordAndCheckComplete("1111And");
    expect(result).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("1111");
    expect(tracker.getOverflowWord()).toEqual("And");
  });

  test("test_overflow_with_digits_splits_at_correct_position", () => {
    // Split position is computed by alnum count, not byte offset.
    const tracker = new WordCompletionTracker("4111"); // 4 alnum chars
    expect(tracker.addWordAndCheckComplete("41111111")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("4111");
    expect(tracker.getOverflowWord()).toEqual("1111");
  });

  test("test_overflow_flows_into_next_tracker", () => {
    // Overflow word fed into the next tracker completes it correctly.
    const tracker1 = new WordCompletionTracker("hello");
    const tracker2 = new WordCompletionTracker("world");
    expect(tracker1.addWordAndCheckComplete("helloworld")).toBeTruthy();
    const overflow = tracker1.getOverflowWord();
    expect(overflow).toEqual("world");
    const result = tracker2.addWordAndCheckComplete(overflow!);
    expect(result).toBeTruthy();
    expect(tracker2.getWordForFrame()).toEqual("world");
    expect(tracker2.getOverflowWord()).toBeNull();
  });

  test("test_overflow_with_digits_flows_into_next_tracker", () => {
    // Realistic card-number overflow: last token spans two frame slots.
    const tracker1 = new WordCompletionTracker("4111 1111 1111 1111");
    const tracker2 = new WordCompletionTracker("And your");
    for (const word of ["4111", "1111", "1111"]) {
      tracker1.addWordAndCheckComplete(word);
    }
    // "1111And" straddles the frame boundary
    let result = tracker1.addWordAndCheckComplete("1111And");
    expect(result).toBeTruthy();
    expect(tracker1.getWordForFrame()).toEqual("1111");
    expect(tracker1.getOverflowWord()).toEqual("And");
    // Feed overflow into tracker2
    result = tracker2.addWordAndCheckComplete(tracker1.getOverflowWord()!);
    expect(result).toBeFalsy();
    expect(tracker2.getWordForFrame()).toEqual("And");
    result = tracker2.addWordAndCheckComplete("your");
    expect(result).toBeTruthy();
  });

  test("test_no_overflow_state_on_normal_word", () => {
    // After a normal (non-straddling) word, overflow getters return None.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getOverflowWord()).toBeNull();
  });
});

describe("TestWordCompletionTrackerMissingWord", () => {
  // Force-complete: TTS provider drops a word-timestamp event.
  test("test_force_complete_when_word_does_not_belong", () => {
    // When word doesn't belong, the slot is force-completed and word becomes overflow.
    const tracker = new WordCompletionTracker("number is");
    const result = tracker.addWordAndCheckComplete("4111");
    expect(result).toBeTruthy();
    expect(tracker.getOverflowWord()).toEqual("4111");
  });

  test("test_force_complete_frame_word_is_full_remaining_expected", () => {
    // Force-complete with no prior progress: frame_word is the entire expected text.
    const tracker = new WordCompletionTracker("number is");
    expect(tracker.addWordAndCheckComplete("4111")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("number is");
  });

  test("test_force_complete_frame_word_is_partial_remaining_expected", () => {
    // Force-complete after partial progress: frame_word is only the unspoken suffix.
    const tracker = new WordCompletionTracker("number is");
    tracker.addWordAndCheckComplete("number"); // consumes "number" (6 chars)
    // Now remaining = " is"; "4111" doesn't belong
    const result = tracker.addWordAndCheckComplete("4111");
    expect(result).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("is");
    expect(tracker.getOverflowWord()).toEqual("4111");
  });

  test("test_force_complete_overflow_routes_to_next_tracker", () => {
    // Overflow from a force-completed slot feeds the next tracker correctly.
    const tracker1 = new WordCompletionTracker("number is");
    const tracker2 = new WordCompletionTracker("4111 1111");
    // force-completes tracker1
    expect(tracker1.addWordAndCheckComplete("4111")).toBeTruthy();
    const overflow = tracker1.getOverflowWord();
    expect(overflow).toEqual("4111");
    expect(tracker2.addWordAndCheckComplete(overflow!)).toBeFalsy();
    expect(tracker2.addWordAndCheckComplete("1111")).toBeTruthy();
  });

  test("test_force_complete_after_several_normal_words", () => {
    // Partial consumption followed by a mismatched word force-completes correctly.
    const tracker = new WordCompletionTracker("Your credit card number is");
    for (const word of ["Your", "credit", "card"]) {
      tracker.addWordAndCheckComplete(word);
    }
    // "4111" doesn't belong (remaining starts with "number...")
    const result = tracker.addWordAndCheckComplete("4111");
    expect(result).toBeTruthy();
    // frame_word should be the unspoken suffix including leading space
    expect(tracker.getWordForFrame()).toEqual("number is");
    expect(tracker.getOverflowWord()).toEqual("4111");
  });

  test("test_force_complete_marks_tracker_complete", () => {
    // After force-complete, is_complete is True regardless of how many chars were spoken.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("4111"); // force-complete
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_force_complete_does_not_affect_overflow_getters_on_normal_words", () => {
    // overflow state is fresh per call; a normal word clears any prior force-complete state.
    const tracker1 = new WordCompletionTracker("ab");
    const tracker2 = new WordCompletionTracker("cd");
    // Force-complete tracker1 with a wrong word
    expect(tracker1.addWordAndCheckComplete("xyz")).toBeTruthy();
    expect(tracker1.getOverflowWord()).not.toBeNull();
    // tracker2 receives "cd" normally — no overflow
    expect(tracker2.addWordAndCheckComplete("cd")).toBeTruthy();
    expect(tracker2.getOverflowWord()).toBeNull();
  });
});

describe("TestPunctuationLeadingTheNextToken", () => {
  // A provider that reports punctuation with the *following* word (", I") rather
  // than the preceding one ("Yeah,").
  //
  // Punctuation trailing a word is swept into that word's attributed span, so a
  // token leading with it presents the same punctuation a second time. The
  // duplicate is dropped from the frame word; the attribution is kept.
  const SENTENCE = "Yeah, I can do that. ";

  test("test_duplicate_punctuation_is_dropped_from_the_frame_word", () => {
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    tracker.addWordAndCheckComplete("Yeah");
    // The comma is attributed here, with the word it trails.
    expect(tracker.getLlmConsumed()).toEqual("Yeah,");
    tracker.addWordAndCheckComplete(", I");
    expect(tracker.getWordForFrame(), "comma must not be emitted twice").toEqual("I");
    expect(tracker.getLlmConsumed()).toEqual("I");
  });

  test("test_remaining_words_still_track", () => {
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    for (const word of ["Yeah", ", I", "can", "do"]) {
      expect(tracker.wordBelongsHere(word), `${JSON.stringify(word)} should belong`).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.addWordAndCheckComplete("that")).toBeTruthy();
  });
});

describe("TestTransformFollowedByUnrepeatedPunctuation", () => {
  // A text transform and punctuation the provider doesn't repeat, back to back.
  //
  // The comma sits at the end of the transformed span's original text ("$42.50,"),
  // so the word after it has to be placed by skipping punctuation that the segment
  // map reached via the transform's atomic cursor jump rather than a normal word
  // advance.
  const TTS_TEXT = "Your balance is forty two dollars and fifty cents, and it is ready";

  const ORIGINAL = "Your balance is $42.50, and it is ready";

  test("test_words_after_the_transform_are_attributed", () => {
    const tracker = new WordCompletionTracker(TTS_TEXT, {
      llmText: ORIGINAL,
      userFacingText: ORIGINAL,
    });
    const words = [
      "Your",
      "balance",
      "is",
      "forty",
      "two",
      "dollars",
      "and",
      "fifty",
      "cents",
      "and",
      "it",
      "is",
      "ready",
    ];
    for (const word of words) {
      expect(tracker.wordBelongsHere(word), `${JSON.stringify(word)} should belong`).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_transformed_span_is_attributed_atomically", () => {
    // The expansion's original text is attributed once, on the word that
    // completes it -- and the word right after the comma resumes normally.
    const tracker = new WordCompletionTracker(TTS_TEXT, {
      llmText: ORIGINAL,
      userFacingText: ORIGINAL,
    });
    for (const word of ["Your", "balance", "is", "forty", "two", "dollars", "and", "fifty"]) {
      tracker.addWordAndCheckComplete(word);
    }
    // Mid-expansion words carry no attribution of their own.
    expect(tracker.getLlmConsumed()).toBeNull();
    tracker.addWordAndCheckComplete("cents");
    expect(tracker.getLlmConsumed()).toEqual("$42.50,");
    tracker.addWordAndCheckComplete("and");
    expect(tracker.getLlmConsumed()).toEqual("and");
  });
});

describe("TestWordCompletionTrackerLLMText", () => {
  // llm_text cursor tracking: each word maps back to its span in the original LLM text.
  test("test_llm_text_none_when_no_llm_text_provided", () => {
    // get_raw_consumed returns None when llm_text was not given.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getLlmConsumed()).toBeNull();
  });

  test("test_llm_text_single_word_no_tags", () => {
    // Simple case: llm_text matches tts_text, no tags.
    const tracker = new WordCompletionTracker("hello world", {
      llmText: "hello world",
    });
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getLlmConsumed()).toEqual("hello");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getLlmConsumed()).toEqual("world");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_opening_tag_included_in_first_word", () => {
    // The opening tag preceding content is consumed with the first word.
    const raw = "<card>4111 1111 1111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: raw,
    });
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getLlmConsumed()).toEqual("<card>4111");
    // Confirms this is exercising the mid-frame span (prev_llm_pos : llm_pos)
    // branch, not the last-word sweep-to-end-of-llm_text branch.
    expect(tracker.isComplete).toBeFalsy();
  });

  test("test_llm_text_tag_chars_not_counted_as_alnum", () => {
    // Tag chars (c,a,r,d) inside <card> must not burn the alnum budget.
    // If tag chars were counted, "4111" would only consume "<card" (4 alnum budget
    // spent on c,a,r,d) and the result would be wrong.
    const raw = "<card>4111</card>";
    const tracker = new WordCompletionTracker("4111", { llmText: raw });
    tracker.addWordAndCheckComplete("4111");
    // The full "<card>4111</card>" should be consumed (last word → consume all).
    expect(tracker.getLlmConsumed()).toEqual("<card>4111</card>");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_four_words_with_card_tags", () => {
    // Full card-number scenario: each word maps to its correct raw span.
    const raw = "<card>4111 1111 1111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: raw,
    });
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getLlmConsumed()).toEqual("<card>4111");
    tracker.addWordAndCheckComplete("1111");
    expect(tracker.getLlmConsumed()).toEqual("1111");
    tracker.addWordAndCheckComplete("1111");
    expect(tracker.getLlmConsumed()).toEqual("1111");
    tracker.addWordAndCheckComplete("1111");
    // Last word: consume all remaining raw text including closing tag.
    expect(tracker.getLlmConsumed()).toEqual("1111</card>");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_closing_tag_consumed_with_last_word", () => {
    // Closing tag is swept into the last word's raw_consumed, not lost.
    const raw = "<card>hello</card>";
    const tracker = new WordCompletionTracker("hello", { llmText: raw });
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getLlmConsumed()).toEqual("<card>hello</card>");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_mid_frame_word_does_not_consume_closing_tag", () => {
    // Non-final words stop before the closing tag; only the last sweeps it up.
    const raw = "<card>hello world</card>";
    const tracker = new WordCompletionTracker("hello world", { llmText: raw });
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getLlmConsumed()).toEqual("<card>hello");
    expect(tracker.isComplete).toBeFalsy();
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getLlmConsumed()).toEqual("world</card>");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_force_complete_consumes_all_remaining", () => {
    // When force-complete fires, all remaining llm_text is consumed at once.
    const raw = "<card>4111 1111 1111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: raw,
    });
    tracker.addWordAndCheckComplete("4111"); // advances cursor to pos 10
    // "WRONG" doesn't belong → force-complete
    tracker.addWordAndCheckComplete("WRONG");
    expect(tracker.getLlmConsumed()).toEqual("1111 1111 1111</card>");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_llm_text_overflow_word_last_raw_consumed_sweeps_tag", () => {
    // When a straddling word completes the frame, closing tag is consumed with it.
    const raw = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111", { llmText: raw });
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getLlmConsumed()).toEqual("<card>4111");
    // "1111And" straddles into the next frame
    const result = tracker.addWordAndCheckComplete("1111And");
    expect(result).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("1111");
    expect(tracker.getOverflowWord()).toEqual("And");
    // is_complete → consume all remaining raw including </card>
    expect(tracker.getLlmConsumed()).toEqual("1111</card>");
  });

  test("test_llm_text_with_ssml_tags_in_expected", () => {
    // expected_text with SSML tags: raw cursor still advances by content alnum count.
    // Cartesia might receive "<spell>4111 1111</spell>" as expected_text
    // while <llm_text is "<card>4111 1111</card>"
    const raw = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("<spell>4111 1111</spell>", {
      llmText: raw,
    });
    // normalized expected = "41111111" (8 chars); both texts share the same alnum count.
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getLlmConsumed()).toEqual("<card>4111");
    tracker.addWordAndCheckComplete("1111");
    expect(tracker.getLlmConsumed()).toEqual("1111</card>");
    expect(tracker.isComplete).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerMultiFrameSimulation", () => {
  // End-to-end simulations of multiple AggregatedTextFrame slots.
  test("test_two_plain_frames_sequential_words", () => {
    // Normal two-frame flow: all words arrive in order with no drops or overflow.
    const tracker1 = new WordCompletionTracker("Your credit card");
    const tracker2 = new WordCompletionTracker("number is 42");
    for (const word of ["Your", "credit", "card"]) {
      tracker1.addWordAndCheckComplete(word);
    }
    expect(tracker1.isComplete).toBeTruthy();
    for (const word of ["number", "is"]) {
      expect(tracker2.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker2.addWordAndCheckComplete("42")).toBeTruthy();
  });

  test("test_credit_card_full_flow_with_llm_text", () => {
    // Full card-number scenario with llm_text tracking across two frames.
    const tracker1 = new WordCompletionTracker("Your credit card number is");
    const tracker2 = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: "<card>4111 1111 1111 1111</card>",
    });
    for (const word of ["Your", "credit", "card", "number", "is"]) {
      tracker1.addWordAndCheckComplete(word);
    }
    expect(tracker1.isComplete).toBeTruthy();
    tracker2.addWordAndCheckComplete("4111");
    expect(tracker2.getLlmConsumed()).toEqual("<card>4111");
    tracker2.addWordAndCheckComplete("1111");
    expect(tracker2.getLlmConsumed()).toEqual("1111");
    tracker2.addWordAndCheckComplete("1111");
    expect(tracker2.getLlmConsumed()).toEqual("1111");
    const result = tracker2.addWordAndCheckComplete("1111");
    expect(result).toBeTruthy();
    expect(tracker2.getLlmConsumed()).toEqual("1111</card>");
  });

  test("test_missing_word_force_complete_then_next_frame", () => {
    // Dropped word-timestamp: force-complete slot 1, route word to slot 2.
    const tracker1 = new WordCompletionTracker("Your credit card number is");
    const tracker2 = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: "<card>4111 1111 1111 1111</card>",
    });
    // "Your", "credit", "card" arrive; then "number" and "is" are dropped.
    for (const word of ["Your", "credit", "card"]) {
      tracker1.addWordAndCheckComplete(word);
    }
    // "4111" arrives but belongs to tracker2 — force-completes tracker1.
    let result = tracker1.addWordAndCheckComplete("4111");
    expect(result).toBeTruthy();
    // frame_word carries the unspoken remainder so a TTSTextFrame can be emitted.
    expect(tracker1.getWordForFrame()).toEqual("number is");
    const overflow = tracker1.getOverflowWord();
    expect(overflow).toEqual("4111");
    // Route overflow into tracker2.
    tracker2.addWordAndCheckComplete(overflow!);
    expect(tracker2.getLlmConsumed()).toEqual("<card>4111");
    tracker2.addWordAndCheckComplete("1111");
    tracker2.addWordAndCheckComplete("1111");
    result = tracker2.addWordAndCheckComplete("1111");
    expect(result).toBeTruthy();
    expect(tracker2.getLlmConsumed()).toEqual("1111</card>");
  });

  test("test_overflow_word_spans_two_frames", () => {
    // A word token that straddles two frame boundaries splits and routes correctly.
    const tracker1 = new WordCompletionTracker("4111 1111 1111 1111");
    const tracker2 = new WordCompletionTracker("And your");
    for (const word of ["4111", "1111", "1111"]) {
      tracker1.addWordAndCheckComplete(word);
    }
    // "1111And" spans the frame boundary.
    let result = tracker1.addWordAndCheckComplete("1111And");
    expect(result).toBeTruthy();
    expect(tracker1.getWordForFrame()).toEqual("1111");
    expect(tracker1.getOverflowWord()).toEqual("And");
    // Feed overflow into tracker2.
    result = tracker2.addWordAndCheckComplete(tracker1.getOverflowWord()!);
    expect(result).toBeFalsy();
    expect(tracker2.getWordForFrame()).toEqual("And");
    expect(tracker2.addWordAndCheckComplete("your")).toBeTruthy();
  });

  test("test_overflow_with_llm_text_across_frames", () => {
    // Raw text cursor is correct when the last straddling word completes the frame.
    const tracker1 = new WordCompletionTracker("4111 1111", {
      llmText: "<card>4111 1111</card>",
    });
    const tracker2 = new WordCompletionTracker("And");
    tracker1.addWordAndCheckComplete("4111");
    expect(tracker1.getLlmConsumed()).toEqual("<card>4111");
    // "1111And" completes tracker1; "And" overflows to tracker2.
    let result = tracker1.addWordAndCheckComplete("1111And");
    expect(result).toBeTruthy();
    expect(tracker1.getLlmConsumed()).toEqual("1111</card>");
    expect(tracker1.getOverflowWord()).toEqual("And");
    result = tracker2.addWordAndCheckComplete(tracker1.getOverflowWord()!);
    expect(result).toBeTruthy();
    expect(tracker2.getWordForFrame()).toEqual("And");
  });

  test("test_multiple_missing_words_single_force_complete", () => {
    // Even if several consecutive words are dropped, one force-complete handles them all.
    // Frame expects "one two three"; TTS skips straight to "four" (next frame's word).
    const tracker1 = new WordCompletionTracker("one two three");
    const tracker2 = new WordCompletionTracker("four five");
    // No words from tracker1 ever arrive; "four" is the first word seen.
    const result = tracker1.addWordAndCheckComplete("four");
    expect(result).toBeTruthy();
    expect(tracker1.getWordForFrame()).toEqual("one two three");
    expect(tracker1.getOverflowWord()).toEqual("four");
    expect(tracker2.addWordAndCheckComplete("four")).toBeFalsy();
    expect(tracker2.addWordAndCheckComplete("five")).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerEmojiInSentence", () => {
  // Word-by-word validation of frame_word and raw_consumed for sentences
  // containing emojis and special characters.
  //
  // Covers:
  // - Emoji in the middle of a sentence whose llm_text has surrounding XML tags.
  // - Emoji adjacent to currency symbols and punctuation.
  // - Multiple emojis scattered through a sentence with no XML tags.
  // - Emoji that does NOT appear in llm_text (safeguard must return None).
  function _assertWord(
    tracker: WordCompletionTracker,
    word: string,
    expectedFrameWord: string | null,
    expectedRawConsumed: string | null,
    idx: number,
  ) {
    const msg = `word ${idx + 1} ${JSON.stringify(word)}`;
    expect(tracker.getWordForFrame(), `${msg}: frame_word`).toEqual(expectedFrameWord);
    expect(tracker.getLlmConsumed(), `${msg}: raw_consumed`).toEqual(expectedRawConsumed);
  }

  test("test_emoji_in_middle_with_raw_tags", () => {
    // Sentence: 'Great job! 🎉 Well done.' wrapped in <praise> tags.
    //
    // The emoji word gets its own raw_consumed span ('🎉') because the
    // chars_for_frame==0 branch finds it at the correct offset in llm_text.
    // Words that follow the emoji pick up immediately after it.
    const sentence = "Great job! 🎉 Well done.";
    const llmText = `<praise>${sentence}</praise>`;
    const words = ["Great", "job!", "🎉", "Well", "done."];
    const expectedFrameWords = ["Great", "job!", "🎉", "Well", "done."];
    const expectedRawConsumed = ["<praise>Great", "job!", "🎉", "Well", "done.</praise>"]; // opening tag consumed with first alnum word
    const tracker = new WordCompletionTracker(sentence, { llmText: llmText });
    for (const [i, word] of words.entries()) {
      const isComplete = tracker.addWordAndCheckComplete(word);
      _assertWord(tracker, word, expectedFrameWords[i], expectedRawConsumed[i], i);
      if (i === words.length - 1) {
        expect(
          isComplete,
          `should be complete after final word ${JSON.stringify(word)}`,
        ).toBeTruthy();
      } else {
        expect(isComplete, `should not be complete after ${JSON.stringify(word)}`).toBeFalsy();
      }
    }
  });

  test("test_emoji_with_currency_and_raw_tags", () => {
    // Sentence: 'Pay $50 😊 today!' wrapped in <promo> tags.
    //
    // Validates that currency symbols ($) are treated as non-alnum punctuation
    // and that the emoji token is correctly assigned its own raw span.
    const sentence = "Pay $50 😊 today!";
    const llmText = `<promo>${sentence}</promo>`;
    const words = ["Pay", "$50", "😊", "today!"];
    const expectedFrameWords = ["Pay", "$50", "😊", "today!"];
    const expectedRawConsumed = ["<promo>Pay", "$50", "😊", "today!</promo>"]; // opening tag consumed with first word
    const tracker = new WordCompletionTracker(sentence, { llmText: llmText });
    for (const [i, word] of words.entries()) {
      const isComplete = tracker.addWordAndCheckComplete(word);
      _assertWord(tracker, word, expectedFrameWords[i], expectedRawConsumed[i], i);
      if (i === words.length - 1) {
        expect(
          isComplete,
          `should be complete after final word ${JSON.stringify(word)}`,
        ).toBeTruthy();
      } else {
        expect(isComplete, `should not be complete after ${JSON.stringify(word)}`).toBeFalsy();
      }
    }
  });

  test("test_multiple_emojis_no_tags", () => {
    // Sentence: 'Hello 😊 world 🎉 there!' with llm_text equal to the sentence.
    //
    // Two emojis at different positions in the sentence; each gets its own
    // raw_consumed span and neither disrupts the alnum cursor for the words
    // that follow.
    const sentence = "Hello 😊 world 🎉 there!";
    const words = ["Hello", "😊", "world", "🎉", "there!"];
    const expectedFrameWords = ["Hello", "😊", "world", "🎉", "there!"];
    const expectedRawConsumed = ["Hello", "😊", "world", "🎉", "there!"]; // no leading tag
    const tracker = new WordCompletionTracker(sentence, { llmText: sentence });
    for (const [i, word] of words.entries()) {
      const isComplete = tracker.addWordAndCheckComplete(word);
      _assertWord(tracker, word, expectedFrameWords[i], expectedRawConsumed[i], i);
      if (i === words.length - 1) {
        expect(
          isComplete,
          `should be complete after final word ${JSON.stringify(word)}`,
        ).toBeTruthy();
      } else {
        expect(isComplete, `should not be complete after ${JSON.stringify(word)}`).toBeFalsy();
      }
    }
  });

  test("test_emoji_absent_from_llm_text_returns_none", () => {
    // Sentence: 'See you soon 😊' but llm_text omits the emoji.
    //
    // The emoji is the last token the TTS returns for this frame. The alnum
    // content ('seeyousoon') is already complete after 'soon', so llm_text is
    // exhausted. The safeguard must set raw_consumed to None because the swept
    // span is empty and does not contain '😊'.
    const sentence = "See you soon 😊";
    const llmText = "<note>See you soon</note>";
    const words = ["See", "you", "soon", "😊"];
    const expectedFrameWords = ["See", "you", "soon", "😊"];
    const expectedRawConsumed = ["<note>See", "you", "soon</note>", null]; // opening tag consumed with first word
    const tracker = new WordCompletionTracker(sentence, { llmText: llmText });
    for (const [i, word] of words.entries()) {
      tracker.addWordAndCheckComplete(word);
      _assertWord(tracker, word, expectedFrameWords[i], expectedRawConsumed[i], i);
    }
    expect(tracker.isComplete).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerMultiAttributeSsmlTag", () => {
  // SSML tags whose opening tag contains internal whitespace (e.g. multiple
  // attributes) can arrive split across several TTS word-timestamp events, since
  // some providers tokenize on whitespace without tag awareness. ElevenLabs'
  // phoneme tag (``<phoneme alphabet="ipa" ph="...">word</phoneme>``, see
  // https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)
  // is a real-world example: the opening tag alone is reported as three separate
  // words (``<phoneme``, ``alphabet="ipa"``, then the closing ``ph="...">word...``).
  const TTS_TEXT = 'My name is <phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>.';
  // Fragments exactly as ElevenLabs reports them: the multi-attribute opening
  // tag is split at each internal space into its own "word".

  const WORDS = [
    "My",
    "name",
    "is",
    "<phoneme",
    'alphabet="ipa"',
    'ph="ʃəˈvɔːn">Siobhan</phoneme>.',
  ];

  test("test_tag_fragments_belong_to_the_frame", () => {
    // Each fragment of the still-open tag must be recognised as belonging
    // to this frame rather than routed elsewhere as passthrough.
    const tracker = new WordCompletionTracker(TTS_TEXT);
    for (const word of WORDS.slice(0, 3)) {
      tracker.addWordAndCheckComplete(word);
    }
    for (const [i, word] of WORDS.slice(3).entries()) {
      expect(
        tracker.wordBelongsHere(word),
        `${JSON.stringify(word)} is part of the open <phoneme> tag and must belong here`,
      ).toBeTruthy();
      const isComplete = tracker.addWordAndCheckComplete(word);
      if (i === WORDS.slice(3).length - 1) {
        expect(isComplete, "closing fragment should complete the frame").toBeTruthy();
      } else {
        expect(isComplete).toBeFalsy();
      }
    }
  });

  test("test_does_not_force_complete_on_tag_open_fragment", () => {
    // The opening '<phoneme' fragment must not force-complete the slot —
    // the tag isn't closed yet, so 'Siobhan' hasn't been spoken.
    const tracker = new WordCompletionTracker(TTS_TEXT);
    for (const word of WORDS.slice(0, 3)) {
      tracker.addWordAndCheckComplete(word);
    }
    const result = tracker.addWordAndCheckComplete("<phoneme");
    expect(result, "tag isn't closed yet; frame must not be complete").toBeFalsy();
  });

  test("test_completes_only_after_closing_fragment", () => {
    // Only the final fragment (which closes the tag) should complete the slot.
    const tracker = new WordCompletionTracker(TTS_TEXT);
    const results = WORDS.map((w) => tracker.addWordAndCheckComplete(w));
    expect(results).toEqual([false, false, false, false, false, true]);
  });

  test("test_llm_consumed_maps_tag_fragments_to_original_word", () => {
    // With llm_text tracking, the tag fragments must all map back to the
    // single original word 'Siobhan.' rather than losing the span.
    const llmText = "My name is Siobhan.";
    const tracker = new WordCompletionTracker(TTS_TEXT, { llmText: llmText });
    for (const word of WORDS.slice(0, -1)) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.addWordAndCheckComplete(WORDS.at(-1)!)).toBeTruthy();
    expect(tracker.getLlmConsumed()).toEqual("Siobhan.");
  });
});

describe("TestWordCompletionTrackerRemainingText", () => {
  // Tests for get_remaining_tts_text() and get_remaining_llm_text().
  //
  // These methods expose the unspoken suffix of tts_text / llm_text so that
  // _force_complete_spoken_slots() can emit a TTSTextFrame for any words that the
  // TTS provider dropped without sending a word-timestamp event.
  // ------------------------------------------------------------------ #
  // get_remaining_text                                                    #
  // ------------------------------------------------------------------ #
  test("test_remaining_text_before_any_words", () => {
    // Before any words arrive, the full expected text is remaining.
    const tracker = new WordCompletionTracker("hello world");
    expect(tracker.getRemainingTtsText()).toEqual("hello world");
  });

  test("test_remaining_text_after_partial_consumption", () => {
    // After one word is consumed, only the unspoken suffix is returned.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getRemainingTtsText()).toEqual("world");
  });

  test("test_remaining_text_after_completion", () => {
    // After full completion get_remaining_text returns an empty string.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getRemainingTtsText()).toEqual("");
  });

  test("test_remaining_text_strips_whitespace", () => {
    // Leading/trailing whitespace in the remaining portion is stripped.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    // The tts_text suffix before stripping is " world".
    const result = tracker.getRemainingTtsText();
    expect(result).toEqual("world");
    expect(result.startsWith(" ")).toBeFalsy();
  });

  test("test_remaining_text_preserves_punctuation", () => {
    // Punctuation inside the remaining text is not removed.
    const tracker = new WordCompletionTracker("Hello, world!");
    tracker.addWordAndCheckComplete("Hello,");
    expect(tracker.getRemainingTtsText()).toEqual("world!");
  });

  test("test_remaining_text_after_force_complete", () => {
    // Force-completing the slot exhausts expected_raw_pos; remaining becomes empty.
    const tracker = new WordCompletionTracker("number is");
    tracker.addWordAndCheckComplete("4111"); // force-complete
    expect(tracker.isComplete).toBeTruthy();
    expect(tracker.getRemainingTtsText()).toEqual("number is");
  });

  test("test_remaining_text_resets_after_reset", () => {
    // reset() resets expected_raw_pos; get_remaining_text returns the full text again.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getRemainingTtsText()).toEqual("");
    tracker.reset();
    expect(tracker.getRemainingTtsText()).toEqual("hello world");
  });
  // ------------------------------------------------------------------ #
  // get_remaining_llm_text                                                #
  // ------------------------------------------------------------------ #

  test("test_remaining_llm_text_none_when_no_llm_text", () => {
    // Without llm_text, get_remaining_llm_text always returns None.
    const tracker = new WordCompletionTracker("hello world");
    expect(tracker.getRemainingLlmText()).toBeNull();
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getRemainingLlmText()).toBeNull();
  });

  test("test_remaining_llm_text_before_any_words", () => {
    // Before any words, the entire llm_text is remaining.
    const raw = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111", { llmText: raw });
    expect(tracker.getRemainingLlmText()).toEqual(raw);
  });

  test("test_remaining_llm_text_after_partial_consumption", () => {
    // After one word, the raw cursor is past its span; only the tail is remaining.
    const raw = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111", { llmText: raw });
    tracker.addWordAndCheckComplete("4111");
    // raw_pos moves past "<card>4111" (10 chars); remaining = " 1111</card>" → strip → "1111</card>"
    expect(tracker.getRemainingLlmText()).toEqual("1111</card>");
  });

  test("test_remaining_llm_text_none_after_completion", () => {
    // After full completion all llm_text is consumed; remaining is None.
    const raw = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111", { llmText: raw });
    tracker.addWordAndCheckComplete("4111");
    tracker.addWordAndCheckComplete("1111");
    expect(tracker.getRemainingLlmText()).toBeNull();
  });

  test("test_remaining_llm_text_resets_after_reset", () => {
    // reset() resets the raw cursor; get_remaining_llm_text returns the full llm_text again.
    const raw = "<card>hello world</card>";
    const tracker = new WordCompletionTracker("hello world", { llmText: raw });
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getRemainingLlmText()).toBeNull();
    tracker.reset();
    expect(tracker.getRemainingLlmText()).toEqual(raw);
  });

  test("test_remaining_llm_text_strips_whitespace", () => {
    // Leading/trailing whitespace in the remaining raw portion is stripped.
    const raw = "<card>hello world</card>";
    const tracker = new WordCompletionTracker("hello world", { llmText: raw });
    tracker.addWordAndCheckComplete("hello");
    // raw_pos is past "<card>hello" (11 chars); raw suffix = " world</card>" → strip
    const result = tracker.getRemainingLlmText();
    expect(result).not.toBeNull();
    expect(result!.startsWith(" ")).toBeFalsy();
    expect(result).toEqual("world</card>");
  });

  test("test_remaining_llm_text_after_force_complete", () => {
    // Force-complete sweeps all llm_text; remaining is None afterwards.
    const raw = "<card>4111 1111 1111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: raw,
    });
    tracker.addWordAndCheckComplete("4111");
    tracker.addWordAndCheckComplete("WRONG"); // force-complete
    expect(tracker.isComplete).toBeTruthy();
    expect(tracker.getRemainingLlmText()).toBeNull();
  });
});

describe("TestWordCompletionTrackerAccumulatedText", () => {
  // Tests for get_accumulated_tts_text() and get_accumulated_llm_text().
  //
  // These methods return the prefix of tts_text / llm_text that has already been
  // consumed by word-timestamp events — the complement of get_remaining_tts_text()
  // and get_remaining_llm_text() which return the unspoken suffix.
  // ------------------------------------------------------------------ #
  // get_accumulated_tts_text                                              #
  // ------------------------------------------------------------------ #
  test("test_accumulated_tts_text_before_any_words", () => {
    // Before any words arrive, nothing has been consumed.
    const tracker = new WordCompletionTracker("hello world");
    expect(tracker.getAccumulatedTtsText()).toEqual("");
  });

  test("test_accumulated_tts_text_after_partial_consumption", () => {
    // After one word the accumulated prefix covers exactly that word.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getAccumulatedTtsText()).toEqual("hello");
  });

  test("test_accumulated_tts_text_after_completion", () => {
    // After all words, the entire tts_text is accumulated.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getAccumulatedTtsText()).toEqual("hello world");
  });

  test("test_accumulated_tts_text_includes_trailing_punctuation", () => {
    // The TTS cursor consumes trailing punctuation, so it appears in the accumulated span.
    const tracker = new WordCompletionTracker("Hello, world!");
    tracker.addWordAndCheckComplete("Hello,");
    expect(tracker.getAccumulatedTtsText()).toEqual("Hello,");
  });

  test("test_accumulated_tts_text_complements_remaining", () => {
    // accumulated + stripped-whitespace + remaining reconstructs tts_text.
    const ttsText = "hello world";
    const tracker = new WordCompletionTracker(ttsText);
    tracker.addWordAndCheckComplete("hello");
    const accumulated = tracker.getAccumulatedTtsText();
    const remaining = tracker.getRemainingTtsText();
    // The space between tokens is stripped from remaining, so re-join with one.
    expect(`${accumulated} ${remaining}`).toEqual(ttsText);
  });

  test("test_accumulated_tts_text_after_force_complete", () => {
    // Force-complete does not advance the TTS cursor; accumulated stays at the
    // point reached before the mismatched word arrived.
    const tracker = new WordCompletionTracker("number is");
    tracker.addWordAndCheckComplete("number");
    tracker.addWordAndCheckComplete("4111"); // force-complete
    expect(tracker.getAccumulatedTtsText()).toEqual("number");
  });

  test("test_accumulated_tts_text_resets_after_reset", () => {
    // reset() resets the TTS cursor; accumulated returns empty string again.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getAccumulatedTtsText()).toEqual("hello world");
    tracker.reset();
    expect(tracker.getAccumulatedTtsText()).toEqual("");
  });
  // ------------------------------------------------------------------ #
  // get_accumulated_llm_text                                              #
  // ------------------------------------------------------------------ #

  test("test_accumulated_llm_text_none_when_no_llm_text", () => {
    // Without llm_text, get_accumulated_llm_text always returns None.
    const tracker = new WordCompletionTracker("hello world");
    expect(tracker.getAccumulatedLlmText()).toBeNull();
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getAccumulatedLlmText()).toBeNull();
  });

  test("test_accumulated_llm_text_before_any_words", () => {
    // Before any words, nothing has been consumed from llm_text.
    const tracker = new WordCompletionTracker("4111 1111", {
      llmText: "<card>4111 1111</card>",
    });
    expect(tracker.getAccumulatedLlmText()).toEqual("");
  });

  test("test_accumulated_llm_text_after_partial_consumption", () => {
    // After one word, the consumed prefix includes the opening tag and first word.
    const tracker = new WordCompletionTracker("4111 1111", {
      llmText: "<card>4111 1111</card>",
    });
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getAccumulatedLlmText()).toEqual("<card>4111");
  });

  test("test_accumulated_llm_text_after_completion", () => {
    // After all words, the entire llm_text is accumulated (closing tag included).
    const tracker = new WordCompletionTracker("4111 1111", {
      llmText: "<card>4111 1111</card>",
    });
    tracker.addWordAndCheckComplete("4111");
    tracker.addWordAndCheckComplete("1111");
    expect(tracker.getAccumulatedLlmText()).toEqual("<card>4111 1111</card>");
  });

  test("test_accumulated_llm_text_complements_remaining", () => {
    // accumulated + stripped-whitespace + remaining reconstructs llm_text.
    const llm = "<card>4111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111", { llmText: llm });
    tracker.addWordAndCheckComplete("4111");
    const accumulated = tracker.getAccumulatedLlmText();
    const remaining = tracker.getRemainingLlmText();
    expect(`${accumulated!.trimEnd()} ${remaining}`).toEqual(llm);
  });

  test("test_accumulated_llm_text_after_force_complete", () => {
    // Force-complete sweeps all remaining llm_text; accumulated covers the full string.
    const llm = "<card>4111 1111 1111 1111</card>";
    const tracker = new WordCompletionTracker("4111 1111 1111 1111", {
      llmText: llm,
    });
    tracker.addWordAndCheckComplete("4111");
    tracker.addWordAndCheckComplete("WRONG"); // force-complete sweeps remaining llm_text
    expect(tracker.getAccumulatedLlmText()).toEqual(llm);
  });

  test("test_accumulated_llm_text_resets_after_reset", () => {
    // reset() resets the LLM cursor; accumulated returns empty string again.
    const tracker = new WordCompletionTracker("hello world", {
      llmText: "<card>hello world</card>",
    });
    tracker.addWordAndCheckComplete("hello");
    tracker.addWordAndCheckComplete("world");
    expect(tracker.getAccumulatedLlmText()).toEqual("<card>hello world</card>");
    tracker.reset();
    expect(tracker.getAccumulatedLlmText()).toEqual("");
  });
});

describe("TestUserFacingText", () => {
  // Tests for get_accumulated_user_facing_text() and get_remaining_user_facing_text().
  //
  // Uses a credit-card number scenario where tts_text has SSML tags, llm_text has
  // pattern delimiters, and user_facing_text is the plain user-visible string.
  const TTS_TEXT = "<spell>4111 1111 1111 1111</spell>";

  const LLM_TEXT = "<card>4111 1111 1111 1111</card>";

  const USER_FACING_TEXT = "4111 1111 1111 1111";

  const WORDS = ["4111", "1111", "1111", "1111"];

  function _tracker() {
    return new WordCompletionTracker(TTS_TEXT, {
      llmText: LLM_TEXT,
      userFacingText: USER_FACING_TEXT,
    });
  }

  test("test_defaults_to_tts_text_when_not_provided", () => {
    // When user_facing_text is omitted, the cursor tracks tts_text instead.
    const tracker = new WordCompletionTracker("hello world");
    tracker.addWordAndCheckComplete("hello");
    expect(tracker.getAccumulatedUserFacingText()).toEqual(tracker.getAccumulatedTtsText());
  });

  test("test_before_any_words_accumulated_is_empty", () => {
    const tracker = _tracker();
    expect(tracker.getAccumulatedUserFacingText()).toEqual("");
  });

  test("test_before_any_words_remaining_is_full_text", () => {
    const tracker = _tracker();
    expect(tracker.getRemainingUserFacingText()).toEqual(USER_FACING_TEXT);
  });

  test("test_user_facing_differs_from_tts_after_first_word", () => {
    // The SSML opening tag means tts_text accumulated != user_facing accumulated.
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("4111");
    expect(tracker.getAccumulatedTtsText()).toEqual("<spell>4111");
  });

  test("test_word_by_word_accumulated_and_remaining", () => {
    // Check accumulated and remaining at each step through the card number.
    const tracker = _tracker();
    const expected = [
      ["4111", " 1111 1111 1111"],
      ["4111 1111", " 1111 1111"],
      ["4111 1111 1111", " 1111"],
      ["4111 1111 1111 1111", ""],
    ];
    for (const [word, [expAcc, expRem]] of WORDS.map(
      (_x, _i) => [WORDS[_i], expected[_i]] as const,
    )) {
      tracker.addWordAndCheckComplete(word);
      expect(tracker.getAccumulatedUserFacingText()).toEqual(expAcc);
      expect(tracker.getRemainingUserFacingText(false)).toEqual(expRem);
    }
  });

  test("test_accumulated_plus_remaining_reconstructs_user_facing_text", () => {
    // accumulated + remaining(strip=False) == user_facing_text at every step.
    const tracker = _tracker();
    for (const word of WORDS) {
      tracker.addWordAndCheckComplete(word);
      const acc = tracker.getAccumulatedUserFacingText();
      const rem = tracker.getRemainingUserFacingText(false);
      expect(acc + rem).toEqual(USER_FACING_TEXT);
    }
  });

  test("test_force_complete_sets_accumulated_to_full_text", () => {
    // Force-completing the slot (mismatched word) sweeps user_facing fully accumulated.
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("4111");
    tracker.addWordAndCheckComplete("WRONG"); // force-complete
    expect(tracker.isComplete).toBeTruthy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual(USER_FACING_TEXT);
    expect(tracker.getRemainingUserFacingText()).toEqual("");
  });

  test("test_reset_clears_user_facing_pos", () => {
    // reset() resets the user_facing cursor; accumulated returns empty string again.
    const tracker = _tracker();
    for (const word of WORDS) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(USER_FACING_TEXT);
    tracker.reset();
    expect(tracker.getAccumulatedUserFacingText()).toEqual("");
    expect(tracker.getRemainingUserFacingText()).toEqual(USER_FACING_TEXT);
  });
});

describe("TestUserFacingTextStrayAngleBracket", () => {
  // A literal '<' with no matching '>' in tts_text (e.g. an emoticon like "<3")
  // is real content, not a truncated SSML tag. When user_facing_text is omitted,
  // the default derived from tts_text must not silently drop everything after it.
  test("test_default_user_facing_text_keeps_text_after_stray_bracket", () => {
    const text = "I love you <3 always";
    const tracker = new WordCompletionTracker(text);
    for (const word of text.trim().split(/\s+/)) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });
});

describe("TestWordBelongsHereLiteralAngleBracketWord", () => {
  // End-to-end companion to
  // TestClassifyHopLiteralMatchHandlesStrayAngleBracket (test_text_segment_map.py):
  // a literal '<3' arriving as its own word-timestamp token, mid-stream, is
  // recognized by literal matching and consumed normally -- not rejected as
  // an unrecognized word, and not force-completing the frame.
  test("test_literal_angle_bracket_word_belongs_and_does_not_force_complete", () => {
    const text = "I love you <3 always";
    const tracker = new WordCompletionTracker(text);
    for (const word of ["I", "love", "you"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.wordBelongsHere("<3")).toBeTruthy();
    let complete = tracker.addWordAndCheckComplete("<3");
    expect(complete).toBeFalsy();
    expect(tracker.getOverflowWord()).toBeNull();
    complete = tracker.addWordAndCheckComplete("always");
    expect(complete).toBeTruthy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });
});

describe("TestWordCompletionTrackerUnicodeSymbolSubstitution", () => {
  // Guards against the regression where ElevenLabs maps Unicode symbols such
  // as '→' to ASCII punctuation like '-' in word-timestamp events.
  //
  // The literal-substring check in TextSegmentMap._symbol_belongs_here failed to find '-'
  // inside '→ Santiago…', which caused premature force-completion of the whole
  // frame after 'Paulo' was consumed.  The symbol-substitution fallback (check
  // whether the next non-space char in the TTS text is itself a non-alnum symbol)
  // must accept the substituted '-' and keep the tracker running normally.
  // The exact sentence that revealed the bug.
  const SENTENCE = "- Example route: São Paulo → Santiago (Chile) → Auckland (New Zealand).";
  // Words as ElevenLabs emits them: both '→' chars are reported as '-'.

  const ELEVENLABS_WORDS = [
    "-",
    "Example",
    "route:",
    "São",
    "Paulo",
    "-",
    "Santiago",
    "(Chile)",
    "-",
    "Auckland",
    "(New",
    "Zealand).",
  ];

  test("test_arrow_as_dash_belongs_here_before_first_arrow", () => {
    // After consuming up to 'Paulo', word_belongs_here('-') must return True.
    //
    // The next character in the TTS text is '→'.  ElevenLabs sends '-' instead;
    // the symbol-substitution fallback must accept it without force-completing.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of ["-", "Example", "route:", "São", "Paulo"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.wordBelongsHere("-")).toBeTruthy();
  });

  test("test_first_arrow_substitution_does_not_force_complete", () => {
    // Processing '-' in place of the first '→' must not complete the tracker.
    //
    // Without the fix, word_belongs_here('-') returned False here and the
    // force-complete path fired, marking the entire frame done prematurely.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of ["-", "Example", "route:", "São", "Paulo"]) {
      tracker.addWordAndCheckComplete(word);
    }
    const result = tracker.addWordAndCheckComplete("-");
    expect(result, "tracker must not be complete after the first → substitution").toBeFalsy();
    expect(tracker.isComplete).toBeFalsy();
  });

  test("test_arrow_as_dash_belongs_here_before_second_arrow", () => {
    // After consuming through '(Chile)', word_belongs_here('-') must return True again.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of ["-", "Example", "route:", "São", "Paulo", "-", "Santiago", "(Chile)"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.wordBelongsHere("-")).toBeTruthy();
  });

  test("test_completes_after_all_elevenlabs_words", () => {
    // Feeding the full ElevenLabs word-timestamp stream must complete the tracker.
    const tracker = new WordCompletionTracker(SENTENCE);
    const results = ELEVENLABS_WORDS.map((w) => tracker.addWordAndCheckComplete(w));
    expect(results.at(-1)!, "tracker should be complete after the last word").toBeTruthy();
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_only_last_word_triggers_completion", () => {
    // No intermediate word should complete the tracker.
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of ELEVENLABS_WORDS.slice(0, -1)) {
      const result = tracker.addWordAndCheckComplete(word);
      expect(result, `should not be complete after '${word}'`).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(ELEVENLABS_WORDS.at(-1)!)).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerCJK", () => {
  // Completion tracking for CJK scripts: Korean, Japanese, and Chinese.
  //
  // Korean words are fed one at a time (Cartesia returns each Hangul word as a
  // separate timestamp event). Japanese and Chinese characters are fed as
  // combined groups (Cartesia merges all chars in one timestamp message into a
  // single token before calling add_word_timestamps).
  // --- Korean ---
  test("test_korean_word_by_word_completion", () => {
    // Korean words fed one at a time complete the tracker correctly.
    const sentence = "저는 여러분의 AI 어시스턴트입니다.";
    const words = ["저는", "여러분의", "AI", "어시스턴트입니다."];
    const tracker = new WordCompletionTracker(sentence);
    for (const word of words.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(words.at(-1)!)).toBeTruthy();
  });

  test("test_korean_normalized_char_count_matches_raw_alnum", () => {
    // Each Hangul syllable must alnum_only to exactly one char.
    //
    // The NFKD decomposition would expand each syllable into 2-3 conjoining
    // jamo, making the normalized length much larger than the raw alnum count
    // and breaking the _advance_by_alnums cursor.  NFD-per-char normalization
    // must keep each syllable as a single character.
    const samples = ["저는여러분의", "안녕하세요", "어시스턴트"];
    for (const text of samples) {
      const rawCount = [...text].filter((c) => /^[\p{L}\p{N}]$/u.test(c)).length;
      const normCount = alnumOnly(text).length;
      expect(
        normCount,
        `alnum_only(${JSON.stringify(text)}): got ${normCount} chars, want ${rawCount}`,
      ).toEqual(rawCount);
    }
  });

  test("test_korean_force_complete_remaining_text_is_correct", () => {
    // After the first Korean word the TTS cursor is at the right position.
    //
    // get_remaining_tts_text() must return the unspoken suffix verbatim so
    // force_complete can emit a correct TTSTextFrame for it.
    const sentence = "저는 여러분의 AI 어시스턴트입니다.";
    const tracker = new WordCompletionTracker(sentence);
    tracker.addWordAndCheckComplete("저는");
    expect(tracker.getRemainingTtsText()).toEqual("여러분의 AI 어시스턴트입니다.");
  });

  test("test_korean_mixed_with_latin", () => {
    // Latin tokens (e.g. 'AI') embedded in Korean text are handled correctly.
    const sentence = "AI 어시스턴트입니다.";
    const tracker = new WordCompletionTracker(sentence);
    expect(tracker.addWordAndCheckComplete("AI")).toBeFalsy();
    expect(tracker.addWordAndCheckComplete("어시스턴트입니다.")).toBeTruthy();
  });

  test("test_korean_word_belongs_here", () => {
    // word_belongs_here distinguishes Korean words based on remaining content.
    const tracker = new WordCompletionTracker("저는 여러분의");
    expect(tracker.wordBelongsHere("저는")).toBeTruthy();
    // A word further into the frame belongs here too: its event arriving means
    // the ones before it were dropped, not that the frame has moved on.
    expect(tracker.wordBelongsHere("여러분의")).toBeTruthy();
    expect(tracker.wordBelongsHere("안녕하세요")).toBeFalsy();
    tracker.addWordAndCheckComplete("저는");
    expect(tracker.wordBelongsHere("여러분의")).toBeTruthy();
  });

  test("test_korean_word_after_a_dropped_event_takes_the_text_before_it", () => {
    // The event for "저는" never arrives, so the next word carries it.
    const tracker = new WordCompletionTracker("저는 여러분의");
    expect(tracker.addWordAndCheckComplete("여러분의")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("저는 여러분의");
  });
  // --- Japanese ---

  test("test_japanese_single_combined_group_completes", () => {
    // A single Cartesia-style combined group (all chars merged) completes the frame.
    // Cartesia merges ["こ","ん","に","ち","は","。"] into "こんにちは。"
    const tracker = new WordCompletionTracker("こんにちは。");
    expect(tracker.addWordAndCheckComplete("こんにちは。")).toBeTruthy();
  });

  test("test_japanese_multiple_groups_for_one_frame", () => {
    // Two Cartesia timestamp groups for one Japanese frame complete in sequence.
    const sentence = "こんにちは、私はあなたの";
    const tracker = new WordCompletionTracker(sentence);
    expect(tracker.addWordAndCheckComplete("こんにちは、私")).toBeFalsy();
    expect(tracker.addWordAndCheckComplete("はあなたの")).toBeTruthy();
  });

  test("test_japanese_force_complete_remaining_text", () => {
    // After the first Japanese group the cursor sits at the right position.
    const sentence = "こんにちは、私はあなたの";
    const tracker = new WordCompletionTracker(sentence);
    tracker.addWordAndCheckComplete("こんにちは、私");
    expect(tracker.getRemainingTtsText()).toEqual("はあなたの");
  });

  test("test_japanese_punctuation_not_counted_toward_completion", () => {
    // Japanese punctuation (。、) is not alphanumeric and must not block completion.
    const tracker = new WordCompletionTracker("こんにちは。");
    // "こんにちは" covers all 5 alnum chars; "。" adds 0.
    expect(tracker.addWordAndCheckComplete("こんにちは。")).toBeTruthy();
  });
  // --- Chinese ---

  test("test_chinese_single_combined_group_completes", () => {
    // A single Cartesia-style combined Chinese group completes the frame.
    // Cartesia merges ["你","好","，","我","是"] into "你好，我是"
    const tracker = new WordCompletionTracker("你好，我是");
    expect(tracker.addWordAndCheckComplete("你好，我是")).toBeTruthy();
  });

  test("test_chinese_multiple_groups_for_one_frame", () => {
    // Two Cartesia timestamp groups for one Chinese frame complete in sequence.
    const sentence = "你好，我是你的智能";
    const tracker = new WordCompletionTracker(sentence);
    expect(tracker.addWordAndCheckComplete("你好，我是")).toBeFalsy();
    expect(tracker.addWordAndCheckComplete("你的智能")).toBeTruthy();
  });

  test("test_chinese_force_complete_remaining_text", () => {
    // After the first Chinese group the cursor sits at the right position.
    const sentence = "你好，我是你的智能";
    const tracker = new WordCompletionTracker(sentence);
    tracker.addWordAndCheckComplete("你好，我是");
    expect(tracker.getRemainingTtsText()).toEqual("你的智能");
  });
});
// ---------------------------------------------------------------------------
// Voice-formatting transforms: segment-map cursor alignment
//
// Simulates the billing message scenario where currency expansion changes the
// alnum content:
//   user_facing / llm: "Your balance is $5, due on 3/15. Call us at 555-1234."
//   tts (post-transform): "Your balance is five dollars, due on 3/15. Call us at 555-1234."
//
// Segment map produced by SequenceMatcher:
//   Seg 1 (unchanged): "Your balance is "  →  "Your balance is "
//   Seg 2 (transformed): "$5,"  →  "five dollars,"
//   Seg 3 (unchanged): " due on 3/15. Call us at 555-1234."  →  same
// ---------------------------------------------------------------------------

const _BILLING_UF = "Your balance is $5, due on 3/15. Call us at 555-1234.";

const _BILLING_TTS = "Your balance is five dollars, due on 3/15. Call us at 555-1234.";

const _BILLING_WORDS = [
  "Your",
  "balance",
  "is",
  "five",
  "dollars,",
  "due",
  "on",
  "3/15.",
  "Call",
  "us",
  "at",
  "555-1234.",
];

describe("TestWordCompletionTrackerWithTransforms", () => {
  // Tracker behaviour when text transforms expand alnum content.
  function _tracker(llmText: string | null = null) {
    return new WordCompletionTracker(_BILLING_TTS, {
      llmText: llmText,
      userFacingText: _BILLING_UF,
    });
  }

  function _advance(tracker: WordCompletionTracker, ...words: string[]) {
    for (const word of words) {
      tracker.addWordAndCheckComplete(word);
    }
  }
  // --- segment map construction ---

  test("test_segment_map_built_when_alnum_differs", () => {
    // Segment map is created when tts_text and user_facing_text differ in alnum content.
    expect(_tracker()._segmentMap).not.toBeNull();
  });

  test("test_segment_map_always_built", () => {
    // A segment map is always built, regardless of whether alnum sequences differ.
    const tracker = new WordCompletionTracker("hello world");
    expect(tracker._segmentMap).toBeInstanceOf(TextSegmentMap);
  });
  // --- suppress_in_context ---

  test("test_suppress_false_before_transformed_segment", () => {
    // Words before the transformed segment are not suppressed.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is");
    expect(tracker.suppressInContext()).toBeFalsy();
  });

  test("test_suppress_true_mid_transformed_segment", () => {
    // 'five' is mid-flight inside the '$5,' segment — must be suppressed.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five");
    expect(tracker.suppressInContext()).toBeTruthy();
  });

  test("test_suppress_false_when_transformed_segment_completes", () => {
    // 'dollars,' completes the segment — must not be suppressed.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five", "dollars,");
    expect(tracker.suppressInContext()).toBeFalsy();
  });

  test("test_suppress_false_for_words_after_transform", () => {
    // Words after the transformed segment are not suppressed.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five", "dollars,", "due");
    expect(tracker.suppressInContext()).toBeFalsy();
  });

  test("test_suppress_false_after_reset", () => {
    // reset() clears segment map state so suppress_in_context returns False.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five");
    tracker.reset();
    expect(tracker.suppressInContext()).toBeFalsy();
  });
  // --- user-facing cursor alignment ---

  test("test_user_facing_pos_held_during_transformed_segment", () => {
    // user_facing_pos must not advance while 'five' is in the transformed segment.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is");
    const posAfterSeg1 = tracker._userFacingPos;
    tracker.addWordAndCheckComplete("five");
    expect(tracker._userFacingPos).toEqual(posAfterSeg1);
  });

  test("test_user_facing_pos_jumps_when_segment_completes", () => {
    // user_facing_pos jumps to end of '$5,' after 'dollars,' is processed.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five");
    const posBefore = tracker._userFacingPos;
    tracker.addWordAndCheckComplete("dollars,");
    const expected = _BILLING_UF.indexOf("$5,") + "$5,".length; // 16 + 3 = 19
    expect(tracker._userFacingPos).toEqual(expected);
    expect(tracker._userFacingPos).toBeGreaterThan(posBefore);
  });

  test("test_accumulated_user_facing_after_transform_segment", () => {
    // get_accumulated_user_facing_text() equals 'Your balance is $5,' after 'dollars,'.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five", "dollars,");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Your balance is $5,");
  });

  test("test_remaining_user_facing_after_transform_segment", () => {
    // get_remaining_user_facing_text() starts with 'due on 3/15.' after 'dollars,'.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five", "dollars,");
    const remaining = tracker.getRemainingUserFacingText(true);
    expect(remaining.startsWith("due on 3/15."), remaining).toBeTruthy();
    expect(remaining).toContain("555-1234.");
  });

  test("test_accumulated_plus_remaining_reconstructs_user_facing", () => {
    // Accumulated + remaining (strip=False) reconstructs the full user_facing_text.
    const tracker = _tracker();
    _advance(tracker, "Your", "balance", "is", "five", "dollars,");
    const acc = tracker.getAccumulatedUserFacingText();
    const rem = tracker.getRemainingUserFacingText(false);
    expect(acc + rem).toEqual(_BILLING_UF);
  });
  // --- completion ---

  test("test_non_completing_words_return_false", () => {
    // All words except the last return False from add_word_and_check_complete.
    const tracker = _tracker();
    for (const word of _BILLING_WORDS.slice(0, -1)) {
      expect(
        tracker.addWordAndCheckComplete(word),
        `word '${word}' should not complete`,
      ).toBeFalsy();
    }
  });

  test("test_last_word_completes", () => {
    // The final word '555-1234.' completes the tracker.
    const tracker = _tracker();
    for (const word of _BILLING_WORDS.slice(0, -1)) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.addWordAndCheckComplete(_BILLING_WORDS.at(-1)!)).toBeTruthy();
  });

  test("test_full_sentence_accumulated_user_facing_equals_original", () => {
    // After all words, accumulated user_facing_text equals the original string.
    const tracker = _tracker();
    for (const word of _BILLING_WORDS) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(_BILLING_UF);
  });
  // --- llm_text attribution ---

  test("test_mid_segment_llm_consumed_is_none", () => {
    // 'five' is in a transformed segment — llm_consumed must be None (suppressed).
    const tracker = _tracker(_BILLING_UF);
    _advance(tracker, "Your", "balance", "is");
    tracker.addWordAndCheckComplete("five");
    expect(tracker.getLlmConsumed()).toBeNull();
  });

  test("test_completing_word_llm_consumed_is_original_segment", () => {
    // 'dollars,' completing the segment carries '$5,' as llm_consumed.
    const tracker = _tracker(_BILLING_UF);
    _advance(tracker, "Your", "balance", "is", "five");
    tracker.addWordAndCheckComplete("dollars,");
    expect(tracker.getLlmConsumed()).toEqual("$5,");
  });

  test("test_unchanged_word_llm_consumed_matches_word", () => {
    // An unchanged word's llm_consumed contains that word.
    const tracker = _tracker(_BILLING_UF);
    tracker.addWordAndCheckComplete("Your");
    const llm = tracker.getLlmConsumed();
    expect(llm).not.toBeNull();
    expect(llm).toContain("Your");
  });

  test("test_post_transform_word_llm_consumed_matches_word", () => {
    // A word after the transformed segment has a valid llm_consumed.
    const tracker = _tracker(_BILLING_UF);
    _advance(tracker, "Your", "balance", "is", "five", "dollars,");
    tracker.addWordAndCheckComplete("due");
    const llm = tracker.getLlmConsumed();
    expect(llm).not.toBeNull();
    expect(llm).toContain("due");
  });
});

describe("TestWordCompletionTrackerTransformAtEndOfUtterance", () => {
  // Context attribution when a transformed segment falls at the end of an utterance.
  //
  // When a text transform expands a token (e.g. "$5" → "five dollars") and the
  // transformed span is the last thing spoken, the final TTS word ("dollars")
  // triggers the is_complete branch. That branch sweeps the remaining llm_text
  // ("$5") but then validates that the spoken word ("dollars") appears in the
  // sweep — which it doesn't. The sweep must be kept because "dollars" is the
  // expanded form of "$5", not a word that needs to appear verbatim in the
  // original.
  test("test_llm_consumed_preserved_when_final_word_completes_transformed_segment", () => {
    // llm_consumed must be the original token, not None, when the utterance ends on a transform.
    const tracker = new WordCompletionTracker("Your total is five dollars", {
      llmText: "Your total is $5",
      userFacingText: "Your total is $5",
    }); // post-transform TTS text
    tracker.addWordAndCheckComplete("Your");
    tracker.addWordAndCheckComplete("total");
    tracker.addWordAndCheckComplete("is");
    tracker.addWordAndCheckComplete("five"); // mid-transform, suppressed
    const result = tracker.addWordAndCheckComplete("dollars"); // completes transform + utterance
    expect(result, "tracker should be complete after 'dollars'").toBeTruthy();
    expect(
      tracker.getLlmConsumed(),
      "llm_consumed must not be None when the final word completes a transformed segment",
    ).not.toBeNull();
    expect(tracker.getLlmConsumed()).toEqual("$5");
  });

  test("test_llm_consumed_correct_for_single_word_transform_at_end", () => {
    // Single-word transform ending the utterance: llm_consumed is the original token.
    const tracker = new WordCompletionTracker("Price is five dollars", {
      llmText: "Price is $5",
      userFacingText: "Price is $5",
    });
    tracker.addWordAndCheckComplete("Price");
    tracker.addWordAndCheckComplete("is");
    tracker.addWordAndCheckComplete("five");
    const result = tracker.addWordAndCheckComplete("dollars");
    expect(result).toBeTruthy();
    expect(tracker.getLlmConsumed()).not.toBeNull();
    expect(tracker.getLlmConsumed()).toEqual("$5");
  });

  test("test_transform_at_end_with_llm_tags_sweeps_closing_tag", () => {
    // Transform at end with surrounding XML tags: closing tag must be swept into llm_consumed.
    const tracker = new WordCompletionTracker("Total is fifty percent", {
      llmText: "<price>Total is 50%</price>",
      userFacingText: "Total is 50%",
    }); // "50%" → "fifty percent"
    tracker.addWordAndCheckComplete("Total");
    tracker.addWordAndCheckComplete("is");
    tracker.addWordAndCheckComplete("fifty");
    const result = tracker.addWordAndCheckComplete("percent");
    expect(result).toBeTruthy();
    expect(tracker.getLlmConsumed()).not.toBeNull();
    expect(tracker.getLlmConsumed()).toContain("50%");
  });

  test("test_mid_sentence_transform_llm_consumed_is_unaffected", () => {
    // Mid-sentence transform behaviour must be preserved alongside the end-of-utterance fix.
    const tracker = new WordCompletionTracker("Your balance is five dollars due now", {
      llmText: "Your balance is $5 due now",
      userFacingText: "Your balance is $5 due now",
    });
    tracker.addWordAndCheckComplete("Your");
    tracker.addWordAndCheckComplete("balance");
    tracker.addWordAndCheckComplete("is");
    tracker.addWordAndCheckComplete("five");
    expect(tracker.getLlmConsumed()).toBeNull(); // suppressed mid-transform
    tracker.addWordAndCheckComplete("dollars");
    expect(tracker.getLlmConsumed()).toEqual("$5"); // segment completes
    tracker.addWordAndCheckComplete("due");
    expect(tracker.getLlmConsumed()).not.toBeNull();
    tracker.addWordAndCheckComplete("now");
    expect(tracker.isComplete).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerTokenChangingReplacements", () => {
  // Whether get_llm_consumed() preserves the original text when a replacement
  // changes tokenization or case instead of falling back to the spoken word.
  //
  // A replacement that splits one word into several (e.g. ``"BODYPUMP"`` ->
  // ``"body pump"``) is tracked as a transformed segment: intermediate words
  // are suppressed (``get_llm_consumed()`` returns None, mirroring how
  // currency expansion already behaves) and the word that completes the
  // segment carries the full original text. A replacement that only changes
  // case or the connector between words (e.g. ``"SQL"`` -> ``"sql"``, or
  // ``"BODYPUMP"`` -> ``"body-pump"``) keeps proportional, per-word tracking,
  // but is validated case- and connector-insensitively so it isn't discarded.
  // Single-word-to-single-word replacements that change the normalized alnum
  // length (e.g. "leisure" -> "lezher") are unaffected and are included here as
  // passing control cases.
  test("test_word_splitting_replacement_commits_original_on_completion", () => {
    // "BODYPUMP" -> "body pump": audio is correct; the segment is tracked
    // atomically, so "body" is suppressed and "pump" carries the full
    // original word, matching how currency expansion already behaves.
    const sentence = "Try BODYPUMP on Monday morning.";
    const ttsText = "Try body pump on Monday morning.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    tracker.addWordAndCheckComplete("Try");
    tracker.addWordAndCheckComplete("body");
    expect(tracker.getLlmConsumed()).toBeNull(); // suppressed mid-transform
    expect(tracker.suppressInContext()).toBeTruthy();
    tracker.addWordAndCheckComplete("pump");
    expect(tracker.getLlmConsumed()).toEqual("BODYPUMP");
    expect(tracker.suppressInContext()).toBeFalsy();
    for (const word of ["on", "Monday", "morning."]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_case_only_replacement_is_not_discarded", () => {
    // "SQL" -> "sql": same single-token structure, only case differs. The
    // span-containment check is case-insensitive, so it validates.
    const sentence = "Contact SQL support today.";
    const ttsText = "Contact sql support today.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    tracker.addWordAndCheckComplete("Contact");
    tracker.addWordAndCheckComplete("sql");
    expect(tracker.getLlmConsumed()).toEqual("SQL");
    tracker.addWordAndCheckComplete("support");
    tracker.addWordAndCheckComplete("today.");
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_hyphenated_single_token_replacement_is_not_discarded", () => {
    // "BODYPUMP" -> "body-pump": single token on both sides, only case+shape differ.
    const sentence = "Try BODYPUMP on Monday morning.";
    const ttsText = "Try body-pump on Monday morning.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    tracker.addWordAndCheckComplete("Try");
    tracker.addWordAndCheckComplete("body-pump");
    expect(tracker.getLlmConsumed()).toEqual("BODYPUMP");
  });

  test("test_accumulated_llm_text_matches_original_despite_split", () => {
    // The cursor ends up past the full original sentence once the frame
    // completes, even though the replacement split one word into two.
    const sentence = "Try BODYPUMP on Monday morning.";
    const ttsText = "Try body pump on Monday morning.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    for (const word of ttsText.trim().split(/\s+/)) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedLlmText()).toEqual(sentence);
  });

  test("test_single_word_case_change_with_different_length_still_works", () => {
    // Control case: "HIIT" -> "hit" differs in alnum length, so it takes
    // the atomic transformed-segment path regardless of case.
    const sentence = "We run HIIT classes on Tuesday.";
    const ttsText = "We run hit classes on Tuesday.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    for (const word of ["We", "run", "hit"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getLlmConsumed()).toContain("HIIT");
    for (const word of ["classes", "on", "Tuesday."]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.isComplete).toBeTruthy();
  });

  test("test_single_word_pronunciation_replacement_still_works", () => {
    // Control case: a 1-to-1 respelling ("leisure" -> "lezher") that
    // differs in alnum length maps back to the original word correctly.
    const sentence = "The leisure centre opens at six.";
    const ttsText = "The lezher centre opens at six.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    for (const word of ["The", "lezher"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getLlmConsumed()).toContain("leisure");
  });

  test("test_inline_ipa_tag_does_not_shift_next_word_boundary", () => {
    // An inline IPA substitution ("leisure" -> "<<l|ɛ|ʒ|ə|r>>") normalizes
    // to no alnum content on the TTS side, since alnum_only()'s tag-stripping
    // regex treats the double angle brackets as a single (malformed) tag.
    // That must not corrupt the word boundary of the following word.
    const sentence = "The leisure centre opens at six.";
    const ttsText = "The <<l|ɛ|ʒ|ə|r>> centre opens at six.";
    const tracker = new WordCompletionTracker(ttsText, {
      llmText: sentence,
      userFacingText: sentence,
    });
    tracker.addWordAndCheckComplete("The");
    tracker.addWordAndCheckComplete("<<l|ɛ|ʒ|ə|r>>");
    tracker.addWordAndCheckComplete("centre");
    expect(
      tracker.getLlmConsumed(),
      "the word following an inline IPA substitution must keep its own span, not have letters stolen from it",
    ).toEqual("centre");
  });
});

describe("TestWordCompletionTrackerSpaceBeforePunctuation", () => {
  // Typography that separates a word from its terminal punctuation by a space.
  //
  // French (and other locales) put a space before ``?`` ``!`` ``:`` ``;`` --
  // e.g. "Comment ça va ?". advance_by_alnums stops at that space, so once the
  // final alnum word is spoken the cursor must still be snapped to end-of-text:
  // otherwise the remaining text never empties, the segment stays "in-progress"
  // forever, and RTVI clients that commit captions on the "completed" status
  // drop the sentence when the next one begins.
  test("test_question_mark_completes_and_empties_remaining", () => {
    const tracker = new WordCompletionTracker("Comment ça va ?");
    tracker.addWordAndCheckComplete("Comment");
    tracker.addWordAndCheckComplete("ça");
    expect(tracker.addWordAndCheckComplete("va")).toBeFalsy();
    expect(tracker.getRemainingUserFacingText(false)).toEqual(" ?");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Comment ça va");
    expect(tracker.addWordAndCheckComplete("?")).toBeTruthy();
  });

  test("test_exclamation_mark_completes_and_empties_remaining", () => {
    const tracker = new WordCompletionTracker("Bonjour !");
    expect(tracker.addWordAndCheckComplete("Bonjour")).toBeFalsy();
    expect(tracker.getRemainingUserFacingText(false)).toEqual(" !");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Bonjour");
    expect(tracker.addWordAndCheckComplete("!")).toBeTruthy();
  });

  test("test_no_break_space_before_question_mark", () => {
    const tracker = new WordCompletionTracker("Ça va ?");
    tracker.addWordAndCheckComplete("Ça");
    expect(tracker.addWordAndCheckComplete("va")).toBeFalsy();
    expect(tracker.getRemainingUserFacingText(false)).toEqual(" ?");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Ça va");
    expect(tracker.addWordAndCheckComplete(" ?")).toBeTruthy();
  });

  test("test_user_facing_text_carries_trailing_mark", () => {
    const tracker = new WordCompletionTracker("Comment ça va ?", {
      userFacingText: "Comment ça va ?",
    });
    tracker.addWordAndCheckComplete("Comment");
    tracker.addWordAndCheckComplete("ça");
    expect(tracker.addWordAndCheckComplete("va")).toBeFalsy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Comment ça va");
    expect(tracker.addWordAndCheckComplete("?")).toBeTruthy();
  });

  test("test_english_trailing_punctuation_unchanged", () => {
    // The no-space English case still completes exactly as before.
    const tracker = new WordCompletionTracker("How are you?");
    tracker.addWordAndCheckComplete("How");
    tracker.addWordAndCheckComplete("are");
    expect(tracker.addWordAndCheckComplete("you")).toBeTruthy();
    expect(tracker.getRemainingUserFacingText(false)).toEqual("");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("How are you?");
  });

  test("test_mid_sentence_colon_drains_immediately", () => {
    // A separated ``:`` mid-sentence appears in the caption as soon as it is spoken.
    //
    // Unlike a terminal mark, a mid-sentence ``:`` (or ``;``) is followed by
    // more content in the same segment, so the cursor must advance past it on
    // its own word rather than lagging until the next alnum word sweeps by.
    const tracker = new WordCompletionTracker("Attention : ceci est un test");
    tracker.addWordAndCheckComplete("Attention");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Attention");
    tracker.addWordAndCheckComplete(":");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Attention :");
    tracker.addWordAndCheckComplete("ceci");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Attention : ceci");
  });

  test("test_multi_sentence_question_mark_drains_immediately", () => {
    // A separated ``?`` between two sentences in one chunk drains on its own word.
    const tracker = new WordCompletionTracker("Comment ça va ? Bien merci.");
    for (const word of ["Comment", "ça", "va"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Comment ça va");
    expect(tracker.addWordAndCheckComplete("?")).toBeFalsy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Comment ça va ?");
    tracker.addWordAndCheckComplete("Bien");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Comment ça va ? Bien");
  });
});

describe("TestWordCompletionTrackerAddedTerminalPunctuation", () => {
  // Some TTS providers append terminal punctuation absent from the source text.
  //
  // e.g. reading a multi-line list of options, a provider may speak each line as
  // its own sentence and report a word-timestamp word like "account." even though
  // the source text has "account" followed by a newline, not a period. Without
  // tolerating this, the tracker permanently desyncs on the first such word and
  // every later word is rejected too.
  const SENTENCE =
    "To better assist you, please choose one of the following options:\n\n        A. I need help with my account\n        B. I have a question about billing\n        C. I need technical support\n\n        Which option fits your needs best?";
  // Words as Cartesia (and similar providers) report them: a period appended
  // to the last word of each list line, which the source text does not have.

  const TTS_WORDS = [
    "To",
    "better",
    "assist",
    "you,",
    "please",
    "choose",
    "one",
    "of",
    "the",
    "following",
    "options:",
    "A.",
    "I",
    "need",
    "help",
    "with",
    "my",
    "account.",
    "B.",
    "I",
    "have",
    "a",
    "question",
    "about",
    "billing.",
    "C.",
    "I",
    "need",
    "technical",
    "support.",
    "Which",
    "option",
    "fits",
    "your",
    "needs",
    "best?",
  ];

  test("test_all_words_recognised_despite_added_period", () => {
    // No word should be rejected just because the TTS added a period.
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    for (const word of TTS_WORDS) {
      expect(
        tracker.wordBelongsHere(word),
        `word ${JSON.stringify(word)} should be recognised despite the added period`,
      ).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
  });

  test("test_completes_after_last_word", () => {
    // The tracker must reach completion once the final word arrives.
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    for (const word of TTS_WORDS.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(TTS_WORDS.at(-1)!)).toBeTruthy();
  });

  test("test_no_force_complete_desync", () => {
    // Once desynced, every later word used to fail too -- verify recovery.
    //
    // The bug produced a permanent desync: the first mismatched word forced
    // the segment map's cursor to stall, so every subsequent word was also
    // rejected as not belonging. Asserting on the middle-of-list words (not
    // just the last) guards against a fix that only patches the first hop.
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    for (const word of TTS_WORDS.slice(0, 17)) {
      // up to "my", just before "account."
      tracker.addWordAndCheckComplete(word);
    }
    for (const word of TTS_WORDS.slice(17)) {
      // "account." onward
      expect(
        tracker.wordBelongsHere(word),
        `word ${JSON.stringify(word)} incorrectly rejected after the 'account.' hop`,
      ).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
  });
});

describe("TestWordCompletionTrackerCaseFolding", () => {
  // Some TTS providers lowercase a word in word-timestamp events.
  //
  // e.g. an acronym like "SQL" in the source text may be reported back as
  // "sql". Without tolerating this, the tracker desyncs the same way it did
  // for added terminal punctuation.
  const SENTENCE = "Please open the SQL database now.";

  const TTS_WORDS = ["Please", "open", "the", "sql", "database", "now."];

  test("test_all_words_recognised_despite_case_difference", () => {
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS) {
      expect(
        tracker.wordBelongsHere(word),
        `word ${JSON.stringify(word)} should be recognised despite the case difference`,
      ).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
  });

  test("test_completes_after_last_word", () => {
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(TTS_WORDS.at(-1)!)).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerAccentFolding", () => {
  // Some TTS providers strip diacritics from a word in word-timestamp events.
  //
  // e.g. "café" in the source text may be reported back as "cafe". Without
  // tolerating this, the tracker desyncs the same way it did for added
  // terminal punctuation.
  const SENTENCE = "Bienvenue au café parisien.";

  const TTS_WORDS = ["Bienvenue", "au", "cafe", "parisien."];

  test("test_all_words_recognised_despite_accent_difference", () => {
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS) {
      expect(
        tracker.wordBelongsHere(word),
        `word ${JSON.stringify(word)} should be recognised despite the accent difference`,
      ).toBeTruthy();
      tracker.addWordAndCheckComplete(word);
    }
  });

  test("test_completes_after_last_word", () => {
    const tracker = new WordCompletionTracker(SENTENCE);
    for (const word of TTS_WORDS.slice(0, -1)) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete(TTS_WORDS.at(-1)!)).toBeTruthy();
  });

  test("test_accented_word_keeps_its_accent_in_the_attributed_span", () => {
    // The span carries the LLM's spelling, not the provider's folded one.
    const tracker = new WordCompletionTracker(SENTENCE, {
      llmText: SENTENCE,
      userFacingText: SENTENCE,
    });
    for (const word of TTS_WORDS.slice(0, 2)) {
      tracker.addWordAndCheckComplete(word);
    }
    tracker.addWordAndCheckComplete("cafe");
    expect(tracker.getLlmConsumed()).toEqual("café");
  });
});

describe("TestForceCompleteAttributesTaggedRemainder", () => {
  // A force-completed slot keeps the LLM tags on its unspoken remainder.
  //
  // The remaining TTS text carries synthesis tags (``<spell>``) and the remaining
  // LLM text carries pattern delimiters (``<card>``). They differ by construction,
  // so the remainder must be attributed on position alone.
  const TTS_TEXT = "<spell>4111 1111 1111 1111</spell>";

  const LLM_TEXT = "<card>4111 1111 1111 1111</card>";

  const USER_FACING = "4111 1111 1111 1111";

  test("test_remainder_carries_the_llm_delimiters", () => {
    const tracker = new WordCompletionTracker(TTS_TEXT, {
      llmText: LLM_TEXT,
      userFacingText: USER_FACING,
    });
    tracker.addWordAndCheckComplete("4111");
    expect(tracker.addWordAndCheckComplete("WRONG")).toBeTruthy();
    expect(tracker.getLlmConsumed()).toEqual("1111 1111 1111</card>");
  });
});

describe("TestTextNoWordArrivesFor", () => {
  // Markup occupies a segment of its own and no word-timestamp event names one,
  // so once everything speakable has been spoken the frame takes what is left --
  // otherwise a tag ending a frame is missing from the turn for good.
  test("test_tag_closing_the_frame_is_included", () => {
    const text = 'Hello there <break time="1s"/>';
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["Hello", "there"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
    expect(tracker.getRemainingUserFacingText()).toEqual("");
  });

  test("test_tag_between_the_last_word_and_its_period_is_included", () => {
    const text = 'Hello there <break time="1s"/>.';
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["Hello", "there."]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });

  test("test_tag_mid_frame_is_included", () => {
    const text = "Hello <break/> there";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["Hello", "there"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });

  test("test_a_word_still_to_come_holds_the_cursor", () => {
    // The frame only takes the rest once it is genuinely finished.
    const text = 'Hello <break time="1s"/> there';
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    expect(tracker.addWordAndCheckComplete("Hello")).toBeFalsy();
    expect(tracker.getAccumulatedUserFacingText()).not.toEqual(text);
  });

  test("test_a_token_running_into_the_next_frame_still_splits", () => {
    // Taking the rest of the frame happens on completion, which is also when a
    // straddling token is split, so the two must not interfere: the frame keeps
    // its own part and the next frame still receives the remainder.
    const text = "Say <break/> ABC";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    tracker.addWordAndCheckComplete("Say");
    expect(tracker.addWordAndCheckComplete("ABCNext")).toBeTruthy();
    expect(tracker.getWordForFrame()).toEqual("ABC");
    expect(tracker.getOverflowWord()).toEqual("Next");
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });

  test("test_punctuation_the_text_sets_off_still_waits_for_its_token", () => {
    // French "va ?" is reported as its own token, so the frame is not finished
    // until it lands and must not sweep the mark up early.
    const text = "Comment ça va ?";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["Comment", "ça", "va"]) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.getAccumulatedUserFacingText()).not.toContain("?");
    expect(tracker.addWordAndCheckComplete("?")).toBeTruthy();
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  });
});
// ---------------------------------------------------------------------------
// Resync: a provider garbles one token, then carries on correctly
// ---------------------------------------------------------------------------

describe("TestWordCompletionTrackerResync", () => {
  // A token matching nothing at the cursor, followed by one that matches ahead.
  //
  // A garbled token is not this frame's text and must not be attributed to it. The
  // frame recovers on a later token, found a short way past the cursor -- the text
  // skipped in between never gets an event of its own, so the word that resyncs
  // carries it.
  //
  // Neither the caller nor the frame has to know which case it is in.
  // :meth:`word_belongs_here` accepts a word anywhere within reach of the cursor,
  // and consuming it takes everything up to it, so a garbled token costs the frame
  // nothing but its own event.
  const SENTENCE = "This is how it is supposed to work";

  function _tracker(llmText: string | null = null) {
    // A tracker three words in, with " it is supposed to work" left to speak.
    const tracker = new WordCompletionTracker(SENTENCE, { llmText: llmText });
    for (const word of ["This", "is", "how"]) {
      tracker.addWordAndCheckComplete(word);
    }
    return tracker;
  }

  test("test_garbled_token_belongs_nowhere", () => {
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("ity")).toBeFalsy();
  });

  test("test_rejected_token_leaves_the_cursor_untouched", () => {
    const tracker = _tracker();
    tracker.wordBelongsHere("ity");
    expect(tracker.getRemainingTtsText()).toEqual("it is supposed to work");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("This is how");
  });

  test("test_resyncing_word_belongs_here", () => {
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("ís")).toBeTruthy();
  });

  test("test_resyncing_word_carries_the_text_it_skipped", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getWordForFrame()).toEqual("it is");
  });

  test("test_resync_attributes_the_skipped_llm_text", () => {
    const tracker = _tracker(SENTENCE);
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getLlmConsumed()).toEqual("it is");
  });

  test("test_progress_covers_the_skipped_text", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("This is how it is");
    expect(tracker.getRemainingUserFacingText()).toEqual("supposed to work");
  });

  test("test_frame_completes_normally_after_a_resync", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    for (const word of ["supposed", "to"]) {
      expect(tracker.wordBelongsHere(word), `${JSON.stringify(word)} should belong`).toBeTruthy();
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete("work")).toBeTruthy();
    expect(tracker.getRemainingTtsText()).toEqual("");
  });

  test("test_lookahead_places_only_whole_words", () => {
    // Resyncing is error recovery, so a partial prefix is not enough to
    // anchor on -- only a token covering a whole word may skip text.
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("supp")).toBeFalsy();
    expect(tracker.wordBelongsHere("supposed")).toBeTruthy();
  });

  test("test_word_further_ahead_sweeps_everything_before_it", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("supposed");
    expect(tracker.getWordForFrame()).toEqual("it is supposed");
  });

  test("test_foreign_word_is_never_placed", () => {
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("banana")).toBeFalsy();
  });

  test("test_lookahead_reach_is_bounded", () => {
    // Recovery spans a garbled token or two, not an arbitrary jump: a word
    // matching far down the sentence is a coincidence, not a resync.
    const tracker = new WordCompletionTracker(SENTENCE);
    tracker.addWordAndCheckComplete("This");
    expect(tracker.wordBelongsHere("work")).toBeFalsy();
  });

  test("test_a_word_at_the_cursor_is_placed_without_sweeping", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("it");
    expect(tracker.getWordForFrame()).toEqual("it");
  });
});

describe("TestWordCompletionTrackerResyncWithSymbols", () => {
  // Symbols inside the span a resync sweeps up.
  //
  // Brackets and arrows never arrive as word events of their own here, so they
  // reach the frame only by riding along with the word that resyncs.
  test("test_brackets_around_the_skipped_word_are_swept_up", () => {
    const text = "This is how (it) is supposed to work";
    const tracker = new WordCompletionTracker(text, { llmText: text });
    for (const word of ["This", "is", "how"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.wordBelongsHere("ity")).toBeFalsy();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getWordForFrame()).toEqual("(it) is");
    expect(tracker.getLlmConsumed()).toEqual("(it) is");
  });

  test("test_arrow_between_the_skipped_word_and_the_match_is_swept_up", () => {
    const text = "This is how it → is supposed to work";
    const tracker = new WordCompletionTracker(text, { llmText: text });
    for (const word of ["This", "is", "how"]) {
      tracker.addWordAndCheckComplete(word);
    }
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getWordForFrame()).toEqual("it → is");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("This is how it → is");
  });

  test("test_a_symbol_token_still_takes_the_symbol_path", () => {
    // A token with nothing to match on is judged by the symbol rule, which
    // lookahead must leave alone.
    const text = "This is how it → is supposed to work";
    const tracker = new WordCompletionTracker(text, { llmText: text });
    for (const word of ["This", "is", "how", "it"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.wordBelongsHere("-")).toBeTruthy();
  });
});

describe("TestWordCompletionTrackerResyncWithTags", () => {
  // Resyncing in a frame that also carries synthesis and LLM markup.
  //
  // The tags are their own segment, so a resync in the text after them has to keep
  // the LLM cursor -- still sitting before the closing ``</card>`` -- in step.
  const TTS = "Call <spell>4111</spell> when it is ready";

  const LLM = "Call <card>4111</card> when it is ready";

  const USER_FACING = "Call 4111 when it is ready";

  function _tracker() {
    const tracker = new WordCompletionTracker(TTS, {
      llmText: LLM,
      userFacingText: USER_FACING,
    });
    for (const word of ["Call", "4111"]) {
      tracker.addWordAndCheckComplete(word);
    }
    return tracker;
  }

  test("test_garbled_token_after_the_tag_belongs_nowhere", () => {
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("whenx")).toBeFalsy();
  });

  test("test_resync_after_the_tag_sweeps_the_skipped_words", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getWordForFrame()).toEqual("when it is");
  });

  test("test_resync_after_the_tag_carries_the_closing_tag_into_context", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getLlmConsumed()).toEqual("</card> when it is");
  });

  test("test_progress_skips_the_tag_it_never_shows", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Call 4111 when it is");
  });

  test("test_frame_completes_normally_after_the_resync", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("ís");
    expect(tracker.addWordAndCheckComplete("ready")).toBeTruthy();
  });

  test("test_lookahead_does_not_reach_past_a_transformed_span", () => {
    // A rewritten span lands all at once, so there is no honest position on
    // its far side to resync to. Whatever follows it waits for force-complete.
    const tracker = new WordCompletionTracker(TTS, {
      llmText: LLM,
      userFacingText: USER_FACING,
    });
    tracker.addWordAndCheckComplete("Call");
    expect(tracker.wordBelongsHere("ís")).toBeFalsy();
  });
});

describe("TestWordCompletionTrackerResyncInsideTransform", () => {
  // Resyncing within a rewritten span, which lands all at once.
  //
  // The span's spoken words are what the resync steps over, so the word that
  // finishes it still attributes the whole span to the text the LLM wrote.
  const TTS = "Your balance is five dollars, due on 3/15.";

  const ORIGINAL = "Your balance is $5, due on 3/15.";

  function _tracker() {
    const tracker = new WordCompletionTracker(TTS, {
      llmText: ORIGINAL,
      userFacingText: ORIGINAL,
    });
    for (const word of ["Your", "balance", "is"]) {
      tracker.addWordAndCheckComplete(word);
    }
    return tracker;
  }

  test("test_garbled_word_inside_the_span_belongs_nowhere", () => {
    const tracker = _tracker();
    expect(tracker.wordBelongsHere("fivex")).toBeFalsy();
  });

  test("test_resync_emits_the_spoken_form_it_stepped_over", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("dollars,");
    expect(tracker.getWordForFrame()).toEqual("five dollars,");
  });

  test("test_resync_completing_the_span_attributes_the_original", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("dollars,");
    expect(tracker.getLlmConsumed()).toEqual("$5,");
    expect(tracker.getAccumulatedUserFacingText()).toEqual("Your balance is $5,");
  });

  test("test_frame_completes_normally_after_the_resync", () => {
    const tracker = _tracker();
    tracker.addWordAndCheckComplete("dollars,");
    for (const word of ["due", "on"]) {
      expect(tracker.addWordAndCheckComplete(word)).toBeFalsy();
    }
    expect(tracker.addWordAndCheckComplete("3/15.")).toBeTruthy();
  });
});

describe("TestWordsWithNoLlmSpanOfTheirOwn", () => {
  // A word the LLM text has nothing left to attribute to.
  //
  // The conversation context falls back to a word's spoken text when it carries no
  // span, so a word that stands for nothing must say so, or the fallback records
  // text the LLM never wrote -- or records it twice.
  test("test_a_mark_an_earlier_word_carried_is_suppressed", () => {
    const text = "Yeah, I can help";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    tracker.addWordAndCheckComplete("Yeah");
    expect(tracker.suppressInContext()).toBeFalsy();
    tracker.addWordAndCheckComplete(",");
    expect(tracker.getLlmConsumed(), "the comma went with 'Yeah'").toBeNull();
    expect(tracker.suppressInContext()).toBeTruthy();
    tracker.addWordAndCheckComplete("I");
    expect(tracker.suppressInContext()).toBeFalsy();
  });

  test("test_text_the_llm_never_wrote_is_suppressed", () => {
    // Spoken text absent from ``llm_text`` has no span, so it is not recorded.
    const tracker = new WordCompletionTracker("Hello 😊", {
      llmText: "Hello",
      userFacingText: "Hello 😊",
    });
    tracker.addWordAndCheckComplete("Hello");
    expect(tracker.suppressInContext()).toBeFalsy();
    tracker.addWordAndCheckComplete("😊");
    expect(tracker.getLlmConsumed()).toBeNull();
    expect(tracker.suppressInContext()).toBeTruthy();
  });

  test("test_without_an_llm_text_nothing_is_suppressed", () => {
    // No spans exist at all, so every word is recorded from its spoken text.
    const tracker = new WordCompletionTracker("Hello world");
    for (const word of ["Hello", "world"]) {
      tracker.addWordAndCheckComplete(word);
      expect(tracker.suppressInContext()).toBeFalsy();
    }
  });
});

describe("TestPunctuationReportedOnItsOwn", () => {
  // A provider that reports a punctuation mark as its own word-timestamp entry.
  //
  // ``advance_by_alnums`` pulls trailing punctuation along with the word before it,
  // so by the time the mark's own event arrives the llm cursor is already past it.
  // Both cursors have to stay in step, and the unspoken tail has to keep the mark.
  test("test_mark_alone_leaves_the_two_remainders_in_step", () => {
    // 'Yeah' then ',' then 'I': the comma travelled with 'Yeah'.
    const text = "Yeah, I can help";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["Yeah", ",", "I"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getRemainingTtsText()).toEqual("can help");
    expect(tracker.getRemainingLlmText()).toEqual("can help");
  });

  test("test_mark_between_two_words_leaves_the_remainders_in_step", () => {
    // '1' then '-' then '2': the hyphen travelled with '1'.
    const text = "1-2 and more text";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["1", "-", "2"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getRemainingTtsText()).toEqual("and more text");
    expect(tracker.getRemainingLlmText()).toEqual("and more text");
  });

  test("test_a_mark_not_yet_reported_stays_in_the_remainder", () => {
    // Ending the frame before the mark arrives: it is still unspoken.
    //
    // Nothing has reported the mark, so it belongs to the text left to say. This
    // is the case a caller ending a frame early emits, and dropping it there
    // loses the tail from the conversation context.
    const text = "It is done. Next sentence here.";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["It", "is", "done"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getRemainingTtsText()).toEqual(". Next sentence here.");
    expect(tracker.getRemainingLlmText()).toEqual(". Next sentence here.");
  });

  test("test_a_mark_the_provider_spoke_is_not_owed_back", () => {
    // The usual case: the mark arrives inside its word, so nothing is outstanding.
    //
    // The counterpart of the test above -- treating this period as unspoken would
    // drop it from the accumulated text and repeat it in the remainder.
    const text = "It is done. Next sentence here.";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["It", "is", "done."]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getAccumulatedLlmText()).toEqual("It is done.");
    expect(tracker.getRemainingLlmText()).toEqual("Next sentence here.");
  });

  test("test_cjk_marks_reported_alone_keep_the_remainders_in_step", () => {
    // The token shape Cartesia reports for Japanese.
    //
    // One entry per character, so every mark arrives on its own, and the service
    // merges the entries of a single message into one token ("きゅ" here).
    const text = "確認いたします…ゼロ、きゅう、ゼロ";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of [
      "確",
      "認",
      "い",
      "た",
      "し",
      "ま",
      "す",
      "…",
      "ゼ",
      "ロ",
      "、",
      "きゅ",
      "う",
    ]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getRemainingTtsText()).toEqual("、ゼロ");
    expect(tracker.getRemainingLlmText()).toEqual("、ゼロ");
    expect(tracker.getAccumulatedLlmText()).toEqual("確認いたします…ゼロ、きゅう");
  });

  test("test_cjk_frame_ended_before_the_mark_is_reported", () => {
    // The provider stops reporting mid-turn, one character short of the mark.
    //
    // The mark travelled with the character before it, so without it being owed
    // back the tail loses it and force_complete discards the whole tail.
    const text = "確認いたします…ゼロ、いち";
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const word of ["確", "認", "い", "た", "し", "ま", "す"]) {
      tracker.addWordAndCheckComplete(word);
    }
    expect(tracker.getRemainingTtsText()).toEqual("…ゼロ、いち");
    expect(tracker.getRemainingLlmText()).toEqual("…ゼロ、いち");
  });
});

describe("TestWordCompletionTrackerMarkdownTokens", () => {
  // Markdown sent to the TTS verbatim, reported the way Cartesia reports it.
  //
  // Cartesia keeps the markdown on each whitespace-separated token (``**General``,
  // ``Overview**``) and appends a period to the last token of every line, even one
  // made only of punctuation (``---.``). Every such token must be placed where it
  // is, without the frame ending early: once a frame is force-completed, every
  // word after it is dropped for the rest of the turn.
  function _assertTracksToTheEnd(text: string, words: string[]) {
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const [i, word] of words.entries()) {
      expect(
        tracker.wordBelongsHere(word),
        `word ${i} ${JSON.stringify(word)} rejected`,
      ).toBeTruthy();
      const complete = tracker.addWordAndCheckComplete(word);
      const isLast = i === words.length - 1;
      expect(complete, `word ${i} ${JSON.stringify(word)} complete=${complete}`).toEqual(isLast);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  }

  test("test_horizontal_rule_then_heading", () => {
    const text = "Look:\n\n---\n\n### **Title**\nBody text.";
    _assertTracksToTheEnd(text, ["Look:.", "---.", "###", "**Title**.", "Body", "text."]);
  });

  test("test_horizontal_rule_at_frame_start", () => {
    const text = "---\n\n### **Summary**\nThe provided images are comprehensive.";
    _assertTracksToTheEnd(text, [
      "---.",
      "###",
      "**Summary**.",
      "The",
      "provided",
      "images",
      "are",
      "comprehensive.",
    ]);
  });

  test("test_bold_label_after_a_line_ending_in_bold", () => {
    const text = "#### **Week 1 (SY 25/26)**\n- **Monday**:\n  - **ENTREE**: Chicken Sandwich";
    _assertTracksToTheEnd(text, [
      "####",
      "**Week",
      "1",
      "(SY",
      "25/26)**.",
      "-",
      "**Monday**:.",
      "-",
      "**ENTREE**:",
      "Chicken",
      "Sandwich.",
    ]);
  });

  test("test_bullet_with_bold_label", () => {
    const text = "- **Structure**: Each day has a designated **ENTREE** (main course).";
    _assertTracksToTheEnd(text, [
      "-",
      "**Structure**:",
      "Each",
      "day",
      "has",
      "a",
      "designated",
      "**ENTREE**",
      "(main",
      "course).",
    ]);
  });

  test("test_frame_from_the_log", () => {
    // The frame that fell out of step in the reported session.
    const text =
      "Below is a detailed description of the content across the images:\n\n---\n\n### **General Overview**\n- **Purpose**: These menus are designed for elementary and high school students, offering a variety of meals each day.";
    const words = [
      "Below",
      "is",
      "a",
      "detailed",
      "description",
      "of",
      "the",
      "content",
      "across",
      "the",
      "images:.",
      "---.",
      "###",
      "**General",
      "Overview**.",
      "-",
      "**Purpose**:",
      "These",
      "menus",
      "are",
      "designed",
      "for",
      "elementary",
      "and",
      "high",
      "school",
      "students,",
      "offering",
      "a",
      "variety",
      "of",
      "meals",
      "each",
      "day.",
    ]; // fmt: skip
    _assertTracksToTheEnd(text, words);
  });
});

describe("TestWordCompletionTrackerUnmatchedSymbolStaysPut", () => {
  // A symbol token that matches nothing must not jump over symbols still to come.
  //
  // A provider can report a symbol other than the one it was given -- ElevenLabs
  // reports ``→`` as ``-`` -- so the token is accepted without being placed. The
  // cursor may step past the unmatched symbol, but not past whitespace into the
  // symbol tokens that follow it (``###``, ``-``). Those arrive as their own
  // events, and once the cursor is past them they no longer belong here, so the
  // frame is force-completed and every later word of the turn is dropped.
  function _assertTracksToTheEnd(text: string, words: string[]) {
    const tracker = new WordCompletionTracker(text, {
      llmText: text,
      userFacingText: text,
    });
    for (const [i, word] of words.entries()) {
      expect(
        tracker.wordBelongsHere(word),
        `word ${i} ${JSON.stringify(word)} rejected`,
      ).toBeTruthy();
      const complete = tracker.addWordAndCheckComplete(word);
      const isLast = i === words.length - 1;
      expect(complete, `word ${i} ${JSON.stringify(word)} complete=${complete}`).toEqual(isLast);
    }
    expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
  }

  test("test_swapped_symbol_before_a_heading", () => {
    const text = "Step one →\n\n### **Step two**\nDone.";
    _assertTracksToTheEnd(text, ["Step", "one", "-", "###", "**Step", "two**", "Done."]);
  });

  test("test_swapped_symbol_before_a_real_one", () => {
    const text = "Step one → - step two";
    _assertTracksToTheEnd(text, ["Step", "one", "-", "-", "step", "two"]);
  });

  test("test_swapped_symbol_before_a_word", () => {
    // A letter right after the symbol already stops the step.
    const text = "Step one → step two";
    _assertTracksToTheEnd(text, ["Step", "one", "-", "step", "two"]);
  });
});
