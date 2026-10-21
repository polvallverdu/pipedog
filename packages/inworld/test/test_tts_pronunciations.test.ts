// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_pronunciations.py

/**
 * The Inworld cases of upstream's `tests/test_tts_pronunciations.py`:
 * `TestInworldPronunciation` and the Inworld test of
 * `TestPronunciationTransforms`. The rest of the file (phoneme utilities,
 * Cartesia, ElevenLabs, Deepgram, gating) belongs with those providers and
 * core (`packages/cartesia/test/test_tts_pronunciations.test.ts` in the
 * manifest).
 */

import { describe, expect, test } from "bun:test";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";

import { InworldHttpTTSService, InworldTTSService } from "../src/tts.ts";

/** loguru `logger.add(sink, level="WARNING")` for the duration of `fn`. */
async function capturedWarnings(fn: (messages: string[]) => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) messages.push(record.message);
  });
  try {
    await fn(messages);
  } finally {
    remove();
  }
  return messages;
}

describe("TestInworldPronunciation", () => {
  test("test_ipa", () => {
    expect(InworldTTSService.formatPronunciation("Crete", "[kriːt]")).toBe("/kriːt/");
  });

  test("test_notation_variants_format_the_same", () => {
    const a = InworldTTSService.formatPronunciation("Achoo", "/əˈʧu/");
    const b = InworldTTSService.formatPronunciation("Achoo", "ə'tʃu");
    expect(a).toBe(b);
  });

  test("test_unusable", () => {
    const fmt = (word: string, ipa: string) => InworldTTSService.formatPronunciation(word, ipa);
    expect(fmt("Glyburide metformin", "ˈɡlaɪ mɛt")).toBeNull(); // one word per pair
    expect(fmt("Crete", "")).toBeNull();
  });

  test("test_http_service_matches", () => {
    expect(InworldHttpTTSService.formatPronunciation("Crete", "kriːt")).toBe(
      InworldTTSService.formatPronunciation("Crete", "kriːt"),
    );
  });
});

describe("TestPronunciationTransforms", () => {
  test("test_unusable_words_are_spoken_as_written", async () => {
    let transform!: ReturnType<typeof InworldTTSService.pronunciationTransformIpa>;
    const messages = await capturedWarnings(async () => {
      transform = InworldTTSService.pronunciationTransformIpa({
        Xarelto: "zəˈɹɛltoʊ",
        "Glyburide metformin": "ˈɡlaɪ mɛt",
      });
    });
    const text = "Glyburide metformin or Xarelto";
    expect(await transform(text, "*")).toBe("Glyburide metformin or /zəˈɹɛltoʊ/");
    expect(messages.some((m) => m.includes("Glyburide metformin") && !m.includes("Xarelto"))).toBe(
      true,
    );
  });
});
