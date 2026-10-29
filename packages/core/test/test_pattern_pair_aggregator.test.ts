// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_pattern_pair_aggregator.py

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { type Aggregation, TextType } from "../src/utils/text/base_text_aggregator.ts";
import {
  MatchAction,
  PatternMatch,
  PatternPairAggregator,
} from "../src/utils/text/pattern_pair_aggregator.ts";

type Handler = ReturnType<typeof makeHandler>;

function makeHandler() {
  return mock(async (_match: PatternMatch) => {});
}

/** `handler.call_args[0][0]` */
function lastArg(handler: Handler): PatternMatch {
  const calls = handler.mock.calls;
  return calls[calls.length - 1]![0];
}

async function collect(gen: AsyncGenerator<PatternMatch>): Promise<PatternMatch[]> {
  const results: PatternMatch[] = [];
  for await (const r of gen) results.push(r);
  return results;
}

describe("TestPatternPairAggregator", () => {
  let aggregator: PatternPairAggregator;
  let testHandler: Handler;
  let codeHandler: Handler;

  beforeEach(() => {
    aggregator = new PatternPairAggregator();
    testHandler = makeHandler();
    codeHandler = makeHandler();

    // Add a test pattern
    aggregator.addPattern("test_pattern", "<test>", "</test>");
    aggregator.addPattern("code_pattern", "<code>", "</code>", MatchAction.AGGREGATE);

    // Register the mock handler
    aggregator.onPatternMatch("test_pattern", testHandler);
    aggregator.onPatternMatch("code_pattern", codeHandler);
  });

  test("test_pattern_match_and_removal", async () => {
    const text = "Hello <test>pattern content</test>!";
    const results = await collect(aggregator.aggregate(text));

    // Verify the handler was called with correct PatternMatch object
    expect(testHandler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(testHandler);
    expect(callArgs).toBeInstanceOf(PatternMatch);
    expect(callArgs.type).toEqual("test_pattern");
    expect(callArgs.fullMatch).toEqual("<test>pattern content</test>");
    expect(callArgs.text).toEqual("pattern content");

    // No results yet (waiting for lookahead after "!")
    expect(results.length).toEqual(0);

    // Next sentence should provide the lookahead and trigger the previous sentence
    for await (const result of aggregator.aggregate(" This is another sentence.")) {
      results.push(result);
    }

    // First result should be "Hello !" triggered by the space lookahead
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hello !");
    expect(results[0]!.type).toEqual("sentence");

    // Now flush to get the remaining sentence
    const result = await aggregator.flush();
    expect(result!.text).toEqual("This is another sentence.");

    // Buffer should be empty after returning a complete sentence
    expect(aggregator.text.text).toEqual("");
  });

  test("test_pattern_match_and_aggregate", async () => {
    const text = "Here is code <code>pattern content</code> This is another sentence.";

    const results = await collect(aggregator.aggregate(text));

    // First result should be "Here is code" when pattern starts
    expect(results[0]!.text).toEqual("Here is code");
    expect(results[0]!.type).toEqual("sentence");

    // Second result should be the code pattern content
    expect(results[1]!.text).toEqual("pattern content");
    expect(results[1]!.type).toEqual("code_pattern");

    // Verify the handler was called with correct PatternMatch object
    expect(codeHandler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(codeHandler);
    expect(callArgs).toBeInstanceOf(PatternMatch);
    expect(callArgs.type).toEqual("code_pattern");
    expect(callArgs.fullMatch).toEqual("<code>pattern content</code>");
    expect(callArgs.text).toEqual("pattern content");

    // Last sentence needs flush (waiting for lookahead after ".")
    const result = await aggregator.flush();
    expect(result!.text).toEqual("This is another sentence.");
    expect(result!.type).toEqual("sentence");

    // Buffer should be empty after returning a complete sentence
    expect(aggregator.text.text).toEqual("");
  });

  test("test_incomplete_pattern", async () => {
    const text = "Hello <test>pattern content";
    const results = await collect(aggregator.aggregate(text));
    // No complete pattern yet, so nothing should be returned
    expect(results.length).toEqual(0);

    // The handler should not be called yet
    expect(testHandler).not.toHaveBeenCalled();

    // Buffer should contain the incomplete text
    expect(aggregator.text.text).toEqual("Hello <test>pattern content");
    expect(aggregator.text.type).toEqual("test_pattern");

    // Reset and confirm buffer is cleared
    await aggregator.reset();
    expect(aggregator.text.text).toEqual("");
  });

  test("test_multiple_patterns", async () => {
    // Set up multiple patterns and handlers
    const voiceHandler = makeHandler();
    const emphasisHandler = makeHandler();

    aggregator.addPattern("voice", "<voice>", "</voice>", MatchAction.REMOVE);

    aggregator.addPattern("emphasis", "<em>", "</em>", MatchAction.KEEP); // Keep emphasis tags

    aggregator.onPatternMatch("voice", voiceHandler);
    aggregator.onPatternMatch("emphasis", emphasisHandler);

    const text = "Hello <voice>female</voice> I am <em>very</em> excited to meet you!";
    const results = await collect(aggregator.aggregate(text));

    // Both handlers should be called with correct data
    expect(voiceHandler).toHaveBeenCalledTimes(1);
    const voiceMatch = lastArg(voiceHandler);
    expect(voiceMatch.type).toEqual("voice");
    expect(voiceMatch.text).toEqual("female");

    expect(emphasisHandler).toHaveBeenCalledTimes(1);
    const emphasisMatch = lastArg(emphasisHandler);
    expect(emphasisMatch.type).toEqual("emphasis");
    expect(emphasisMatch.text).toEqual("very");

    // With lookahead, we need to flush to get the final sentence
    expect(results.length).toEqual(0); // Waiting for lookahead after "!"

    const result = await aggregator.flush();
    // Voice pattern should be removed, emphasis pattern should remain
    expect(result!.text).toEqual("Hello  I am <em>very</em> excited to meet you!");

    // Buffer should be empty
    expect(aggregator.text.text).toEqual("");
  });

  test("test_handle_interruption", async () => {
    const text = "Hello <test>pattern";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    // Simulate interruption
    await aggregator.handleInterruption();

    // Buffer should be cleared
    expect(aggregator.text.text).toEqual("");

    // Handler should not have been called
    expect(testHandler).not.toHaveBeenCalled();
  });

  test("test_pattern_across_sentences", async () => {
    const text = "Hello <test>This is sentence one. This is sentence two.</test> Final sentence.";
    const results = await collect(aggregator.aggregate(text));

    // Handler should be called with entire content
    expect(testHandler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(testHandler);
    expect(callArgs.text).toEqual("This is sentence one. This is sentence two.");

    // With lookahead, we need to flush to get the final sentence
    expect(results.length).toEqual(0); // Waiting for lookahead after "."

    const result = await aggregator.flush();
    // Pattern should be removed, resulting in text with sentences merged
    expect(result!.text).toEqual("Hello  Final sentence.");

    // Buffer should be empty
    expect(aggregator.text.text).toEqual("");
  });

  /** Punctuation inside a closed KEEP pattern is not a sentence boundary. */
  test("test_keep_pattern_content_not_split", async () => {
    aggregator.addPattern("spell_pattern", "<spell>", "</spell>", MatchAction.KEEP);

    const text = "Your code is <spell>X. Y. Z</spell>. Say <spell>St. Louis</spell> slowly. Done";
    const results = await collect(aggregator.aggregate(text));

    expect(results.map((r) => r.text)).toEqual([
      "Your code is <spell>X. Y. Z</spell>.",
      "Say <spell>St. Louis</spell> slowly.",
    ]);
    const result = await aggregator.flush();
    expect(result!.text).toEqual("Done");
  });

  /**
   * Unclosed REMOVE pattern: flush returns text before it, drops the rest.
   *
   * A closed <test>...</test> pair is stripped from the output entirely
   * (see test_pattern_match_and_removal); an unclosed one degrades to the
   * same result instead of leaking the raw start tag and its content.
   */
  test("test_flush_unclosed_pattern_returns_preceding_text", async () => {
    const text = "Well <test>pattern content";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual("Well");
    expect(result!.text).not.toContain("<test>");
    expect(result!.text).not.toContain("pattern content");

    // The pair never closed, so its handler is not invoked.
    expect(testHandler).not.toHaveBeenCalled();

    // Buffer is cleared after flush.
    expect(aggregator.text.text).toEqual("");
  });

  /** Unclosed pattern with nothing before it: flush drops it entirely. */
  test("test_flush_unclosed_pattern_with_no_preceding_text", async () => {
    const text = "<test>pattern content";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result = await aggregator.flush();
    expect(result).toBeNull();
    expect(testHandler).not.toHaveBeenCalled();
  });

  /** After flush drops an incomplete pattern, the aggregator works cleanly again. */
  test("test_flush_state_resets_for_reuse", async () => {
    let text = "Well <test>pattern content";
    for await (const _ of aggregator.aggregate(text)) {
      // pass
    }
    await aggregator.flush();
    expect(aggregator.text.text).toEqual("");

    // A fresh, fully-closed pattern still works after the reset.
    text = "New <test>value</test> sentence.";
    const results = await collect(aggregator.aggregate(text));
    const result = await aggregator.flush();
    const combined = results.map((r) => r.text).join("") + (result ? result.text : "");
    expect(combined).not.toContain("value");
    expect(combined).toContain("New");
  });

  /**
   * A prior closed REMOVE pair doesn't confuse handling of a later,
   * genuinely unclosed occurrence of the same pattern type: flush must
   * find the actual unmatched occurrence, not just the first occurrence
   * of the start delimiter in the buffer.
   */
  test("test_flush_remove_pattern_closed_then_unclosed_same_type", async () => {
    const text = "Start <test>closed</test> middle <test>unclosed";
    const results = await collect(aggregator.aggregate(text));

    const result = await aggregator.flush();
    const combined = results.map((r) => r.text).join("") + (result ? result.text : "");
    expect(combined).toContain("Start");
    expect(combined).toContain("middle");
    expect(combined).not.toContain("closed");
    expect(combined).not.toContain("unclosed");

    expect(testHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * Two different unclosed REMOVE patterns: flush cuts at whichever
   * starts first in the text, not whichever pattern was registered first.
   */
  test("test_flush_earliest_unmatched_wins_regardless_of_registration_order", async () => {
    const aggregator = new PatternPairAggregator();
    const voiceHandler = makeHandler();
    const testHandler = makeHandler();
    // Registered in reverse of where they appear in the text below.
    aggregator.addPattern("voice", "<voice>", "</voice>", MatchAction.REMOVE);
    aggregator.addPattern("test2", "<test>", "</test>", MatchAction.REMOVE);
    aggregator.onPatternMatch("voice", voiceHandler);
    aggregator.onPatternMatch("test2", testHandler);

    const text = "Hi <test>foo <voice>bar";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual("Hi");
    expect(result!.text).not.toContain("foo");
    expect(result!.text).not.toContain("bar");
    expect(voiceHandler).not.toHaveBeenCalled();
    expect(testHandler).not.toHaveBeenCalled();
  });

  /**
   * Unclosed KEEP pattern: flush keeps the content, delimiter
   * included, just as a closed KEEP pair is kept verbatim (see
   * test_multiple_patterns).
   */
  test("test_flush_unclosed_keep_pattern_kept_verbatim", async () => {
    aggregator.addPattern("emphasis", "<em>", "</em>", MatchAction.KEEP);

    const text = "Well <em>unclosed content";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual(text);
  });

  /**
   * A closed KEEP pair earlier in the buffer must not be mistaken for
   * the unmatched one; the actually-unmatched occurrence can come later.
   */
  test("test_flush_keep_pattern_uses_correct_unmatched_occurrence", async () => {
    aggregator.addPattern("emphasis", "<em>", "</em>", MatchAction.KEEP);

    const text = "Hello <em>bold</em> world <em>unclosed";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    // Unclosed KEEP content is kept, so nothing gets dropped, and the
    // closed <em>bold</em> pair is not mistaken for the unmatched one.
    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual(text);
  });

  /**
   * Unclosed AGGREGATE pattern: content is dropped like REMOVE, and its
   * handler is not invoked, since AGGREGATE content is a side channel
   * that's never spoken.
   */
  test("test_flush_unclosed_aggregate_pattern_dropped_without_handler", async () => {
    const text = "Before <code>unclosed content";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Before");

    const result = await aggregator.flush();
    expect(result).toBeNull();
    expect(codeHandler).not.toHaveBeenCalled();
  });

  /**
   * A completed pair still sitting in the buffer at flush time is not
   * mistaken for an unmatched one: its start delimiter (and any start
   * nested inside its span) is skipped, and the cut happens at the
   * genuinely unmatched occurrence that follows it.
   */
  test("test_flush_skips_completed_pair_still_in_buffer", async () => {
    // Seed the buffer directly: aggregate() strips closed REMOVE pairs
    // eagerly, so flush() seeing one only happens in edge cases (e.g. a
    // pair completing while _last_processed_position is stale).
    (aggregator as unknown as { _text: string })._text =
      "Start <test>closed</test> middle <test>unclosed";

    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual("Start <test>closed</test> middle");
    expect(result!.text).not.toContain("unclosed");
  });

  /**
   * Buffer ending mid-delimiter (stream cut off inside '<test>') has
   * the partial delimiter trimmed rather than spoken as plain text.
   */
  test("test_flush_trims_trailing_partial_start_delimiter", async () => {
    const text = "Hello <te";
    const results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result: Aggregation | null = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual("Hello");
  });
});

describe("TestPatternPairAggregatorTokenMode", () => {
  let aggregator: PatternPairAggregator;
  let handler: Handler;

  beforeEach(() => {
    aggregator = new PatternPairAggregator({ aggregationType: TextType.TOKEN });
    handler = makeHandler();
    aggregator.addPattern("think", "<think>", "</think>", MatchAction.REMOVE);
    aggregator.onPatternMatch("think", handler);
  });

  /** Non-pattern text passes through as TOKEN, one per aggregate call. */
  test("test_token_no_patterns", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["Hello", " world", "."]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    expect(results.length).toEqual(3);
    expect(results[0]!.text).toEqual("Hello");
    expect(results[1]!.text).toEqual(" world");
    expect(results[2]!.text).toEqual(".");
    for (const r of results) {
      expect(r.type).toEqual("token");
    }
  });

  /** Pattern detection still works with word-by-word token delivery. */
  test("test_token_pattern_detection", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["Hi ", "<think>", "secret", "</think>", " bye"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    // Handler called once when the pattern completes
    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(handler);
    expect(callArgs.text).toEqual("secret");

    // "Hi " yields before pattern starts, pattern is removed, " bye" yields after
    expect(results.length).toEqual(2);
    expect(results[0]!.text).toEqual("Hi ");
    expect(results[0]!.type).toEqual("token");
    expect(results[1]!.text).toEqual(" bye");
    expect(results[1]!.type).toEqual("token");
  });

  /** Incomplete pattern is buffered across calls, not leaked to output. */
  test("test_token_incomplete_pattern_buffers", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["Hi ", "<think>", "partial"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    // Only "Hi " should be yielded; "<think>partial" stays buffered
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hi ");
    expect(results[0]!.type).toEqual("token");
    expect(handler).not.toHaveBeenCalled();
  });

  /** TOKEN mode: an unclosed REMOVE pattern is dropped on flush, not leaked. */
  test("test_token_flush_drops_unclosed_pattern", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["Hi ", "<think>", "secret"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hi ");

    const result = await aggregator.flush();
    expect(result).toBeNull();
    expect(handler).not.toHaveBeenCalled();

    // State resets after flush.
    expect(aggregator.text.text).toEqual("");
  });

  /**
   * A start delimiter split across chunks is not leaked as plain text.
   *
   * Regression test for https://github.com/pipecat-ai/pipecat/issues/5267:
   * on unmodified main, "<thin" is yielded as a token before the delimiter
   * reassembles, so the REMOVE pattern is never recognized and "secret" is
   * spoken.
   */
  test("test_token_start_delimiter_split_across_chunks", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["Hi ", "<thin", "k>secret</think>", " bye"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    // The delimiter reassembles and the pattern is recognized: content is
    // stripped and the handler fires exactly once with the right content.
    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(handler);
    expect(callArgs.text).toEqual("secret");

    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["Hi ", " bye"]);
  });

  /** A start delimiter split across three chunks reassembles correctly. */
  test("test_token_start_delimiter_split_across_three_chunks", async () => {
    const results: PatternMatch[] = [];
    for (const token of ["<th", "in", "k>secret</think>"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(handler);
    expect(callArgs.text).toEqual("secret");

    // Nothing should have leaked while the delimiter was reassembling.
    expect(results).toEqual([]);
  });

  /** A chunk that is entirely a partial delimiter yields nothing. */
  test("test_token_partial_delimiter_chunk_yields_nothing", async () => {
    const results = await collect(aggregator.aggregate("<thin"));
    expect(results).toEqual([]);
    expect(aggregator.text.text).toEqual("<thin");
  });

  /** A plain trailing '<' is held back and emitted with the next chunk once it no longer matches a delimiter. */
  test("test_token_trailing_prefix_char_held_then_emitted", async () => {
    const results: PatternMatch[] = [];
    for await (const r of aggregator.aggregate("Hello <")) results.push(r);
    // "<" could be the start of "<think>", so it's held back.
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hello ");

    for await (const r of aggregator.aggregate(" world")) results.push(r);
    // Once the held-back "<" is followed by something other than "t", it
    // no longer matches a delimiter prefix and is emitted with the rest.
    expect(results.length).toEqual(2);
    expect(results[1]!.text).toEqual("< world");
  });

  /**
   * A split AGGREGATE delimiter still reassembles: content is yielded as
   * its own aggregation instead of the fragments leaking as plain tokens.
   */
  test("test_token_split_aggregate_delimiter_recognized", async () => {
    const codeHandler = makeHandler();
    aggregator.addPattern("code_pattern", "<code>", "</code>", MatchAction.AGGREGATE);
    aggregator.onPatternMatch("code_pattern", codeHandler);

    const results: PatternMatch[] = [];
    for (const token of ["Here is code ", "<cod", "e>pattern content</code>", " more"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    expect(codeHandler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(codeHandler);
    expect(callArgs.text).toEqual("pattern content");

    expect(results.map((r) => [r.type, r.text])).toEqual([
      ["token", "Here is code "],
      ["code_pattern", "pattern content"],
      ["token", " more"],
    ]);
  });

  /** A split KEEP delimiter still reassembles and triggers its handler. */
  test("test_token_split_keep_delimiter_recognized", async () => {
    const keepHandler = makeHandler();
    aggregator.addPattern("em", "<em>", "</em>", MatchAction.KEEP);
    aggregator.onPatternMatch("em", keepHandler);

    const results: PatternMatch[] = [];
    for (const token of ["very <e", "m>excited</em> today"]) {
      for await (const r of aggregator.aggregate(token)) results.push(r);
    }

    expect(keepHandler).toHaveBeenCalledTimes(1);
    const callArgs = lastArg(keepHandler);
    expect(callArgs.text).toEqual("excited");

    // KEEP delimiters stay in the text; the split start delimiter
    // reassembles intact instead of leaking as a fragment ("<e").
    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["very ", "<em>excited</em> today"]);
  });
});

/** A pattern whose start and end delimiters are the same string, like a Markdown code fence. */
describe("TestPatternPairAggregatorSameDelimiter", () => {
  let aggregator: PatternPairAggregator;

  beforeEach(() => {
    aggregator = new PatternPairAggregator();
    aggregator.addPattern("code", "```", "```", MatchAction.AGGREGATE);
  });

  async function run(chunks: string[]): Promise<[string, string][]> {
    const results: [string, string][] = [];
    for (const chunk of chunks) {
      for await (const aggregation of aggregator.aggregate(chunk)) {
        results.push([String(aggregation.type), aggregation.text]);
      }
    }
    const remaining = await aggregator.flush();
    if (remaining) {
      results.push(["flush", remaining.text]);
    }
    return results;
  }

  test("test_text_before_fence_is_yielded", async () => {
    const results = await run(["Here is the code:\n```python\nprint(1)\n```\nDone."]);
    expect(results).toEqual([
      ["sentence", "Here is the code:"],
      ["code", "python\nprint(1)"],
      ["flush", "Done."],
    ]);
  });

  test("test_sentence_before_fence_is_not_split_inside_it", async () => {
    const results = await run(["Here is the code.\n```python\nprint(1)\n```\nDone."]);
    expect(results).toEqual([
      ["sentence", "Here is the code."],
      ["code", "python\nprint(1)"],
      ["flush", "Done."],
    ]);
  });

  test("test_fence_split_across_chunks", async () => {
    const results = await run([
      "Here is",
      " the code.\n",
      "``",
      "`python\nprint(1)\n",
      "``",
      "`\nDone.",
    ]);
    expect(results).toEqual([
      ["sentence", "Here is the code."],
      ["code", "python\nprint(1)"],
      ["flush", "Done."],
    ]);
  });

  test("test_two_blocks_pair_in_order", async () => {
    const results = await run(["A.\n```\none\n```\nB.\n```\ntwo\n```\nC."]);
    expect(results).toEqual([
      ["sentence", "A."],
      ["code", "one"],
      ["sentence", "B."],
      ["code", "two"],
      ["flush", "C."],
    ]);
  });

  test("test_unclosed_fence_is_dropped_at_flush", async () => {
    const results = await run(["Type ``` to start a block."]);
    expect(results).toEqual([["sentence", "Type"]]);
    // The next reply starts clean.
    expect(await run(["How else can I help?"])).toEqual([["flush", "How else can I help?"]]);
  });
});
