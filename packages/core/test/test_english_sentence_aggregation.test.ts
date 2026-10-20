// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_english_sentence_aggregation.py

/** English sentence boundaries under fragmented streaming input. */

import { describe, expect, test } from "bun:test";

import { SimpleTextAggregator } from "../src/utils/text/simple_text_aggregator.ts";

const CHUNKINGS = ["whole", "word", "character", "three_characters"] as const;

const SENTENCES: [string, string[]][] = [
  ["sentence_final_time", ["We met at 5 p.m.", "Then we left."]],
  ["sentence_final_acronym", ["He lives in the U.S.", "His sister lives in Canada."]],
  ["mid_sentence_abbreviation", ["We sell pens, paper, etc. in the shop.", "Come inside."]],
  ["sentence_final_abbreviation", ["We sell pens, paper, etc.", "The shop closes at six."]],
  ["initials", ["W. E. B. Du Bois wrote extensively.", "His work remains influential."]],
  ["attributed_exclamation", ['"Stop!" he shouted.', "The car halted."]],
  ["attributed_question", ["“Are you ready?” she asked.", "I nodded."]],
  ["ellipsis_boundary", ["Wait...", "Then continue."]],
  ["mid_sentence_ellipsis", ["That's strange... but possible.", "Let's check."]],
  ["repeated_exclamation", ["No!!!", "Stop!"]],
  ["ip_address", ["Your IP address is 192.168.1.1.", "Enter it in the browser."]],
  ["url", ["Go to https://example.com/help.", "Then click Support."]],
  ["email", ["Email support@example.com.", "We'll reply soon."]],
];

describe("test_english_sentence_aggregation", () => {
  // pytest ids: test_name[<sentences id>-<chunking>]
  for (const chunking of CHUNKINGS) {
    for (const [id, sentences] of SENTENCES) {
      test(`test_english_boundaries_preserve_text_across_chunks[${id}-${chunking}]`, async () => {
        const text = sentences.join(" ");
        let chunks: string[];
        if (chunking === "whole") {
          chunks = [text];
        } else if (chunking === "word") {
          chunks = text.match(/\S+\s*/g) ?? [];
        } else {
          const size = chunking === "character" ? 1 : 3;
          // Slice by code points, as Python does.
          const chars = Array.from(text);
          chunks = [];
          for (let i = 0; i < chars.length; i += size) {
            chunks.push(chars.slice(i, i + size).join(""));
          }
        }

        const aggregator = new SimpleTextAggregator();
        const actual: string[] = [];
        for (const chunk of chunks) {
          for await (const item of aggregator.aggregate(chunk)) {
            actual.push(item.text);
          }
        }
        const tail = await aggregator.flush();
        if (tail) {
          actual.push(tail.text);
        }

        expect(actual).toEqual(sentences);
        expect(await aggregator.flush()).toBeNull();
      });
    }
  }
});
