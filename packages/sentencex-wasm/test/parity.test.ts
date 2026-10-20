// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause

// Parity with the native `sentencex@1.0.32` npm addon (the same Rust core,
// compiled with neon). Its indices count Unicode scalar values; ours are
// UTF-16 string indices, so the native ones are converted before comparing.

import { describe, expect, test } from "bun:test";
import * as native from "sentencex";
import { getSentenceBoundaries, type SentenceBoundary, segment } from "../src/index.ts";
import { CORPUS } from "./corpus.ts";
import upstreamCorpus from "./fixtures/upstream-corpus.json";

/** Map a code point index of `text` to a UTF-16 index. */
function codePointToUtf16(text: string): (i: number) => number {
  const offsets = [0];
  for (const ch of text) offsets.push(offsets[offsets.length - 1]! + ch.length);
  return (i) => offsets[i] ?? text.length + (i - (offsets.length - 1));
}

function nativeBoundaries(language: string, text: string): SentenceBoundary[] {
  const toUtf16 = codePointToUtf16(text);
  return native.get_sentence_boundaries(language, text).map((b) => ({
    start_index: toUtf16(b.start_index),
    end_index: toUtf16(b.end_index),
    text: b.text,
    boundary_symbol: b.boundary_symbol,
    is_paragraph_break: b.is_paragraph_break,
  }));
}

let checked = 0;

function expectParity(language: string, text: string): void {
  const ctx = `${language}: ${JSON.stringify(text)}`;
  expect(segment(language, text), ctx).toEqual(native.segment(language, text));
  const ours = getSentenceBoundaries(language, text);
  expect(ours, ctx).toEqual(nativeBoundaries(language, text));
  for (const b of ours) {
    if (b.text === text.slice(b.start_index, b.end_index)) continue;
    throw new Error(`${ctx}: boundary text is not text.slice(start_index, end_index)`);
  }
  checked++;
}

/** Every prefix that ends on a code point boundary (never inside a surrogate pair). */
function prefixes(text: string): string[] {
  const out: string[] = [];
  let end = 0;
  for (const ch of text) {
    end += ch.length;
    out.push(text.slice(0, end));
  }
  return out;
}

const UPSTREAM_LANGUAGES = ["en", "de", "es", "fr", "pt", "pl", "it", "nl", "ja", "zh", "hi", "ar"];

describe("parity with native sentencex@1.0.32", () => {
  test("hand-written corpus (whole texts and every prefix)", () => {
    for (const [language, text] of CORPUS) {
      expectParity(language, text);
      for (const p of prefixes(text)) expectParity(language, p);
    }
  });

  test("upstream Pipecat test strings, singly and joined with their neighbours", () => {
    const files = upstreamCorpus as Record<string, string[]>;
    for (const strings of Object.values(files)) {
      const texts = [...strings];
      for (let i = 0; i + 1 < strings.length; i++) texts.push(`${strings[i]} ${strings[i + 1]}`);
      for (const text of texts) {
        for (const language of UPSTREAM_LANGUAGES) expectParity(language, text);
        // Streaming: upstream re-segments the growing buffer after every token.
        for (const p of prefixes(text)) {
          expectParity("en", p);
          expectParity("de", p);
          expectParity("ja", p);
        }
      }
    }
  });

  test("more than 10 KB (sentencex's paragraph chunking path)", () => {
    const para = "Filler sentence number one here 👋. Dr. Who? Yes… ".repeat(120);
    const text = `${para}end’.\n\n${para}\r\n\r\n${para}`;
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(10 * 1024);
    expectParity("en", text);
    expectParity("ja", text);
  });

  test("every supported language on a mixed sample", () => {
    const sample =
      "Dr. A. B. Smith said: “Hello!” Then… 3.14 p.m. 😀 ¿Qué? 。次。 नमस्ते। هل؟\n\nOk. Ende z.B. hier.";
    const codes =
      "am ar bg bn ca da de el en es fi fr gu hi hy it ja kk kn ml mr my nl pa pl pt ru sk ta te uk zh ur fa he ko th vi nb nn sl sv tr id xx".split(
        " ",
      );
    for (const code of codes) expectParity(code, sample);
  });

  test("lone surrogates: same boundaries; we keep the original code units", () => {
    // The native addon (and our TextEncoder) see U+FFFD for a lone surrogate.
    // We slice the caller's string, so the surrogate survives in our output.
    for (const text of [
      "Hello \ud83d",
      "\ud83d",
      "A \udc00 b. C\ud83d. D.",
      "Hi 👋\ud83d. Next 😀.",
    ]) {
      const ours = segment("en", text);
      expect(ours.join("")).toBe(text);
      expect(ours.map((s) => s.toWellFormed())).toEqual(native.segment("en", text));
      const b = getSentenceBoundaries("en", text).map((x) => ({
        ...x,
        text: x.text.toWellFormed(),
      }));
      expect(b).toEqual(nativeBoundaries("en", text));
    }
  });

  test("summary", () => {
    expect(checked).toBeGreaterThan(1000);
    console.log(`parity: ${checked} (language, text) pairs identical`);
  });
});
