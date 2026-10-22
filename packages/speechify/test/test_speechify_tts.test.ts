// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_speechify_tts.py

/**
 * Tests for Speechify TTS speech-mark and Server-Sent Events handling.
 *
 * Porting notes:
 * - `pytest.approx(x)` becomes `toBeCloseTo`, so the two tuples that carry one are
 *   compared field by field.
 * - `@pytest.mark.parametrize` becomes a loop over the cases.
 * - The `SpeechifyHttpTTSService` tests at the end are not in upstream: they drive the
 *   service against a local `Bun.serve` fake of the SSE endpoint.
 */

import { describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  _outputFormatFromSampleRate,
  _parseSseEvent,
  _SpeechMarkAccumulator,
  languageToSpeechifyLanguage,
  SPEECHIFY_API_VERSION,
  SpeechifyHttpTTSService,
} from "../src/tts.ts";

type Dict = Record<string, any>;

const TEXT = "Hello world.";

/** Feed chunks of speech marks through an accumulator and collect its words. */
function wordTimes(
  chunks: (Dict[] | null | undefined)[],
  { text = TEXT, timeOffset = 0.0 }: { text?: string; timeOffset?: number } = {},
): [string, number][] {
  const accumulator = new _SpeechMarkAccumulator(text, timeOffset);
  const collected = chunks.flatMap((chunk) => accumulator.add(chunk));
  return [...collected, ...accumulator.flush()];
}

/** Build a word speech mark. */
function mark(value: string, start: number, end: number, startTime = 0, endTime = 0): Dict {
  return {
    type: "word",
    value,
    start,
    end,
    start_time: startTime,
    end_time: endTime,
  };
}

// The speech marks Speechify streams for TEXT.
const STREAMING_MARKS = [mark("Hello", 0, 5, 0, 469), mark("world.", 6, 12, 469, 1152)];

describe("TestSpeechMarks", () => {
  // Speech marks become (word, seconds) pairs and an utterance end time.

  test("test_marks_convert_milliseconds_to_seconds", () => {
    expect(wordTimes([STREAMING_MARKS])).toEqual([
      ["Hello", 0.0],
      ["world.", 0.469],
    ]);
  });

  test("test_time_offset_shifts_words", () => {
    // The offset sequences words across the utterances of one turn.
    const result = wordTimes([STREAMING_MARKS], { timeOffset: 2.5 });
    expect(result.length).toBe(2);
    expect(result[0]).toEqual(["Hello", 2.5]);
    expect(result[1]![0]).toBe("world.");
    expect(result[1]![1]).toBeCloseTo(2.969, 6);
  });

  test("test_end_time_tracks_the_last_mark_and_ignores_the_offset", () => {
    const accumulator = new _SpeechMarkAccumulator(TEXT, 2.5);
    accumulator.add(STREAMING_MARKS);

    expect(accumulator.endTime).toBeCloseTo(1.152, 6);
  });

  test("test_non_word_marks_are_skipped", () => {
    const marks = [
      { type: "sentence", start: 0, end: 12, start_time: 0, end_time: 1152 },
      STREAMING_MARKS[0]!,
    ];

    expect(wordTimes([marks])).toEqual([["Hello", 0.0]]);
  });

  for (const marks of [null, [], [{}], [{ type: "word", value: "" }]] as (Dict[] | null)[]) {
    test(`test_empty_marks_produce_nothing[${JSON.stringify(marks)}]`, () => {
      expect(wordTimes([marks])).toEqual([]);
    });
  }
});

describe("TestWordRecovery", () => {
  // Words come from the synthesized text, not from the mark's normalized value.

  test("test_normalized_value_is_replaced_by_the_original_spelling", () => {
    // Speechify flattens typographic apostrophes; the offsets recover them.
    expect(wordTimes([[mark("you'd", 0, 5)]], { text: "you’d like" })).toEqual([["you’d", 0.0]]);
  });

  const unusableCases: Dict[] = [
    { value: "world." }, // No offsets at all.
    { start: 6, end: 99, value: "world." }, // End past the text.
    { start: 6, end: 6, value: "world." }, // Empty span.
    { start: "6", end: "12", value: "world." }, // Offsets not integers.
  ];
  for (const unusable of unusableCases) {
    test(`test_unusable_offsets_fall_back_to_the_value[${JSON.stringify(unusable)}]`, () => {
      expect(wordTimes([[{ type: "word", ...unusable }]])).toEqual([["world.", 0.0]]);
    });
  }

  test("offsets count code points, as Python indexes a str", () => {
    // Not in upstream: an astral character is one Python character but two UTF-16 units.
    expect(wordTimes([[mark("hi", 2, 4), mark("there", 5, 10)]], { text: "😀 hi there" })).toEqual([
      ["hi", 0.0],
      ["there", 0.0],
    ]);
  });
});

describe("TestSplitWords", () => {
  // Marks that abut in the text are one word, even across chunk boundaries.

  // Speechify marks "text-to-speech" as five separate marks.
  const HYPHENATED = "I like text-to-speech systems.";

  test("test_abutting_marks_join_into_one_word", () => {
    const marks = [
      mark("text", 7, 11),
      mark("-", 11, 12),
      mark("to", 12, 14),
      mark("-", 14, 15),
      mark("speech", 15, 21),
      mark("systems.", 22, 30),
    ];

    expect(wordTimes([marks], { text: HYPHENATED })).toEqual([
      ["text-to-speech", 0.0],
      ["systems.", 0.0],
    ]);
  });

  test("test_a_split_word_is_joined_across_chunks", () => {
    // A run of abutting marks can straddle two speech.chunk events.
    expect(
      wordTimes(
        [
          [mark("text", 7, 11), mark("-", 11, 12), mark("to", 12, 14), mark("-", 14, 15)],
          [mark("speech", 15, 21), mark("systems.", 22, 30)],
        ],
        { text: HYPHENATED },
      ),
    ).toEqual([
      ["text-to-speech", 0.0],
      ["systems.", 0.0],
    ]);
  });

  test("test_a_joined_word_keeps_the_first_marks_timestamp", () => {
    const marks = [mark("text", 7, 11, 500), mark("-", 11, 12, 900)];

    expect(wordTimes([marks], { text: HYPHENATED })).toEqual([["text-", 0.5]]);
  });

  test("test_a_word_is_released_as_soon_as_the_text_shows_it_cannot_continue", () => {
    // Only words the text can still extend are held back for the next chunk.
    const accumulator = new _SpeechMarkAccumulator(HYPHENATED);

    expect(accumulator.add([mark("I", 0, 1), mark("like", 2, 6)])).toEqual([
      ["I", 0.0],
      ["like", 0.0],
    ]);
  });

  test("test_a_word_left_pending_at_the_end_of_the_stream_is_flushed", () => {
    // The text ends mid-run when the trailing mark is not the final character.
    const accumulator = new _SpeechMarkAccumulator(HYPHENATED);
    accumulator.add([mark("text", 7, 11), mark("-", 11, 12)]);

    expect(accumulator.flush()).toEqual([["text-", 0.0]]);
    expect(accumulator.flush()).toEqual([]);
  });
});

describe("TestSSEParsing", () => {
  // Server-Sent Events blocks decode to an event name and payload.

  test("test_chunk_with_audio_and_marks", () => {
    const event = _parseSseEvent(
      'event: speech.chunk\ndata: {"audio":"SUQzBAA=","speech_marks":[]}',
    );

    expect(event).toEqual(["speech.chunk", { audio: "SUQzBAA=", speech_marks: [] }]);
  });

  test("test_done_event", () => {
    const event = _parseSseEvent(
      'event: speech.done\ndata: {"billable_characters_count":40,"audio_duration_ms":4350}',
    );

    expect(event).toEqual([
      "speech.done",
      { billable_characters_count: 40, audio_duration_ms: 4350 },
    ]);
  });

  test("test_unknown_event_name_is_preserved_for_the_caller_to_ignore", () => {
    const event = _parseSseEvent("event: speech.something-new\ndata: {}");

    expect(event).toEqual(["speech.something-new", {}]);
  });

  test("test_multi_line_data_is_joined", () => {
    const event = _parseSseEvent('event: speech.done\ndata: {"audio_duration_ms":\ndata: 4350}');

    expect(event).toEqual(["speech.done", { audio_duration_ms: 4350 }]);
  });

  test("test_comment_lines_are_ignored", () => {
    const event = _parseSseEvent(": keep-alive\nevent: speech.done\ndata: {}");

    expect(event).toEqual(["speech.done", {}]);
  });

  for (const block of [
    "event: speech.done", // No data field.
    'data: {"audio":', // Truncated JSON.
    "",
  ]) {
    test(`test_undecodable_blocks_yield_nothing[${JSON.stringify(block)}]`, () => {
      expect(_parseSseEvent(block)).toBeNull();
    });
  }
});

describe("TestOutputFormat", () => {
  // Sample rates map to Speechify's PCM output formats.

  for (const sampleRate of [8000, 16000, 22050, 24000, 44100, 48000]) {
    test(`test_supported_sample_rates_pass_through[${sampleRate}]`, () => {
      expect(_outputFormatFromSampleRate(sampleRate)).toEqual([`pcm_${sampleRate}`, sampleRate]);
    });
  }

  test("test_unsupported_sample_rate_falls_back", () => {
    // Speechify has no pcm_32000, so the caller is told the real synthesis rate.
    expect(_outputFormatFromSampleRate(32000)).toEqual(["pcm_24000", 24000]);
  });
});

describe("TestLanguageMapping", () => {
  // Languages resolve to the regional tags Speechify documents.

  test("test_base_languages_resolve_to_supported_regional_tags", () => {
    expect(languageToSpeechifyLanguage(Language.EN)).toBe("en-US");
    expect(languageToSpeechifyLanguage(Language.PT)).toBe("pt-BR");
    expect(languageToSpeechifyLanguage(Language.DE)).toBe("de-DE");
  });

  test("test_regional_variants_are_preserved", () => {
    expect(languageToSpeechifyLanguage(Language.ES_MX)).toBe("es-MX");
    expect(languageToSpeechifyLanguage(Language.EN_GB)).toBe("en-GB");
  });

  test("test_unmapped_languages_pass_through_as_bcp47_tags", () => {
    expect(languageToSpeechifyLanguage(Language.JA_JP)).toBe("ja-JP");
  });
});

//
// Not in upstream: the service against a fake SSE endpoint.
//

function sse(event: string, data: Dict): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function withSseServer<T>(
  respond: () => Response,
  fn: (baseUrl: string, requests: { headers: Headers; body: Dict }[]) => Promise<T>,
): Promise<T> {
  const requests: { headers: Headers; body: Dict }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ headers: request.headers, body: (await request.json()) as Dict });
      return respond();
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    server.stop(true);
  }
}

describe("TestSpeechifyHttpTTSService", () => {
  const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

  test("streams audio and word timestamps over SSE and sends the pinned headers", async () => {
    const body =
      sse("speech.chunk", {
        type: "speech.chunk",
        audio: b64(PCM),
        speech_marks: [mark("Hello", 0, 5, 0, 469)],
      }) +
      sse("speech.chunk", {
        type: "speech.chunk",
        speech_marks: [mark("world.", 6, 12, 469, 1152)],
      }) +
      sse("speech.done", { type: "speech.done", audio_duration_ms: 1200 });
    await withSseServer(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      async (baseUrl, requests) => {
        const tts = new SpeechifyHttpTTSService({
          apiKey: "k",
          baseUrl,
          sampleRate: 24000,
          settings: new SpeechifyHttpTTSService.Settings({
            language: "en-US",
            textNormalization: true,
          }),
        });
        const [down] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: TEXT })],
        });
        expect(requests.length).toBe(1);
        const { headers, body: payload } = requests[0]!;
        expect(headers.get("authorization")).toBe("Bearer k");
        expect(headers.get("speechify-version")).toBe(SPEECHIFY_API_VERSION);
        expect(headers.get("speechify-caller")).toBe("pipecat");
        expect(headers.get("speechify-caller-version")).toBeTruthy();
        expect(payload).toEqual({
          input: TEXT,
          voice_id: "geffen_32",
          model: "simba-3.2",
          output_format: "pcm_24000",
          language: "en-US",
          options: { text_normalization: true },
        });
        const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
        expect(audio.length).toBe(1);
        expect(audio[0]!.audio).toEqual(PCM);
        expect(audio[0]!.sampleRate).toBe(24000);
        const words = down.filter((f) => f instanceof TTSTextFrame) as TTSTextFrame[];
        expect(words.map((f) => f.text)).toEqual(["Hello", "world."]);
        expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
      },
    );
  });

  test("a non-200 response becomes an ErrorFrame", async () => {
    await withSseServer(
      () => new Response("nope", { status: 401 }),
      async (baseUrl) => {
        const tts = new SpeechifyHttpTTSService({ apiKey: "k", baseUrl, sampleRate: 24000 });
        const [down, up] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: TEXT })],
        });
        expect([...down, ...up].some((f) => f instanceof ErrorFrame)).toBe(true);
      },
    );
  });
});
