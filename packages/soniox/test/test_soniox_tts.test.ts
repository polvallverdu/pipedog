// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_soniox_tts.py

/**
 * Tests for the Soniox TTS service.
 *
 * Porting notes:
 * - Upstream builds services with `SonioxTTSService.__new__` to skip
 *   `__init__`; a TypeScript class cannot skip its constructor, so these tests
 *   build a real service (`apiKey` only) and overwrite the same attributes.
 * - `monkeypatch.setattr` becomes assigning the instance property.
 */

import { describe, expect, test } from "bun:test";
import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  ErrorFrame,
  type Frame,
  TextType,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { TTSSettings } from "@pipedog/core/services/settings";
import { State } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { AggregatedFrameSequencer } from "@pipedog/core/utils/context/aggregated_frame_sequencer";
import { WordCompletionTracker } from "@pipedog/core/utils/context/word_completion_tracker";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { concatenateAggregatedText, TextPartForConcatenation } from "@pipedog/core/utils/string";
import { languageToSonioxTtsLanguage, SonioxTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

function service(language: string | null): SonioxTTSService {
  const s = new SonioxTTSService({ apiKey: "test-key" });
  (s as any)._settings = new TTSSettings({ language });
  (s as any)._partials = new Map();
  return s;
}

function timestamps(text: string, start = 0.0): Dict {
  const chars = Array.from(text);
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => Math.round((start + i * 0.1) * 10) / 10),
  };
}

test("test_soniox_english_characters_assemble_into_words", () => {
  const s = service("en");

  expect(s._toWordTimes("s1", timestamps("Hi world. "))).toEqual([
    ["Hi", 0.0],
    ["world.", 0.3],
  ]);
});

test("test_soniox_english_partial_word_carries_across_messages", () => {
  const s = service("en");

  expect(s._toWordTimes("s1", timestamps("Hel"))).toEqual([]);
  expect(s._toWordTimes("s1", timestamps("lo you ", 0.3))).toEqual([
    ["Hello", 0.0],
    ["you", 0.6],
  ]);
});

test("test_soniox_english_final_partial_word_is_buffered_for_terminated", () => {
  const s = service("en");

  expect(s._toWordTimes("s1", timestamps("Hi you"))).toEqual([["Hi", 0.0]]);
  // The receive loop flushes this buffered word when Soniox sends `terminated`.
  expect((s as any)._partials.get("s1")).toEqual(["you", 0.3]);
});

test("test_soniox_streams_buffer_partial_words_independently", () => {
  const s = service("en");

  s._toWordTimes("s1", timestamps("Hel"));
  s._toWordTimes("s2", timestamps("wor", 1.0));

  expect((s as any)._partials.get("s1")).toEqual(["Hel", 0.0]);
  expect((s as any)._partials.get("s2")).toEqual(["wor", 1.0]);

  expect(s._toWordTimes("s1", timestamps("lo ", 0.3))).toEqual([["Hello", 0.0]]);
  expect(s._toWordTimes("s2", timestamps("ld ", 1.3))).toEqual([["world", 1.0]]);
});

test("test_soniox_timestamp_length_mismatch_returns_empty", () => {
  const s = service("en");

  expect(
    s._toWordTimes("s1", { characters: ["H", "i"], character_start_times_seconds: [0.0] }),
  ).toEqual([]);
  expect((s as any)._partials.has("s1")).toBe(false);
});

test("test_soniox_japanese_timestamps_emit_per_character", () => {
  const s = service("ja");

  expect(s._toWordTimes("s1", timestamps("こんにちは、私"))).toEqual([
    ["こ", 0.0],
    ["ん", 0.1],
    ["に", 0.2],
    ["ち", 0.3],
    ["は", 0.4],
    ["私", 0.6],
  ]);
  expect((s as any)._partials.has("s1")).toBe(false);
});

test("test_soniox_chinese_timestamps_emit_per_character", () => {
  const s = service("zh");

  expect(s._toWordTimes("s1", timestamps("你好，世界。"))).toEqual([
    ["你", 0.0],
    ["好", 0.1],
    ["世", 0.3],
    ["界", 0.4],
  ]);
});

test("test_soniox_japanese_tokens_concatenate_without_spaces", () => {
  const s = service("ja");
  const tokens = s._toWordTimes("s1", timestamps("こんにちは、私"));

  const includesInterFrameSpaces = s._isChineseOrJapaneseLanguage();
  expect(
    concatenateAggregatedText(
      tokens.map(
        ([word]) =>
          new TextPartForConcatenation({
            text: word,
            includesInterPartSpaces: includesInterFrameSpaces,
          }),
      ),
    ),
  ).toBe("こんにちは私");
});

test("test_soniox_japanese_punctuation_recovered_by_word_tracker", () => {
  // CJK tokens drop punctuation (isalnum filter), which is safe: the frame
  // sequencer's WordCompletionTracker matches tokens by alphanumeric content
  // only and commits spans of the original text, sweeping adjacent punctuation
  // into each consumed span.
  const text = "こんにちは、私はAIです。";
  const s = service("ja");
  const tokens = s._toWordTimes("s1", timestamps(text));

  const tracker = new WordCompletionTracker(text);
  let complete = false;
  for (const [word] of tokens) {
    complete = tracker.addWordAndCheckComplete(word);
  }

  expect(complete).toBe(true);
  expect(tracker.getAccumulatedUserFacingText()).toBe(text);
});

describe("TestSonioxUpdateSettingsFinalizesOldContext", () => {
  // A mid-reply voice/model/language/speed change re-mints the turn context. The
  // old context's still-pending sentence must be finalized first, or the
  // already-heard prefix's word-timestamps land on no slot and drop from the
  // transcript.

  async function servicePendingPrefix(oldCtx: string) {
    const s = new SonioxTTSService({
      apiKey: "test-key",
      settings: new SonioxTTSService.Settings({
        model: "tts-rt-v2",
        voice: "Adrian",
        language: Language.EN,
        speed: null,
      }),
    });
    const svc = s as any;
    // Applying a settings delta reports the service usable again.
    svc._isUsable = true;
    // Real streaming sequencer with a mid-sentence prefix pending on the turn ctx.
    const seq = new AggregatedFrameSequencer({ name: s.name, streaming: true });
    svc._aggregatedFrameSequencer = seq;
    svc._turnContextId = oldCtx;
    for (const token of ["Hi", " there"]) {
      const frame = new AggregatedTextFrame({
        text: token,
        textType: TextType.SENTENCE,
        rawText: token,
      });
      await seq.registerSpoken(frame, oldCtx, token, true);
    }
    expect((seq as any)._slots).toEqual([]); // nothing promoted: sentence has no boundary yet

    const pushed: Frame[] = [];
    const state: { flushed: string | null } = { flushed: null };
    svc._pushSequencerFrames = async (frames: Frame[], _contextId: string | null) => {
      pushed.push(...frames);
    };
    svc.flushAudio = async (contextId: string | null = null) => {
      state.flushed = contextId;
    };
    svc.audioContextAvailable = (_contextId: string) => true;
    svc.createContextId = () => "ctx-new";
    return { s, svc, seq, pushed, state };
  }

  test("test_voice_change_finalizes_and_rescues_prefix", async () => {
    const oldCtx = "ctx-old";
    const { svc, seq, pushed, state } = await servicePendingPrefix(oldCtx);

    await svc._updateSettings(new SonioxTTSService.Settings({ voice: "Emma" }));

    // The old context's pending sentence was force-promoted into a real slot.
    const slots = (seq as any)._slots;
    expect(slots.map((sl: Dict) => sl.frame.text)).toEqual(["Hi there"]);
    expect(slots[0].contextId).toBe(oldCtx);
    expect(pushed.some((f) => f instanceof AggregatedTextFrame && f.text === "Hi there")).toBe(
      true,
    );
    expect(state.flushed).toBe(oldCtx);
    expect(svc._turnContextId).toBe("ctx-new");

    // A word-timestamp for the flushed prefix (on the OLD context) still finds
    // the promoted slot and emits a progress frame.
    const result = seq.processWord("Hi", 10, oldCtx);
    expect(result.some((f) => f instanceof TTSTextFrame && f.text === "Hi")).toBe(true);
    const progress = result.filter((f) => f instanceof AggregatedTextProgressFrame);
    expect(progress).toHaveLength(1);
    expect((progress[0] as AggregatedTextProgressFrame).accumulatedText).toBe("Hi");
  });

  test("test_speed_change_also_finalizes", async () => {
    // Soniox additionally re-mints on a speed change, so it must finalize too.
    const oldCtx = "ctx-old";
    const { svc, seq } = await servicePendingPrefix(oldCtx);

    await svc._updateSettings(new SonioxTTSService.Settings({ speed: 1.2 }));

    expect((seq as any)._slots.map((sl: Dict) => sl.frame.text)).toEqual(["Hi there"]);
    expect(svc._turnContextId).toBe("ctx-new");
  });
});

class FakeWebsocket {
  state: State = State.OPEN;
  sent: Dict[] = [];

  async send(message: string): Promise<void> {
    this.sent.push(JSON.parse(message));
  }
}

test("test_soniox_run_tts_configures_a_stream_it_has_not_opened", async () => {
  // A stream ID first seen on this connection (e.g. after a reconnect) must
  // be configured before its text, or Soniox rejects it.
  const s = new SonioxTTSService({ apiKey: "test-key" });
  const ws = new FakeWebsocket();
  s._websocket = ws as any;

  for await (const _ of s.runTts("Hello.", "stream-1")) {
    // drain
  }
  for await (const _ of s.runTts("Again.", "stream-1")) {
    // drain
  }

  const sent = ws.sent;
  expect(sent.map((m) => m.stream_id)).toEqual(["stream-1", "stream-1", "stream-1"]);
  expect(sent[0]).not.toHaveProperty("text");
  expect(sent.slice(1).map((m) => m.text)).toEqual(["Hello.", "Again."]);
});

class FakeReceivingWebsocket extends FakeWebsocket {
  _messages: Dict[];

  constructor(messages: Dict[]) {
    super();
    this._messages = messages;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
    for (const message of this._messages) {
      yield JSON.stringify(message);
    }
  }
}

test("test_soniox_error_code_sets_category", async () => {
  const s = new SonioxTTSService({ apiKey: "test-key" });
  const categories: (ErrorCategory | null)[] = [];

  (s as any).pushError = async (_msg: string, options: Dict = {}) => {
    categories.push(options.category ?? null);
  };
  s._websocket = new FakeReceivingWebsocket([
    { error_code: 402, error_type: "organization_balance_exhausted" },
    { error_code: 401, error_type: "unauthorized" },
    { error_code: "oops" },
  ]) as any;

  await s._receiveMessages();

  expect(categories).toEqual([ErrorCategory.QUOTA, ErrorCategory.AUTHENTICATION, null]);
});

test("test_soniox_run_tts_send_failure_yields_error_with_exception", async () => {
  class FailingWebsocket extends FakeWebsocket {
    override async send(_message: string): Promise<void> {
      throw new ConnectionError("socket closed");
    }
  }
  class ConnectionError extends Error {
    override name = "ConnectionError";
  }

  const s = new SonioxTTSService({ apiKey: "test-key" });
  s._websocket = new FailingWebsocket() as any;
  (s as any)._connect = async () => {};
  (s as any)._disconnect = async () => {};

  const frames: Frame[] = [];
  for await (const frame of s.runTts("Hello.", "stream-1")) {
    if (frame !== null) frames.push(frame);
  }

  expect(frames[0]).toBeInstanceOf(ErrorFrame);
  expect((frames[0] as ErrorFrame).exception).toBeInstanceOf(ConnectionError);
  expect(frames[1]).toBeInstanceOf(TTSStoppedFrame);
});

test("test_soniox_run_tts_connect_failure_yields_error_with_exception", async () => {
  const s = new SonioxTTSService({ apiKey: "test-key" });
  s._websocket = null;

  class TimeoutErr extends Error {
    override name = "TimeoutError";
  }
  (s as any)._connect = async () => {
    throw new TimeoutErr("no answer");
  };

  const frames: Frame[] = [];
  for await (const frame of s.runTts("Hello.", "stream-1")) {
    if (frame !== null) frames.push(frame);
  }

  expect(frames).toHaveLength(1);
  expect(frames[0]).toBeInstanceOf(ErrorFrame);
  expect((frames[0] as ErrorFrame).exception).toBeInstanceOf(TimeoutErr);
});

for (const language of [Language.NB, Language.NB_NO]) {
  test(`test_norwegian_bokmal_maps_to_soniox_norwegian[${language}]`, () => {
    expect(languageToSonioxTtsLanguage(language)).toBe("no");
  });
}
