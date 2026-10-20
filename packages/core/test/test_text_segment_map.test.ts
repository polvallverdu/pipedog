// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_text_segment_map.py

import { describe, expect, test } from "bun:test";

import {
  type _Hop,
  _HopKind,
  type TextSegment,
  TextSegmentMap,
} from "../src/utils/context/text_segment_map.ts";
import { foldForMatching } from "../src/utils/text/alnum_utils.ts";

// Python reaches into `_segments` and `_classify_hop` directly; in TS they are
// protected, so the tests access them through these typed shims.
function segmentsOf(smap: TextSegmentMap): TextSegment[] {
  return (smap as unknown as { _segments: TextSegment[] })._segments;
}

function classifyHop(segmentRemaining: string, remainingWord: string): _Hop {
  return (
    TextSegmentMap as unknown as {
      _classifyHop(segmentRemaining: string, remainingWord: string): _Hop;
    }
  )._classifyHop(segmentRemaining, remainingWord);
}

function codePointLength(text: string): number {
  return [...text].length;
}

describe("TestTextSegmentMapBuild", () => {
  test("test_equal_texts_produce_unchanged_segments", () => {
    const smap = new TextSegmentMap("hello world", "hello world");
    for (const seg of segmentsOf(smap)) {
      expect(seg.isTransformed).toBe(false);
    }
  });

  test("test_currency_produces_transformed_segment", () => {
    const smap = new TextSegmentMap("forty two dollars and fifty cents", "$42.50");
    const transformed = segmentsOf(smap).filter((s) => s.isTransformed);
    expect(transformed.length > 0).toBe(true);
  });

  test("test_segment_original_end_covers_full_text", () => {
    const original = "Your balance is $42.50";
    const smap = new TextSegmentMap("Your balance is forty two dollars and fifty cents", original);
    const segments = segmentsOf(smap);
    const last = segments[segments.length - 1] as TextSegment;
    expect(last.originalEnd).toEqual(original.length);
  });

  test("test_unchanged_prefix_segment", () => {
    const smap = new TextSegmentMap("Your balance is forty two dollars", "Your balance is $42");
    const first = segmentsOf(smap)[0] as TextSegment;
    expect(first.isTransformed).toBe(false);
    expect(first.original).toEqual("Your balance is ");
  });

  test("test_tts_alnum_count_correct", () => {
    const smap = new TextSegmentMap("forty two", "$42");
    const seg = segmentsOf(smap).find((s) => s.isTransformed) as TextSegment;
    expect(seg.ttsAlnumCount).toEqual("fortytwo".length);
  });

  test("test_original_alnum_count_correct", () => {
    const smap = new TextSegmentMap("fifty percent", "50%");
    const seg = segmentsOf(smap).find((s) => s.isTransformed) as TextSegment;
    expect(seg.originalAlnumCount).toEqual(2); // "50"
  });
});

describe("TestTextSegmentMapAdvance", () => {
  function makeCurrencyMap(): TextSegmentMap {
    return new TextSegmentMap(
      "Your balance is forty two dollars and fifty cents",
      "Your balance is $42.50",
    );
  }

  test("test_unchanged_words_advance_user_facing_pos", () => {
    const smap = makeCurrencyMap();
    smap.advanceWord("Your");
    expect(smap.userFacingPos).toBeGreaterThan(0);
    expect(smap.inTransformedSegment).toBe(false);
  });

  test("test_in_transformed_segment_true_mid_segment", () => {
    const smap = makeCurrencyMap();
    smap.advanceWord("Your");
    smap.advanceWord("balance");
    smap.advanceWord("is");
    smap.advanceWord("forty"); // enters transformed segment
    expect(smap.inTransformedSegment).toBe(true);
  });

  test("test_cursors_held_during_transformed_segment", () => {
    const smap = makeCurrencyMap();
    smap.advanceWord("Your");
    smap.advanceWord("balance");
    smap.advanceWord("is");
    const posBefore = smap.userFacingPos;
    smap.advanceWord("forty");
    smap.advanceWord("two");
    expect(smap.userFacingPos).toEqual(posBefore);
  });

  test("test_cursors_jump_on_segment_completion", () => {
    const smap = makeCurrencyMap();
    smap.advanceWord("Your");
    smap.advanceWord("balance");
    smap.advanceWord("is");
    const posBefore = smap.userFacingPos;
    smap.advanceWord("forty");
    smap.advanceWord("two");
    smap.advanceWord("dollars");
    smap.advanceWord("and");
    smap.advanceWord("fifty");
    smap.advanceWord("cents"); // segment completes
    expect(smap.userFacingPos).toBeGreaterThan(posBefore);
    expect(smap.inTransformedSegment).toBe(false);
  });

  test("test_last_completed_segment_on_transform_completion", () => {
    const smap = makeCurrencyMap();
    for (const word of [
      "Your",
      "balance",
      "is",
      "forty",
      "two",
      "dollars",
      "and",
      "fifty",
      "cents",
    ]) {
      smap.advanceWord(word);
    }
    const seg = smap.lastCompletedSegment;
    expect(seg).not.toBeNull();
    expect((seg as TextSegment).isTransformed).toBe(true);
    expect((seg as TextSegment).original).toContain("42");
  });

  test("test_last_completed_segment_none_before_completion", () => {
    const smap = makeCurrencyMap();
    smap.advanceWord("Your");
    expect(smap.lastCompletedSegment).toBeNull();
  });

  test("test_in_transformed_segment_false_before_segment", () => {
    const smap = makeCurrencyMap();
    expect(smap.inTransformedSegment).toBe(false);
  });

  test("test_in_transformed_segment_false_after_completion", () => {
    const smap = makeCurrencyMap();
    for (const word of [
      "Your",
      "balance",
      "is",
      "forty",
      "two",
      "dollars",
      "and",
      "fifty",
      "cents",
    ]) {
      smap.advanceWord(word);
    }
    expect(smap.inTransformedSegment).toBe(false);
  });
});

describe("TestTextSegmentMapWithLlmText", () => {
  test("test_llm_pos_advances_past_digits_stops_before_closing_tag", () => {
    // Transformed segment: "$42" -> "forty two dollars" (15 alnum)
    // advanceByAlnums("<card>$42</card>", 0, 2) counts "4" and "2",
    // then the trailing loop hits "<" and stops -- result is 9.
    const smap = new TextSegmentMap("forty two dollars", "$42", "<card>$42</card>");
    smap.advanceWord("forty");
    smap.advanceWord("two");
    smap.advanceWord("dollars");
    // Position 9 is the "<" that opens "</card>" -- the two alnum digits
    // have been consumed but the closing tag is still unread (it will be
    // swept by WordCompletionTracker on the final "isComplete" word).
    expect(smap.llmPos).toEqual(9);
  });

  test("test_llm_pos_defaults_to_original_text_when_not_provided", () => {
    // "50%" -> "fifty percent" (12 alnum).  originalAlnumCount = 2 ("50").
    // advanceByAlnums("50%", 0, 2) consumes "5" and "0", then the
    // trailing loop advances past "%" (non-alnum, non-space, non-tag) -> 3.
    const smap = new TextSegmentMap("fifty percent", "50%");
    smap.advanceWord("fifty");
    smap.advanceWord("percent");
    expect(smap.llmPos).toEqual(3); // past "50%"
  });
});

describe("TestTextSegmentMapReset", () => {
  test("test_reset_restores_initial_state", () => {
    const smap = new TextSegmentMap("forty two dollars", "$42");
    smap.advanceWord("forty");
    smap.advanceWord("two");
    smap.reset();
    expect(smap.userFacingPos).toEqual(0);
    expect(smap.llmPos).toEqual(0);
    expect(smap.inTransformedSegment).toBe(false);
    expect(smap.lastCompletedSegment).toBeNull();
  });

  test("test_reset_allows_replay", () => {
    const smap = new TextSegmentMap("forty two dollars", "$42");
    smap.advanceWord("forty");
    smap.advanceWord("two");
    const posFirst = smap.userFacingPos;
    smap.reset();
    smap.advanceWord("forty");
    smap.advanceWord("two");
    expect(smap.userFacingPos).toEqual(posFirst);
  });
});

describe("TestTextSegmentMapEqualTexts", () => {
  test("test_all_segments_unchanged", () => {
    const smap = new TextSegmentMap("hello world", "hello world");
    for (const seg of segmentsOf(smap)) {
      expect(seg.isTransformed).toBe(false);
    }
  });

  test("test_advance_works_for_equal_texts", () => {
    const smap = new TextSegmentMap("hello world", "hello world");
    smap.advanceWord("hello");
    expect(smap.inTransformedSegment).toBe(false);
    smap.advanceWord("world");
    expect(smap.inTransformedSegment).toBe(false);
  });
});

describe("TestTextSegmentMapTokenChangingReplacements", () => {
  // Whether segments are flagged as transformed when a replacement changes
  // tokenization, versus when it only changes case or the connector between
  // words.
  //
  // A replacement that splits one word into several changes the *word count*
  // within the segment, which breaks the 1:1 token correspondence proportional
  // advancement assumes -- it must be flagged transformed so the segment is
  // held and committed atomically instead. A replacement that only changes
  // case or swaps the connector between words (space vs. hyphen) keeps the
  // same single-token structure, so proportional advancement still lands at
  // the correct position; those are intentionally left unflagged here and are
  // instead handled by lenient (case/connector-insensitive) span validation in
  // `WordCompletionTracker`.

  test("test_word_splitting_replacement_is_flagged_transformed", () => {
    // "BODYPUMP" -> "body pump": same alnum content, different tokenization.
    const smap = new TextSegmentMap(
      "Try body pump on Monday morning.",
      "Try BODYPUMP on Monday morning.",
    );
    const seg = segmentsOf(smap).find((s) => s.original === "BODYPUMP") as TextSegment;
    // a replacement that splits one word into several must be treated as transformed
    expect(seg.isTransformed).toBe(true);
  });

  test("test_case_only_replacement_is_not_flagged_transformed", () => {
    // "SQL" -> "sql": same alnum content, same single-token structure, only
    // case differs. Proportional advancement already lands correctly here.
    const smap = new TextSegmentMap("Contact sql support today.", "Contact SQL support today.");
    const seg = segmentsOf(smap).find((s) => s.original === "SQL") as TextSegment;
    expect(seg.isTransformed).toBe(false);
  });

  test("test_hyphenated_single_token_replacement_is_not_flagged_transformed", () => {
    // "BODYPUMP" -> "body-pump": still a single token on both sides.
    const smap = new TextSegmentMap(
      "Try body-pump on Monday morning.",
      "Try BODYPUMP on Monday morning.",
    );
    const seg = segmentsOf(smap).find((s) => s.original === "BODYPUMP") as TextSegment;
    expect(seg.isTransformed).toBe(false);
  });

  test("test_different_length_replacement_is_already_flagged_transformed", () => {
    // Control case: "HIIT" -> "hit" differs in alnum length, so it takes
    // the transformed/atomic path via the existing alnum-content check.
    const smap = new TextSegmentMap(
      "We run hit classes on Tuesday.",
      "We run HIIT classes on Tuesday.",
    );
    const seg = segmentsOf(smap).find((s) => s.original === "HIIT") as TextSegment;
    expect(seg.isTransformed).toBe(true);
  });

  test("test_acronym_letter_spacing_is_flagged_transformed", () => {
    // "API" -> "A P I": same alnum content, but letter-spacing splits one
    // word into three -- the same word-count change as splitting replacements.
    const smap = new TextSegmentMap("A P I launched", "API launched");
    const seg = segmentsOf(smap).find((s) => s.original === "API") as TextSegment;
    expect(seg.isTransformed).toBe(true);
  });
});

describe("TestTextSegmentMapSsmlPhonemeTag", () => {
  // SSML phoneme tags (e.g. ElevenLabs' <phoneme alphabet="ipa" ph="...">)
  // wrap a word for pronunciation without changing its alnum content, but the
  // surrounding markup means the segment must be treated as transformed (held
  // atomically) rather than assumed to advance proportionally word-by-word.

  test("test_phoneme_wrapped_word_is_flagged_transformed", () => {
    const llmText = "My name is Siobhan.";
    const ttsText = 'My name is <phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>.';
    const smap = new TextSegmentMap(ttsText, llmText, llmText);
    const seg = segmentsOf(smap).find((s) => s.original.includes("Siobhan")) as TextSegment;
    expect(seg.isTransformed).toBe(true);
  });

  test("test_in_transformed_segment_true_for_leading_zero_alnum_fragment", () => {
    // Once the preceding segment is fully consumed, a fragment that itself
    // contributes zero alnum chars (e.g. a still-open tag's attribute text,
    // which normalizes to '') is textually already inside the transformed
    // segment and must report inTransformedSegment=true. Otherwise callers
    // (WordCompletionTracker.suppressInContext) wrongly treat the fragment
    // as outside any transform and try to attribute raw llmText chars to it.
    const llmText = "My name is Siobhan.";
    const ttsText = 'My name is <phoneme alphabet="ipa" ph="ʃəˈvɔːn">Siobhan</phoneme>.';
    const smap = new TextSegmentMap(ttsText, llmText, llmText);
    smap.advanceWord("My");
    smap.advanceWord("name");
    smap.advanceWord("is"); // prior unchanged segment now fully consumed
    smap.advanceWord("<phoneme"); // 0 alnum chars, but inside the transformed segment
    expect(smap.inTransformedSegment).toBe(true);
  });
});

describe("TestTextSegmentMapStrayAngleBracket", () => {
  // A literal '<' with no matching '>' in ordinary TTS text (e.g. an emoticon
  // like "<3" or a comparison like "5 < 10") is real content, not a truncated
  // SSML tag, so it must not cause a segment to be misclassified as transformed.

  test("test_unchanged_segment_with_stray_angle_bracket_not_flagged_transformed", () => {
    const text = "I love you <3 always";
    const smap = new TextSegmentMap(text, text);
    const seg = segmentsOf(smap)[0] as TextSegment;
    expect(seg.tts).toEqual(text);
    expect(seg.isTransformed).toBe(false);
  });
});

describe("TestClassifyHopLiteralMatchHandlesStrayAngleBracket", () => {
  // A literal '<3' arriving as its own word-timestamp token (e.g. an emoticon
  // in ordinary text) is placed by _classifyHop's literal-matching strategies
  // (1/2) directly, character for character against the segment's raw
  // remaining text.

  test("test_literal_angle_bracket_word_placed_via_literal_strategy", () => {
    const hop = classifyHop("<3 always", "<3");
    expect(hop.kind).toEqual(_HopKind.PLACED);
    // segmentAdvance == word.length (offset 0 + "<3".length) is literal strategy's
    // formula; the markup-stripped strategy would compute this differently
    // (via rawOffsetAfterCleanChars), so this pins down *which* strategy matched.
    expect(hop.segmentAdvance).toEqual("<3".length);
  });
});

describe("TestClassifyHopSkipsLeadingPunctuation", () => {
  // A word arriving right after punctuation the provider didn't repeat as its
  // own token (e.g. the comma in "Yeah, I can") must still be placed -- the
  // segment's leading punctuation run has to be skipped, not just its leading
  // whitespace.

  test("test_word_after_comma_and_space_is_placed", () => {
    const hop = classifyHop(", I can do that. ", "I");
    expect(hop.kind).toEqual(_HopKind.PLACED);
    expect(hop.segmentAdvance).toEqual(", I".length);
  });

  test("test_full_sentence_advances_word_by_word", () => {
    const smap = new TextSegmentMap("Yeah, I can do that.", "Yeah, I can do that.");
    for (const word of ["Yeah", "I", "can", "do"]) {
      expect(smap.wordBelongsCurrentSegment(word)).toBe(true);
      smap.advanceWord(word);
    }
    expect(smap.wordBelongsCurrentSegment("that")).toBe(true);
    smap.advanceWord("that");
    expect(smap.isComplete).toBe(true);
  });

  test("test_tag_name_is_not_matched_as_a_spoken_word", () => {
    // The punctuation skip must stop at '<' rather than scanning into a
    // tag's name, or a tag name arriving as its own word-timestamp token would
    // be PLACED as if it were spoken content and consume the tag.
    const hop = classifyHop("<break/>hello", "break");
    // 'break' is the tag's name, not spoken content
    expect(hop.kind).not.toEqual(_HopKind.PLACED);
  });

  test("test_word_after_leading_tag_still_placed_via_markup_strategy", () => {
    // Stopping the punctuation skip at '<' must not cost the markup-stripped
    // strategy (3) its match on a segment that opens with a tag.
    const hop = classifyHop("<spell>4111 1111 1111 1111</spell>", "4111");
    expect(hop.kind).toEqual(_HopKind.PLACED);
  });
});

describe("TestProviderTokenShapes", () => {
  // Word-timestamp tokens arrive in provider-specific shapes. Each shape below
  // is handled by a different part of _classifyHop's matching, so each needs its
  // own scenario.

  test("test_tokens_carrying_their_own_leading_whitespace", () => {
    // Some providers include the separating space in the token (Inworld's
    // " world"), so the match must succeed against the segment text as-is --
    // before any leading-whitespace skip is applied.
    const smap = new TextSegmentMap("Hello world", "Hello world");
    for (const word of ["Hello", " world"]) {
      expect(smap.wordBelongsCurrentSegment(word)).toBe(true);
      smap.advanceWord(word);
    }
    expect(smap.isComplete).toBe(true);
  });

  test("test_tokens_uppercased_by_the_provider", () => {
    // A provider that upper-cases its tokens needs the *word* side folded, not
    // just the segment side -- the folded-candidate pass alone would still be
    // comparing an upper-case word against lower-case source text.
    const smap = new TextSegmentMap("hello world", "hello world");
    for (const word of ["HELLO", "WORLD"]) {
      expect(smap.wordBelongsCurrentSegment(word)).toBe(true);
      smap.advanceWord(word);
    }
    expect(smap.isComplete).toBe(true);
  });

  test("test_tokens_carrying_an_accent_absent_from_the_source", () => {
    // Accent folding must work in both directions: the provider may report a
    // diacritic the source text doesn't have, not only strip one it does.
    const smap = new TextSegmentMap("Visit the cafe today", "Visit the cafe today");
    for (const word of ["Visit", "the"]) {
      smap.advanceWord(word);
    }
    expect(smap.wordBelongsCurrentSegment("café")).toBe(true);
  });
});

describe("TestClassifyHopCaseFoldRequiresWordBoundary", () => {
  // The case/accent-folded fallback strategy must not PLACE a word mid-word.
  //
  // Folding erases case before the prefix (startsWith) match, so a short word
  // that is only a case-insensitive prefix of a longer word (e.g. "account" vs
  // "Accountant") must not be accepted -- that would silently corrupt the
  // cursor by landing inside the longer word instead of at a real boundary.

  test("test_short_word_not_placed_inside_longer_word_via_case_fold", () => {
    const hop = classifyHop(" Accountant", "account");
    // must not match 'account' mid-word inside 'Accountant'
    expect(hop.kind).not.toEqual(_HopKind.PLACED);

    const smap = new TextSegmentMap(
      "Please talk to the Accountant",
      "Please talk to the Accountant",
    );
    for (const word of ["Please", "talk", "to", "the"]) {
      smap.advanceWord(word);
    }
    expect(smap.wordBelongsCurrentSegment("account")).toBe(false);
  });

  test("test_whole_word_case_fold_still_matches_at_boundary", () => {
    const smap = new TextSegmentMap("Please open the SQL database", "Please open the SQL database");
    for (const word of ["Please", "open", "the"]) {
      smap.advanceWord(word);
    }

    expect(smap.wordBelongsCurrentSegment("sql")).toBe(true);
    smap.advanceWord("sql");
    expect(smap.wordBelongsCurrentSegment("database")).toBe(true);
  });
});

describe("TestLeadingDuplicatePunctuation", () => {
  // A provider that reports a mark with the *following* word rather than the one
  // it trails.
  //
  // The raw cursor stops before punctuation so the next token can still match it,
  // while the LLM cursor sweeps it into the preceding word's span. A token that
  // then leads with that same mark carries it a second time, and the map reports
  // how much of its head to drop.

  const SENTENCE = "Yeah, I can do that.";

  function mapAfterFirstWord(): TextSegmentMap {
    const smap = new TextSegmentMap(SENTENCE, SENTENCE, SENTENCE);
    smap.advanceWord("Yeah");
    return smap;
  }

  test("test_cursors_disagree_about_the_trailing_mark", () => {
    const smap = mapAfterFirstWord();
    expect(smap.rawPos).toEqual(4); // raw cursor stops before the comma
    expect(smap.llmPos).toEqual(5); // llm cursor swept the comma into 'Yeah'
  });

  test("test_repeated_mark_is_reported_as_a_leading_duplicate", () => {
    const smap = mapAfterFirstWord();
    smap.advanceWord(", I");
    expect(smap.lastLeadingDuplicate).toEqual(2); // drop the comma and its space
  });

  test("test_word_without_the_mark_reports_nothing", () => {
    const smap = mapAfterFirstWord();
    smap.advanceWord("I");
    expect(smap.lastLeadingDuplicate).toEqual(0);
  });

  test("test_punctuation_only_token_is_left_alone", () => {
    // The mark arriving as its own event stands for this position itself.
    const smap = mapAfterFirstWord();
    smap.advanceWord(", ");
    expect(smap.lastLeadingDuplicate).toEqual(0);
  });

  test("test_unconsumed_opening_punctuation_is_not_a_duplicate", () => {
    const sentence = 'He said "hello" today';
    const smap = new TextSegmentMap(sentence, sentence, sentence);
    smap.advanceWord("He");
    smap.advanceWord("said");
    smap.advanceWord('"hello');
    expect(smap.lastLeadingDuplicate).toEqual(0); // the quote is new content
  });

  test("test_reset_clears_it", () => {
    const smap = mapAfterFirstWord();
    smap.advanceWord(", I");
    smap.reset();
    expect(smap.lastLeadingDuplicate).toEqual(0);
  });
});

describe("TestWordCarriesItsOwnPunctuation", () => {
  // A provider may punctuate a tagged span more than the source text does.

  test("test_hop_matches_a_word_whose_punctuation_the_span_lacks", () => {
    // Cartesia reports "1234." for "<spell>1234</spell>\n\nHow ...", turning the
    // line break into a sentence ending. The literal and folded strategies already
    // retry with the word's trailing punctuation removed; the markup-stripped one
    // has to as well, or the word matches nothing.
    const remaining = "<spell>1234</spell>\n\nHow can I help you today?";
    const hop = classifyHop(remaining, "1234.");
    expect(hop.kind).toEqual(_HopKind.PLACED);
    expect(remaining.slice(0, hop.segmentAdvance)).toEqual("<spell>1234");
  });

  test("test_sentence_tracks_through_the_extra_punctuation", () => {
    const text = "I love to count <spell>1234</spell>\n\nHow can I help you today?";
    const smap = new TextSegmentMap(text, text);
    for (const word of ["I", "love", "to", "count", "1234.", "How", "can", "I", "help", "you"]) {
      smap.advanceWord(word);
      // `${word}` should not overflow
      expect(smap.lastOverflow).toBeNull();
    }
    smap.advanceWord("today?");
    expect(smap.isComplete).toBe(true);
    expect(smap.userFacingPos).toEqual(text.length);
  });
});

describe("TestClassifyHopFoldsTypographicVariants", () => {
  // Strategy 2 folds typographic variants, not just case and accents.
  //
  // LLMs emit the typographic forms; a TTS service may report the ASCII form in its
  // word-timestamp events (or the reverse). Without folding, the hop is NO_MATCH and the
  // slot force-completes, collapsing the rest of the sentence into one frame.

  test("test_curly_apostrophe_matches_ascii_token", () => {
    const hop = classifyHop("don’t worry", "don't");
    expect(hop.kind).toEqual(_HopKind.PLACED);
  });

  test("test_ascii_apostrophe_matches_curly_token", () => {
    const hop = classifyHop("don't worry", "don’t");
    expect(hop.kind).toEqual(_HopKind.PLACED);
  });

  test("test_en_dash_matches_hyphen_token", () => {
    const hop = classifyHop("2020–2021 report", "2020-2021");
    expect(hop.kind).toEqual(_HopKind.PLACED);
  });

  test("test_curly_quotes_match_straight_quotes", () => {
    const hop = classifyHop("“hello” there", '"hello"');
    expect(hop.kind).toEqual(_HopKind.PLACED);
  });

  test("test_unrelated_token_still_does_not_match", () => {
    // Folding must not turn a genuine mismatch into a match.
    const hop = classifyHop("hello world", "goodbye");
    expect(hop.kind).toEqual(_HopKind.NO_MATCH);
  });
});

describe("TestFoldPreservesLength", () => {
  // The fold must map each character to exactly one character.
  //
  // Strategy 2 finds a match offset in folded space and applies it to the raw text, so a
  // fold that changed length would silently mis-place the cursor rather than fail loudly.
  // The property is not self-evident: lower-casing is not length-preserving in Unicode
  // ("İ".toLowerCase() is two characters), and the fold survives that only because
  // the accent fold decomposes first and keeps the base character.

  test("test_fold_is_length_preserving_across_unicode", () => {
    // Python's str.isprintable(): everything except categories Cc, Cf, Cs, Co,
    // Cn, Zl, Zp and Zs (the ASCII space excepted).
    const nonPrintable = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
    const chars: string[] = [];
    for (let i = 32; i < 0x110000; i++) {
      if (i >= 0xd800 && i <= 0xdfff) continue; // surrogates (Cs)
      const ch = String.fromCodePoint(i);
      if (ch === " " || !nonPrintable.test(ch)) chars.push(ch);
    }
    const sample = chars.join("");
    expect(codePointLength(foldForMatching(sample))).toEqual(codePointLength(sample));
  });

  test("test_dotted_capital_i_folds_to_one_character", () => {
    // "İ".toLowerCase() is "i" + COMBINING DOT ABOVE; folding must not inherit that.
    expect(foldForMatching("İ")).toEqual("i");
  });

  test("test_fold_is_narrow", () => {
    // Only the listed variants change -- no blanket Unicode compatibility folding.
    //
    // A compatibility normalization would fold thousands of characters (CJK
    // compatibility ideographs, halfwidth katakana, math alphanumerics) that no TTS
    // service is known to substitute, widening the match surface far beyond the
    // provider behaviour this is meant to absorb.
    for (const char of ["ﬁ", "½", "１", "三", "′", " "]) {
      expect(foldForMatching(char)).toEqual(char);
    }
  });
});
