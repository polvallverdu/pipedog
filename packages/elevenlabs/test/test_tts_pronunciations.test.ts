// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_pronunciations.py

/**
 * The Text-to-Dialogue cases of upstream's `tests/test_tts_pronunciations.py`:
 * `TestElevenLabsPronunciation.test_dialogue_ipa` and
 * `TestPronunciationTransforms.test_longest_first`. The rest of the file
 * belongs with its providers and core (`packages/cartesia/test/test_tts_pronunciations.test.ts`
 * in the manifest).
 */

import { describe, expect, test } from "bun:test";
import { ElevenLabsDialogueTTSService } from "../src/dialogue/tts.ts";

describe("TestElevenLabsPronunciation", () => {
  test("test_dialogue_ipa", () => {
    expect(ElevenLabsDialogueTTSService.formatPronunciation("Metformin", "[mɛt'fɔɹmɪn]")).toBe(
      "/mɛtˈfɔɹmɪn/",
    );
  });
});

describe("TestPronunciationTransforms", () => {
  test("test_longest_first", async () => {
    const transform = ElevenLabsDialogueTTSService.pronunciationTransformIpa({
      metformin: "mɛtˈfɔɹmɪn",
      "glyburide metformin": "ˈɡlaɪbjəˌraɪd mɛtˈfɔɹmɪn",
    });
    const result = await transform("Glyburide metformin, or metformin", "*");
    expect(result).toBe("/ˈɡlaɪbjəˌraɪd mɛtˈfɔɹmɪn/, or /mɛtˈfɔɹmɪn/");
  });
});
