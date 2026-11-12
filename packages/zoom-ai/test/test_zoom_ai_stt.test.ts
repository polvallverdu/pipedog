// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_zoom_ai_stt.py

/**
 * Tests for the Zoom Scribe Live and Fast STT services.
 *
 * Porting notes:
 * - `monkeypatch.setattr("pipecat.services.websocket_service.websocket_connect", ...)`
 *   → spying on the service's `_websocketConnect`, the only caller of
 *   `websocketConnect()`. Python's `args[0]` / `kwargs` become the URI and
 *   the options object (`additional_headers` → `additionalHeaders`).
 * - `monkeypatch.setattr(zoom_ai_stt, "INPUT_GAP_SECS" | "SESSION_CLOSE_TIMEOUT_SECS", x)`
 *   → the service's `_inputGapSecs` / `_sessionCloseTimeoutSecs` fields (an ES
 *   module export is read-only; see the DIVERGENCE note in `src/stt.ts`).
 * - Patching `WebsocketSTTService.stop` / `.cancel` → `spyOn` on its prototype.
 * - `push_error(error_msg=..., category=...)` keyword calls are
 *   `pushError(msg, { category })` here, so `kwargs` assertions compare the
 *   call's arguments.
 * - `websockets.exceptions.InvalidStatus` → a stand-in error carrying the
 *   handshake `response` (status and body), which `describeRefusal()` reads.
 * - `create_task` receives a task function, not a coroutine: recording it and
 *   awaiting it later means calling it.
 * - `pytest.mark.parametrize` → one test per case, named with pytest's ids.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createTask, sleep, waitFor } from "@pipedog/asyncio";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { WebsocketSTTService } from "@pipedog/core/services/stt_service";
import { State, type WebsocketConnectOptions } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import { ZoomAISTTService, type ZoomAISTTServiceOptions } from "../src/stt.ts";

afterEach(() => {
  mock.restore();
});

type Message = string | Uint8Array;

/** A websocket that replays server messages and records what was sent. */
class _FakeWebsocket {
  #messages: Message[];
  state: State;
  sent: Message[] = [];
  closed = false;

  constructor(messages: Message[] | null = null, options: { state?: State } = {}) {
    this.#messages = messages ?? [];
    this.state = options.state ?? State.OPEN;
  }

  async send(payload: Message): Promise<void> {
    this.sent.push(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = State.CLOSED;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Message> {
    for (const message of this.#messages) {
      yield message;
    }
  }
}

type ConnectCall = { args: [string]; kwargs: WebsocketConnectOptions };

// Test access to protected members, as the Python tests do.
type Internals = any;

function internals(service: ZoomAISTTService): Internals {
  return service as unknown as Internals;
}

function _patchConnect(websocket: _FakeWebsocket): ConnectCall[] {
  const calls: ConnectCall[] = [];
  spyOn(ZoomAISTTService.prototype as Internals, "_websocketConnect").mockImplementation(
    async (uri: string, options: WebsocketConnectOptions = {}) => {
      calls.push({ args: [uri], kwargs: options });
      return websocket;
    },
  );
  return calls;
}

function _patchConnectError(error: unknown): void {
  spyOn(ZoomAISTTService.prototype as Internals, "_websocketConnect").mockImplementation(
    async () => {
      throw error;
    },
  );
}

function _live(
  sampleRate = 16000,
  options: Partial<ZoomAISTTServiceOptions> = {},
): ZoomAISTTService {
  const service = new ZoomAISTTService({ apiKey: "test-key", ...options });
  // sample_rate is normally set when the pipeline starts, which these tests skip.
  internals(service)._sampleRate = sampleRate;
  return service;
}

function _recordFrames(service: ZoomAISTTService): unknown[] {
  const frames: unknown[] = [];
  const s = internals(service);
  s.pushFrame = mock(async (f: Frame) => {
    frames.push(f);
  });
  s.broadcastFrame = mock(async (frameCls: unknown, _kw?: unknown) => {
    frames.push(frameCls);
  });
  s.emitSttUsageMetrics = mock(async () => {});
  return frames;
}

function _event(kind: string, fields: Record<string, unknown> = {}): string {
  return pyJsonDumps({ type: kind, ...fields });
}

function parse(message: Message | undefined): Record<string, unknown> {
  return JSON.parse(message as string);
}

function bytes(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function concat(chunks: Message[]): Uint8Array {
  const parts = chunks.filter((m): m is Uint8Array => m instanceof Uint8Array);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

/** Stand-in for `websockets.exceptions.InvalidStatus` with its `Response`. */
class InvalidStatus extends Error {
  response: { status_code: number; reason_phrase: string; body: Uint8Array };

  constructor(response: { status_code: number; reason_phrase: string; body: Uint8Array }) {
    super(`server rejected WebSocket connection: HTTP ${response.status_code}`);
    this.name = "InvalidStatus";
    this.response = response;
  }
}

class ConnectionError extends Error {
  override name = "ConnectionError";
}

// Scribe Live

test("test_connect_sends_the_session_update", async () => {
  const websocket = new _FakeWebsocket();
  const calls = _patchConnect(websocket);
  const service = _live();

  await internals(service)._connectWebsocket();

  expect(calls[0]!.args[0]).toEqual("wss://api.zoom.us/v2/aiservices/scribe/live");
  expect(calls[0]!.kwargs.subprotocols).toEqual(["live-asr"]);
  const headers = calls[0]!.kwargs.additionalHeaders!;
  expect(headers.Authorization).toEqual("Bearer test-key");
  expect(headers["User-Agent"]!.startsWith("pipecat/")).toBe(true);
  expect(headers["x-zm-trackingid"]!.startsWith("zoom_ai_community_pipecat_")).toBe(true);
  expect(headers["x-zm-trackingid"]).toEqual(internals(service)._trackingId);
  expect(parse(websocket.sent[0])).toEqual({
    type: "session.update",
    language: "en-US",
    audio: { format: "pcm16" },
    turn_detection: { silence_duration_ms: 350 },
  });
});

for (const [id, silenceDurationMs, expected] of [
  ["500-expected0", 500, { silence_duration_ms: 500 }],
  // Scribe's server default: exactly the documented session.update
  ["None-None", null, undefined],
] as const) {
  test(`test_silence_duration_setting[${id}]`, async () => {
    const websocket = new _FakeWebsocket();
    _patchConnect(websocket);
    const service = _live(16000, {
      settings: new ZoomAISTTService.Settings({ silenceDurationMs }),
    });

    await internals(service)._connectWebsocket();

    // dict.get() returns None for a missing key.
    expect(parse(websocket.sent[0]).turn_detection).toEqual(expected);
  });
}

test("test_language_setting_maps_to_a_scribe_locale", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ language: Language.DE_DE }),
  });

  await internals(service)._connectWebsocket();

  expect(parse(websocket.sent[0]).language).toEqual("de-DE");
});

for (const turnOpen of [true, false]) {
  /** Input stopping mid-turn (e.g. a mute) gets enough silence for Scribe to end the turn. */
  test(`test_input_gap_mid_turn_sends_silence_to_end_it[${turnOpen ? "True" : "False"}]`, async () => {
    const service = _live();
    const s = internals(service);
    s._inputGapSecs = 0.02;
    const websocket = new _FakeWebsocket();
    s._websocket = websocket;
    s._userTurnOpen = turnOpen;
    s._lastInputTime = 0; // input stopped long ago

    const task = createTask(() => s._inputGapHandler());
    await sleep(0.1);
    task.cancel();

    const sent = websocket.sent.filter((m) => m instanceof Uint8Array);
    // silence_duration_ms (350) plus 100 ms, once per gap; nothing without an open turn
    expect(sent).toEqual(turnOpen ? [bytes(Math.floor((16000 * 2 * 450) / 1000))] : []);
    expect(s._sttUsagePendingSeconds).toBeCloseTo(turnOpen ? 0.45 : 0);
  });
}

test("test_input_gap_silence_is_resampled_and_counted_at_the_pipeline_rate", async () => {
  const service = _live(8000);
  const s = internals(service);
  s._inputGapSecs = 0.02;
  const websocket = new _FakeWebsocket();
  s._websocket = websocket;
  s._userTurnOpen = true;
  s._lastInputTime = 0;

  const task = createTask(() => s._inputGapHandler());
  await sleep(0.1);
  task.cancel();

  const sent = concat(websocket.sent);
  // Up to 450 ms at 16 kHz; the resampler holds back the rest.
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(Math.floor((16000 * 2 * 450) / 1000));
  expect(s._sttUsagePendingSeconds).toBeCloseTo(0.45);
});

test("test_keepalive_silence_is_resampled_and_counted", async () => {
  const service = _live(24000);
  const s = internals(service);
  const websocket = new _FakeWebsocket();
  s._websocket = websocket;

  await s._sendKeepalive(bytes(Math.floor((24000 * 2) / 10))); // 100 ms at 24 kHz

  const sent = concat(websocket.sent);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(Math.floor((16000 * 2) / 10));
  expect(s._sttUsagePendingSeconds).toBeCloseTo(0.1);
});

test("test_plaintext_urls_warn_except_for_localhost", () => {
  const warnings: string[] = [];
  spyOn(logger, "warning").mockImplementation(((msg: string) => {
    warnings.push(msg);
  }) as typeof logger.warning);
  new ZoomAISTTService({ apiKey: "test-key", url: "ws://scribe.example.com/live" });
  expect(warnings.length === 1 && warnings[0]!.includes("not encrypted")).toBe(true);
  warnings.length = 0;
  new ZoomAISTTService({ apiKey: "test-key", url: "ws://localhost:8080/live" });
  new ZoomAISTTService({ apiKey: "test-key" });
  expect(warnings).toEqual([]);
});

test("test_audio_is_sent_as_it_arrives", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket();

  await drain(service.runStt(bytes(640, 1)));
  await drain(service.runStt(bytes(640, 2)));

  expect(s._websocket.sent).toEqual([bytes(640, 1), bytes(640, 2)]);
});

test("test_off_rate_audio_is_resampled_to_16_khz", async () => {
  const service = _live(8000);
  const s = internals(service);
  s._websocket = new _FakeWebsocket();

  for (let i = 0; i < 10; i++) {
    await drain(service.runStt(bytes(1600)));
  }

  const audioSent = concat(s._websocket.sent);
  // 8 kHz in, 16 kHz out: twice the bytes, less what the resampler still holds.
  const ratio = audioSent.length / (2 * 10 * 1600);
  expect(ratio).toBeGreaterThan(0.9);
  expect(ratio).toBeLessThanOrEqual(1.0);
});

test("test_scribe_turn_brackets_the_final_transcript", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("session.updated"),
    _event("input_audio_buffer.speech_started", { item_id: "item_1", audio_start_ms: 100 }),
    _event("input_audio_buffer.speech_stopped", { item_id: "item_1", audio_end_ms: 900 }),
    _event("transcription.completed", {
      item_id: "item_1",
      transcript: "[Speaker 1] What is the capital of France?",
      audio_start_ms: 100,
      audio_end_ms: 900,
    }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  expect(frames.map((f) => (typeof f === "function" ? f : (f as object).constructor))).toEqual([
    ProposedUserStartedSpeakingFrame,
    TranscriptionFrame,
    ProposedUserStoppedSpeakingFrame,
  ]);
  const transcript = frames[1] as TranscriptionFrame;
  expect(transcript.text).toEqual("What is the capital of France?");
  expect(transcript.finalized).toBeTruthy();
  expect(transcript.language).toBe(Language.EN_US);
});

test("test_repeated_speech_start_opens_one_turn", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started"),
    _event("input_audio_buffer.speech_started"),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  expect(frames).toEqual([ProposedUserStartedSpeakingFrame]);
});

test("test_usage_is_reported_before_the_transcription_frame", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started", { item_id: "item_1" }),
    _event("transcription.completed", { item_id: "item_1", transcript: "Berlin." }),
  ]);
  const events: string[] = [];
  s.pushFrame = mock(async (f: Frame) => {
    events.push(f.constructor.name);
  });
  s.broadcastFrame = mock(async () => {});
  s.emitSttUsageMetrics = mock(async () => {
    events.push("usage");
  });

  await s._receiveMessages();

  expect(events).toEqual(["usage", "TranscriptionFrame"]);
});

test("test_disconnect_closes_an_open_turn", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([_event("input_audio_buffer.speech_started")]);
  const frames = _recordFrames(service);

  await s._receiveMessages();
  await s._disconnectWebsocket();

  expect(frames).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
});

test("test_rejected_session_settings_are_a_permanent_error", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("session.created"),
    _event("error", {
      error: { code: "invalid_config", message: "no polishing", fatal: false },
    }),
    _event("error", {
      error: { code: "missing_config", message: "send config", fatal: true },
    }),
  ]);
  s._trackingId = "track_1";
  const pushError = mock(async (..._args: unknown[]) => {});
  s.pushError = pushError;

  await s._receiveMessages();

  const [nonFatal, fatal] = pushError.mock.calls;
  expect(pushError.mock.calls.length).toBe(2);
  expect(nonFatal).toEqual([
    "Zoom Scribe Live error invalid_config: no polishing (tracking_id=track_1)",
  ]);
  expect(fatal).toEqual([
    "Zoom Scribe Live error missing_config: send config (tracking_id=track_1)",
    { category: ErrorCategory.INVALID_REQUEST },
  ]);
});

for (const fatal of [true, false]) {
  test(`test_errors_after_the_session_starts_are_reported[${fatal ? "True" : "False"}]`, async () => {
    const service = _live();
    const s = internals(service);
    s._websocket = new _FakeWebsocket([
      _event("session.updated"),
      _event("error", { error: { code: "internal", message: "bad things", fatal } }),
    ]);
    s._trackingId = "track_1";
    const pushError = mock(async (..._args: unknown[]) => {});
    s.pushError = pushError;

    await s._receiveMessages();

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(pushError.mock.calls[0]).toEqual([
      "Zoom Scribe Live error internal: bad things (tracking_id=track_1)",
    ]);
  });
}

test("test_settings_change_reconnects", async () => {
  const service = _live();
  const s = internals(service);
  const reconnect = mock(async () => {});
  s._requestReconnect = reconnect;

  await s._updateSettings(new ZoomAISTTService.Settings({ language: Language.JA_JP }));

  expect(s._settings.language).toEqual("ja-JP");
  expect(reconnect).toHaveBeenCalledTimes(1);
});

test("test_live_diarization_is_requested_only_when_on", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ diarization: true }),
  });

  await internals(service)._connectWebsocket();

  expect(parse(websocket.sent[0])).toEqual({
    type: "session.update",
    language: "en-US",
    audio: { format: "pcm16" },
    config: { diarization: true },
    turn_detection: { silence_duration_ms: 350 },
  });
});

test("test_live_recognition_options_are_requested_only_when_set", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({
      model: "zoom-scribe-multilingual",
      languageDetection: "continuous",
      vocabulary: ["Pipecat", "LiveKit"],
      textPolishing: true,
      extra: { config: { profanity_filter: true } },
    }),
  });

  await internals(service)._connectWebsocket();

  const update = parse(websocket.sent[0]);
  expect(update.config).toEqual({
    model: "zoom-scribe-multilingual",
    language_detection: { mode: "continuous" },
    profanity_filter: true,
    vocabulary: { phrases: ["Pipecat", "LiveKit"] },
  });
  expect(update.outputs).toEqual({ text_polishing: { enabled: true, include_transcript: true } });
});

test("test_live_extra_is_merged_into_the_session_update", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const extra = {
    config: { vocabulary_id: "acct_vocab_1", diarization: false },
    turn_detection: { max_segment_duration_ms: 15000 },
    outputs: { future_output: { enabled: true } },
    audio: { format: "opus" }, // the service sends PCM16, so this is kept
  };
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ diarization: true, extra }),
  });

  await internals(service)._connectWebsocket();

  const update = parse(websocket.sent[0]);
  expect(update.config).toEqual({ diarization: false, vocabulary_id: "acct_vocab_1" });
  expect(update.turn_detection).toEqual({
    silence_duration_ms: 350,
    max_segment_duration_ms: 15000,
  });
  expect(update.outputs).toEqual({ future_output: { enabled: true } });
  expect(update.audio).toEqual({ format: "pcm16" });
  expect(extra.audio).toEqual({ format: "opus" }); // the caller's dict isn't modified
});

test("test_live_acts_on_settings_given_through_extra", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({
      extra: { outputs: { text_polishing: { enabled: true } } },
    }),
  });
  const s = internals(service);
  await s._connectWebsocket();
  const update = parse(websocket.sent[0]);
  // The transcript is the fallback when polishing fails, so it is always requested.
  expect(update.outputs).toEqual({ text_polishing: { enabled: true, include_transcript: true } });

  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", {
      item_id: "item_1",
      transcript: "Um, hello hello there.",
      outputs: { text_polishing: { text: "Hello there." } },
    }),
  ]);
  const frames = _recordFrames(service);
  await s._receiveMessages();

  const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
  expect(transcripts.length).toBe(1);
  expect(transcripts[0]!.text).toEqual("Hello there.");
});

test("test_live_frame_language_is_none_when_detection_reports_none", async () => {
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ languageDetection: "continuous" }),
  });
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", { item_id: "item_1", transcript: "Hola." }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
  expect(transcripts.length).toBe(1);
  expect(transcripts[0]!.language).toBeNull();
});

test("test_live_frames_carry_the_detected_language", async () => {
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ languageDetection: "continuous" }),
  });
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", {
      item_id: "item_1",
      transcript: "Buenos días.",
      language: "es",
    }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
  expect(transcripts.length).toBe(1);
  expect(transcripts[0]!.language).toBe(Language.ES);
});

for (const [id, polished, expected] of [
  // falls back to the transcript
  [
    "[polishing_failed: timeout]-Um, hello hello there.",
    "[polishing_failed: timeout]",
    "Um, hello hello there.",
  ],
  // speaker tags removed
  ["[Speaker 1] Hello there.-Hello there.", "[Speaker 1] Hello there.", "Hello there."],
] as const) {
  test(`test_live_polished_text_edge_cases[${id}]`, async () => {
    const service = _live(16000, {
      settings: new ZoomAISTTService.Settings({ textPolishing: true }),
    });
    const s = internals(service);
    s._websocket = new _FakeWebsocket([
      _event("transcription.completed", {
        item_id: "item_1",
        transcript: "Um, hello hello there.",
        outputs: { text_polishing: { text: polished } },
      }),
    ]);
    const frames = _recordFrames(service);

    await s._receiveMessages();

    const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
    expect(transcripts.length).toBe(1);
    expect(transcripts[0]!.text).toEqual(expected);
  });
}

test("test_live_text_polishing_pushes_the_polished_text", async () => {
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ textPolishing: true }),
  });
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", {
      item_id: "item_1",
      transcript: "Um, hello hello there.",
      outputs: { text_polishing: { text: "Hello there." } },
    }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
  expect(transcripts.length).toBe(1);
  expect(transcripts[0]!.text).toEqual("Hello there.");
  expect((transcripts[0]!.result as Record<string, unknown>).transcript).toEqual(
    "Um, hello hello there.",
  );
});

test("test_live_speaker_labels_stay_in_the_raw_result", async () => {
  const service = _live(16000, {
    settings: new ZoomAISTTService.Settings({ diarization: true }),
  });
  const s = internals(service);
  const spans = [
    // sent only when the speaker changed mid-utterance
    { speaker: "Speaker 1", transcript: "Hi", audio_start_ms: 0, audio_end_ms: 500 },
    { speaker: "Speaker 2", transcript: "fine", audio_start_ms: 500, audio_end_ms: 900 },
  ];
  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", {
      item_id: "item_1",
      transcript: "[Speaker 1] Hello there.",
      speaker: "Speaker 1",
    }),
    _event("transcription.completed", {
      item_id: "item_2",
      transcript: "Hi fine",
      speaker: "Speaker 1",
      speaker_segments: spans,
    }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  const transcripts = frames.filter((f) => f instanceof TranscriptionFrame);
  expect(transcripts.length).toBe(2);
  const [first, second] = transcripts as [TranscriptionFrame, TranscriptionFrame];
  const firstResult = first.result as Record<string, unknown>;
  expect(first.text).toEqual("Hello there.");
  expect(firstResult.speaker).toEqual("Speaker 1");
  expect("speaker_segments" in firstResult).toBe(false);
  expect((second.result as Record<string, unknown>).speaker_segments).toEqual(spans);
});

for (const [id, diarization, diarizationEnabled, warned] of [
  ["True-False-True", true, false, true],
  ["True-True-False", true, true, false],
  ["True-None-False", true, null, false],
  ["False-False-False", false, false, false],
] as const) {
  test(`test_live_warns_when_scribe_cannot_diarize[${id}]`, async () => {
    const service = _live(16000, {
      settings: new ZoomAISTTService.Settings({ diarization }),
    });
    const s = internals(service);
    const fields = diarizationEnabled === null ? {} : { diarization_enabled: diarizationEnabled };
    s._websocket = new _FakeWebsocket([_event("session.updated", fields)]);
    const warning = spyOn(logger, "warning").mockImplementation(
      (() => {}) as typeof logger.warning,
    );

    await s._receiveMessages();

    expect(warning.mock.calls.length > 0).toBe(warned);
  });
}

for (const shouldInterrupt of [true, false]) {
  test(`test_metadata_recommends_external_turn_strategies[${shouldInterrupt ? "True" : "False"}]`, () => {
    const service = _live(16000, { shouldInterrupt });

    const strategies = service.serviceMetadataFrame().userTurnStrategies;

    expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
    expect((strategies as ExternalUserTurnStrategies).enableInterruptions).toBe(shouldInterrupt);
    expect(service.supportsTtfs).toBe(false);
  });
}

for (const [id, language, locale] of [
  ["Language.EN-en-US", Language.EN, "en-US"],
  ["Language.PT-pt-BR", Language.PT, "pt-BR"],
  ["Language.PT_PT-pt-PT", Language.PT_PT, "pt-PT"],
  ["Language.KO-ko-KR", Language.KO, "ko-KR"],
  ["Language.NL_NL-nl-NL", Language.NL_NL, "nl-NL"],
] as const) {
  test(`test_base_languages_map_to_a_scribe_locale[${id}]`, async () => {
    const websocket = new _FakeWebsocket();
    _patchConnect(websocket);
    const service = _live(16000, { settings: new ZoomAISTTService.Settings({ language }) });

    await internals(service)._connectWebsocket();

    expect(parse(websocket.sent[0]).language).toEqual(locale);
  });
}

for (const [id, language, locale] of [
  ["Language.EN_GB-en-US", Language.EN_GB, "en-US"],
  ["Language.ES_MX-es-ES", Language.ES_MX, "es-ES"],
  ["en-GB-en-US", "en-GB", "en-US"],
  ["Language.XH-xh", Language.XH, "xh"],
] as const) {
  test(`test_unlisted_languages_resolve_through_their_base_language[${id}]`, () => {
    const service = _live(16000, {
      settings: new ZoomAISTTService.Settings({ language: language as Language }),
    });

    expect(internals(service)._settings.language).toEqual(locale);
  });
}

test("test_stop_closes_the_session", async () => {
  const service = _live();
  const s = internals(service);
  const websocket = new _FakeWebsocket();
  s._websocket = websocket;
  s._sessionCloseTimeoutSecs = 0.01;
  spyOn(WebsocketSTTService.prototype, "stop").mockResolvedValue(undefined);

  await service.stop(new EndFrame());

  expect(s._disconnecting).toBeTruthy();
  expect(websocket.sent).toEqual([pyJsonDumps({ type: "session.close" })]);
});

test("test_stop_waits_for_the_last_transcript", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket();
  const frames = _recordFrames(service);
  const baseStop = spyOn(WebsocketSTTService.prototype, "stop").mockResolvedValue(undefined);
  const sent: Record<string, unknown>[] = [];

  async function scribeAnswers(message: Record<string, unknown>): Promise<void> {
    // Scribe sends the pending final, then session.closed, after session.close.
    sent.push(message);
    if (message.type === "session.close") {
      async function answer(): Promise<void> {
        await s._handleEvent({ type: "transcription.completed", transcript: "Last words." });
        await s._handleEvent({ type: "session.closed", reason: "client" });
      }

      createTask(answer);
    }
  }

  s._sendJson = scribeAnswers;

  await service.stop(new EndFrame());

  expect(sent).toEqual([{ type: "session.close" }]);
  expect(
    frames
      .filter((f) => f instanceof TranscriptionFrame)
      .map((f) => (f as TranscriptionFrame).text),
  ).toEqual(["Last words."]);
  expect(baseStop).toHaveBeenCalledTimes(1);
});

test("test_stop_gives_up_waiting_after_the_timeout", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket();
  s._sessionCloseTimeoutSecs = 0.05;
  const baseStop = spyOn(WebsocketSTTService.prototype, "stop").mockResolvedValue(undefined);

  await waitFor(() => service.stop(new EndFrame()), 1);

  expect(baseStop).toHaveBeenCalledTimes(1);
});

test("test_transcript_without_speech_started_opens_its_own_turn", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("transcription.completed", { item_id: "item_1", transcript: "Hello." }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  expect(frames[0]).toBe(ProposedUserStartedSpeakingFrame);
  expect(frames[1]).toBeInstanceOf(TranscriptionFrame);
  expect(frames[2]).toBe(ProposedUserStoppedSpeakingFrame);
});

test("test_empty_transcript_ends_the_turn_without_a_transcription", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started", { item_id: "item_1" }),
    _event("transcription.completed", { item_id: "item_1", transcript: "" }),
  ]);
  const frames = _recordFrames(service);

  await s._receiveMessages();

  expect(frames).toEqual([ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame]);
});

test("test_live_reports_no_processing_metrics", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started", { item_id: "item_1" }),
    _event("input_audio_buffer.speech_stopped", { item_id: "item_1" }),
    _event("transcription.completed", { item_id: "item_1", transcript: "Hi." }),
  ]);
  _recordFrames(service);
  const start = mock(async () => {});
  const stop = mock(async () => {});
  s.startProcessingMetrics = start;
  s.stopProcessingMetrics = stop;

  await s._receiveMessages();

  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

test("test_settings_change_waits_for_the_scribe_turn_to_end", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started", { item_id: "item_1" }),
  ]);
  _recordFrames(service);
  const reconnect = mock(async () => {});
  s._reconnect = reconnect;

  await s._receiveMessages(); // Scribe heard speech; no local VAD in this pipeline
  await s._updateSettings(new ZoomAISTTService.Settings({ language: Language.JA_JP }));

  expect(reconnect).not.toHaveBeenCalled();
  expect(s._needReconnect).toBeTruthy(); // runs when the aggregator ends the turn
});

test("test_held_settings_change_applies_when_the_scribe_turn_ends", async () => {
  // No user aggregator, and the turn ends with an empty transcript: the change must
  // still be applied once Scribe's turn is over.
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket([
    _event("input_audio_buffer.speech_started", { item_id: "item_1" }),
  ]);
  _recordFrames(service);
  const reconnect = mock(async () => {});
  s._reconnect = reconnect;
  const scheduled: (() => Promise<unknown>)[] = [];
  s.createTask = (coro: () => Promise<unknown>, _name: string | null = null) => {
    scheduled.push(coro);
  };

  await s._receiveMessages();
  await s._updateSettings(new ZoomAISTTService.Settings({ silenceDurationMs: 500 }));
  expect(reconnect).not.toHaveBeenCalled();

  await s._handleEvent({ type: "transcription.completed", transcript: "" });

  expect(scheduled.length).toBe(1);
  await scheduled[0]!();
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(s._canReconnect).toBeTruthy();
});

test("test_settings_change_reconnects_with_the_new_config", async () => {
  const websocket = new _FakeWebsocket();
  _patchConnect(websocket);
  const service = _live();
  const s = internals(service);

  await s._connectWebsocket();
  await s._disconnectWebsocket();
  s._settings.applyUpdate(
    new ZoomAISTTService.Settings({ silenceDurationMs: 500, diarization: true }),
  );
  websocket.state = State.OPEN;
  await s._connectWebsocket();

  const update = parse(websocket.sent[websocket.sent.length - 1]);
  expect(update.config).toEqual({ diarization: true });
  expect(update.turn_detection).toEqual({ silence_duration_ms: 500 });
  expect(s._sessionClosed.isSet()).toBe(false); // stop() waits again on the new session
});

test("test_cancel_does_not_close_the_session_gracefully", async () => {
  const service = _live();
  const s = internals(service);
  const websocket = new _FakeWebsocket();
  s._websocket = websocket;
  spyOn(WebsocketSTTService.prototype, "cancel").mockResolvedValue(undefined);

  await service.cancel(new CancelFrame());

  expect(websocket.sent).not.toContain(pyJsonDumps({ type: "session.close" }));
});

test("test_disconnect_reports_once", async () => {
  const service = _live();
  const s = internals(service);
  s._websocket = new _FakeWebsocket();
  const onDisconnected = mock(async (..._args: unknown[]) => {});
  s._callEventHandler = onDisconnected;

  await s._disconnectWebsocket();
  await s._disconnectWebsocket();

  expect(onDisconnected).toHaveBeenCalledTimes(1);
  expect(onDisconnected).toHaveBeenCalledWith("on_disconnected");
});

test("test_failed_first_connect_still_starts_the_receive_loop", async () => {
  _patchConnectError(new ConnectionError("network down"));
  const service = _live();
  const s = internals(service);
  s.pushError = mock(async () => {});
  const started: (string | null)[] = [];
  s.createTask = (_coro: unknown, name: string | null = null) => {
    started.push(name);
    return undefined;
  };

  await s._connect();

  expect(s._websocket).toBeNull();
  // The receive loop owns reconnecting, so it must run even without a socket.
  expect(started).toContain("receive");
});

test("test_connect_clears_a_previous_disconnect_before_connecting", async () => {
  const service = _live();
  const s = internals(service);
  s._disconnecting = true; // left set by the disconnect half of a reconnect
  const disconnectingWhileConnecting: boolean[] = [];

  s._connectWebsocket = async () => {
    disconnectingWhileConnecting.push(s._disconnecting);
  };
  s.createTask = (_coro: unknown, _name: string | null = null) => undefined;

  await s._connect();

  expect(disconnectingWhileConnecting).toEqual([false]);
});

for (const [id, body, expected] of [
  [
    "body0-Zoom refused the connection (HTTP 401): Invalid Access token",
    new TextEncoder().encode('{"code":124, "message":"Invalid Access token"}'),
    "Zoom refused the connection (HTTP 401): Invalid Access token",
  ],
  [
    "-Unable to connect to Zoom Scribe Live: server rejected WebSocket connection: HTTP 401",
    new Uint8Array(0),
    "Unable to connect to Zoom Scribe Live: server rejected WebSocket connection: HTTP 401",
  ],
] as const) {
  test(`test_refused_handshake_reports_zoom_reason[${id}]`, async () => {
    const refusal = new InvalidStatus({ status_code: 401, reason_phrase: "Unauthorized", body });

    _patchConnectError(refusal);
    const service = _live();
    const s = internals(service);
    const pushError = mock(async (..._args: unknown[]) => {});
    s.pushError = pushError;
    const connectionErrors: unknown[] = [];

    service.eventHandler("on_connection_error", async (_service, error: unknown) => {
      connectionErrors.push(error);
    });

    await s._connectWebsocket();
    // Event handlers run as background tasks; let it finish.
    await sleep(0);

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(pushError).toHaveBeenCalledWith(expected, { exception: refusal });
    expect(connectionErrors).toEqual([
      expected.startsWith("Unable to connect to Zoom Scribe Live: ")
        ? expected.slice("Unable to connect to Zoom Scribe Live: ".length)
        : expected,
    ]);
  });
}
