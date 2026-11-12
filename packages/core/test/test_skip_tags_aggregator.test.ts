// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_skip_tags_aggregator.py

import { beforeEach, describe, expect, test } from "bun:test";

import { type Aggregation, TextType } from "../src/utils/text/base_text_aggregator.ts";
import { SkipTagsAggregator } from "../src/utils/text/skip_tags_aggregator.ts";

async function collect(iter: AsyncIterable<Aggregation>): Promise<Aggregation[]> {
  const results: Aggregation[] = [];
  for await (const agg of iter) {
    results.push(agg);
  }
  return results;
}

describe("TestSkipTagsAggregator", () => {
  let aggregator: SkipTagsAggregator;

  beforeEach(() => {
    aggregator = new SkipTagsAggregator({ tags: [["<spell>", "</spell>"]] });
  });

  test("test_no_tags", async () => {
    await aggregator.reset();

    // No tags involved, aggregate at end of sentence.
    const text = "Hello Pipecat!";
    const results = await collect(aggregator.aggregate(text));

    // Should still be waiting for lookahead after "!"
    expect(results.length).toEqual(0);

    // Flush to get the pending sentence
    const result = await aggregator.flush();
    expect(result!.text).toEqual("Hello Pipecat!");
    expect(result!.type).toEqual("sentence");
    expect(aggregator.text.text).toEqual("");
  });

  test("test_basic_tags", async () => {
    await aggregator.reset();

    // Tags involved, avoid aggregation during tags.
    const text = "My email is <spell>foo@pipecat.ai</spell>.";
    const results = await collect(aggregator.aggregate(text));

    // Should still be waiting for lookahead after "."
    expect(results.length).toEqual(0);

    // Flush to get the pending sentence
    const result = await aggregator.flush();
    expect(result!.text).toEqual("My email is <spell>foo@pipecat.ai</spell>.");
    expect(result!.type).toEqual("sentence");
    expect(aggregator.text.text).toEqual("");
  });

  test("test_streaming_tags", async () => {
    await aggregator.reset();

    // Tags involved
    const text = "My email is <spell>foo.bar@pipecat.ai</spell>.";
    const results = await collect(aggregator.aggregate(text));

    // Should still be waiting for lookahead after "."
    expect(results.length).toEqual(0);
    expect(aggregator.text.text).toEqual(text);
    expect(aggregator.text.type).toEqual("sentence");

    // Flush to get the pending sentence
    const result = await aggregator.flush();
    expect(result!.text).toEqual(text);
    expect(aggregator.text.text).toEqual("");
    expect(aggregator.text.type).toEqual("sentence");
  });

  test("test_flush_unclosed_tag_sentence_mode", async () => {
    // Unclosed tag: flush still returns the buffered text (pin current behavior).
    //
    // Tags are pass-through markers, so an unclosed tag's content is spoken
    // the same as a closed tag's, matching test_basic_tags.
    await aggregator.reset();

    const text = "My email is <spell>foo@pipecat.ai";
    let results = await collect(aggregator.aggregate(text));
    expect(results.length).toEqual(0);

    const result = await aggregator.flush();
    expect(result!.text).toEqual(text);
    expect(result!.type).toEqual("sentence");

    // Tag state resets after flush, so a reused aggregator isn't stuck
    // thinking it's still inside a tag.
    expect(aggregator.text.text).toEqual("");
    results = await collect(aggregator.aggregate("Hi there. Next"));
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hi there.");
  });

  test("test_closed_tag_content_not_split", async () => {
    // Punctuation inside a closed tag is not a sentence boundary.
    await aggregator.reset();

    const text = "Your code is <spell>X. Y. Z</spell>. Say <spell>St. Louis</spell> slowly. Done";
    const results = await collect(aggregator.aggregate(text));

    expect(results.map((r) => r.text)).toEqual([
      "Your code is <spell>X. Y. Z</spell>.",
      "Say <spell>St. Louis</spell> slowly.",
    ]);
    const result = await aggregator.flush();
    expect(result!.text).toEqual("Done");
  });

  test("test_tag_after_emitted_sentence_not_split", async () => {
    // A tag is still recognized after an earlier sentence has been emitted.
    await aggregator.reset();

    const text = "Hi <spell>AB</spell>. My name is <spell>Bob. Smith</spell> today. Done";
    const results = await collect(aggregator.aggregate(text));

    expect(results.map((r) => r.text)).toEqual([
      "Hi <spell>AB</spell>.",
      "My name is <spell>Bob. Smith</spell> today.",
    ]);
  });
});

describe("TestSkipTagsAggregatorTokenMode", () => {
  let aggregator: SkipTagsAggregator;

  beforeEach(() => {
    aggregator = new SkipTagsAggregator({
      tags: [["<spell>", "</spell>"]],
      aggregationType: TextType.TOKEN,
    });
  });

  test("test_token_no_tags", async () => {
    // No tags: text passes through immediately as TOKEN.
    const results = await collect(aggregator.aggregate("Hello!"));
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hello!");
    expect(results[0]!.type).toEqual("token");
  });

  test("test_token_inside_tag_buffers", async () => {
    // Inside a tag, text is buffered until the closing tag is found.
    let results = await collect(aggregator.aggregate("<spell>foo@bar"));
    // Still inside tag, nothing yielded
    expect(results.length).toEqual(0);

    // Close the tag
    results = await collect(aggregator.aggregate("</spell>"));
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("<spell>foo@bar</spell>");
    expect(results[0]!.type).toEqual("token");
  });

  test("test_token_flush_unclosed_tag", async () => {
    // Flush with an unclosed tag returns the buffered text instead of dropping it.
    await collect(aggregator.aggregate("<spell>unclosed"));
    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toEqual("<spell>unclosed");
    expect(result!.type).toEqual("token");

    // Buffer and tag state are reset after flush.
    expect(aggregator.text.text).toEqual("");
    const results = await collect(aggregator.aggregate("more text"));
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("more text");
  });

  test("test_token_flush_empty_buffer", async () => {
    // Flush with nothing buffered returns None.
    await collect(aggregator.aggregate("Hello!"));
    const result = await aggregator.flush();
    expect(result).toBeNull();
  });

  test("test_token_text_around_tags", async () => {
    // Simulate word-by-word token delivery with tags.
    const results: Aggregation[] = [];
    // Simulate LLM streaming tokens one at a time
    for (const token of ["Hi ", "<spell>", "X", "</spell>", " bye"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    expect(results.length).toEqual(3);
    // Text before tag passes through immediately
    expect(results[0]!.text).toEqual("Hi ");
    expect(results[0]!.type).toEqual("token");
    // Tagged content is buffered until the closing tag, then yielded whole
    expect(results[1]!.text).toEqual("<spell>X</spell>");
    expect(results[1]!.type).toEqual("token");
    // Text after tag passes through immediately
    expect(results[2]!.text).toEqual(" bye");
    expect(results[2]!.type).toEqual("token");
  });

  test("test_token_start_tag_split_across_chunks", async () => {
    // A start tag split across chunks is not leaked as plain text.
    //
    // Regression test for https://github.com/pipecat-ai/pipecat/issues/5267:
    // on unmodified main, "<spe" is yielded as a token before the tag
    // reassembles, fragmenting content that should be emitted as one token.
    const results: Aggregation[] = [];
    for (const token of ["Call ", "<spe", "ll>a b c</spell>", " now"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["Call ", "<spell>a b c</spell>", " now"]);
  });

  test("test_token_start_tag_split_across_three_chunks", async () => {
    // A start tag split across three chunks reassembles into one token.
    const results: Aggregation[] = [];
    for (const token of ["<sp", "el", "l>abc</spell>"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    // Nothing should have leaked while the tag was reassembling.
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("<spell>abc</spell>");
  });

  test("test_token_partial_tag_chunk_yields_nothing", async () => {
    // A chunk that is entirely a partial start tag yields nothing.
    const results = await collect(aggregator.aggregate("<spe"));
    expect(results).toEqual([]);
    expect(aggregator.text.text).toEqual("<spe");
  });

  test("test_token_trailing_prefix_char_held_then_emitted", async () => {
    // A plain trailing '<' is held back and emitted with the next chunk once it
    // no longer matches a tag.
    const results: Aggregation[] = [];
    for await (const agg of aggregator.aggregate("Hi <")) {
      results.push(agg);
    }
    // "<" could be the start of "<spell>", so it's held back.
    expect(results.length).toEqual(1);
    expect(results[0]!.text).toEqual("Hi ");

    for await (const agg of aggregator.aggregate(" there")) {
      results.push(agg);
    }
    // Once the held-back "<" is followed by something other than "s", it
    // no longer matches a tag prefix and is emitted with the rest.
    expect(results.length).toEqual(2);
    expect(results[1]!.text).toEqual("< there");
  });

  test("test_token_partial_tag_after_yield_in_same_chunk", async () => {
    // A chunk holding both yieldable text and a trailing partial tag keeps
    // the tag working: the retained partial tag is rescanned once complete,
    // so content split across later chunks still buffers as one unit.
    const results: Aggregation[] = [];
    for (const token of ["Call <spe", "ll>a b", " c</sp", "ell> now"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["Call ", "<spell>a b c</spell> now"]);
  });

  test("test_token_multiple_tag_pairs_split_across_chunks", async () => {
    // With multiple registered tag pairs, a split start tag of either
    // pair is held back and reassembles.
    const aggregator = new SkipTagsAggregator({
      tags: [
        ["<spell>", "</spell>"],
        ["<code>", "</code>"],
      ],
      aggregationType: TextType.TOKEN,
    });

    const results: Aggregation[] = [];
    for (const token of ["Call ", "<cod", "e>x</code>", " and ", "<spe", "ll>y</spell>", " done"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["Call ", "<code>x</code>", " and ", "<spell>y</spell>", " done"]);
  });

  test("test_token_second_tag_after_closed_tag_not_fragmented", async () => {
    // A second tag opened after an earlier tag closes is not fragmented.
    //
    // Regression test for https://github.com/pipecat-ai/pipecat/issues/5267:
    // on unmodified main, `_current_tag_index` is left pointing past the end
    // of the buffer once it's cleared after the first tag closes, making
    // `parse_start_end_tags` blind to every tag that follows.
    const results: Aggregation[] = [];
    for (const token of ["<spell>abc</spell>", "<spell>de", "f</spell>", " done"]) {
      for await (const agg of aggregator.aggregate(token)) {
        results.push(agg);
      }
    }

    const texts = results.map((r) => r.text);
    expect(texts).toEqual(["<spell>abc</spell>", "<spell>def</spell>", " done"]);
  });
});
