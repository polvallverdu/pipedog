// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sentencex_tokenizer.py

/** Sentencex adapter offset and incremental aggregation contracts. */

import { expect, mock, test } from "bun:test";

import * as stringModule from "../src/utils/string.ts";
import { matchEndofsentence } from "../src/utils/string.ts";
import type { Aggregation } from "../src/utils/text/base_text_aggregator.ts";
import { SimpleTextAggregator } from "../src/utils/text/simple_text_aggregator.ts";

const STRING_MODULE = "../src/utils/string.ts";

async function texts(iter: AsyncIterable<Aggregation>): Promise<string[]> {
  const results: string[] = [];
  for await (const a of iter) {
    results.push(a.text);
  }
  return results;
}

/**
 * Equivalent of `monkeypatch.setattr(simple_text_aggregator, "match_endofsentence", fn)`.
 * Restores the original module afterwards.
 */
async function withPatchedMatchEndofsentence(
  fn: (text: string, options?: { language?: string | null }) => number,
  body: () => Promise<void>,
): Promise<void> {
  const original = { ...stringModule };
  mock.module(STRING_MODULE, () => ({ ...original, matchEndofsentence: fn }));
  try {
    await body();
  } finally {
    mock.module(STRING_MODULE, () => original);
  }
}

const SOURCE_OFFSET_CASES: [string, string, string][] = [
  ["Hello.   Next", "en", "Hello."],
  ["Hello.\n\nNext", "en", "Hello."],
  ["\n\nHello. Next", "en", "\n\nHello."],
  ["👋 Hello. 😀 Next", "en", "👋 Hello."],
  ["Café is open. Next", "en", "Café is open."],
  ["こんにちは。次", "ja", "こんにちは。"],
  ["Dr. 田中が来ます。次の文です。", "ja", "Dr. 田中が来ます。"],
  ["U.S.のAWSです。次の文です。", "ja", "U.S.のAWSです。"],
  ["你好。下一句", "zh", "你好。"],
  ["नमस्ते। यह", "hi", "नमस्ते।"],
  ["هل أنت بخير؟ نعم", "ar", "هل أنت بخير؟"],
  ["Hello. Next", "unrecognized", "Hello."],
];

for (const [text, language, prefix] of SOURCE_OFFSET_CASES) {
  test(`test_source_character_offsets[${JSON.stringify(text)}-${language}]`, () => {
    const boundary = matchEndofsentence(text, { language });
    expect(boundary).toEqual(prefix.length);
    expect(text.slice(0, boundary)).toEqual(prefix);
  });
}

async function testChunkBoundariesDoNotChangeSentences(
  chunkSize: number,
  language: string,
  sentences: string[],
): Promise<void> {
  const text = sentences.join(" ");
  const aggregator = new SimpleTextAggregator({ language });
  const actual: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    actual.push(...(await texts(aggregator.aggregate(text.slice(start, start + chunkSize)))));
  }
  const tail = await aggregator.flush();
  if (tail) {
    actual.push(tail.text);
  }
  expect(actual).toEqual(sentences);
}

const CHUNK_SIZES = [1, 3, 1000];

const LANGUAGE_CASES: [string, string[]][] = [
  ["en", ["Dr. Smith is here.", "It costs $29.95."]],
  ["de-DE", ["Das ist z.B. wichtig.", "Weiter geht es."]],
  ["pt-BR", ["O Sr. Silva chegou.", "Depois saiu."]],
  ["fr", ["Voir p. 12 pour les détails.", "Ensuite continuez."]],
  ["pl", ["Prof. Kowalski przyszedł.", "Potem wyszedł."]],
  ["it", ["Il dott. Rossi arriva.", "Poi parte."]],
  ["nl", ["Dr. Jansen komt.", "Daarna vertrekt hij."]],
  ["ja", ["こんにちは。", "次の文です。"]],
  ["ja", ["Dr. 田中が来ます。", "次の文です。"]],
  ["ja", ["U.S.のAWSです。", "次の文です。"]],
];

for (const [language, sentences] of LANGUAGE_CASES) {
  for (const chunkSize of CHUNK_SIZES) {
    test(`test_chunk_boundaries_do_not_change_sentences[${language}-${JSON.stringify(sentences)}-${chunkSize}]`, async () => {
      await testChunkBoundariesDoNotChangeSentences(chunkSize, language, sentences);
    });
  }
}

test("test_pronoun_boundary_with_streamed_sentence_starter", async () => {
  const aggregator = new SimpleTextAggregator({ language: "en" });
  const actual = await texts(
    aggregator.aggregate("We make a good team, you and I. Did you see him?"),
  );
  const tail = await aggregator.flush();
  if (tail) {
    actual.push(tail.text);
  }
  expect(actual).toEqual(["We make a good team, you and I.", "Did you see him?"]);
});

const LOOKAHEAD_CASES: string[][] = [
  ["We make a good team, you and I.", "Did you see him?"],
  ["Albert I. Jones is here.", "Hello."],
  ["Albert I. Douglas is here.", "Hello."],
  ['He said "Hello."', "Then he left."],
  ["This is the U.S. Department of State.", "Next."],
  ["Hello!?", "Next."],
  ["We make a good team, you and I.", "Did?"],
];

for (const sentences of LOOKAHEAD_CASES) {
  for (const chunkSize of CHUNK_SIZES) {
    test(`test_lookahead_retry_preserves_sentences[${JSON.stringify(sentences)}-${chunkSize}]`, async () => {
      await testChunkBoundariesDoNotChangeSentences(chunkSize, "en", sentences);
    });
  }
}

test("test_retry_emits_on_word_delimiter_without_splitting_partial_starters", async () => {
  const aggregator = new SimpleTextAggregator();
  expect(await texts(aggregator.aggregate("We make a good team, you and I. D"))).toEqual([]);
  expect(await texts(aggregator.aggregate("id"))).toEqual([]);
  expect(await texts(aggregator.aggregate(" "))).toEqual(["We make a good team, you and I."]);
  expect(aggregator.text.text).toEqual("Did");

  const initials = new SimpleTextAggregator();
  expect(await texts(initials.aggregate("Albert I. Do"))).toEqual([]);
  expect(await texts(initials.aggregate("uglas "))).toEqual([]);
  expect((await initials.flush())!.text).toEqual("Albert I. Douglas");
});

test("test_first_character_fast_path_still_emits_immediately", async () => {
  const aggregator = new SimpleTextAggregator();
  expect(await texts(aggregator.aggregate("Hello. "))).toEqual([]);
  expect(await texts(aggregator.aggregate("N"))).toEqual(["Hello."]);
  expect(aggregator.text.text).toEqual("N");
});

for (const ending of ["reset", "handle_interruption", "flush"] as const) {
  test(`test_pending_retry_is_cleared_between_generations[${ending}]`, async () => {
    const aggregator = new SimpleTextAggregator();
    const text = "We make a good team, you and I. Did";
    expect(await texts(aggregator.aggregate(text))).toEqual([]);
    const result =
      ending === "reset"
        ? await aggregator.reset()
        : ending === "handle_interruption"
          ? await aggregator.handleInterruption()
          : await aggregator.flush();
    if (ending === "flush") {
      expect((result as Aggregation).text).toEqual(text);
    }
    expect(await texts(aggregator.aggregate("Dr. Smith is here. Next"))).toEqual([
      "Dr. Smith is here.",
    ]);
    expect((await aggregator.flush())!.text).toEqual("Next");
  });
}

test("test_unbroken_lookahead_has_bounded_tokenizer_work", async () => {
  const calls: string[] = [];

  const unresolved = (text: string, _options?: { language?: string | null }): number => {
    calls.push(text);
    return 0;
  };

  await withPatchedMatchEndofsentence(unresolved, async () => {
    const aggregator = new SimpleTextAggregator();
    const text = `I. ${"x".repeat(10_000)} more words without punctuation`;
    expect(await texts(aggregator.aggregate(text))).toEqual([]);
    expect(calls).toEqual(["I. x", `I. ${"x".repeat(10_000)} `]);
    expect((await aggregator.flush())!.text).toEqual(text);
  });
});

const QUOTES = ['"', "'", "“", "‘", "«", "「"];

for (const chunkSize of CHUNK_SIZES) {
  for (const quote of QUOTES) {
    test(`test_open_quote_preserves_abbreviations_without_waiting_for_close[${chunkSize}-${quote}]`, async () => {
      const text = `She said, ${quote}Dr. Smith is here. Next sentence`;
      const aggregator = new SimpleTextAggregator();
      const actual: string[] = [];
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        actual.push(...(await texts(aggregator.aggregate(text.slice(offset, offset + chunkSize)))));
      }
      expect(actual).toEqual([`She said, ${quote}Dr. Smith is here.`]);
      expect((await aggregator.flush())!.text).toEqual("Next sentence");
    });
  }
}

const QUOTATION_CASES: string[][] = [
  ['She said, "Dr. Smith is here."', "Then she left."],
  ["She said, “Dr. Smith is here.”", "Then she left."],
  ['She said, "Hello.', 'Next sentence."'],
  ["Don't call Dr. Smith.", "He's busy."],
  ["The doctor's here.", "Let's go."],
];

for (const sentences of QUOTATION_CASES) {
  test(`test_quotation_probe_preserves_other_boundaries[${JSON.stringify(sentences)}]`, async () => {
    await testChunkBoundariesDoNotChangeSentences(1, "en", sentences);
  });
}

for (const quote of ['"', "“", "'", "«"]) {
  test(`test_quoted_abbreviation_offsets[${quote}]`, () => {
    const text = `👋 She said, ${quote}Dr. Smith is here. Next`;
    expect(matchEndofsentence(text)).toEqual(`👋 She said, ${quote}Dr. Smith is here.`.length);
    expect(matchEndofsentence(`She said, ${quote}Dr. S`)).toEqual(0);
  });
}

for (const wordLength of [64, 65, 10_000]) {
  test(`test_long_lookahead_word_retries_at_delimiter[${wordLength}]`, async () => {
    const calls: string[] = [];

    const boundaryWhenWordEnds = (
      text: string,
      _options?: { language?: string | null },
    ): number => {
      calls.push(text);
      return text.endsWith(" ") ? "I.".length : 0;
    };

    await withPatchedMatchEndofsentence(boundaryWhenWordEnds, async () => {
      const aggregator = new SimpleTextAggregator();
      const word = "x".repeat(wordLength);
      expect(await texts(aggregator.aggregate(`I. ${word}`))).toEqual([]);
      expect(calls).toEqual(["I. x"]);
      expect(await texts(aggregator.aggregate(" "))).toEqual(["I."]);
      expect(calls).toEqual(["I. x", `I. ${word} `]);
      expect((await aggregator.flush())!.text).toEqual(word);
    });
  });
}

for (const prefix of ['"', "“", "—", "👋 "]) {
  test(`test_non_word_lookahead_retries_only_after_following_word[${prefix}]`, async () => {
    const calls: string[] = [];

    const unresolved = (text: string, _options?: { language?: string | null }): number => {
      calls.push(text);
      return 0;
    };

    await withPatchedMatchEndofsentence(unresolved, async () => {
      const aggregator = new SimpleTextAggregator();
      // Python's prefix[0] is the first code point, not the first UTF-16 unit.
      const firstChar = [...prefix][0] as string;
      expect(await texts(aggregator.aggregate(`I. ${prefix}`))).toEqual([]);
      expect(calls).toEqual([`I. ${firstChar}`]);
      expect(await texts(aggregator.aggregate("Douglas"))).toEqual([]);
      expect(calls.length).toEqual(1);
      expect(await texts(aggregator.aggregate(" "))).toEqual([]);
      expect(calls).toEqual([`I. ${firstChar}`, `I. ${prefix}Douglas `]);
      expect((await aggregator.flush())!.text).toEqual(`I. ${prefix}Douglas`);
    });
  });
}
