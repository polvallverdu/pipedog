// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_simple_text_aggregator.py

import { beforeEach, describe, expect, test } from "bun:test";

import { type Aggregation, TextType } from "../src/utils/text/base_text_aggregator.ts";
import { SimpleTextAggregator } from "../src/utils/text/simple_text_aggregator.ts";

async function collect(iter: AsyncIterable<Aggregation>): Promise<Aggregation[]> {
  const results: Aggregation[] = [];
  for await (const agg of iter) {
    results.push(agg);
  }
  return results;
}

describe("TestSimpleTextAggregator", () => {
  let aggregator: SimpleTextAggregator;

  beforeEach(() => {
    aggregator = new SimpleTextAggregator();
  });

  test("test_reset_aggregations", async () => {
    const text = "Hello ";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences yet
    expect(results.length).toBe(0);
    expect(aggregator.text.text).toBe("Hello");
    await aggregator.reset();
    expect(aggregator.text.text).toBe("");
  });

  test("test_simple_sentence", async () => {
    const text = "Hello Pipecat!";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences yet (waiting for lookahead after "!")
    expect(results.length).toBe(0);

    // Flush to get the pending sentence
    const aggregate = await aggregator.flush();
    expect(aggregate!.text).toBe("Hello Pipecat!");
    expect(aggregate!.type).toBe("sentence");
    expect(aggregator.text.text).toBe("");
  });

  test("test_multiple_sentences", async () => {
    const text = "Hello Pipecat! How are you?";
    const results = await collect(aggregator.aggregate(text));

    // First sentence should be complete (lookahead from "H" confirmed it)
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("Hello Pipecat!");

    // Flush to get the pending sentence
    const result = await aggregator.flush();
    expect(result!.text).toBe("How are you?");
  });

  test("test_lookahead_decimal_number", async () => {
    // Test that $29.95 is not split at $29.
    const text = "Ask me for only $29.95/month.";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences yet (waiting for lookahead after final ".")
    expect(results.length).toBe(0);

    // Can use flush() to get the pending sentence at end of stream
    const result = await aggregator.flush();
    expect(result!.text).toBe("Ask me for only $29.95/month.");
  });

  test("test_lookahead_abbreviation", async () => {
    // Test that Mr. Smith is not split at Mr.
    const text = "Hello Mr. Smith.";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences yet (waiting for lookahead after final ".")
    expect(results.length).toBe(0);

    // Can use flush() to get the pending sentence at end of stream
    const result = await aggregator.flush();
    expect(result!.text).toBe("Hello Mr. Smith.");
  });

  test("test_lookahead_actual_sentence_end", async () => {
    // Test that a real sentence end is detected after lookahead.
    const text = "Hello world. Next sentence";
    const results = await collect(aggregator.aggregate(text));

    // First sentence should be complete (lookahead from "N" confirmed it)
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("Hello world.");
  });

  test("test_flush_pending_sentence", async () => {
    // Test that flush() returns pending sentence waiting for lookahead.
    const text = "Hello world.";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences yet (waiting for lookahead)
    expect(results.length).toBe(0);

    // Call flush to get it
    const result = await aggregator.flush();
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello world.");
    // Flush again should return None
    expect(await aggregator.flush()).toBeNull();
  });

  test("test_flush_with_no_pending", async () => {
    // Test that flush() returns any remaining text in buffer.
    const text = "Hello";
    const results = await collect(aggregator.aggregate(text));

    // No complete sentences
    expect(results.length).toBe(0);

    const result = await aggregator.flush();
    // flush() now returns any remaining text, not just pending lookahead
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello");
    // Buffer should be empty after flush
    expect(aggregator.text.text).toBe("");
  });

  test("test_flush_after_lookahead_confirmed", async () => {
    // Test flush after lookahead has already confirmed sentence.
    const text = "Hello. W";
    const results = await collect(aggregator.aggregate(text));

    // First sentence should be complete (lookahead from "W" confirmed it)
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("Hello.");

    // flush() returns any remaining text (the "W" in this case)
    const result = await aggregator.flush();
    expect(result!.text).toBe("W");
  });

  test("test_japanese_multiple_sentences", async () => {
    // Test that Japanese sentences are properly split during streaming.
    const text = "こんにちは。元気ですか？";
    const results = await collect(aggregator.aggregate(text));

    // First sentence detected when 元 arrives as lookahead after 。
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("こんにちは。");

    // Flush returns the second sentence
    const result = await aggregator.flush();
    expect(result!.text).toBe("元気ですか？");
  });

  test("test_japanese_sentence_with_lookahead", async () => {
    // Test that a Japanese sentence is detected with a lookahead character.
    const text = "こんにちは。元";
    const results = await collect(aggregator.aggregate(text));

    // 。 triggers lookahead, then 元 confirms it
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("こんにちは。");

    // Flush returns remainder
    const result = await aggregator.flush();
    expect(result!.text).toBe("元");
  });

  test("test_chinese_streaming_tokens", async () => {
    // Test Chinese text split across multiple streaming tokens.
    const aggregator = new SimpleTextAggregator();

    const tokens = ["你好", "世界", "。", "下一", "句话", "。"];
    const allResults: Aggregation[] = [];
    for (const token of tokens) {
      const results = await collect(aggregator.aggregate(token));
      allResults.push(...results);
    }

    // First sentence detected when 下 arrives after 。
    expect(allResults.length).toBe(1);
    expect(allResults[0]!.text).toBe("你好世界。");

    // Flush returns the second sentence
    const result = await aggregator.flush();
    expect(result!.text).toBe("下一句话。");
  });

  test("test_japanese_single_sentence_flush", async () => {
    // Test that a single Japanese sentence with no lookahead flushes correctly.
    const text = "こんにちは。";
    const results = await collect(aggregator.aggregate(text));

    // No lookahead yet - waiting
    expect(results.length).toBe(0);

    // Flush returns the complete sentence
    const result = await aggregator.flush();
    expect(result!.text).toBe("こんにちは。");
  });
});

describe("TestSimpleTextAggregatorTokenMode", () => {
  let aggregator: SimpleTextAggregator;

  beforeEach(() => {
    aggregator = new SimpleTextAggregator({ aggregationType: TextType.TOKEN });
  });

  test("test_token_passthrough", async () => {
    // TOKEN mode yields text immediately without buffering.
    const results = await collect(aggregator.aggregate("Hello"));
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("Hello");
    expect(results[0]!.type).toBe("token");
  });

  test("test_token_multiple_calls", async () => {
    // Each aggregate call yields its text independently.
    const r1 = await collect(aggregator.aggregate("Hello "));
    const r2 = await collect(aggregator.aggregate("world."));
    expect(r1.length).toBe(1);
    expect(r1[0]!.text).toBe("Hello ");
    expect(r2.length).toBe(1);
    expect(r2[0]!.text).toBe("world.");
  });

  test("test_token_empty_text", async () => {
    // Empty text yields nothing.
    const results = await collect(aggregator.aggregate(""));
    expect(results.length).toBe(0);
  });

  test("test_token_flush_returns_none", async () => {
    // Flush returns None in TOKEN mode since nothing is buffered.
    await aggregator.aggregate("Hello")[Symbol.asyncIterator]().next();
    const result = await aggregator.flush();
    expect(result).toBeNull();
  });
});
