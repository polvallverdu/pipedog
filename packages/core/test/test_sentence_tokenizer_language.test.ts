// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sentence_tokenizer_language.py

/** Sentence language selection from ordered TTS settings in streaming text. */

import { describe, expect, test } from "bun:test";

import {
  AggregatedTextFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TTSUpdateSettingsFrame,
} from "../src/frames/frames.ts";
import { TTSSettings } from "../src/services/settings.ts";
import { TTSService, type TTSServiceOptions } from "../src/services/tts_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { Language } from "../src/transcriptions/language.ts";
import {
  type _AggregatedFrameSlot,
  _ParallelSentenceAggregator,
  AggregatedFrameSequencer,
} from "../src/utils/context/aggregated_frame_sequencer.ts";
import { matchEndofsentence, resolveSentenceTokenizerLanguage } from "../src/utils/string.ts";
import { SimpleTextAggregator } from "../src/utils/text/simple_text_aggregator.ts";

/** Capture aggregation results without a provider connection. */
class RecordingTTS extends TTSService {
  sentences: [string, string][] = [];

  constructor(language: Language | string | null = Language.DE, options: TTSServiceOptions = {}) {
    super({ ...options, settings: new TTSSettings({ language, voice: null, model: null }) });
  }

  override languageToServiceLanguage(language: Language): string | null {
    return `provider-${language}`;
  }

  async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    yield null;
  }

  protected override async _handleAggregatedText(
    frame: AggregatedTextFrame,
    _contextId: string | null = null,
  ): Promise<void> {
    this.sentences.push([frame.text, this.textAggregationLanguage]);
  }
}

function settingsOf(tts: TTSService): TTSSettings {
  return (tts as unknown as { _settings: TTSSettings })._settings;
}

function slotsOf(seq: AggregatedFrameSequencer): _AggregatedFrameSlot[] {
  return (seq as unknown as { _slots: _AggregatedFrameSlot[] })._slots;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("test_language_resolution", () => {
  const cases: [Language | string | null, string][] = [
    [Language.DE, "de"],
    ["de-DE", "de"],
    ["de_AT", "de"],
    ["pt-BR", "pt"],
    ["nb-NO", "nb"],
    ["nn", "nn"],
    ["sl", "sl"],
    ["ml", "ml"],
    ["unknown", "unknown"],
    ["ja", "ja"],
    ["auto", "en"],
    [null, "en"],
  ];
  for (const [language, model] of cases) {
    test(`test_language_resolution[${language}-${model}]`, () => {
      expect(resolveSentenceTokenizerLanguage(language)).toEqual(model);
    });
  }
});

test("test_tts_preserves_language_before_provider_conversion", () => {
  const tts = new RecordingTTS(Language.DE);
  expect(settingsOf(tts).language).toEqual("provider-de");
  expect(tts.textAggregationLanguage).toEqual("de");
});

test("test_streaming_models_are_independent", async () => {
  const german = new SimpleTextAggregator({ language: "de" });
  const english = new SimpleTextAggregator({ language: "en" });
  expect((await collect(german.aggregate("Das ist bzw. w"))).map((a) => a.text)).toEqual([]);
  expect((await collect(english.aggregate("Das ist bzw. w"))).map((a) => a.text)).toEqual([
    "Das ist bzw.",
  ]);
  expect((await collect(german.aggregate("ichtig. Weiter"))).map((a) => a.text)).toEqual([
    "Das ist bzw. wichtig.",
  ]);
  expect(matchEndofsentence("こんにちは。次", { language: "ja" })).toEqual("こんにちは。".length);
});

test("test_language_update_applies_to_following_text_and_preserves_buffer", async () => {
  const tts = new RecordingTTS();
  const frames = [
    new LLMFullResponseStartFrame(),
    new LLMTextFrame({ text: "Das ist bzw." }),
    new TTSUpdateSettingsFrame({ delta: new TTSSettings({ language: Language.EN }) }),
    new LLMTextFrame({ text: " wichtig." }),
    new LLMFullResponseEndFrame(),
    new LLMFullResponseStartFrame(),
    new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
    new LLMFullResponseEndFrame(),
  ];
  await runTest(tts, { framesToSend: frames });
  expect(tts.sentences).toEqual([
    ["Das ist bzw.", "en"],
    ["wichtig.", "en"],
    ["Das ist bzw.", "en"],
    ["wichtig.", "en"],
  ]);
});

test("test_unspecified_language_defaults_to_english_and_updates_without_start_frame", async () => {
  const tts = new RecordingTTS(null);
  expect(tts.textAggregationLanguage).toEqual("en");
  await runTest(tts, {
    framesToSend: [
      new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
      new LLMFullResponseEndFrame(),
      new TTSUpdateSettingsFrame({ delta: new TTSSettings({ language: Language.DE }) }),
      new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
      new LLMFullResponseEndFrame(),
      new TTSUpdateSettingsFrame({ delta: new TTSSettings({ language: null }) }),
      new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
      new LLMFullResponseEndFrame(),
    ],
  });
  expect(tts.sentences).toEqual([
    ["Das ist bzw.", "en"],
    ["wichtig.", "en"],
    ["Das ist bzw. wichtig.", "de"],
    ["Das ist bzw.", "en"],
    ["wichtig.", "en"],
  ]);
});

test("test_parallel_channels_use_the_same_language_for_slicing", async () => {
  const aggregator = new _ParallelSentenceAggregator("de");
  const text = "Das ist bzw. wichtig. Weiter geht es. N";
  const result = await collect(aggregator.aggregate(text, text, text));
  expect(result.map((a) => a.ttsText.trim())).toEqual(["Das ist bzw. wichtig.", "Weiter geht es."]);
  expect(result.every((a) => a.ttsText === a.llmText && a.llmText === a.userFacingText)).toBe(true);
});

test("test_targeted_update_does_not_change_other_service", async () => {
  const tts = new RecordingTTS();
  const other = new RecordingTTS(Language.EN);
  await runTest(tts, {
    framesToSend: [
      new TTSUpdateSettingsFrame({
        service: other,
        delta: new TTSSettings({ language: Language.EN }),
      }),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
      new LLMFullResponseEndFrame(),
    ],
  });
  expect(tts.sentences).toEqual([["Das ist bzw. wichtig.", "de"]]);
});

test("test_interruption_discards_buffer_and_allows_new_language", async () => {
  const tts = new RecordingTTS();
  await runTest(tts, {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Das ist bzw." }),
      new SleepFrame({ sleep: 0.05 }),
      new InterruptionFrame(),
      new SleepFrame({ sleep: 0.05 }),
      new TTSUpdateSettingsFrame({ delta: new TTSSettings({ language: Language.EN }) }),
      new LLMFullResponseStartFrame(),
      new LLMTextFrame({ text: "Das ist bzw. wichtig." }),
      new LLMFullResponseEndFrame(),
    ],
  });
  expect(tts.sentences).toEqual([
    ["Das ist bzw.", "en"],
    ["wichtig.", "en"],
  ]);
});

test("test_streaming_context_retains_language_after_another_context_starts", async () => {
  const sequencer = new AggregatedFrameSequencer({ streaming: true });

  async function feed(context: string, text: string, language: string): Promise<void> {
    await sequencer.registerSpoken(
      new AggregatedTextFrame({ text, textType: TextType.TOKEN }),
      context,
      text,
      true,
      { language },
    );
  }

  await feed("de", "Das ist bzw.", "de");
  await feed("en", "Hello. Next", "en");
  await feed("de", " wichtig. Weiter", "de");
  expect(slotsOf(sequencer).map((slot) => slot.frame.text.trim())).toEqual([
    "Hello.",
    "Das ist bzw. wichtig.",
  ]);
});

test("test_streaming_context_language_updates_with_incoming_text", async () => {
  const sequencer = new AggregatedFrameSequencer({ streaming: true });
  for (const [text, language] of [
    ["Das ist bzw.", "de"],
    [" wichtig. Weiter", "en"],
  ] as const) {
    await sequencer.registerSpoken(
      new AggregatedTextFrame({ text, textType: TextType.TOKEN }),
      "context",
      text,
      true,
      { language },
    );
  }
  expect(slotsOf(sequencer).map((slot) => slot.frame.text.trim())).toEqual([
    "Das ist bzw.",
    "wichtig.",
  ]);
});
