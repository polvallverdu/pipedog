// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_string.py

import { describe, expect, test } from "bun:test";

import {
  longestTrailingPartialMatch,
  matchEndofsentence,
  parseStartEndTags,
} from "../src/utils/string.ts";

function expectSentences(sentences: string[], label: string): void {
  for (const sentence of sentences) {
    expect(matchEndofsentence(sentence), `Failed for ${label}: ${sentence}`).toBeTruthy();
  }
}

describe("TestUtilsString", () => {
  test("test_endofsentence", async () => {
    expect(matchEndofsentence("This is a sentence.")).toEqual(19);
    expect(matchEndofsentence("This is a sentence!")).toEqual(19);
    expect(matchEndofsentence("This is a sentence?")).toEqual(19);
    expect(matchEndofsentence("This is a sentence;")).toEqual(19);
    expect(matchEndofsentence("This is a sentence...")).toEqual(21);
    expect(matchEndofsentence("This is a sentence. This is another one")).toEqual(19);
    expect(matchEndofsentence("This is for Mr. and Mrs. Jones.")).toEqual(31);
    expect(matchEndofsentence("Meet the new Mr. and Mrs.")).toEqual(25);
    expect(matchEndofsentence("U.S.A. and N.A.S.A.")).toEqual(19);
    expect(matchEndofsentence("USA and NASA.")).toEqual(13);
    expect(matchEndofsentence("My number is 123-456-7890.")).toEqual(26);
    expect(matchEndofsentence("For information, call 411.")).toEqual(26);
    expect(matchEndofsentence("My emails are foo@pipecat.ai and bar@pipecat.ai.")).toEqual(48);
    expect(matchEndofsentence("My email is foo.bar@pipecat.ai.")).toEqual(31);
    expect(matchEndofsentence("My email is spell(foo.bar@pipecat.ai).")).toEqual(38);
    expect(matchEndofsentence("My email is <spell>foo.bar@pipecat.ai</spell>.")).toEqual(46);
    expect(matchEndofsentence("The number pi is 3.14159.")).toEqual(25);
    expect(matchEndofsentence("Valid scientific notation 1.23e4.")).toEqual(33);
    expect(matchEndofsentence("Valid scientific notation 0.e4.")).toEqual(31);
    expect(matchEndofsentence("It still early, it's 3:00 a.m.")).toEqual(30);
    expect(matchEndofsentence("This is not a sentence")).toBeFalsy();
    expect(matchEndofsentence("This is not a sentence,")).toBeFalsy();
    expect(matchEndofsentence("This is not a sentence, ")).toBeFalsy();
    expect(matchEndofsentence("Ok, Mr. Smith let's ")).toBeFalsy();
    expect(matchEndofsentence("Dr. Walker, I presume ")).toBeFalsy();
    expect(matchEndofsentence("Prof. Walker, I presume ")).toBeFalsy();
    expect(matchEndofsentence("zweitens, und 3")).toBeFalsy();
    expect(matchEndofsentence("Heute ist Dienstag, der 3")).toBeFalsy(); // 3. Juli 2024
    expect(matchEndofsentence("America, or the U.S")).toBeFalsy(); // U.S.A.
    expect(matchEndofsentence("My emails are foo@pipecat.ai and bar@pipecat.ai")).toBeFalsy();
    expect(matchEndofsentence("The number pi is 3.14159")).toBeFalsy();
  });

  test("test_endofsentence_multilingual", async () => {
    // Test sentence detection across various language families and scripts.

    // Arabic script (Arabic, Urdu, Persian)
    expectSentences(
      [
        "مرحبا؟", // Arabic question mark
        "السلام عليكم؛", // Arabic semicolon
        "یہ اردو ہے۔", // Urdu full stop
      ],
      "Arabic/Urdu",
    );

    // Should not match incomplete Arabic
    expect(matchEndofsentence("مرحبا،"), "Arabic comma should not end sentence").toBeFalsy();

    expectSentences(["你好。", "你好！", "吃了吗？", "安全第一；"], "Chinese");
    expect(matchEndofsentence("你好，")).toBeFalsy();

    expectSentences(["हैलो।", "हैलो！", "आप खाये हैं？", "सुरक्षा पहले।"], "Hindi");
    expect(matchEndofsentence("हैलो，")).toBeFalsy();

    // East Asian (Japanese, Korean)
    expectSentences(
      [
        "こんにちは。", // Japanese
        "元気ですか？", // Japanese question
        "ありがとう！", // Japanese exclamation
      ],
      "Japanese",
    );

    expectSentences(
      [
        "안녕하세요。", // Korean with ideographic period
        "어떻게 지내세요？", // Korean question
      ],
      "Korean",
    );

    // Southeast Asian scripts
    expectSentences(
      [
        "สวัสดี।", // Thai with Devanagari-style punctuation
      ],
      "Thai",
    );

    expectSentences(
      [
        "မင်္ဂလာပါ၊", // Myanmar little section
        "ကျေးဇူးတင်ပါတယ်။", // Myanmar section
      ],
      "Myanmar",
    );

    // Other Indic scripts (same punctuation as Hindi but different scripts)
    expectSentences(
      [
        "নমস্কার।", // Bengali
        "আপনি কেমন আছেন？", // Bengali question (uses Latin ?)
      ],
      "Bengali",
    );

    expectSentences(
      [
        "வணக்கம்।", // Tamil
        "நீங்கள் எப்படி இருக்கிறீர்கள்？", // Tamil question
      ],
      "Tamil",
    );

    // Armenian
    expectSentences(
      [
        "Բարև։", // Armenian full stop
        "Ինչպես եք՞", // Armenian question mark
        "Շնորհակալություն՜", // Armenian exclamation
      ],
      "Armenian",
    );

    // Ethiopic (Amharic)
    expectSentences(
      [
        "ሰላም።", // Ethiopic full stop
        "እንዴት ነዎት፧", // Ethiopic question mark
      ],
      "Amharic",
    );

    // Languages using Latin punctuation (should still work)
    expectSentences(
      [
        "Hola.", // Spanish
        "Bonjour!", // French
        "Guten Tag?", // German
        "Привет.", // Russian (Cyrillic but uses Latin punctuation)
        "Γεια σας.", // Greek
        "שלום.", // Hebrew
        "გამარჯობა.", // Georgian
      ],
      "Latin script",
    );
  });

  test("test_endofsentence_cjk_with_lookahead", async () => {
    // Test sentence detection for CJK text with lookahead characters.
    //
    // This tests the tokenizer fallback path: the tokenizer returns entire
    // text as one sentence because it doesn't support CJK languages, but
    // unambiguous punctuation is detected via the fallback scan.

    // Japanese: sentence + lookahead character
    expect(matchEndofsentence("こんにちは。元")).toEqual(6);
    expect(matchEndofsentence("元気ですか？は")).toEqual(6);
    expect(matchEndofsentence("ありがとう！次")).toEqual(6);

    // Chinese: sentence + lookahead character
    expect(matchEndofsentence("你好世界。下")).toEqual(5);
    expect(matchEndofsentence("你好吗？我")).toEqual(4);

    // Korean: sentence + lookahead character
    expect(matchEndofsentence("안녕하세요。다")).toEqual(6);

    // Multiple CJK sentences with lookahead - should return first sentence
    expect(matchEndofsentence("こんにちは。元気ですか？は")).toEqual(6);

    // Indic script with lookahead
    expect(matchEndofsentence("हैलो।अ")).toEqual(5);

    // Arabic with lookahead
    expect(matchEndofsentence("مرحبا؟ك")).toEqual(6);
  });

  test("test_endofsentence_latin_not_affected_by_fallback", async () => {
    // Verify that the CJK fallback does not change behavior for Latin text.
    // These should still return 0 - Latin "." is NOT in the unambiguous set
    expect(matchEndofsentence("Mr. S")).toBeFalsy();
    expect(matchEndofsentence("Ok, Mr. Smith let's ")).toBeFalsy();
    expect(matchEndofsentence("The number pi is 3.14159")).toBeFalsy();
    expect(matchEndofsentence("America, or the U.S")).toBeFalsy();

    // These should still return correct values via the tokenizer path
    expect(matchEndofsentence("This is a sentence. This is another one")).toEqual(19);
    expect(matchEndofsentence("For information, call 411.")).toEqual(26);
  });

  test("test_endofsentence_streaming_tokens", async () => {
    // Test the specific use case of streaming LLM tokens.

    // These are the scenarios that were problematic with the original regex
    // Single tokens should not be considered complete sentences
    expect(matchEndofsentence("Hello"), "Single token should not be sentence").toBeFalsy();
    expect(matchEndofsentence("world"), "Single token should not be sentence").toBeFalsy();
    expect(matchEndofsentence("The"), "Single token should not be sentence").toBeFalsy();
    expect(matchEndofsentence("quick"), "Single token should not be sentence").toBeFalsy();

    // But accumulating tokens should eventually form sentences
    expect(matchEndofsentence("Hello world"), "No punctuation = incomplete").toBeFalsy();
    expect(matchEndofsentence("Hello world."), "With punctuation = complete").toEqual(12);

    // Test progressive building (simulating token streaming)
    const tokens = ["The", " quick", " brown", " fox", " jumps", "."];
    let accumulated = "";
    tokens.forEach((token, i) => {
      accumulated += token;
      if (i < tokens.length - 1) {
        // All but the last token
        expect(
          matchEndofsentence(accumulated),
          `Should be incomplete at token ${i}: '${accumulated}'`,
        ).toBeFalsy();
      } else {
        // Last token adds the period
        expect(matchEndofsentence(accumulated), `Should be complete: '${accumulated}'`).toEqual(
          accumulated.length,
        );
      }
    });

    // Test with multiple sentences
    expect(
      matchEndofsentence("First sentence. Second incomplete"),
      "Should return end of first sentence",
    ).toEqual(15);
  });
});

describe("TestStartEndTags", () => {
  test("test_empty", async () => {
    expect(parseStartEndTags("", [], null, 0)).toEqual([null, 0]);
    expect(parseStartEndTags("Hello from Pipecat!", [], null, 0)).toEqual([null, 0]);
  });

  test("test_simple", async () => {
    // (<a>, </a>)
    expect(parseStartEndTags("Hello from <a>Pipecat</a>!", [["<a>", "</a>"]], null, 0)).toEqual([
      null,
      26,
    ]);
    expect(parseStartEndTags("Hello from <a>Pipecat", [["<a>", "</a>"]], null, 0)).toEqual([
      ["<a>", "</a>"],
      21,
    ]);
    expect(parseStartEndTags("Hello from <a>Pipecat", [["<a>", "</a>"]], null, 6)).toEqual([
      ["<a>", "</a>"],
      21,
    ]);

    // (spell(, ))
    expect(parseStartEndTags("Hello from spell(Pipecat)!", [["spell(", ")"]], null, 0)).toEqual([
      null,
      26,
    ]);
    expect(parseStartEndTags("Hello from spell(Pipecat", [["spell(", ")"]], null, 0)).toEqual([
      ["spell(", ")"],
      24,
    ]);
  });

  test("test_multiple", async () => {
    // (<a>, </a>)
    expect(
      parseStartEndTags(
        "Hello from <a>Pipecat</a>! Hello <a>World</a>!",
        [["<a>", "</a>"]],
        null,
        0,
      ),
    ).toEqual([null, 46]);

    expect(
      parseStartEndTags("Hello from <a>Pipecat</a>! Hello <a>World", [["<a>", "</a>"]], null, 0),
    ).toEqual([["<a>", "</a>"], 41]);
  });
});

describe("TestLongestTrailingPartialMatch", () => {
  test("test_empty_and_no_match", async () => {
    expect(longestTrailingPartialMatch("", ["<a>"])).toEqual(0);
    expect(longestTrailingPartialMatch("Hello", [])).toEqual(0);
    expect(longestTrailingPartialMatch("Hello", ["<a>"])).toEqual(0);
  });

  test("test_single_candidate", async () => {
    expect(longestTrailingPartialMatch("Hello <", ["<think>"])).toEqual(1);
    expect(longestTrailingPartialMatch("Hello <thin", ["<think>"])).toEqual(5);
    // A complete candidate is not a partial match (proper prefixes only).
    expect(longestTrailingPartialMatch("Hello <think>", ["<think>"])).toEqual(0);
  });

  test("test_text_shorter_than_candidate", async () => {
    expect(longestTrailingPartialMatch("<th", ["<think>"])).toEqual(3);
  });

  test("test_multiple_candidates_longest_wins", async () => {
    // "<te" matches "<test>" (3) over the shared "<t" prefix of "<think>" (2).
    expect(longestTrailingPartialMatch("Hi <te", ["<think>", "<test>"])).toEqual(3);
    expect(longestTrailingPartialMatch("Hi <th", ["<think>", "<test>"])).toEqual(3);
    // Shared prefix alone matches both; length is the same either way.
    expect(longestTrailingPartialMatch("Hi <t", ["<think>", "<test>"])).toEqual(2);
    // Candidate order doesn't change the result.
    expect(longestTrailingPartialMatch("Hi <te", ["<test>", "<think>"])).toEqual(3);
  });

  test("test_single_char_candidate_has_no_proper_prefix", async () => {
    expect(longestTrailingPartialMatch("Hello <", ["<"])).toEqual(0);
  });
});
