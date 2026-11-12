// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tts_pronunciations.py

/**
 * Tests for IPA pronunciation hints across TTS services.
 *
 * PORTING NOTES:
 * - loguru's `logger.add(sink, level="WARNING")` becomes `logger.addSink`,
 *   keeping records at WARNING or above.
 * - Deepgram, ElevenLabs and Inworld services are imported by relative path,
 *   since this package does not depend on those packages.
 * - `aiohttp_session=None` has no counterpart: the HTTP service takes an
 *   optional `fetch` instead.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Frame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { ipaPhones, normalizeIpa, stressBeforeVowels } from "@pipedog/core/utils/text/phonemes";
import { DeepgramFluxTTSBase } from "../../deepgram/src/flux/tts_base.ts";
import { DeepgramHttpTTSService, DeepgramTTSService } from "../../deepgram/src/tts.ts";
import { ElevenLabsDialogueTTSService } from "../../elevenlabs/src/dialogue/tts.ts";
import { ElevenLabsHttpTTSService, ElevenLabsTTSService } from "../../elevenlabs/src/tts.ts";
import { InworldHttpTTSService, InworldTTSService } from "../../inworld/src/tts.ts";
import { CartesiaHttpTTSService, CartesiaTTSService } from "../src/tts.ts";

setDefaultTimeout(15_000);

/** Collects WARNING-or-above log messages while `fn` runs. */
async function capturedWarnings<T>(fn: (messages: string[]) => T | Promise<T>): Promise<T> {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) messages.push(record.message);
  });
  try {
    return await fn(messages);
  } finally {
    remove();
  }
}

describe("TestNormalizeIpa", () => {
  test("test_strips_delimiters_and_syllable_breaks", () => {
    expect(normalizeIpa(" /ˈtʃɪ.kən/ ")).toEqual("ˈtʃɪkən");
    expect(normalizeIpa("[ˈtʃɪkən]")).toEqual("ˈtʃɪkən");
  });

  test("test_unifies_notation", () => {
    expect(normalizeIpa("ˈʧɪkən")).toEqual("ˈtʃɪkən");
    expect(normalizeIpa("ˈt͡ʃɪkən")).toEqual("ˈtʃɪkən");
    expect(normalizeIpa("ˈpiʦa")).toEqual("ˈpit͡sa");
    expect(normalizeIpa("t͜s")).toEqual("t͡s");
    expect(normalizeIpa("'ælɛgrə")).toEqual("ˈælɛɡrə");
    expect(normalizeIpa("bi:")).toEqual("biː");
  });

  test("test_keeps_sounds", () => {
    // r and ɹ, ɾ and t are different sounds in some languages; notation only.
    expect(normalizeIpa("ˈbɛɾə ˈrɑk")).toEqual("ˈbɛɾə ˈrɑk");
  });

  test("test_collapses_whitespace", () => {
    expect(normalizeIpa("ˈɡlaɪ   mɛt")).toEqual("ˈɡlaɪ mɛt");
  });
});

describe("TestIpaPhones", () => {
  test("test_groups_multi_character_phones", () => {
    expect(ipaPhones("ˈtʃaɪnə")).toEqual(["ˈ", "tʃ", "aɪ", "n", "ə"]);
    expect(ipaPhones("ˈʧaɪnə")).toEqual(["ˈ", "tʃ", "aɪ", "n", "ə"]);
  });

  test("test_groups_only_tied_clusters", () => {
    expect(ipaPhones("kæts")).toEqual(["k", "æ", "t", "s"]);
    expect(ipaPhones("ˈpit͡sa")).toEqual(["ˈ", "p", "i", "ts", "a"]);
  });

  test("test_keeps_length_and_diacritics_with_their_phone", () => {
    expect(ipaPhones("biːn̩")).toEqual(["b", "iː", "n̩"]);
  });

  test("test_stress_where_written", () => {
    expect(ipaPhones("mɛtˈfɔɹmɪn")).toEqual(["m", "ɛ", "t", "ˈ", "f", "ɔ", "ɹ", "m", "ɪ", "n"]);
  });

  test("test_stress_before_vowels", () => {
    const phones = stressBeforeVowels(ipaPhones("ˌsɪpɹoʊˈflɑksəsɪn"));
    expect(phones.join("")).toEqual("sˌɪpɹoʊflˈɑksəsɪn");
  });
});

describe("TestCartesiaPronunciation", () => {
  test("test_ipa", () => {
    expect(CartesiaTTSService.formatPronunciation("Metformin", "mɛtˈfɔɹmɪn")).toEqual(
      "<<m|ɛ|t|f|ˈ|ɔ|ɹ|m|ɪ|n>>",
    );
  });

  test("test_notation_variants_format_the_same", () => {
    const a = CartesiaTTSService.formatPronunciation("Achoo", "/əˈʧu/");
    const b = CartesiaTTSService.formatPronunciation("Achoo", "ə'tʃu");
    expect(a).toEqual(b);
  });

  test("test_phrase", () => {
    expect(CartesiaTTSService.formatPronunciation("Glyburide metformin", "ˈɡlaɪ mɛt")).toEqual(
      "<<ɡ|l|ˈ|aɪ>> <<m|ɛ|t>>",
    );
  });

  test("test_http_service_matches", () => {
    expect(CartesiaHttpTTSService.formatPronunciation("Metformin", "mɛtˈfɔɹmɪn")).toEqual(
      CartesiaTTSService.formatPronunciation("Metformin", "mɛtˈfɔɹmɪn"),
    );
  });
});

describe("TestElevenLabsPronunciation", () => {
  test("test_ipa", () => {
    expect(ElevenLabsTTSService.formatPronunciation("Allegra", "/əˈlɛgrə/")).toEqual(
      '<phoneme alphabet="ipa" ph="əˈlɛɡrə">Allegra</phoneme>',
    );
  });

  test("test_phrase_gets_a_tag_per_word", () => {
    expect(
      ElevenLabsTTSService.formatPronunciation("Zovirax tablets", "ˈzoʊvəˌræks ˈtæbləts"),
    ).toEqual(
      '<phoneme alphabet="ipa" ph="ˈzoʊvəˌræks">Zovirax</phoneme> ' +
        '<phoneme alphabet="ipa" ph="ˈtæbləts">tablets</phoneme>',
    );
  });

  test("test_word_count_mismatch", () => {
    expect(ElevenLabsTTSService.formatPronunciation("Zovirax tablets", "ˈzoʊvəˌræks")).toBeNull();
  });

  test("test_escapes_markup", () => {
    expect(ElevenLabsTTSService.formatPronunciation("A&B", "eɪ")).toEqual(
      '<phoneme alphabet="ipa" ph="eɪ">A&amp;B</phoneme>',
    );
  });

  test("test_http_service_matches", () => {
    expect(ElevenLabsHttpTTSService.formatPronunciation("Metformin", "mɛtˈfɔɹmɪn")).toEqual(
      ElevenLabsTTSService.formatPronunciation("Metformin", "mɛtˈfɔɹmɪn"),
    );
  });

  test("test_dialogue_ipa", () => {
    expect(ElevenLabsDialogueTTSService.formatPronunciation("Metformin", "[mɛt'fɔɹmɪn]")).toEqual(
      "/mɛtˈfɔɹmɪn/",
    );
  });
});

describe("TestInworldPronunciation", () => {
  test("test_ipa", () => {
    expect(InworldTTSService.formatPronunciation("Crete", "[kriːt]")).toEqual("/kriːt/");
  });

  test("test_notation_variants_format_the_same", () => {
    const a = InworldTTSService.formatPronunciation("Achoo", "/əˈʧu/");
    const b = InworldTTSService.formatPronunciation("Achoo", "ə'tʃu");
    expect(a).toEqual(b);
  });

  test("test_unusable", () => {
    const fmt = (word: string, ipa: string) => InworldTTSService.formatPronunciation(word, ipa);
    expect(fmt("Glyburide metformin", "ˈɡlaɪ mɛt")).toBeNull(); // one word per pair
    expect(fmt("Crete", "")).toBeNull();
  });

  test("test_http_service_matches", () => {
    expect(InworldHttpTTSService.formatPronunciation("Crete", "kriːt")).toEqual(
      InworldTTSService.formatPronunciation("Crete", "kriːt"),
    );
  });
});

describe("TestDeepgramPronunciation", () => {
  test("test_ipa", () => {
    expect(DeepgramTTSService.formatPronunciation("dupilumab", "duːˈpɪljuːmæb")).toEqual(
      '\\{"word": "dupilumab", "pronounce": "duːpˈɪljuːmæb"\\}',
    );
  });

  test("test_notation_variants_format_the_same", () => {
    const a = DeepgramTTSService.formatPronunciation("Achoo", "/əˈʧu/");
    const b = DeepgramTTSService.formatPronunciation("Achoo", "ə'tʃu");
    expect(a).toEqual(b);
  });

  test("test_quotes_in_word_are_escaped", () => {
    expect(DeepgramTTSService.formatPronunciation('say "hi"', "haɪ")).toEqual(
      '\\{"word": "say \\"hi\\"", "pronounce": "haɪ"\\}',
    );
  });

  test("test_unusable", () => {
    const fmt = (word: string, ipa: string) => DeepgramTTSService.formatPronunciation(word, ipa);
    expect(fmt("Crete", "")).toBeNull();
    expect(fmt("ab", "ˈkʌɹənt".repeat(3))).toBeNull(); // far longer than the word
    expect(fmt("dupilumab", "duːˈpɪljuːmæb".repeat(12))).toBeNull(); // over 128 characters
  });

  test("test_short_word_gets_a_length_floor", () => {
    expect(DeepgramTTSService.formatPronunciation("a", "əˈbaʊtðæt")).not.toBeNull();
  });

  test("test_http_service_matches", () => {
    expect(DeepgramHttpTTSService.formatPronunciation("Crete", "kriːt")).toEqual(
      DeepgramTTSService.formatPronunciation("Crete", "kriːt"),
    );
  });

  test("test_flux_unsupported", () => {
    expect(DeepgramFluxTTSBase.formatPronunciation("Crete", "kriːt")).toBeNull();
  });
});

describe("TestPronunciationTransforms", () => {
  test("test_replaces_whole_words_case_insensitively", async () => {
    const transform = ElevenLabsTTSService.pronunciationTransformIpa({ metformin: "mɛtˈfɔɹmɪn" });
    const result = await transform("Take METFORMIN twice. Metformin, then water.", "*");
    expect(result).toEqual(
      'Take <phoneme alphabet="ipa" ph="mɛtˈfɔɹmɪn">METFORMIN</phoneme> twice. ' +
        '<phoneme alphabet="ipa" ph="mɛtˈfɔɹmɪn">Metformin</phoneme>, then water.',
    );
  });

  test("test_leaves_longer_and_hyphenated_words", async () => {
    const transform = CartesiaTTSService.pronunciationTransformIpa({ Metformin: "mɛtˈfɔɹmɪn" });
    const text = "Metformins and glyburide-metformin and metformin-ER";
    expect(await transform(text, "*")).toEqual(text);
  });

  test("test_longest_first", async () => {
    const transform = ElevenLabsDialogueTTSService.pronunciationTransformIpa({
      metformin: "mɛtˈfɔɹmɪn",
      "glyburide metformin": "ˈɡlaɪbjəˌraɪd mɛtˈfɔɹmɪn",
    });
    const result = await transform("Glyburide metformin, or metformin", "*");
    expect(result).toEqual("/ˈɡlaɪbjəˌraɪd mɛtˈfɔɹmɪn/, or /mɛtˈfɔɹmɪn/");
  });

  test("test_unusable_words_are_spoken_as_written", async () => {
    const [transform, messages] = await capturedWarnings(
      (messages) =>
        [
          InworldTTSService.pronunciationTransformIpa({
            Xarelto: "zəˈɹɛltoʊ",
            "Glyburide metformin": "ˈɡlaɪ mɛt",
          }),
          messages,
        ] as const,
    );
    const text = "Glyburide metformin or Xarelto";
    expect(await transform(text, "*")).toEqual("Glyburide metformin or /zəˈɹɛltoʊ/");
    expect(messages.some((m) => m.includes("Glyburide metformin") && !m.includes("Xarelto"))).toBe(
      true,
    );
  });

  test("test_base_service_supports_nothing", async () => {
    const transform = TTSService.pronunciationTransformIpa({ Metformin: "mɛtˈfɔɹmɪn" });
    expect(await transform("Metformin", "*")).toEqual("Metformin");
  });
});

/** Records the text it is asked to speak; pronunciations are wrapped in <>. */
class RecordingTTSService extends TTSService {
  spoken: string[] = [];
  pronunciationsSupported = true;

  constructor(options: TTSServiceOptions = {}) {
    super({
      pushStartFrame: true,
      pushTextFrames: false,
      stopFrameTimeoutS: 0.1,
      ...options,
    });
  }

  static override formatPronunciation(_word: string, ipa: string): string | null {
    return `<${ipa}>`;
  }

  override get supportsPronunciations(): boolean {
    return this.pronunciationsSupported;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  // biome-ignore lint/correctness/useYield: matches upstream (no audio, `if False: yield`)
  override async *runTts(text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    this.spoken.push(text.trim());
  }
}

async function _upper(text: string, _textType: string): Promise<string> {
  return text.toUpperCase();
}

/** Speak each text, giving the service time to run before the next frame. */
function _speak(...texts: string[]): Frame[] {
  return texts.flatMap((text) => [new TTSSpeakFrame({ text }), new SleepFrame({ sleep: 0.2 })]);
}

describe("TestPronunciationGating", () => {
  function _service(): RecordingTTSService {
    const pronounce = RecordingTTSService.pronunciationTransformIpa({ crete: "kriːt" });
    return new RecordingTTSService({
      textTransforms: [
        ["*", _upper],
        ["*", pronounce],
      ],
    });
  }

  test("test_applied_when_available", async () => {
    const tts = _service();
    await runTest(tts, { framesToSend: _speak("Visit Crete"), startTimeout: 5.0 });
    expect(tts.spoken).toEqual(["VISIT <kriːt>"]);
  });

  test("test_skipped_when_unavailable", async () => {
    const tts = _service();
    tts.pronunciationsSupported = false;
    const messages = await capturedWarnings(async (messages) => {
      await runTest(tts, {
        framesToSend: _speak("Visit Crete", "Crete again"),
        startTimeout: 5.0,
      });
      return messages;
    });
    // Other transforms still run; the warning is logged once.
    expect(tts.spoken).toEqual(["VISIT CRETE", "CRETE AGAIN"]);
    expect(messages.filter((m) => m.includes("pronunciation markup")).length).toEqual(1);
  });
});

describe("TestElevenLabsPronunciationAvailability", () => {
  function _ws(model: string, ssml: boolean | null): ElevenLabsTTSService {
    return new ElevenLabsTTSService({
      apiKey: "test",
      settings: new ElevenLabsTTSService.Settings({ voice: "v", model }),
      enableSsmlParsing: ssml,
    });
  }

  test("test_websocket_needs_phoneme_model_and_ssml_parsing", () => {
    expect(_ws("eleven_flash_v2", true).supportsPronunciations).toBe(true);
    expect(_ws("eleven_turbo_v2", true).supportsPronunciations).toBe(true);
    expect(_ws("eleven_flash_v2_5", true).supportsPronunciations).toBe(false);
    expect(_ws("eleven_flash_v2", null).supportsPronunciations).toBe(false);
    expect(_ws("eleven_flash_v2", false).supportsPronunciations).toBe(false);
  });

  test("test_http_needs_phoneme_model", () => {
    function http(model: string): ElevenLabsHttpTTSService {
      return new ElevenLabsHttpTTSService({
        apiKey: "test",
        settings: new ElevenLabsHttpTTSService.Settings({ voice: "v", model }),
      });
    }

    expect(http("eleven_turbo_v2").supportsPronunciations).toBe(true);
    expect(http("eleven_multilingual_v2").supportsPronunciations).toBe(false);
  });
});
