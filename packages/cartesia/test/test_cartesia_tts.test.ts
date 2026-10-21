// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_cartesia_tts.py

import { describe, expect, test } from "bun:test";

import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  type Frame,
  TextType,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { TTSSettings } from "@pipedog/core/services/settings";
import { Language } from "@pipedog/core/transcriptions/language";
import { AggregatedFrameSequencer } from "@pipedog/core/utils/context/aggregated_frame_sequencer";
import { WordCompletionTracker } from "@pipedog/core/utils/context/word_completion_tracker";
import { concatenateAggregatedText, TextPartForConcatenation } from "@pipedog/core/utils/string";

import { CartesiaTTSService } from "../src/tts.ts";

// Python's `CartesiaTTSService.__new__(CartesiaTTSService)`: an instance whose
// constructor never ran, so the tests reach the protected members directly.
type AnyService = any;

function _service(language: string): AnyService {
  const service: AnyService = Object.create(CartesiaTTSService.prototype);
  service._settings = new TTSSettings({ language });
  return service;
}

function _processWordTimestamps(
  words: string[],
  starts: number[],
  language: string,
): [string, number][] {
  return _service(language)._normalizeWordTimestamps(words, starts);
}

function _concatenateProcessedTimestamps(
  timestampGroups: [string[], number[]][],
  language: string,
): string {
  const service = _service(language);
  const textParts: TextPartForConcatenation[] = [];
  for (const [words, starts] of timestampGroups) {
    const processedTimestamps: [string, number][] = service._normalizeWordTimestamps(words, starts);
    const includesInterFrameSpaces: boolean = service._wordTimestampsIncludeInterFrameSpaces();
    textParts.push(
      ...processedTimestamps.map(
        ([word, _timestamp]) =>
          new TextPartForConcatenation({
            text: word,
            includesInterPartSpaces: includesInterFrameSpaces,
          }),
      ),
    );
  }
  return concatenateAggregatedText(textParts);
}

test("test_cartesia_chinese_word_timestamps_keep_one_entry_per_character", () => {
  expect(_processWordTimestamps(["你", "好", "。"], [0.0, 0.1, 0.2], "zh")).toEqual([
    ["你", 0.0],
    ["好", 0.1],
    ["。", 0.2],
  ]);
});

test("test_cartesia_japanese_word_timestamps_keep_one_entry_per_character", () => {
  expect(
    _processWordTimestamps(
      ["こ", "ん", "に", "ち", "は", "。"],
      [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
      "ja",
    ),
  ).toEqual([
    ["こ", 0.0],
    ["ん", 0.1],
    ["に", 0.2],
    ["ち", 0.3],
    ["は", 0.4],
    ["。", 0.5],
  ]);
});

test("test_cartesia_korean_word_timestamps_preserve_words_and_timestamps", () => {
  expect(_processWordTimestamps(["안녕하세요", "반갑습니다"], [0.0, 0.2], "ko")).toEqual([
    ["안녕하세요", 0.0],
    ["반갑습니다", 0.2],
  ]);
});

test("test_cartesia_korean_word_timestamps_do_not_join_latin_and_hangul", () => {
  expect(_processWordTimestamps(["AI", "어시스턴트입니다."], [3.7026982, 4.1999383], "ko")).toEqual(
    [
      ["AI", 3.7026982],
      ["어시스턴트입니다.", 4.1999383],
    ],
  );
});

test("test_cartesia_japanese_timestamp_groups_reassemble_without_spaces", () => {
  expect(
    _concatenateProcessedTimestamps(
      [
        [
          ["こ", "ん", "に", "ち", "は", "、", "私"],
          [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        ],
        [
          ["は", "あ", "な", "た", "の"],
          [1.0, 1.1, 1.2, 1.3, 1.4],
        ],
      ],
      "ja",
    ),
  ).toEqual("こんにちは、私はあなたの");
});

test("test_cartesia_chinese_timestamp_groups_reassemble_without_spaces", () => {
  expect(
    _concatenateProcessedTimestamps(
      [
        [
          ["你", "好", "，", "我", "是"],
          [0.1, 0.2, 0.3, 0.4, 0.5],
        ],
        [
          ["你", "的", "智", "能"],
          [1.0, 1.1, 1.2, 1.3],
        ],
      ],
      "zh",
    ),
  ).toEqual("你好，我是你的智能");
});

test("test_cartesia_korean_timestamp_groups_reassemble_with_spaces", () => {
  expect(
    _concatenateProcessedTimestamps(
      [
        [["저는"], [1.6]],
        [["여러분의"], [1.8]],
        [
          ["AI", "어시스턴트입니다."],
          [3.7, 4.2],
        ],
      ],
      "ko",
    ),
  ).toEqual("저는 여러분의 AI 어시스턴트입니다.");
});

test("test_cartesia_spell_tag_keeps_its_word_attached_to_following_punctuation", () => {
  expect(_processWordTimestamps(["<spell>1234</spell>."], [0.0], "en")).toEqual([["1234.", 0.0]]);
});

test("test_cartesia_tag_between_two_words_keeps_them_separated", () => {
  expect(_processWordTimestamps(["to<spell>1234</spell>"], [0.0], "en")).toEqual([
    ["to 1234", 0.0],
  ]);
});

test("test_cartesia_tag_only_token_is_dropped", () => {
  expect(_processWordTimestamps(['<break time="80ms"/>'], [0.0], "en")).toEqual([]);
});

/**
 * Every normalized token has to be recognised by the word tracker.
 *
 * A token the tracker cannot place force-completes the slot, which emits all the
 * text left unspoken — synthesis tags included — as one TTSTextFrame, ending the
 * turn's word-level tracking.
 */
test("test_cartesia_spell_token_matches_the_text_sent_for_synthesis", () => {
  const text = "Hello, I love to <spell>1234</spell>.";
  const tracker = new WordCompletionTracker(text, { llmText: text, userFacingText: text });

  for (const [word] of _processWordTimestamps(
    ["Hello,", "I", "love", "to", "<spell>1234</spell>."],
    [0.0, 0.1, 0.2, 0.3, 0.4],
    "en",
  )) {
    expect(tracker.wordBelongsHere(word), `${JSON.stringify(word)} was not recognised`).toBe(true);
    tracker.addWordAndCheckComplete(word);
  }

  expect(tracker.isComplete).toBeTruthy();
  expect(tracker.getAccumulatedUserFacingText()).toEqual(text);
});

/**
 * A mid-reply voice/model/language change re-mints the turn context. The old
 * context's still-pending sentence must be finalized first, or the already-heard
 * prefix's word-timestamps land on no slot and drop out of the transcript.
 */
describe("TestCartesiaUpdateSettingsFinalizesOldContext", () => {
  async function _serviceWithPendingPrefix(
    oldCtx: string,
  ): Promise<[AnyService, AnyService, Frame[]]> {
    const service: AnyService = Object.create(CartesiaTTSService.prototype);
    service._name = "CartesiaTTSService#0";
    service._settings = new CartesiaTTSService.Settings({
      model: "sonic-3.5",
      voice: "voiceA",
      language: Language.EN,
      generationConfig: null,
      pronunciationDictId: null,
    });
    // Applying a settings delta reports the service usable again.
    service._isUsable = true;
    // Real streaming sequencer with a mid-sentence prefix pending on the turn ctx.
    const seq: AnyService = new AggregatedFrameSequencer({ name: service._name, streaming: true });
    service._aggregatedFrameSequencer = seq;
    service._turnContextId = oldCtx;
    for (const token of ["Hi", " there"]) {
      const frame = new AggregatedTextFrame({
        text: token,
        textType: TextType.SENTENCE,
        rawText: token,
      });
      await seq.registerSpoken(frame, oldCtx, token, true);
    }
    expect(seq._slots).toEqual([]); // nothing promoted — sentence has no boundary yet

    // Stub I/O so _updateSettings exercises the finalize/flush/re-mint logic
    // without a websocket. Capture frames the finalize pushes.
    const pushed: Frame[] = [];

    const fakePush = async (frames: Frame[], _contextId: string) => {
      pushed.push(...frames);
    };

    const fakeFlush = async (contextId: string | null = null) => {
      service._flushed = contextId;
    };

    service._flushed = null;
    service._pushSequencerFrames = fakePush;
    service.flushAudio = fakeFlush;
    service.audioContextAvailable = (_contextId: string) => true;
    service.createContextId = () => "ctx-new";
    return [service, seq, pushed];
  }

  test("test_voice_change_finalizes_and_rescues_prefix", async () => {
    const oldCtx = "ctx-old";
    const [service, seq, pushed] = await _serviceWithPendingPrefix(oldCtx);

    await service._updateSettings(new CartesiaTTSService.Settings({ voice: "voiceB" }));

    // The old context's pending sentence was force-promoted into a real slot.
    expect(seq._slots.map((s: AnyService) => s.frame.text)).toEqual(["Hi there"]);
    expect(seq._slots[0].contextId).toEqual(oldCtx);
    // The finalize pushed the promoted sentence anchor downstream.
    expect(pushed.some((f) => f instanceof AggregatedTextFrame && f.text === "Hi there")).toBe(
      true,
    );
    // The context was flushed and the turn context re-minted afterwards.
    expect(service._flushed).toEqual(oldCtx);
    expect(service._turnContextId).toEqual("ctx-new");

    // A word-timestamp for the flushed prefix (arriving on the OLD context during
    // playout) still finds the promoted slot and emits a progress frame.
    const result: Frame[] = seq.processWord("Hi", 10, oldCtx);
    expect(result.some((f) => f instanceof TTSTextFrame && f.text === "Hi")).toBe(true);
    const progress = result.filter((f) => f instanceof AggregatedTextProgressFrame);
    expect(progress.length).toEqual(1);
    expect((progress[0] as AggregatedTextProgressFrame).accumulatedText).toEqual("Hi");
  });

  test("test_non_remint_change_does_not_finalize", async () => {
    // A change that does not re-mint the context (e.g. pronunciation_dict_id)
    // must NOT finalize — that would prematurely promote and mis-segment the
    // ongoing reply.
    const oldCtx = "ctx-old";
    const [service, seq, pushed] = await _serviceWithPendingPrefix(oldCtx);

    await service._updateSettings(
      new CartesiaTTSService.Settings({ pronunciationDictId: "dict-1" }),
    );

    expect(seq._slots).toEqual([]); // still pending, not promoted
    expect(pushed).toEqual([]);
    expect(service._flushed).toBeNull();
    expect(service._turnContextId).toEqual(oldCtx);
  });
});
