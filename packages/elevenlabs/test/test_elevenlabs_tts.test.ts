// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_elevenlabs_tts.py

/** Tests for ElevenLabs TTS alignment handling. */

import { describe, expect, test } from "bun:test";
import { BaseExpressionAdapter } from "@pipedog/core/adapters/tts/base_expression_adapter";
import { ExpressionFormatter } from "@pipedog/core/expressive/formatter";
import { TTSMetadataFrame, TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { ConnectionClosedOK, State } from "@pipedog/core/services/websocket_service";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { concatenateAggregatedText, TextPartForConcatenation } from "@pipedog/core/utils/string";
import { ElevenLabsAudioTagExpressionAdapter } from "../src/elevenlabs_adapter.ts";
import { calculateWordTimes, ElevenLabsHttpTTSService, ElevenLabsTTSService } from "../src/tts.ts";
// Upstream imports these helpers through `tts`, which imports them from `tts_base`.
import {
  _selectAlignment,
  _stripUtteranceLeadingSpaces,
  _wordTimestampsIncludeInterFrameSpaces,
  ELEVENLABS_MODEL_LANGUAGES,
  ELEVENLABS_V2_5_LANGUAGES,
  ELEVENLABS_V3_LANGUAGES,
  ELEVENLABS_V4_LANGUAGES,
  elevenlabsLanguageCode,
  languageToElevenlabsLanguage,
} from "../src/tts_base.ts";

// Tests reach into protected members.
type Any = any;

const _WS_ALIGNMENT_KEYS = ["chars", "charStartTimesMs", "charDurationsMs"] as const;

function _chunk(text: string): Record<string, any[]> {
  const chars = Array.from(text);
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * 100),
    charDurationsMs: chars.map(() => 100),
  };
}

function _wordsFromChunks(chunks: Record<string, any[]>[]): string[] {
  let cumulativeTime = 0.0;
  let partialWord = "";
  let partialWordStartTime = 0.0;
  const wordTimes: [string, number][] = [];
  let alignmentStarted = false;

  for (const chunk of chunks) {
    const alignment = _stripUtteranceLeadingSpaces(chunk, _WS_ALIGNMENT_KEYS, !alignmentStarted);
    alignmentStarted = true;
    let chunkWordTimes: [string, number][];
    [chunkWordTimes, partialWord, partialWordStartTime] = calculateWordTimes(
      alignment,
      cumulativeTime,
      partialWord,
      partialWordStartTime,
    );
    wordTimes.push(...chunkWordTimes);

    const starts: number[] = alignment.charStartTimesMs;
    const durations: number[] = alignment.charDurationsMs;
    if (starts.length > 0 && durations.length > 0) {
      cumulativeTime += (starts[starts.length - 1]! + durations[durations.length - 1]!) / 1000.0;
    }
  }

  if (partialWord) {
    wordTimes.push([partialWord, partialWordStartTime]);
  }

  return wordTimes.map(([word]) => word);
}

function _concatenateWordsForLanguage(words: string[], language: string): string {
  const includesInterFrameSpaces = _wordTimestampsIncludeInterFrameSpaces(language);
  return concatenateAggregatedText(
    words.map(
      (word) =>
        new TextPartForConcatenation({
          text: word,
          includesInterPartSpaces: includesInterFrameSpaces,
        }),
    ),
  );
}

/** Python `a < b` on sets: proper subset. */
function isProperSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size >= b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

describe("test_elevenlabs_tts", () => {
  test("test_elevenlabs_flash_alignment_preserves_inter_word_chunk_space", () => {
    const chunks = [
      _chunk(" Why did the math book"),
      _chunk(" look so sad? "),
      _chunk(" Because it had too m"),
      _chunk("any problems. "),
    ];

    expect(_wordsFromChunks(chunks)).toEqual([
      "Why",
      "did",
      "the",
      "math",
      "book",
      "look",
      "so",
      "sad?",
      "Because",
      "it",
      "had",
      "too",
      "many",
      "problems.",
    ]);
  });

  test("test_elevenlabs_japanese_timestamp_chunks_reassemble_without_spaces", () => {
    const words = _wordsFromChunks([
      _chunk("どんなことでも気 "),
      _chunk("軽に相談してくださいね。 "),
    ]);

    expect(words).toEqual(["どんなことでも気", "軽に相談してくださいね。"]);
    expect(_concatenateWordsForLanguage(words, "ja")).toBe(
      "どんなことでも気軽に相談してくださいね。",
    );
  });

  test("test_elevenlabs_chinese_timestamp_chunks_reassemble_without_spaces", () => {
    const words = _wordsFromChunks([_chunk("你好，我是 "), _chunk("你的智能助手。 ")]);

    expect(words).toEqual(["你好，我是", "你的智能助手。"]);
    expect(_concatenateWordsForLanguage(words, "zh-CN")).toBe("你好，我是你的智能助手。");
  });

  test("test_elevenlabs_english_timestamp_chunks_reassemble_with_spaces", () => {
    const words = ["Hello", "world."];

    expect(_concatenateWordsForLanguage(words, "en")).toBe("Hello world.");
  });

  test("test_elevenlabs_timestamp_spacing_languages", () => {
    expect(_wordTimestampsIncludeInterFrameSpaces("ja")).toBe(true);
    expect(_wordTimestampsIncludeInterFrameSpaces("zh-CN")).toBe(true);
    expect(_wordTimestampsIncludeInterFrameSpaces("yue")).toBe(true);
    expect(_wordTimestampsIncludeInterFrameSpaces("en")).toBe(false);
  });

  test("test_elevenlabs_alignment_strips_only_utterance_leading_spaces", () => {
    const first = _stripUtteranceLeadingSpaces(_chunk("  Hello"), _WS_ALIGNMENT_KEYS, true);
    const subsequent = _stripUtteranceLeadingSpaces(_chunk(" world"), _WS_ALIGNMENT_KEYS, false);

    expect(first.chars).toEqual(Array.from("Hello"));
    expect(subsequent.chars).toEqual(Array.from(" world"));
  });

  test("test_select_alignment_default_prefers_alignment", () => {
    const msg = {
      alignment: _chunk("Hello"),
      normalizedAlignment: _chunk(" Hello"),
    };
    const selected = _selectAlignment(msg, {
      normalizedKey: "normalizedAlignment",
      alignmentKey: "alignment",
      preferNormalized: false,
    });
    expect(selected).not.toBeNull();
    expect(selected!.chars).toEqual(Array.from("Hello"));
  });

  test("test_select_alignment_dictionary_mode_prefers_normalized", () => {
    const msg = {
      alignment: _chunk("Hello"),
      normalizedAlignment: _chunk(" Hello"),
    };
    const selected = _selectAlignment(msg, {
      normalizedKey: "normalizedAlignment",
      alignmentKey: "alignment",
      preferNormalized: true,
    });
    expect(selected).not.toBeNull();
    expect(selected!.chars).toEqual(Array.from(" Hello"));
  });

  test("test_select_alignment_falls_back_when_preferred_missing", () => {
    const msgDefault = { normalizedAlignment: _chunk(" Hello") };
    let selected = _selectAlignment(msgDefault, {
      normalizedKey: "normalizedAlignment",
      alignmentKey: "alignment",
      preferNormalized: false,
    });
    expect(selected).not.toBeNull();
    expect(selected!.chars).toEqual(Array.from(" Hello"));

    const msgDict = { alignment: _chunk("Hello") };
    selected = _selectAlignment(msgDict, {
      normalizedKey: "normalizedAlignment",
      alignmentKey: "alignment",
      preferNormalized: true,
    });
    expect(selected).not.toBeNull();
    expect(selected!.chars).toEqual(Array.from("Hello"));
  });

  test("test_select_alignment_falls_back_when_preferred_null", () => {
    const msg = { alignment: null, normalizedAlignment: _chunk(" Hello") };
    const selected = _selectAlignment(msg, {
      normalizedKey: "normalizedAlignment",
      alignmentKey: "alignment",
      preferNormalized: false,
    });
    expect(selected).not.toBeNull();
    expect(selected!.chars).toEqual(Array.from(" Hello"));
  });

  test("test_select_alignment_returns_none_when_both_missing", () => {
    expect(
      _selectAlignment(
        {},
        {
          normalizedKey: "normalizedAlignment",
          alignmentKey: "alignment",
          preferNormalized: false,
        },
      ),
    ).toBeNull();
    expect(
      _selectAlignment(
        { alignment: null, normalizedAlignment: null },
        {
          normalizedKey: "normalizedAlignment",
          alignmentKey: "alignment",
          preferNormalized: true,
        },
      ),
    ).toBeNull();
  });

  test("test_select_alignment_works_with_http_field_names", () => {
    const msg = {
      alignment: { characters: Array.from("Hi") },
      normalized_alignment: { characters: Array.from(" Hi") },
    };
    let selected = _selectAlignment(msg, {
      normalizedKey: "normalized_alignment",
      alignmentKey: "alignment",
      preferNormalized: false,
    });
    expect(selected).not.toBeNull();
    expect(selected!.characters).toEqual(Array.from("Hi"));

    selected = _selectAlignment(msg, {
      normalizedKey: "normalized_alignment",
      alignmentKey: "alignment",
      preferNormalized: true,
    });
    expect(selected).not.toBeNull();
    expect(selected!.characters).toEqual(Array.from(" Hi"));
  });

  // ---------------------------------------------------------------------------
  // Keepalive vs context-init race
  //
  // The keepalive must only stamp a context_id once its context-init (carrying
  // voice_settings) has been sent. Stamping it earlier makes the keepalive the
  // context's first message, with no voice_settings, and ElevenLabs rejects the
  // later context-init with a 1008 policy violation.
  // ---------------------------------------------------------------------------

  /** Minimal stand-in for the ElevenLabs websocket that records sends. */
  class _FakeWebSocket {
    state: State = State.OPEN;
    sent: Record<string, unknown>[] = [];

    async send(data: string): Promise<void> {
      this.sent.push(pyJsonLoads(data) as Record<string, unknown>);
    }
  }

  function _makeService(): Any {
    return new ElevenLabsTTSService({
      apiKey: "test-key",
      settings: new ElevenLabsTTSService.Settings({
        voice: "test-voice",
        stability: 0.55,
        similarityBoost: 0.85,
        useSpeakerBoost: true,
        speed: 0.81,
      }),
    });
  }

  test("test_keepalive_does_not_stamp_context_before_init", async () => {
    // During the pre-init window the keepalive must not stamp the new context_id.
    const service = _makeService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;

    // Simulate the start of an LLM turn: TTSService sets the turn context id on
    // LLMFullResponseStartFrame, before runTts sends the voice_settings init.
    service._turnContextId = "ctx-1";
    service.resetActiveAudioContext();
    expect(service._contextInitSent.has("ctx-1")).toBe(false);

    await service._sendKeepalive();

    // Context-less keepalive: the real context-init stays the context's first
    // message, so ElevenLabs won't reject it with 1008.
    expect(ws.sent).toEqual([{ text: "" }]);
  });

  test("test_keepalive_stamps_context_after_init", async () => {
    // Once the context-init has been sent, the keepalive targets that context.
    const service = _makeService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;
    service._turnContextId = "ctx-1";
    service.resetActiveAudioContext();
    // runTts records the context once its voice_settings init has gone out.
    service._contextInitSent.add("ctx-1");

    await service._sendKeepalive();

    expect(ws.sent).toEqual([{ text: "", context_id: "ctx-1" }]);
  });

  test("test_keepalive_without_active_context_sends_empty", async () => {
    // With no active context, the keepalive sends a plain empty message.
    const service = _makeService();
    const ws = new _FakeWebSocket();
    service._websocket = ws;
    service._turnContextId = null;
    service.resetActiveAudioContext();

    await service._sendKeepalive();

    expect(ws.sent).toEqual([{ text: "" }]);
  });

  /**
   * Records the JSON payload of each POST; the 400 response makes runTts bail
   * after posting (upstream: a fake aiohttp session).
   */
  function _fakeHttpSession(): { payloads: Record<string, unknown>[]; fetch: typeof fetch } {
    const payloads: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      payloads.push(pyJsonLoads(String(init?.body)) as Record<string, unknown>);
      return new Response("rejected", { status: 400 });
    }) as unknown as typeof fetch;
    return { payloads, fetch: fakeFetch };
  }

  async function _httpPayloadForModel(model: string): Promise<Record<string, unknown>> {
    const session = _fakeHttpSession();
    const service: Any = new ElevenLabsHttpTTSService({
      apiKey: "test-key",
      fetch: session.fetch,
      settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model }),
    });
    service._previousText = "Hello!";
    for await (const _ of service.runTts("How can I assist you today?", "ctx-1")) {
      // drain
    }
    return session.payloads[0]!;
  }

  test("test_http_payload_includes_previous_text_when_supported", async () => {
    const payload = await _httpPayloadForModel("eleven_flash_v2_5");
    expect(payload.previous_text).toBe("Hello!");
  });

  for (const model of ["eleven_v3", "eleven_v3_conversational"]) {
    test(`test_http_payload_omits_previous_text_for_eleven_v3_models[${model}]`, async () => {
      const payload = await _httpPayloadForModel(model);
      expect("previous_text" in payload).toBe(false);
    });
  }

  // ---------------------------------------------------------------------------
  // Disconnect vs server-initiated close race
  //
  // When the server closes the websocket first (normal during teardown), the
  // close-handshake send in _disconnectWebsocket raises ConnectionClosed. That
  // must not be reported as a pipeline error: a non-fatal ErrorFrame here can
  // e.g. trigger a spurious ServiceSwitcherStrategyFailover switch on shutdown.
  // ---------------------------------------------------------------------------

  /** Websocket stand-in whose sends fail with a normal close. */
  class _ClosedWebSocket {
    state: State = State.OPEN;

    async send(_data: string): Promise<void> {
      throw new ConnectionClosedOK(1001, "going away");
    }

    async close(): Promise<void> {}
  }

  test("test_disconnect_does_not_push_error_when_server_closed_first", async () => {
    // A ConnectionClosed during the disconnect handshake is not a pipeline error.
    const service = _makeService();
    service._websocket = new _ClosedWebSocket();

    const errors: unknown[] = [];

    service.pushError = async (errorMsg?: string, _options?: unknown) => {
      errors.push(errorMsg);
    };

    await service._disconnectWebsocket();

    expect(errors).toEqual([]);
    expect(service._websocket).toBeNull();
  });

  test("test_v3_language_set_extends_the_v2_5_set", () => {
    // Eleven v3 adds languages; it never drops one Flash and Turbo support.
    expect(isProperSubset(ELEVENLABS_V2_5_LANGUAGES, ELEVENLABS_V3_LANGUAGES)).toBe(true);
    expect(ELEVENLABS_V2_5_LANGUAGES.size).toBe(32);
    expect(ELEVENLABS_V3_LANGUAGES.size).toBe(74);
  });

  test("test_v4_language_set_extends_the_v3_set", () => {
    // Eleven v4 adds languages; it never drops one Eleven v3 supports.
    expect(isProperSubset(ELEVENLABS_V3_LANGUAGES, ELEVENLABS_V4_LANGUAGES)).toBe(true);
    expect(ELEVENLABS_V4_LANGUAGES.size).toBe(84);
  });

  test("test_language_code_is_gated_by_model", () => {
    // A language the model doesn't cover is dropped rather than sent.
    // Welsh is v3-only.
    expect(elevenlabsLanguageCode("eleven_v3_conversational", "cy")).toBe("cy");
    expect(elevenlabsLanguageCode("eleven_flash_v2_5", "cy")).toBeNull();
    // German is common to both.
    expect(elevenlabsLanguageCode("eleven_flash_v2_5", "de")).toBe("de");
    expect(elevenlabsLanguageCode("eleven_v3", "de")).toBe("de");
    // Cantonese is v4-only.
    expect(elevenlabsLanguageCode("eleven_v4_turbo", "yue")).toBe("yue");
    expect(elevenlabsLanguageCode("eleven_v4", "yue")).toBe("yue");
    expect(elevenlabsLanguageCode("eleven_v3", "yue")).toBeNull();
  });

  test("test_models_without_language_support_send_no_code", () => {
    // Models absent from the mapping take no language code at all.
    expect("eleven_multilingual_v2" in ELEVENLABS_MODEL_LANGUAGES).toBe(false);
    expect(elevenlabsLanguageCode("eleven_multilingual_v2", "de")).toBeNull();
    expect(elevenlabsLanguageCode(null, "de")).toBeNull();
  });

  test("test_no_language_requested_is_not_a_warning_case", () => {
    // Omitting a language is normal, not a mismatch.
    expect(elevenlabsLanguageCode("eleven_v3", null)).toBeNull();
    expect(elevenlabsLanguageCode("eleven_v3", "")).toBeNull();
  });

  test("test_every_mapped_language_is_accepted_by_some_model", () => {
    // The enum map and the per-model sets can't drift apart.
    for (const language of new Set(Object.values(Language))) {
      const code = languageToElevenlabsLanguage(language);
      if (ELEVENLABS_V3_LANGUAGES.has(code)) {
        expect(elevenlabsLanguageCode("eleven_v3", code)).toBe(code);
      }
      if (ELEVENLABS_V4_LANGUAGES.has(code)) {
        expect(elevenlabsLanguageCode("eleven_v4_turbo", code)).toBe(code);
      }
    }
  });

  /** Yields the given server messages, then ends. */
  class _MessagesWebSocket {
    state: State = State.OPEN;
    #messages: string[];

    constructor(messages: Record<string, unknown>[]) {
      this.#messages = messages.map((m) => pyJsonDumps(m));
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
      for (const message of this.#messages) {
        yield message;
      }
    }
  }

  test("test_wordless_alignment_still_advances_the_clock", async () => {
    // Trailing punctuation can arrive on its own; its span must not be dropped.
    const service = _makeService();
    const reported: [string, number][] = [];

    service.addWordTimestamps = async (wordTimes: [string, number][], ..._args: unknown[]) => {
      reported.push(...wordTimes);
    };
    service._websocket = new _MessagesWebSocket(
      ["Hi there", "!", " Bye "].map((text) => ({ contextId: "ctx-1", alignment: _chunk(text) })),
    );

    await service._receiveMessages();

    expect(reported.map(([word]) => word)).toEqual(["Hi", "there!", "Bye"]);
    // "Bye" starts after the 8 characters of the first chunk, the "!", and its space.
    expect(reported.at(-1)![1]).toBeCloseTo(0.8 + 0.1 + 0.1, 6);
  });

  for (const [model, adapter] of [
    ["eleven_flash_v2_5", BaseExpressionAdapter],
    ["eleven_multilingual_v2", BaseExpressionAdapter],
    ["eleven_v3", ElevenLabsAudioTagExpressionAdapter],
    ["eleven_v4_turbo", ElevenLabsAudioTagExpressionAdapter],
  ] as const) {
    test(`test_http_expression_adapter_follows_the_model[${model}-${adapter.name}]`, () => {
      const service = new ElevenLabsHttpTTSService({
        apiKey: "test-key",
        fetch: _fakeHttpSession().fetch,
        settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model }),
      });
      // Python `type(x) is C`: the exact class, not a subclass.
      expect(Object.getPrototypeOf(service.getExpressionAdapter()).constructor).toBe(adapter);
    });
  }

  test("test_http_model_change_to_one_without_audio_tags_is_broadcast", async () => {
    const service = new ElevenLabsHttpTTSService({
      apiKey: "test-key",
      fetch: _fakeHttpSession().fetch,
      settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model: "eleven_v3" }),
    });

    const [, up] = await runTest(service, {
      framesToSend: [
        new TTSUpdateSettingsFrame({
          delta: new ElevenLabsHttpTTSService.Settings({ model: "eleven_flash_v2_5" }),
        }),
      ],
      pipelineParams: new PipelineParams({ enableExpressiveConversation: true }),
    });

    const metadata = up.filter((f) => f instanceof TTSMetadataFrame) as TTSMetadataFrame[];
    expect(metadata[0]!.expression).not.toBeNull();
    expect(metadata.at(-1)!.expression).toBeNull();
  });

  /** A `fetch` whose 200 response streams the given JSON lines. */
  function _streamingHttpFetch(lines: Record<string, unknown>[]): typeof fetch {
    return (async () =>
      new Response(lines.map((line) => `${pyJsonDumps(line)}\n`).join(""), {
        status: 200,
      })) as unknown as typeof fetch;
  }

  function _httpChunk(text: string): Record<string, unknown> {
    const chars = Array.from(text);
    return {
      alignment: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => i * 0.1),
        character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1),
      },
    };
  }

  test("test_http_word_timestamps_report_audio_tags_as_words", async () => {
    const chunks = ["It's ", "[excited]", " back [sh", "ort pause] up."];
    const service: Any = new ElevenLabsHttpTTSService({
      apiKey: "test-key",
      fetch: _streamingHttpFetch(chunks.map((c) => _httpChunk(c))),
      settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model: "eleven_v3" }),
    });
    const reported: string[] = [];

    service.addWordTimestamps = async (wordTimes: [string, number][], ..._args: unknown[]) => {
      reported.push(...wordTimes.map(([word]) => word));
    };
    service._expressionFormatter = new ExpressionFormatter(() => service.getExpressionAdapter(), {
      owner: service,
    });

    for await (const _ of service.runTts("It's [excited] back [short pause] up.", "ctx-1")) {
      // drain
    }

    expect(reported.slice(0, 4)).toEqual(["It's", "[excited]", "back", "[short pause]"]);
  });

  test("test_http_audio_tag_ending_the_reply_is_reported_whole", async () => {
    const chunks = ["Thanks. [inhales ", "deeply]"];
    const service: Any = new ElevenLabsHttpTTSService({
      apiKey: "test-key",
      fetch: _streamingHttpFetch(chunks.map((c) => _httpChunk(c))),
      settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model: "eleven_v3" }),
    });
    const reported: string[] = [];

    service.addWordTimestamps = async (wordTimes: [string, number][], ..._args: unknown[]) => {
      reported.push(...wordTimes.map(([word]) => word));
    };
    service._expressionFormatter = new ExpressionFormatter(() => service.getExpressionAdapter(), {
      owner: service,
    });

    for await (const _ of service.runTts("Thanks. [inhales deeply]", "ctx-1")) {
      // drain
    }

    expect(reported).toEqual(["Thanks.", "[inhales deeply]"]);
  });

  test("test_http_alignment_is_left_as_is_without_expressive_conversation", async () => {
    const service: Any = new ElevenLabsHttpTTSService({
      apiKey: "test-key",
      fetch: _streamingHttpFetch([_httpChunk("Press [ to open the menu now.")]),
      settings: new ElevenLabsHttpTTSService.Settings({ voice: "test-voice", model: "eleven_v3" }),
    });
    const reported: string[] = [];

    service.addWordTimestamps = async (wordTimes: [string, number][], ..._args: unknown[]) => {
      reported.push(...wordTimes.map(([word]) => word));
    };

    for await (const _ of service.runTts("Press [ to open the menu now.", "ctx-1")) {
      // drain
    }

    expect(reported).toEqual(["Press", "[", "to", "open", "the", "menu", "now."]);
  });
});
