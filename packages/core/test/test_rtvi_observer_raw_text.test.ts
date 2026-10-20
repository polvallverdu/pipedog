// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_raw_text.py

/** Tests for the raw text messages RTVIObserver sends for the STT, LLM and TTS. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AggregatedTextFrame,
  type Frame,
  InterimTranscriptionFrame,
  LLMTextFrame,
  TranscriptionFrame,
  TTSTextFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { RTVIObserver, RTVIObserverParams } from "../src/processors/frameworks/rtvi/observer.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";

const RAW_TEXT_MESSAGES = [RTVI.STTRawTextMessage, RTVI.LLMRawTextMessage, RTVI.TTSRawTextMessage];

// Messages are inspected loosely, as upstream does.
type SentMessage = any;

describe("TestRTVIObserverRawText", () => {
  // The observer's protected state is set directly, as upstream does.
  let observer: any;
  let sendRtviMessage: ReturnType<typeof mock>;
  let transport: BaseOutputTransport;

  beforeEach(() => {
    observer = new RTVIObserver(null, {
      params: new RTVIObserverParams({
        sttRawTextEnabled: true,
        llmRawTextEnabled: true,
        ttsRawTextEnabled: true,
      }),
    });
    sendRtviMessage = mock(async (_m: SentMessage) => {});
    observer.sendRtviMessage = sendRtviMessage;
    // The bot is speaking, so text is sent right away instead of queued.
    observer._botIsSpeaking = true;
    transport = new BaseOutputTransport(new TransportParams());
  });

  async function _push(frame: Frame): Promise<void> {
    await observer.onPushFrame(
      new FramePushed({
        source: transport,
        destination: transport,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
        firstPush: true,
      }),
    );
  }

  async function _pushOneOfEach(): Promise<void> {
    await _push(new TranscriptionFrame({ text: "Hello.", userId: "user", timestamp: "now" }));
    await _push(new LLMTextFrame({ text: "Hi" }));
    const segment = new AggregatedTextFrame({
      text: "Hi there.",
      textType: TextType.SENTENCE,
      contextId: "turn",
    });
    segment.willBeSpoken = true;
    await _push(segment);
    await _push(
      new TTSTextFrame({
        text: "Hi",
        textType: TextType.WORD,
        contextId: "turn",
        segmentId: segment.id,
      }),
    );
  }

  function _sentMessages(): SentMessage[] {
    return sendRtviMessage.mock.calls.map((call) => call[0]);
  }

  function _sentRawText(): SentMessage[] {
    return _sentMessages().filter((m) => RAW_TEXT_MESSAGES.some((cls) => m instanceof cls));
  }

  const typeOf = (m: SentMessage) => m.constructor;

  test("test_raw_text_is_kept_from_the_client_by_default", async () => {
    observer._params = new RTVIObserverParams();
    await _pushOneOfEach();

    expect(_sentRawText()).toEqual([]);
  });

  test("test_a_transcription_is_sent_as_stt_raw_text_before_user_transcription", async () => {
    await _push(new InterimTranscriptionFrame({ text: "Hel", userId: "user", timestamp: "t1" }));
    await _push(new TranscriptionFrame({ text: "Hello.", userId: "user", timestamp: "t2" }));

    const messages = _sentMessages();
    expect(messages.map(typeOf)).toEqual([
      RTVI.UserInputMessage,
      RTVI.STTRawTextMessage,
      RTVI.UserTranscriptionMessage,
      RTVI.UserInputMessage,
      RTVI.STTRawTextMessage,
      RTVI.UserTranscriptionMessage,
    ]);
    expect([messages[1].data, messages[4].data]).toEqual([
      new RTVI.STTRawTextMessageData({
        text: "Hel",
        userId: "user",
        timestamp: "t1",
        final: false,
      }),
      new RTVI.STTRawTextMessageData({
        text: "Hello.",
        userId: "user",
        timestamp: "t2",
        final: true,
      }),
    ]);
  });

  test("test_llm_text_is_sent_as_llm_raw_text_before_bot_llm_text", async () => {
    await _push(new LLMTextFrame({ text: "Hi" }));

    const messages = _sentMessages();
    expect(messages.map(typeOf)).toEqual([RTVI.LLMRawTextMessage, RTVI.BotLLMTextMessage]);
    expect(messages[0].data.text).toEqual("Hi");
  });

  test("test_llm_text_is_only_sent_as_llm_raw_text_without_bot_llm_messages", async () => {
    observer._params.botLlmEnabled = false;
    await _push(new LLMTextFrame({ text: "Hi there." }));

    expect(_sentMessages().map(typeOf)).toEqual([RTVI.LLMRawTextMessage]);
  });

  test("test_spoken_text_is_sent_as_tts_raw_text_before_bot_tts_text", async () => {
    await _pushOneOfEach();

    const ttsMessages = _sentMessages().filter(
      (m) => m instanceof RTVI.TTSRawTextMessage || m instanceof RTVI.BotTTSTextMessage,
    );
    expect(ttsMessages.map(typeOf)).toEqual([RTVI.TTSRawTextMessage, RTVI.BotTTSTextMessage]);
    expect(ttsMessages[0].data.text).toEqual("Hi");
  });

  test("test_spoken_text_is_only_sent_as_tts_raw_text_without_bot_output_or_tts", async () => {
    observer._params.botOutputEnabled = false;
    observer._params.botTtsEnabled = false;
    const segment = new AggregatedTextFrame({
      text: "Hi there.",
      textType: TextType.SENTENCE,
      contextId: "turn",
    });
    segment.willBeSpoken = true;
    await _push(segment);
    await _push(
      new TTSTextFrame({
        text: "Hi",
        textType: TextType.WORD,
        contextId: "turn",
        segmentId: segment.id,
      }),
    );

    expect(_sentMessages().map(typeOf)).toEqual([RTVI.TTSRawTextMessage]);
  });

  test("test_tts_raw_text_leaves_out_skipped_text_types", async () => {
    observer._params.skipTextTypes = ["status"];
    const segment = new AggregatedTextFrame({
      text: "Looking that up.",
      textType: "status",
      contextId: "turn",
    });
    segment.willBeSpoken = true;
    await _push(segment);
    await _push(
      new TTSTextFrame({
        text: "Looking",
        textType: TextType.WORD,
        contextId: "turn",
        segmentId: segment.id,
      }),
    );

    expect(_sentRawText()).toEqual([]);
  });

  test("test_raw_text_is_kept_from_older_clients", async () => {
    for (const version of [
      [2, 1, 0],
      [1, 4, 0],
    ]) {
      // subTest(version=version)
      observer._rtvi = { clientVersion: version };
      await _pushOneOfEach();

      expect(_sentRawText()).toEqual([]);
    }
  });
});

describe("TestRTVIObserverParamsUserTranscription", () => {
  // Skipped: `RTVIObserverParams.user_transcription_enabled` is deprecated upstream
  // and is not ported, so there is no deprecation warning to check.
  test.skip("test_turning_user_transcription_off_is_deprecated", () => {});

  // Skipped: only exercises the deprecated `user_transcription_enabled` parameter,
  // which is not ported.
  test.skip("test_leaving_user_transcription_on_is_not_deprecated", () => {});
});
