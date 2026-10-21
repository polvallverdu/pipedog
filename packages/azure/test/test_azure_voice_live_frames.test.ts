// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_frames.py

/**
 * Tests for frame emission in AzureVoiceLiveLLMService.
 *
 * These tests drive the service's receive task handler with scripted Voice
 * Live server events and assert on the frames pushed downstream, using the
 * event names and payload shapes the live service sends.
 */

import { expect, test } from "bun:test";

import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import {
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  SpeechControlParamsFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import * as events from "../src/voice_live/events.ts";
import { AzureVoiceLiveLLMService } from "../src/voice_live/llm.ts";

// The protected members these tests reach into, as upstream does.
type Internals = any;
type Dict = Record<string, unknown>;
type FrameClass = abstract new (...args: any[]) => Frame;

const RESPONSE_ID = "resp_1";
const ITEM_ID = "msg_1";

/** Construct a service with no real connection. The constructor does no I/O. */
function _makeService(): Internals {
  return new AzureVoiceLiveLLMService({
    apiKey: "test-key",
    endpoint: "https://my-resource.services.ai.azure.com",
  });
}

function _sessionService(session: events.SessionProperties): Internals {
  return new AzureVoiceLiveLLMService({
    apiKey: "test-key",
    endpoint: "https://my-resource.services.ai.azure.com",
    settings: new AzureVoiceLiveLLMService.Settings({ sessionProperties: session }),
  });
}

/** Minimal async-iterable websocket that yields scripted JSON strings. */
class _FakeWebSocket {
  private readonly _messages: string[];

  constructor(messages: string[]) {
    this._messages = [...messages];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (this._messages.length > 0) {
      yield this._messages.shift()!;
    }
  }
}

/** Records frames passed to a service's `pushFrame`. */
class _FrameRecorder {
  frames: Frame[] = [];

  readonly call = async (frame: Frame): Promise<void> => {
    this.frames.push(frame);
  };

  ofTypes(...types: FrameClass[]): Frame[] {
    return this.frames.filter((f) => types.some((t) => f instanceof t));
  }
}

function _record(service: Internals): _FrameRecorder {
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;
  return recorder;
}

/** Records frame types broadcast via `broadcastFrame`. */
class _BroadcastRecorder {
  types: unknown[] = [];

  readonly call = async (frameType: unknown): Promise<void> => {
    this.types.push(frameType);
  };
}

/** Stand-in for `pushError`, which needs a linked processor. */
async function _noopError(..._args: unknown[]): Promise<void> {}

/** Feed scripted server-event dicts through the receive handler. */
async function _drive(service: Internals, scripted: Dict[]): Promise<void> {
  service._websocket = new _FakeWebSocket(scripted.map((e) => pyJsonDumps(e)));
  await service._receiveTaskHandler();
}

function _audioDelta(payload: Uint8Array = new Uint8Array([0, 1, 2, 3])): Dict {
  return {
    type: "response.audio.delta",
    event_id: "event_audio",
    response_id: RESPONSE_ID,
    item_id: ITEM_ID,
    output_index: 0,
    content_index: 0,
    delta: bytesToBase64(payload),
  };
}

function _audioDone(): Dict {
  return {
    type: "response.audio.done",
    event_id: "event_audio_done",
    response_id: RESPONSE_ID,
    item_id: ITEM_ID,
    output_index: 0,
    content_index: 0,
  };
}

function _responseDone(status = "completed"): Dict {
  return {
    type: "response.done",
    event_id: "event_done",
    response: {
      object: "realtime.response",
      id: RESPONSE_ID,
      status,
      status_details: null,
      output: [],
      usage: { total_tokens: 10, input_tokens: 4, output_tokens: 6 },
    },
  };
}

function _assistantItem(): Dict {
  return {
    id: ITEM_ID,
    object: "realtime.item",
    type: "message",
    status: "incomplete",
    role: "assistant",
    content: [],
  };
}

function _outputItemAdded(eventId = "e1"): Dict {
  return {
    type: "response.output_item.added",
    event_id: eventId,
    response_id: RESPONSE_ID,
    output_index: 0,
    item: _assistantItem(),
  };
}

function _recordSent(service: Internals): events.ClientEvent[] {
  const sent: events.ClientEvent[] = [];
  service.sendClientEvent = async (event: events.ClientEvent) => {
    sent.push(event);
  };
  return sent;
}

function _kinds(sent: events.ClientEvent[]): string[] {
  return sent.map((e) => e.constructor.name);
}

test("test_audio_deltas_are_bracketed_by_tts_frames", async () => {
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [_audioDelta(), _audioDelta(), _audioDone(), _responseDone()]);

  const started = recorder.ofTypes(TTSStartedFrame);
  const stopped = recorder.ofTypes(TTSStoppedFrame);
  const audio = recorder.ofTypes(TTSAudioRawFrame);

  expect(started.length).toBe(1);
  expect(stopped.length).toBe(1);
  expect(audio.length).toBe(2);

  const startedIdx = recorder.frames.indexOf(started[0]!);
  const stoppedIdx = recorder.frames.indexOf(stopped[0]!);
  expect(
    audio.every((f) => {
      const idx = recorder.frames.indexOf(f);
      return startedIdx < idx && idx < stoppedIdx;
    }),
  ).toBe(true);
});

test("test_a_second_audio_item_stays_in_the_open_tts_turn", async () => {
  // A new item that starts before the previous one reports done opens no second turn.
  const service = _makeService();
  const recorder = _record(service);

  const secondItem = { ..._audioDelta(), item_id: "msg_2" };
  await _drive(service, [
    _audioDelta(),
    secondItem,
    { ..._audioDone(), item_id: "msg_2" },
    _responseDone(),
  ]);

  expect(recorder.ofTypes(TTSStartedFrame).length).toBe(1);
  expect(recorder.ofTypes(TTSStoppedFrame).length).toBe(1);
  expect(service._currentAudioResponse.itemId).toBe("msg_2");
});

test("test_audio_items_in_one_response_share_one_tts_turn", async () => {
  // An item that starts after the previous one reports done opens no second turn.
  const service = _makeService();
  const recorder = _record(service);

  const secondItem = { ..._audioDelta(), item_id: "msg_2" };
  await _drive(service, [
    _audioDelta(),
    _audioDone(),
    secondItem,
    { ..._audioDone(), item_id: "msg_2" },
    _responseDone(),
  ]);

  expect(recorder.ofTypes(TTSStartedFrame, TTSStoppedFrame).map((f) => f.constructor)).toEqual([
    TTSStartedFrame,
    TTSStoppedFrame,
  ]);
  const stoppedIdx = recorder.frames.indexOf(recorder.ofTypes(TTSStoppedFrame)[0]!);
  expect(
    recorder.ofTypes(TTSAudioRawFrame).every((f) => recorder.frames.indexOf(f) < stoppedIdx),
  ).toBe(true);
});

test("test_audio_frames_carry_the_configured_output_rate", async () => {
  const service = _makeService();
  service._ensureAudioConfig(16000, 16000);
  const recorder = _record(service);

  await _drive(service, [_audioDelta()]);

  const audio = recorder.ofTypes(TTSAudioRawFrame) as TTSAudioRawFrame[];
  expect(audio[0]!.sampleRate).toBe(16000);
  expect(audio[0]!.numChannels).toBe(1);
});

test("test_assistant_item_opens_and_response_done_closes_the_llm_response", async () => {
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [_outputItemAdded("event_item"), _responseDone()]);

  expect(recorder.ofTypes(LLMFullResponseStartFrame).length).toBe(1);
  expect(recorder.ofTypes(LLMFullResponseEndFrame).length).toBe(1);
});

test.each([
  ["audio", ["text", "audio"] as events.Modality[], true],
  ["text-only", ["text"] as events.Modality[], false],
])(
  "test_an_interruption_reports_a_tts_stop_only_when_one_started[%s]",
  async (_id, modalities, expectTtsStop) => {
    // A text-only session never opens a TTS turn, so it has no stop to report.
    const service = _sessionService(new events.SessionProperties({ modalities }));
    const recorder = _record(service);
    _recordSent(service);

    const script: Dict[] = [_outputItemAdded()];
    if (expectTtsStop) {
      script.push(_audioDelta());
    }
    await _drive(service, script);
    recorder.frames.length = 0;

    await service._handleInterruption();

    expect(recorder.ofTypes(TTSStoppedFrame).length > 0).toBe(expectTtsStop);
    expect(recorder.ofTypes(LLMFullResponseEndFrame).length).toBe(1);
  },
);

test.each([
  ["mid-audio", false],
  ["after-audio-done", true],
])(
  "test_a_server_vad_interruption_closes_the_tts_turn_exactly_once[%s]",
  async (_id, audioDoneFirst) => {
    // speech_started truncates, and so clears the audio tracking, before the interruption.
    const service = _makeService();
    const recorder = _record(service);
    service.broadcastFrame = new _BroadcastRecorder().call;
    _recordSent(service);

    const script: Dict[] = [_outputItemAdded(), _audioDelta()];
    if (audioDoneFirst) {
      script.push(_audioDone());
    }
    script.push({ type: "input_audio_buffer.speech_started", event_id: "e2" });
    await _drive(service, script);

    await service._handleInterruption();

    expect(recorder.ofTypes(TTSStartedFrame).length).toBe(1);
    expect(recorder.ofTypes(TTSStoppedFrame).length).toBe(1);
  },
);

test.each([
  ["server-vad", false],
  ["manual", true],
])(
  "test_an_interruption_cancels_the_response_and_drops_what_it_still_streams[%s]",
  async (_id, manual) => {
    // A cancelled response streams what it generated until response.done.
    const session = manual
      ? new events.SessionProperties({ turnDetection: null })
      : new events.SessionProperties();
    const service = _sessionService(session);
    const recorder = _record(service);
    const sent = _recordSent(service);

    await _drive(service, [
      { type: "response.created", event_id: "e1", response: { id: RESPONSE_ID } },
      _audioDelta(),
    ]);
    await service._handleInterruption();
    expect(_kinds(sent)).toContain("ResponseCancelEvent");

    recorder.frames.length = 0;
    const transcript = {
      type: "response.audio_transcript.delta",
      event_id: "e2",
      response_id: RESPONSE_ID,
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      delta: "three, four",
    };
    await _drive(service, [
      _audioDelta(),
      transcript,
      _responseDone("cancelled"),
      { type: "response.created", event_id: "e3", response: { id: "resp_2" } },
      { ..._audioDelta(), response_id: "resp_2", item_id: "msg_2" },
    ]);

    expect(recorder.ofTypes(TTSTextFrame).length).toBe(0);
    expect(recorder.ofTypes(TTSAudioRawFrame).length).toBe(1);
  },
);

test("test_a_response_interrupted_before_it_is_announced_is_still_dropped", async () => {
  // A split utterance can interrupt a response Voice Live hasn't announced yet.
  const service = _sessionService(new events.SessionProperties({ turnDetection: null }));
  const recorder = _record(service);
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  service._context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });

  await service._handleUserStoppedSpeaking(null);
  await service._handleInterruption();
  expect(_kinds(sent)).toContain("ResponseCancelEvent");

  // The caller stops again before the cancelled response has finished.
  await service._handleUserStoppedSpeaking(null);
  expect(_kinds(sent).filter((k) => k === "ResponseCreateEvent").length).toBe(1);

  await _drive(service, [
    { type: "response.created", event_id: "e1", response: { id: RESPONSE_ID } },
    _audioDelta(),
    _responseDone("cancelled"),
  ]);

  expect(recorder.ofTypes(TTSAudioRawFrame).length).toBe(0);
  expect(_kinds(sent).filter((k) => k === "ResponseCreateEvent").length).toBe(2);
});

test("test_an_interruption_with_no_response_running_sends_no_cancel", async () => {
  const service = _makeService();
  _record(service);
  const sent = _recordSent(service);

  await service._handleInterruption();

  expect(_kinds(sent)).not.toContain("ResponseCancelEvent");
});

test.each([
  ["manual", true],
  ["server-vad", false],
])(
  "test_a_manual_interruption_replays_the_speech_onset_after_clearing[%s]",
  async (_id, manual) => {
    // Local VAD confirms speech after its onset was sent, and the clear would discard it.
    const session = manual
      ? new events.SessionProperties({ turnDetection: null })
      : new events.SessionProperties();
    const service = _sessionService(session);
    _record(service);
    const sent = _recordSent(service);
    service._llmNeedsConversationSetup = false;
    service._handleSpeechControlParams(
      new SpeechControlParamsFrame({ vadParams: new VADParams({ startSecs: 0.2 }) }),
    );

    // One second of 16 kHz audio in 20 ms frames, each frame holding its index.
    for (let i = 0; i < 50; i++) {
      const audio = new Uint8Array(640);
      for (let j = 0; j < 640; j += 2) audio[j] = i;
      await service._sendUserAudio(
        new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
      );
    }
    sent.length = 0;

    await service._handleInterruption();

    const kinds = _kinds(sent);
    if (!manual) {
      expect(kinds).not.toContain("InputAudioBufferClearEvent");
      return;
    }
    expect(kinds.slice(0, 2)).toEqual([
      "InputAudioBufferClearEvent",
      "InputAudioBufferAppendEvent",
    ]);
    const replayed = base64ToBytes((sent[1] as events.InputAudioBufferAppendEvent).audio);
    // start_secs plus the margin, ending with the last frame sent.
    expect(replayed.length).toBe(Math.trunc(16000 * 2 * 0.5));
    expect([...replayed.slice(-2)]).toEqual([49, 0]);
  },
);

test("test_truncation_never_passes_the_audio_received", async () => {
  // Playback lags generation, and Voice Live rejects a truncation beyond the audio.
  const service = _makeService();
  _record(service);
  const sent = _recordSent(service);

  // 100 ms of 24 kHz mono PCM16.
  await _drive(service, [_audioDelta(new Uint8Array(4800))]);
  expect(service._currentAudioResponse).not.toBeNull();
  service._currentAudioResponse.startTimeMs -= 30_000;

  await service._truncateCurrentAudioResponse();

  const truncates = sent.filter(
    (e) => e instanceof events.ConversationItemTruncateEvent,
  ) as events.ConversationItemTruncateEvent[];
  expect(truncates.map((t) => t.audioEndMs)).toEqual([100]);
});

test("test_audio_transcript_delta_pushes_tts_text", async () => {
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [
    {
      type: "response.audio_transcript.delta",
      event_id: "event_t",
      response_id: RESPONSE_ID,
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    },
  ]);

  const textFrames = recorder.ofTypes(TTSTextFrame) as TTSTextFrame[];
  expect(textFrames.map((f) => f.text)).toEqual(["Hello"]);
});

test("test_input_transcription_deltas_accumulate_then_finalize", async () => {
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [
    {
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "e1",
      item_id: "item_u",
      content_index: 0,
      delta: "what's the ",
    },
    {
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "e2",
      item_id: "item_u",
      content_index: 0,
      delta: "weather",
    },
    {
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "e3",
      item_id: "item_u",
      content_index: 0,
      transcript: "What's the weather?",
    },
  ]);

  const interim = recorder.ofTypes(InterimTranscriptionFrame) as InterimTranscriptionFrame[];
  const final = recorder.ofTypes(TranscriptionFrame) as TranscriptionFrame[];

  expect(interim.map((f) => f.text)).toEqual(["what's the ", "what's the weather"]);
  expect(final.map((f) => f.text)).toEqual(["What's the weather?"]);
  expect(service._interimTranscriptionText).toBe("");
});

test("test_server_vad_speech_events_propose_user_turns", async () => {
  const service = _makeService();
  _record(service);
  const broadcasts = new _BroadcastRecorder();
  service.broadcastFrame = broadcasts.call;

  await _drive(service, [
    { type: "input_audio_buffer.speech_started", event_id: "e1", audio_start_ms: 100 },
    { type: "input_audio_buffer.speech_stopped", event_id: "e2", audio_end_ms: 900 },
  ]);

  expect(broadcasts.types).toEqual([
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
  ]);
});

test("test_manual_turn_detection_suppresses_proposed_turn_frames", async () => {
  // With server VAD off, the caller's own strategy drives turn frames.
  const service = _sessionService(new events.SessionProperties({ turnDetection: null }));
  _record(service);
  const broadcasts = new _BroadcastRecorder();
  service.broadcastFrame = broadcasts.call;

  await _drive(service, [
    { type: "input_audio_buffer.speech_started", event_id: "e1", audio_start_ms: 100 },
    { type: "input_audio_buffer.speech_stopped", event_id: "e2", audio_end_ms: 900 },
  ]);

  expect(broadcasts.types).toEqual([]);
});

test.each([
  // Routine during turn-taking, including re-truncating what `auto_truncate` cut.
  ["response_cancel_not_active", false],
  ["conversation_already_has_active_response", false],
  ["item_already_truncated", false],
  ["item_not_found", true],
  ["invalid_value", true],
])("test_an_error_event_is_reported_and_the_session_continues[%s]", async (code, reported) => {
  // An error event rejects one request; a session-ending error closes the connection.
  const service = _makeService();
  const recorder = _record(service);
  const errors: boolean[] = [];

  service.pushError = async (
    _errorMsg: string,
    options: { forceTreatAsPermanent?: boolean } = {},
  ) => {
    errors.push(options.forceTreatAsPermanent ?? false);
  };

  await _drive(service, [
    {
      type: "error",
      event_id: "e1",
      error: { type: "invalid_request_error", code, message: "rejected" },
    },
    _audioDelta(),
  ]);

  expect(errors).toEqual(reported ? [false] : []);
  expect(recorder.ofTypes(TTSAudioRawFrame).length).toBeGreaterThan(0);
});

test("test_an_assistant_item_opens_the_response_only_once", async () => {
  // The same item is announced by both conversation.item.created and
  // response.output_item.added.
  const service = _makeService();
  const recorder = _record(service);

  const scripted: Dict[] = [
    {
      type: "conversation.item.created",
      event_id: "e1",
      previous_item_id: "",
      item: _assistantItem(),
    },
    _outputItemAdded("e2"),
    _responseDone(),
  ];
  const created: unknown[] = [];

  service._callEventHandler = async (eventName: string, ...args: unknown[]) => {
    if (eventName === "on_conversation_item_created") {
      created.push(args[0]);
    }
  };

  await _drive(service, scripted);

  expect(recorder.ofTypes(LLMFullResponseStartFrame).length).toBe(1);
  expect(recorder.ofTypes(LLMFullResponseEndFrame).length).toBe(1);
  expect(created).toEqual([ITEM_ID]);
});

test("test_caller_audio_streams_before_the_first_context", async () => {
  // Server VAD can hear the caller before the app sends its first context.
  const service = _makeService();
  const sent = _recordSent(service);

  await service._sendUserAudio(
    new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 16000, numChannels: 1 }),
  );

  expect(sent.map((e) => e.constructor)).toEqual([events.InputAudioBufferAppendEvent]);
});

test("test_a_manual_turn_before_the_first_context_creates_no_response", async () => {
  const service = _makeService();
  service._settings.sessionProperties.turnDetection = null;
  const sent = _recordSent(service);

  await service._handleUserStoppedSpeaking(null);

  expect(sent).toEqual([]);
});

test("test_interruption_closes_the_turn_only_once", async () => {
  // A cancelled response still reports done after the turn was closed.
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [_outputItemAdded(), _audioDelta()]);

  // As upstream, sends are not mocked: the scripted socket can't send, and the
  // failure is reported as an error.
  await service._handleInterruption();
  await _drive(service, [_responseDone("cancelled")]);

  expect(recorder.ofTypes(LLMFullResponseStartFrame).length).toBe(1);
  expect(recorder.ofTypes(LLMFullResponseEndFrame).length).toBe(1);
});

test("test_a_response_asked_for_mid_flight_waits_for_response_done", async () => {
  // Voice Live rejects a second response while one is running.
  const service = _makeService();
  _record(service);
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  service._context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });

  // A response is running.
  await _drive(service, [{ type: "response.created", event_id: "e1", response: {} }]);
  expect(service._responseInFlight).toBe(true);

  // A tool result asks for the follow-up before that response finished.
  await service._createResponse();
  expect(_kinds(sent)).not.toContain("ResponseCreateEvent");
  expect(service._runLlmWhenResponseDone).toBe(true);

  // It goes out once the running response reports done.
  await _drive(service, [_responseDone()]);
  expect(_kinds(sent)).toContain("ResponseCreateEvent");
  expect(service._runLlmWhenResponseDone).toBe(false);
});

test("test_a_response_takes_the_session_modalities", async () => {
  // Native-audio voices reject ["text", "audio"] as a per-response override.
  const service = _makeService();
  _record(service);
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  service._context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });

  await service._createResponse();

  const creates = sent.filter((e) => e instanceof events.ResponseCreateEvent);
  expect(creates.length).toBe(1);
  expect("response" in creates[0]!.modelDump({ excludeNone: true })).toBe(false);
});

test("test_a_deferred_response_survives_a_failed_response", async () => {
  // A tool result owed a response still gets one when the response it waited on fails.
  const service = _makeService();
  _record(service);
  service.pushError = _noopError;
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  service._context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });

  await _drive(service, [{ type: "response.created", event_id: "e1", response: {} }]);
  await service._createResponse();
  expect(service._runLlmWhenResponseDone).toBe(true);

  sent.length = 0;
  await _drive(service, [_responseDone("failed")]);

  expect(_kinds(sent)).toContain("ResponseCreateEvent");
  expect(service._runLlmWhenResponseDone).toBe(false);
});

function _errorFor(eventId: string | null, code: string): Dict {
  return {
    type: "error",
    event_id: "server_evt",
    error: {
      type: "invalid_request_error",
      code,
      message: "rejected",
      event_id: eventId,
    },
  };
}

/** A service ready to create responses, recording the client events it sends. */
function _responseService(): [Internals, events.ClientEvent[]] {
  const service = _makeService();
  _record(service);
  service.pushError = _noopError;
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._llmNeedsConversationSetup = false;
  service._context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
  return [service, sent];
}

function _creates(sent: events.ClientEvent[]): events.ResponseCreateEvent[] {
  return sent.filter(
    (e) => e instanceof events.ResponseCreateEvent,
  ) as events.ResponseCreateEvent[];
}

test("test_a_rejected_response_request_frees_the_next_one", async () => {
  // No response.done follows a rejected request, so the error itself clears it.
  const [service, sent] = _responseService();

  await service._createResponse();
  const request = _creates(sent)[0]!;
  await _drive(service, [_errorFor(request.eventId, "invalid_value")]);

  expect(service._responseInFlight).toBe(false);
  await service._createResponse();
  expect(_creates(sent).length).toBe(2);
});

test("test_a_rejected_response_request_releases_the_deferred_response", async () => {
  const [service, sent] = _responseService();

  await service._createResponse();
  const request = _creates(sent)[0]!;
  // A tool result asks for a follow-up before the request is answered.
  await service._createResponse();
  expect(service._runLlmWhenResponseDone).toBe(true);

  await _drive(service, [_errorFor(request.eventId, "invalid_value")]);

  expect(_creates(sent).length).toBe(2);
  expect(service._runLlmWhenResponseDone).toBe(false);
});

test.each([
  // Voice Live is already running a response of its own; its response.done clears it.
  ["request", "conversation_already_has_active_response"],
  // The error is about some other client event.
  ["other", "invalid_value"],
  [null, "invalid_value"],
])("test_other_errors_leave_the_response_request_running[%s-%s]", async (eventId, code) => {
  const [service, sent] = _responseService();

  await service._createResponse();
  const request = _creates(sent)[0]!;
  const id = eventId === "request" ? request.eventId : eventId;
  await _drive(service, [_errorFor(id, code)]);

  expect(service._responseInFlight).toBe(true);
});

test("test_text_deltas_push_llm_text_when_audio_is_off", async () => {
  // A text-only session reports its response through response.text.delta.
  const service = _makeService();
  const recorder = _record(service);

  await _drive(service, [
    {
      type: "response.text.delta",
      event_id: "e1",
      response_id: RESPONSE_ID,
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    },
    _responseDone(),
  ]);

  expect((recorder.ofTypes(LLMTextFrame) as LLMTextFrame[]).map((f) => f.text)).toEqual(["Hello"]);
});

test("test_an_interruption_drops_a_deferred_response", async () => {
  // The interrupting turn asks for its own response.
  const service = _makeService();
  _record(service);
  const sent = _recordSent(service);
  service._apiSessionReady = true;
  service._responseInFlight = true;
  service._runLlmWhenResponseDone = true;

  await service._handleInterruption();

  expect(service._runLlmWhenResponseDone).toBe(false);

  await _drive(service, [_responseDone("cancelled")]);
  expect(_kinds(sent)).not.toContain("ResponseCreateEvent");
});

test("test_a_failed_transcription_clears_the_interim_text", async () => {
  // Only a completed transcription clears it, so a failure would carry over.
  const service = _makeService();
  _record(service);
  const errors: string[] = [];

  service.pushError = async (errorMsg: string) => {
    errors.push(errorMsg);
  };

  await _drive(service, [
    {
      type: "conversation.item.input_audio_transcription.delta",
      event_id: "e1",
      item_id: "item_u",
      content_index: 0,
      delta: "what's the ",
    },
    {
      type: "conversation.item.input_audio_transcription.failed",
      event_id: "e2",
      item_id: "item_u",
      content_index: 0,
      error: { type: "server_error", message: "audio was unintelligible" },
    },
  ]);

  expect(service._interimTranscriptionText).toBe("");
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("unintelligible");
});
