// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_pushes.py

/** Tests for which pushes RTVIObserver handles. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSTextFrame,
  UserBackchannelFrame,
  UserStartedSpeakingFrame,
  VADUserStartedSpeakingFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import {
  RTVIConfigureObserverFrame,
  RTVISendTextFrame,
} from "../src/processors/frameworks/rtvi/frames.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { RTVIObserver, RTVIObserverParams } from "../src/processors/frameworks/rtvi/observer.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import { TextType } from "../src/utils/text/base_text_aggregator.ts";

// Messages are inspected loosely, as upstream does.
type SentMessage = any;

const typeOf = (m: SentMessage) => m.constructor;

/** An observer whose `sendRtviMessage` is mocked, as upstream does with AsyncMock. */
function mockedObserver(params: RTVIObserverParams): {
  observer: any;
  send: ReturnType<typeof mock>;
} {
  const observer: any = new RTVIObserver(null, { params });
  const send = mock(async (_m: SentMessage, _excludeNone?: boolean) => {});
  observer.sendRtviMessage = send;
  return { observer, send };
}

describe("TestRTVIObserverPushes", () => {
  // The observer's protected state is accessed directly, as upstream does.
  let observer: any;
  let send: ReturnType<typeof mock>;
  let source: FrameProcessor;

  beforeEach(() => {
    ({ observer, send } = mockedObserver(new RTVIObserverParams()));
    source = new FrameProcessor();
  });

  async function _push(
    frame: Frame,
    {
      firstPush = true,
      source: src = null,
    }: { firstPush?: boolean; source?: FrameProcessor | null } = {},
  ): Promise<void> {
    const s = src ?? source;
    await observer.onPushFrame(
      new FramePushed({
        source: s,
        destination: s,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
        firstPush,
      }),
    );
  }

  function _leftOut(text: string, textType: string = "sentence"): AggregatedTextFrame {
    // Text the TTS left out of speech, marked as it marks it.
    const frame = new AggregatedTextFrame({ text, textType });
    frame.skipTts = true;
    return frame;
  }

  function _sentMessages(): SentMessage[] {
    return send.mock.calls.map((call) => call[0]);
  }

  function _sentOutputData(): SentMessage[] {
    return _sentMessages()
      .filter((m) => m instanceof RTVI.BotOutputMessage)
      .map((m) => m.data);
  }

  function _sentOutputs(): string[] {
    return _sentOutputData().map((data) => data.text);
  }

  function lastSent(): SentMessage {
    return send.mock.calls[send.mock.calls.length - 1]![0];
  }

  const audio = () => new Uint8Array(320);

  test("test_audio_is_skipped_unless_audio_levels_are_reported", async () => {
    await _push(new InputAudioRawFrame({ audio: audio(), sampleRate: 16000, numChannels: 1 }));
    await _push(new TTSAudioRawFrame({ audio: audio(), sampleRate: 16000, numChannels: 1 }));
    expect(send).not.toHaveBeenCalled();

    ({ observer, send } = mockedObserver(
      new RTVIObserverParams({ userAudioLevelEnabled: true, audioLevelPeriodSecs: 0 }),
    ));
    await _push(new InputAudioRawFrame({ audio: audio(), sampleRate: 16000, numChannels: 1 }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("test_a_frame_is_handled_on_its_first_push_only", async () => {
    const frame = new UserStartedSpeakingFrame();

    await _push(frame);
    await _push(frame, { firstPush: false });

    expect(send).toHaveBeenCalledTimes(1);
  });

  test("test_a_frame_disabled_on_its_first_push_is_never_handled", async () => {
    const frame = new VADUserStartedSpeakingFrame();

    await _push(frame);
    observer._applyConfig(new RTVIConfigureObserverFrame({ vadUserSpeakingEnabled: true }));
    await _push(frame, { firstPush: false });

    expect(send).not.toHaveBeenCalled();
  });

  test("test_aggregated_text_is_handled_once_it_has_gone_through_the_transport", async () => {
    const frame = new AggregatedTextFrame({ text: "hello", textType: "sentence" });
    frame.willBeSpoken = true;
    const transport = new BaseOutputTransport(new TransportParams());

    await _push(frame);
    expect(observer._queuedAggregatedTextFrames).toEqual([]);

    await _push(frame, { firstPush: false, source: transport });
    expect(observer._queuedAggregatedTextFrames).toEqual([frame]);
  });

  test("test_text_the_tts_left_out_is_sent_without_waiting_for_the_bot_to_speak", async () => {
    const transport = new BaseOutputTransport(new TransportParams());

    await _push(_leftOut("Hello there."), { source: transport });

    expect(_sentOutputs()).toEqual(["Hello there."]);
  });

  test("test_text_the_tts_left_out_waits_behind_text_queued_before_it", async () => {
    const transport = new BaseOutputTransport(new TransportParams());
    const spoken = new AggregatedTextFrame({ text: "Here it is.", textType: "sentence" });
    spoken.willBeSpoken = true;

    await _push(spoken, { source: transport });
    await _push(_leftOut("print(1)", "code"), { source: transport });
    expect(_sentOutputs()).toEqual([]);

    await _push(new BotStartedSpeakingFrame());
    expect(_sentOutputs()).toEqual(["Here it is.", "print(1)"]);
  });

  test("test_a_transcript_spoken_without_a_tts_service_waits_for_the_bot_to_speak", async () => {
    const transport = new BaseOutputTransport(new TransportParams());
    const cutOff = new TTSTextFrame({ text: "Let me check.", textType: TextType.SENTENCE });
    const transcript = new TTSTextFrame({ text: "Here it is.", textType: TextType.SENTENCE });

    await _push(cutOff, { source: transport });
    await _push(new InterruptionFrame());
    await _push(transcript, { source: transport });
    expect(_sentOutputs()).toEqual([]);

    await _push(new BotStartedSpeakingFrame());
    expect(_sentOutputs()).toEqual(["Here it is."]);
  });

  test("test_an_interruption_drops_queued_text_whose_speech_it_cut_off", async () => {
    const transport = new BaseOutputTransport(new TransportParams());
    const spoken = new AggregatedTextFrame({ text: "Let me check.", textType: "sentence" });
    spoken.willBeSpoken = true;

    await _push(spoken, { source: transport });
    await _push(new InterruptionFrame());
    await _push(_leftOut("Here it is."), { source: transport });
    await _push(new BotStartedSpeakingFrame());

    expect(_sentOutputs()).toEqual(["Here it is."]);
  });

  test("test_an_interruption_keeps_queued_text_whose_speech_it_cant_cut_off", async () => {
    const transport = new BaseOutputTransport(new TransportParams());
    const spoken = new AggregatedTextFrame({ text: "Please hold.", textType: "sentence" });
    spoken.willBeSpoken = true;
    spoken.interruptible = false;

    await _push(spoken, { source: transport });
    await _push(new InterruptionFrame());
    expect(_sentOutputs()).toEqual([]);

    await _push(new BotStartedSpeakingFrame());
    expect(_sentOutputs()).toEqual(["Please hold."]);
  });

  test("test_bot_output_follows_the_speech_without_speaking_messages", async () => {
    ({ observer, send } = mockedObserver(new RTVIObserverParams({ botSpeakingEnabled: false })));
    const transport = new BaseOutputTransport(new TransportParams());
    const cutOff = new AggregatedTextFrame({ text: "Let me check.", textType: "sentence" });
    cutOff.willBeSpoken = true;
    const spoken = new AggregatedTextFrame({ text: "Here it is.", textType: "sentence" });
    spoken.willBeSpoken = true;

    await _push(cutOff, { source: transport });
    await _push(new InterruptionFrame());
    await _push(spoken, { source: transport });
    expect(_sentOutputs()).toEqual([]);

    await _push(new BotStartedSpeakingFrame());
    await _push(new BotStoppedSpeakingFrame());
    expect(_sentOutputs()).toEqual(["Here it is."]);
    expect(_sentMessages().map(typeOf)).toEqual([RTVI.BotOutputMessage]);
  });

  test("test_text_that_isnt_spoken_starts_a_segment", async () => {
    const transport = new BaseOutputTransport(new TransportParams());
    const sentence = new AggregatedTextFrame({ text: "Hello there.", textType: "sentence" });
    sentence.skipTts = true;
    const code = new AggregatedTextFrame({ text: "print(1)", textType: "code" });
    const transcript = new TTSTextFrame({ text: "Here it is.", textType: TextType.SENTENCE });

    await _push(new BotStartedSpeakingFrame());
    for (const frame of [sentence, code, transcript]) {
      await _push(frame, { source: transport });
    }

    expect(_sentOutputData().map((d) => [d.text, d.spokenStatus, d.spokenProgress])).toEqual([
      ["Hello there.", "new", null],
      ["print(1)", "new", null],
      ["Here it is.", "new", null],
    ]);
  });

  test("test_a_user_backchannel_is_sent_as_user_input", async () => {
    await _push(new UserBackchannelFrame({ text: "mhm", userId: "user", timestamp: "now" }));

    const message = lastSent();
    expect(message).toBeInstanceOf(RTVI.UserInputMessage);
    expect(message.data).toEqual(
      new RTVI.UserInputMessageData({
        text: "mhm",
        inputType: "backchannel",
        userId: "user",
        timestamp: "now",
        final: true,
      }),
    );
  });

  test("test_a_transcription_is_sent_as_user_input_then_user_transcription", async () => {
    await _push(new InterimTranscriptionFrame({ text: "Hel", userId: "user", timestamp: "t1" }));
    await _push(new TranscriptionFrame({ text: "Hello.", userId: "user", timestamp: "t2" }));

    const messages = _sentMessages();
    expect(messages.map(typeOf)).toEqual([
      RTVI.UserInputMessage,
      RTVI.UserTranscriptionMessage,
      RTVI.UserInputMessage,
      RTVI.UserTranscriptionMessage,
    ]);
    expect([messages[0].data, messages[2].data]).toEqual([
      new RTVI.UserInputMessageData({
        text: "Hel",
        inputType: "transcription",
        userId: "user",
        timestamp: "t1",
        final: false,
      }),
      new RTVI.UserInputMessageData({
        text: "Hello.",
        inputType: "transcription",
        userId: "user",
        timestamp: "t2",
        final: true,
      }),
    ]);
  });

  // Skipped: exercises only `RTVIObserverParams.user_transcription_enabled`, deprecated
  // upstream since 1.13.0 and therefore not ported (see observer.ts header).
  test.skip("test_a_transcription_is_only_sent_as_user_input_without_user_transcription", async () => {
    observer._params.userTranscriptionEnabled = false;
    await _push(new TranscriptionFrame({ text: "Hello.", userId: "user", timestamp: "now" }));

    expect(_sentMessages().map(typeOf)).toEqual([RTVI.UserInputMessage]);
  });

  test("test_text_from_the_client_is_acknowledged_as_user_input", async () => {
    await _push(new RTVISendTextFrame({ msgId: "msg-1", text: "Hello." }));

    const message = lastSent();
    expect(message).toBeInstanceOf(RTVI.UserInputMessage);
    expect([message.data.text, message.data.inputType, message.data.final]).toEqual([
      "Hello.",
      "chat",
      true,
    ]);
    expect([message.data.msgId, message.data.userId]).toEqual(["msg-1", null]);
    expect(message.modelDump({ excludeNone: true }).data).not.toHaveProperty("user_id");
  });

  test("test_text_from_a_known_sender_is_acknowledged_with_their_id", async () => {
    await _push(new RTVISendTextFrame({ msgId: "msg-1", text: "Hello.", userId: "user" }));

    const message = lastSent();
    expect([message.data.msgId, message.data.userId]).toEqual(["msg-1", "user"]);
  });

  test("test_user_input_is_kept_from_the_client_when_disabled", async () => {
    observer._params.userInputEnabled = false;
    await _push(new TranscriptionFrame({ text: "Hello.", userId: "user", timestamp: "now" }));
    await _push(new UserBackchannelFrame({ text: "mhm", userId: "user", timestamp: "now" }));
    await _push(new RTVISendTextFrame({ msgId: "msg-1", text: "Hello." }));

    expect(_sentMessages().map(typeOf)).toEqual([RTVI.UserTranscriptionMessage]);
  });
});

describe("TestRTVIObserverSegments", () => {
  let observer: any;
  let send: ReturnType<typeof mock>;
  let transport: BaseOutputTransport;

  beforeEach(() => {
    ({ observer, send } = mockedObserver(new RTVIObserverParams({ skipTextTypes: ["status"] })));
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

  function _segment(text: string, textType: string): AggregatedTextFrame {
    // All the segments of one LLM response share a TTS context.
    const segment = new AggregatedTextFrame({ text, textType, contextId: "turn" });
    segment.willBeSpoken = true;
    return segment;
  }

  function _word(text: string, segment: AggregatedTextFrame): TTSTextFrame {
    return new TTSTextFrame({
      text,
      textType: TextType.WORD,
      contextId: "turn",
      segmentId: segment.id,
    });
  }

  function _progress(
    segment: AggregatedTextFrame,
    accumulatedText: string,
    remainingText: string,
  ): AggregatedTextProgressFrame {
    return new AggregatedTextProgressFrame({
      segmentId: segment.id,
      contextId: "turn",
      text: segment.text,
      textType: segment.textType,
      accumulatedText,
      remainingText,
    });
  }

  function _sentMessages(): SentMessage[] {
    return send.mock.calls.map((call) => call[0]);
  }

  function _sentTexts(): string[] {
    return _sentMessages()
      .filter((m) => m?.data != null && typeof m.data === "object" && "text" in m.data)
      .map((m) => m.data.text);
  }

  function _sentOutputs(): SentMessage[] {
    return _sentMessages()
      .filter((m) => m instanceof RTVI.BotOutputMessage)
      .map((m) => m.data);
  }

  test("test_a_segment_spoken_in_one_piece_completes_as_that_segment", async () => {
    const sentence = _segment("That sounds fun.", TextType.SENTENCE);
    const spoken = new TTSTextFrame({
      text: sentence.text,
      textType: TextType.SENTENCE,
      segmentId: sentence.id,
    });
    spoken.willBeSpoken = true;
    await _push(sentence);
    await _push(spoken);

    expect(_sentOutputs().map((data) => [data.spokenStatus, data.segmentId])).toEqual([
      ["new", sentence.id],
      ["completed", sentence.id],
    ]);
  });

  test("test_a_skipped_segment_keeps_its_progress_and_words_from_the_client", async () => {
    const status = _segment("One moment, please.", "status");
    await _push(status);
    await _push(_word("One", status));
    await _push(_progress(status, "One", " moment, please."));

    expect(send).not.toHaveBeenCalled();
  });

  test("test_a_segment_after_a_skipped_one_is_sent", async () => {
    const status = _segment("One moment, please.", "status");
    const sentence = _segment("That sounds fun.", TextType.SENTENCE);
    await _push(status);
    await _push(_word("One", status));
    await _push(sentence);
    await _push(_word("That", sentence));

    expect(_sentTexts()).toEqual(["That sounds fun.", "That"]);
  });

  test("test_words_follow_their_segment_when_the_segments_come_first", async () => {
    // A turn's segments can all arrive before the first one is spoken.
    const status = _segment("One moment, please.", "status");
    const sentence = _segment("That sounds fun.", TextType.SENTENCE);
    await _push(status);
    await _push(sentence);
    await _push(_word("One", status));
    await _push(_word("That", sentence));

    expect(_sentTexts()).toEqual(["That sounds fun.", "That"]);
  });

  test("test_a_skipped_segment_is_forgotten_once_spoken", async () => {
    const status = _segment("One moment, please.", "status");
    await _push(status);
    await _push(_progress(status, "One moment, please.", ""));

    expect(observer._skippedSegmentIds).toEqual(new Set());
  });

  test("test_a_skipped_segment_cut_off_is_forgotten_when_the_bot_stops", async () => {
    const status = _segment("One moment, please.", "status");
    await _push(status);
    await _push(new InterruptionFrame());
    // A word the output transport pushed before it handled the interruption.
    await _push(_word("One", status));
    await _push(new BotStoppedSpeakingFrame());

    expect(_sentTexts()).not.toContain("One");
    expect(observer._skippedSegmentIds).toEqual(new Set());
  });

  test("test_a_skipped_segment_cut_off_in_a_pause_is_forgotten_when_the_bot_speaks", async () => {
    const status = _segment("One moment, please.", "status");
    await _push(status);
    await _push(new BotStoppedSpeakingFrame());
    expect(observer._skippedSegmentIds).toEqual(new Set([status.id]));

    await _push(new InterruptionFrame());
    await _push(new BotStartedSpeakingFrame());
    expect(observer._skippedSegmentIds).toEqual(new Set());
  });

  test("test_a_skipped_segment_spoken_in_one_piece_is_forgotten", async () => {
    const status = _segment("One moment, please.", "status");
    await _push(status);
    await _push(new TTSTextFrame({ text: status.text, textType: "status", segmentId: status.id }));

    expect(send).not.toHaveBeenCalled();
    expect(observer._skippedSegmentIds).toEqual(new Set());
  });

  function _connectClient(version: number[]): void {
    observer._rtvi = { clientVersion: version };
  }

  test("test_a_backchannel_is_sent_as_output_and_tts_text", async () => {
    const backchannel = _segment("Mm-hmm, go on.", TextType.BACKCHANNEL);
    await _push(backchannel);
    await _push(_word("Mm-hmm,", backchannel));
    await _push(_progress(backchannel, "Mm-hmm,", " go on."));

    const messages = _sentMessages();
    expect(messages.map(typeOf)).toEqual([
      RTVI.BotOutputMessage,
      RTVI.BotTTSTextMessage,
      RTVI.BotOutputMessage,
    ]);
    expect(_sentOutputs().map((data) => [data.textType, data.spokenStatus])).toEqual([
      [TextType.BACKCHANNEL, "new"],
      [TextType.BACKCHANNEL, "in-progress"],
    ]);
    expect(messages[1].data.text).toEqual("Mm-hmm,");
  });

  test("test_a_backchannel_spoken_in_one_piece_is_sent_as_output_and_tts_text", async () => {
    const backchannel = _segment("Mm-hmm.", TextType.BACKCHANNEL);
    const spoken = new TTSTextFrame({
      text: backchannel.text,
      textType: TextType.BACKCHANNEL,
      segmentId: backchannel.id,
    });
    spoken.willBeSpoken = true;
    await _push(backchannel);
    await _push(spoken);

    expect(_sentMessages().map(typeOf)).toEqual([
      RTVI.BotOutputMessage,
      RTVI.BotOutputMessage,
      RTVI.BotTTSTextMessage,
    ]);
    expect(_sentOutputs().map((data) => data.spokenStatus)).toEqual(["new", "completed"]);
  });

  test("test_a_backchannel_is_kept_from_older_clients", async () => {
    for (const version of [
      [2, 1, 0],
      [1, 4, 0],
    ]) {
      // subTest(version=version)
      _connectClient(version);
      const backchannel = _segment("Mm-hmm, go on.", TextType.BACKCHANNEL);
      await _push(backchannel);
      await _push(_word("Mm-hmm,", backchannel));
      await _push(_progress(backchannel, "Mm-hmm,", " go on."));
      await _push(_progress(backchannel, "Mm-hmm, go on.", ""));

      expect(send).not.toHaveBeenCalled();
      expect(observer._skippedSegmentIds).toEqual(new Set());
    }
  });

  test("test_a_backchannel_spoken_in_one_piece_is_kept_from_older_clients", async () => {
    _connectClient([2, 1, 0]);
    const backchannel = _segment("Mm-hmm.", TextType.BACKCHANNEL);
    const spoken = new TTSTextFrame({
      text: backchannel.text,
      textType: TextType.BACKCHANNEL,
      segmentId: backchannel.id,
    });
    spoken.willBeSpoken = true;
    await _push(backchannel);
    await _push(spoken);

    expect(send).not.toHaveBeenCalled();
    expect(observer._skippedSegmentIds).toEqual(new Set());
  });

  test("test_a_segment_after_a_backchannel_is_sent_to_older_clients", async () => {
    _connectClient([2, 1, 0]);
    const backchannel = _segment("Mm-hmm.", TextType.BACKCHANNEL);
    const sentence = _segment("That sounds fun.", TextType.SENTENCE);
    await _push(backchannel);
    await _push(_word("Mm-hmm.", backchannel));
    await _push(sentence);
    await _push(_word("That", sentence));

    expect(_sentTexts()).toEqual(["That sounds fun.", "That"]);
  });

  test("test_a_backchannel_is_kept_from_the_client_when_skipped", async () => {
    observer._params.skipTextTypes = ["status", TextType.BACKCHANNEL];
    const backchannel = _segment("Mm-hmm.", TextType.BACKCHANNEL);
    await _push(backchannel);
    await _push(_word("Mm-hmm.", backchannel));

    expect(send).not.toHaveBeenCalled();
  });
});
