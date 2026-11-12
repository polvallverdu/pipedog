// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_assemblyai_tts.py

/**
 * Tests for AssemblyAITTSService against a fake Streaming TTS server.
 *
 * Porting notes:
 * - The fake server (upstream: `websockets.asyncio.server.serve`) is a
 *   `Bun.serve` websocket server on 127.0.0.1.
 * - `monkeypatch.setattr(assemblyai_tts, "_WORD_BOUNDARIES_GRACE_S", x)` and
 *   `"_KEEPALIVE_INTERVAL_S"` → the service's `_wordBoundariesGraceS` /
 *   `_keepaliveIntervalS` instance fields (ES module exports are read-only).
 */

import { describe, expect, test } from "bun:test";
import {
  BotStoppedSpeakingFrame,
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import {
  _DEFAULT_VOICE_ID,
  AssemblyAITTSService,
  type AssemblyAITTSServiceOptions,
} from "../src/tts.ts";

type Dict = Record<string, any>;

// 80 ms of 24 kHz 16-bit mono audio per Audio frame, two frames per request.
const AUDIO_CHUNK = repeatBytes(new Uint8Array([0x01, 0x02]), 1920);
const CHUNK_MS = 80;
const WORD_MS = 50;

function repeatBytes(bytes: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(bytes.length * n);
  for (let i = 0; i < n; i++) out.set(bytes, i * bytes.length);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

interface Captured {
  messages: Dict[];
  connections?: number;
  connect_times?: number[];
  path?: string;
  auth?: string | null;
}

interface ServerOptions {
  word_boundaries?: boolean;
  stall_first_flush?: boolean;
  error_after_begin?: Dict | null;
  error_before_begin?: Dict | null;
  error_once?: boolean;
  configuration?: Dict | null;
  expires_in?: number;
}

interface ConnState {
  path: string;
  auth: string | null;
  flushId: number;
  sessionMs: number;
  buffer: string;
  stalled: boolean;
  closed: boolean;
}

type FakeServer = ReturnType<typeof Bun.serve>;

/**
 * Build a fake server following the documented Streaming TTS protocol.
 *
 * Each Flush is answered with two Audio frames, a FlushDone and (unless
 * `word_boundaries` is false) a WordBoundaries frame placing the request's
 * words on the session timeline. With `stall_first_flush` the first request
 * sends one Audio frame and then waits, so it is still in flight when the
 * client cancels it. `error_after_begin` ends every session (or only the
 * first, with `error_once`) with that Error; `error_before_begin` refuses
 * every session with it in place of Begin. `configuration` adds keys to
 * Begin's configuration, and `expires_in` sets the first session's
 * expires_at; later sessions last an hour.
 */
function serve(captured: Captured, options: ServerOptions = {}): FakeServer {
  const wordBoundaries = options.word_boundaries ?? true;
  const expiresIn = options.expires_in ?? 3600;
  return Bun.serve<ConnState, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const data: ConnState = {
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        flushId: 0,
        sessionMs: 0,
        buffer: "",
        stalled: options.stall_first_flush ?? false,
        closed: false,
      };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        captured.connections = (captured.connections ?? 0) + 1;
        captured.connect_times ??= [];
        captured.connect_times.push(performance.now() / 1000);
        captured.path = ws.data.path;
        captured.auth = ws.data.auth;
        const send = (m: Dict) => ws.send(JSON.stringify(m));
        const errorBeforeBegin = options.error_before_begin;
        if (errorBeforeBegin) {
          send({ type: "Error", ...errorBeforeBegin });
          ws.data.closed = true;
          ws.close(errorBeforeBegin.error_code, "See Error message for details");
          return;
        }
        send({
          type: "Begin",
          id: `session-${captured.connections}`,
          expires_at: Date.now() / 1000 + (captured.connections === 1 ? expiresIn : 3600),
          configuration: {
            voice: "jane",
            word_boundaries: wordBoundaries,
            ...(options.configuration ?? {}),
          },
        });
        const errorAfterBegin = options.error_after_begin;
        if (errorAfterBegin && !(options.error_once && captured.connections > 1)) {
          send({ type: "Error", ...errorAfterBegin });
          ws.data.closed = true;
          ws.close(errorAfterBegin.error_code, "See Error message for details");
        }
      },
      message(ws, raw) {
        if (ws.data.closed) return;
        const state = ws.data;
        const send = (m: Dict) => ws.send(JSON.stringify(m));
        const msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        ) as Dict;
        captured.messages.push(msg);
        if (msg.type === "Generate") {
          state.buffer += msg.text;
        } else if (msg.type === "Flush") {
          const audio = bytesToBase64(AUDIO_CHUNK);
          const frame = { type: "Audio", audio, flush_id: state.flushId };
          if (state.stalled) {
            state.stalled = false;
            send(frame);
            // Cancelled audio still holds its place on the timeline.
            state.sessionMs += CHUNK_MS;
            state.flushId += 1;
            state.buffer = "";
            return;
          }
          send(frame);
          send(frame);
          const duration = 2 * CHUNK_MS;
          send({ type: "FlushDone", flush_id: state.flushId, audio_duration_ms: duration });
          if (wordBoundaries) {
            const words = state.buffer
              .split(/\s+/)
              .filter((w) => w.length > 0)
              .map((word, i) => ({
                word,
                start: state.sessionMs + i * WORD_MS,
                end: state.sessionMs + (i + 1) * WORD_MS,
                confidence: 0.9,
              }));
            send({
              type: "WordBoundaries",
              flush_id: state.flushId,
              audio_start_ms: state.sessionMs,
              words,
            });
          }
          state.sessionMs += duration;
          state.flushId += 1;
          state.buffer = "";
        } else if (msg.type === "Cancel") {
          send({ type: "Cancelled", audio_duration_seconds: 0.08 });
          state.flushId += 1;
          state.buffer = "";
        } else if (msg.type === "Terminate") {
          send({
            type: "Termination",
            session_duration_seconds: 0,
            total_input_char_length: 0,
            audio_duration_seconds: 0.0,
          });
          state.closed = true;
          ws.close(1000, "Session ended");
        }
      },
    },
  });
}

async function withServer<T>(server: FakeServer, fn: (server: FakeServer) => Promise<T>) {
  try {
    return await fn(server);
  } finally {
    server.stop(true);
  }
}

function _service(
  server: FakeServer,
  options: Partial<AssemblyAITTSServiceOptions> = {},
): AssemblyAITTSService {
  const port = server.port;
  return new AssemblyAITTSService({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${port}/v1/ws`,
    sampleRate: 24000,
    ...options,
  });
}

function _sent(captured: Captured, msgType: string): Dict[] {
  return captured.messages.filter((m) => m.type === msgType);
}

const count = (frames: Frame[], cls: abstract new (...args: any[]) => Frame) =>
  frames.filter((f) => f instanceof cls).length;

test("test_speak_streams_audio_and_words", async () => {
  // A TTSSpeakFrame is sent as one flushed request and its audio and words come back.
  const captured: Captured = { messages: [] };
  const [downFrames, upFrames] = await withServer(serve(captured), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from AssemblyAI." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    }),
  );

  expect([...downFrames, ...upFrames].some((f) => f instanceof ErrorFrame)).toBe(false);
  expect(count(downFrames, TTSStartedFrame)).toEqual(1);
  expect(count(downFrames, TTSStoppedFrame)).toEqual(1);
  const audio = concatBytes(
    downFrames.filter((f) => f instanceof TTSAudioRawFrame).map((f) => f.audio),
  );
  expect(audio).toEqual(concatBytes([AUDIO_CHUNK, AUDIO_CHUNK]));
  const words = downFrames.filter((f) => f instanceof TTSTextFrame).map((f) => f.text);
  expect(words).toEqual(["Hello", "from", "AssemblyAI."]);

  // The key goes in the header raw, and the session is configured in the URL.
  expect(captured.auth).toEqual("test-key");
  const query = new URL(captured.path as string, "ws://x").searchParams;
  expect(query.getAll("sample_rate")).toEqual(["24000"]);
  expect(query.getAll("encoding")).toEqual(["pcm_s16le"]);
  expect(captured.messages.map((m) => m.type)).toEqual(["Generate", "Flush"]);
  expect(captured.connections).toEqual(1);
});

test("test_llm_turn_flushes_each_sentence_into_one_context", async () => {
  // Each sentence is its own request, and the turn's words stay in order.
  const captured: Captured = { messages: [] };
  const tokens = "Hi there! Thanks for calling. How can I help?".split(" ");
  const [downFrames] = await withServer(serve(captured), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        ...tokens.map((token) => new LLMTextFrame({ text: `${token} ` })),
        new LLMFullResponseEndFrame(),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    }),
  );

  const generates = _sent(captured, "Generate").map((m) => m.text);
  expect(generates).toEqual(["Hi there!", "Thanks for calling.", "How can I help?"]);
  expect(_sent(captured, "Flush").length).toEqual(3);

  expect(count(downFrames, TTSStartedFrame)).toEqual(1);
  expect(count(downFrames, TTSStoppedFrame)).toEqual(1);
  const wordFrames = downFrames.filter((f) => f instanceof TTSTextFrame);
  expect(wordFrames.map((f) => f.text)).toEqual(tokens);
  // Word times are on the session's timeline, measured from the turn's first audio.
  const pts = wordFrames.map((f) => f.pts as number);
  expect(pts).toEqual([...pts].sort((a, b) => a - b));
  expect((pts[2] as number) - (pts[0] as number)).toEqual(CHUNK_MS * 2 * 1_000_000);
});

test("test_missing_word_boundaries_still_close_the_context", async () => {
  // Without WordBoundaries the context closes after the grace period and keeps its text.
  const captured: Captured = { messages: [] };
  const [downFrames] = await withServer(serve(captured, { word_boundaries: false }), (server) => {
    const service = _service(server);
    (service as any)._wordBoundariesGraceS = 0.05;
    return runTest(service, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from AssemblyAI." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    });
  });

  expect(count(downFrames, TTSStoppedFrame)).toEqual(1);
  const text = downFrames
    .filter((f) => f instanceof TTSTextFrame)
    .map((f) => f.text)
    .join(" ");
  expect(text).toEqual("Hello from AssemblyAI.");
});

test("test_interruption_cancels_without_reconnecting", async () => {
  // An interruption sends Cancel, drops the cancelled audio and reuses the session.
  const captured: Captured = { messages: [] };
  let service!: AssemblyAITTSService;
  const [downFrames] = await withServer(serve(captured, { stall_first_flush: true }), (server) => {
    service = _service(server);
    return runTest(service, {
      framesToSend: [
        new TTSSpeakFrame({ text: "This reply gets cut off." }),
        new SleepFrame({ sleep: 0.2 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new TTSSpeakFrame({ text: "Go ahead." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    });
  });

  expect(_sent(captured, "Cancel").length).toEqual(1);
  expect(captured.connections).toEqual(1);
  const words = downFrames.filter((f) => f instanceof TTSTextFrame).map((f) => f.text);
  expect(words.slice(-2)).toEqual(["Go", "ahead."]);
  expect(service.getAudioContexts().length).toEqual(0);
});

test("test_interruption_after_synthesis_finished_sends_no_cancel", async () => {
  // Once every request has been answered there is nothing to cancel on the server.
  const captured: Captured = { messages: [] };
  await withServer(serve(captured), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from AssemblyAI." }),
        new SleepFrame({ sleep: 0.3 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
    }),
  );

  expect(_sent(captured, "Cancel").length).toEqual(0);
});

function _error(code: number, errorType: string | null, text: string, fields: Dict = {}): Dict {
  const error: Dict = { error_code: code, error: text };
  if (errorType) {
    Object.assign(error, { error_type: errorType, retryable: false, param: null });
  }
  Object.assign(error, fields);
  return error;
}

const errorTexts = (frames: Frame[]) =>
  frames.filter((f) => f instanceof ErrorFrame).map((f) => f.error);

test("test_missing_voice_makes_the_service_unusable", async () => {
  // A voice that can't be found fails the same way on every retry.
  const captured: Captured = { messages: [] };
  const error = _error(3012, "voice_not_found", "The requested voice was not found.", {
    param: "voice_id",
  });
  let service!: AssemblyAITTSService;
  const [, upFrames] = await withServer(
    serve(captured, { error_before_begin: error }),
    (server) => {
      service = _service(server, {
        settings: new AssemblyAITTSService.Settings({ voice: "nobody" }),
      });
      return runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.3 })] });
    },
  );

  expect(service.isUsable).toBe(false);
  expect(errorTexts(upFrames).some((e) => e.includes("3012 voice_not_found"))).toBe(true);
  expect(captured.connections).toEqual(1);
});

test("test_unspeakable_text_is_not_permanent", async () => {
  // A text the server can't split fails that text only; the service reconnects.
  const captured: Captured = { messages: [] };
  const error = _error(
    3006,
    "invalid_request",
    "Text contains a 900-character segment too long to synthesize. Add spaces or punctuation.",
  );
  let service!: AssemblyAITTSService;
  const [, upFrames] = await withServer(
    serve(captured, { error_after_begin: error, error_once: true }),
    (server) => {
      service = _service(server, { reconnectBackoffMinWait: 0, reconnectBackoffMaxWait: 0 });
      return runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.3 })] });
    },
  );

  expect(service.isUsable).toBe(true);
  expect(upFrames.some((f) => f instanceof ErrorFrame)).toBe(true);
  expect(captured.connections).toEqual(2);
});

test("test_rejected_key_makes_the_service_unusable", async () => {
  // A credential refused before Begin fails the same way on every retry.
  const captured: Captured = { messages: [] };
  const error = _error(1008, "unauthorized", "Unauthorized: Invalid API key");
  let service!: AssemblyAITTSService;
  const [, upFrames] = await withServer(
    serve(captured, { error_before_begin: error }),
    (server) => {
      service = _service(server);
      return runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.3 })] });
    },
  );

  expect(service.isUsable).toBe(false);
  expect(errorTexts(upFrames).some((e) => e.includes("1008 unauthorized"))).toBe(true);
  expect(captured.connections).toEqual(1);
});

test("test_error_without_error_type_after_begin_is_not_permanent", async () => {
  // An error after Begin is reported but left to the reconnect to settle.
  const captured: Captured = { messages: [] };
  const error = _error(3006, null, "Unsupported preset voice 'nobody'.");
  let service!: AssemblyAITTSService;
  const [, upFrames] = await withServer(
    serve(captured, { error_after_begin: error, error_once: true }),
    (server) => {
      service = _service(server);
      return runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.3 })] });
    },
  );

  expect(service.isUsable).toBe(true);
  expect(errorTexts(upFrames).some((e) => e.includes("error 3006: Unsupported"))).toBe(true);
  expect(captured.connections).toEqual(2);
});

test("test_routine_session_end_is_not_an_error", async () => {
  // An expired session reconnects without reporting an error.
  const captured: Captured = { messages: [] };
  const error = _error(
    3008,
    "session_expired",
    "Session reached its maximum duration; open a new connection to continue",
    { retryable: true },
  );
  const [, upFrames] = await withServer(
    serve(captured, { error_after_begin: error, error_once: true }),
    (server) => runTest(_service(server), { framesToSend: [new SleepFrame({ sleep: 0.3 })] }),
  );

  expect(upFrames.some((f) => f instanceof ErrorFrame)).toBe(false);
  expect(captured.connections).toEqual(2);
});

test("test_reconnect_waits_for_retry_after_seconds", async () => {
  // A retryable refusal is retried no sooner than the server asks.
  const captured: Captured = { messages: [] };
  const error = _error(
    3005,
    "at_capacity",
    "The TTS service is at capacity; please retry in 1 seconds.",
    { retryable: true, retry_after_seconds: 0.4 },
  );
  let service!: AssemblyAITTSService;
  await withServer(serve(captured, { error_after_begin: error, error_once: true }), (server) => {
    service = _service(server);
    return runTest(service, { framesToSend: [new SleepFrame({ sleep: 1.5 })] });
  });

  expect(service.isUsable).toBe(true);
  expect(captured.connect_times?.length).toEqual(2);
  const [first, second] = captured.connect_times as [number, number];
  expect(second - first).toBeGreaterThanOrEqual(0.4);
});

test("test_begin_limits_size_generate_messages", async () => {
  // Generate texts are split at the limit Begin reports and joined as sent.
  const captured: Captured = { messages: [] };
  const limits = { limits: { max_generate_text_length: 8 } };
  await withServer(serve(captured, { configuration: limits }), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new SleepFrame({ sleep: 0.1 }),
        new TTSSpeakFrame({ text: "Hello from AssemblyAI." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    }),
  );

  const generates: string[] = _sent(captured, "Generate").map((m) => m.text);
  expect(generates.every((text) => text.length <= 8)).toBe(true);
  expect(generates.join("")).toEqual("Hello from AssemblyAI.");
});

test("test_idle_session_is_kept_alive", async () => {
  // An idle session sends KeepAlive, since the server closes sessions that go quiet.
  const captured: Captured = { messages: [] };
  await withServer(serve(captured), (server) => {
    const service = _service(server);
    (service as any)._keepaliveIntervalS = 0.1;
    return runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.35 })] });
  });

  expect(_sent(captured, "KeepAlive").length).toBeGreaterThanOrEqual(2);
});

test("test_expiring_session_is_renewed_between_requests", async () => {
  // A session near expires_at is replaced before the next request, keeping the turn.
  const captured: Captured = { messages: [] };
  const [downFrames] = await withServer(serve(captured, { expires_in: 1.0 }), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new TTSSpeakFrame({ text: "First reply." }),
        new SleepFrame({ sleep: 0.8 }),
        new BotStoppedSpeakingFrame(),
        new TTSSpeakFrame({ text: "Second reply." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    }),
  );

  expect(captured.connections).toEqual(2);
  const words = downFrames.filter((f) => f instanceof TTSTextFrame).map((f) => f.text);
  expect(words).toEqual(["First", "reply.", "Second", "reply."]);
});

test("test_session_renewed_mid_turn_keeps_word_times", async () => {
  // A turn that spans a renewal keeps its word times measured from its first audio.
  const captured: Captured = { messages: [] };
  const tokens = ["Hi ", "there! ", "Thanks ", "for ", "calling. ", "Bye."];
  const [downFrames] = await withServer(serve(captured, { expires_in: 1.0 }), (server) =>
    runTest(_service(server), {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        ...tokens.slice(0, 3).map((token) => new LLMTextFrame({ text: token })),
        // The first sentence is spoken and the session nears expires_at.
        new SleepFrame({ sleep: 0.8 }),
        ...tokens.slice(3).map((token) => new LLMTextFrame({ text: token })),
        new LLMFullResponseEndFrame(),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    }),
  );

  expect(captured.connections).toEqual(2);
  const wordFrames = downFrames.filter((f) => f instanceof TTSTextFrame);
  expect(wordFrames.map((f) => f.text)).toEqual(tokens.map((token) => token.trim()));
  // Each sentence's words follow the audio of the sentences before it.
  const start = wordFrames[0]?.pts as number;
  const offsetsMs = wordFrames.map((f) => Math.floor(((f.pts as number) - start) / 1_000_000));
  expect(offsetsMs).toEqual([
    0,
    WORD_MS,
    2 * CHUNK_MS,
    2 * CHUNK_MS + WORD_MS,
    2 * CHUNK_MS + 2 * WORD_MS,
    4 * CHUNK_MS,
  ]);
});

test("test_context_recreated_after_quiet_timeout_restarts_word_times", async () => {
  // Words after a context times out mid-turn are timed from the recreated context's audio.
  const captured: Captured = { messages: [] };
  const wordTimes: (readonly [string, number])[] = [];
  const [downFrames] = await withServer(serve(captured), (server) => {
    const service = _service(server, { stopFrameTimeoutS: 0.3 });
    const addWordTimestamps = service.addWordTimestamps.bind(service);
    service.addWordTimestamps = async (times, contextId = null, options = {}) => {
      wordTimes.push(...times);
      await addWordTimestamps(times, contextId, options);
    };
    return runTest(service, {
      framesToSend: [
        new LLMFullResponseStartFrame(),
        new LLMTextFrame({ text: "Hi there! " }),
        new LLMTextFrame({ text: "Thanks " }),
        // The turn goes quiet for longer than stop_frame_timeout_s.
        new SleepFrame({ sleep: 0.8 }),
        new LLMTextFrame({ text: "for calling. " }),
        new LLMTextFrame({ text: "Bye." }),
        new LLMFullResponseEndFrame(),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    });
  });

  expect(count(downFrames, TTSStartedFrame)).toEqual(2);
  expect(wordTimes.map(([word]) => word)).toEqual([
    "Hi",
    "there!",
    "Thanks",
    "for",
    "calling.",
    "Bye.",
  ]);
  // The recreated context's words start again from zero.
  const offsetsMs = wordTimes.map(([, time]) => Math.round(time * 1000));
  expect(offsetsMs).toEqual([0, WORD_MS, 0, WORD_MS, 2 * WORD_MS, 2 * CHUNK_MS]);
});

function _query(service: AssemblyAITTSService): URLSearchParams {
  return new URL((service as any)._buildWebsocketUrl()).searchParams;
}

describe("sync", () => {
  test("test_language_is_sent_when_set", () => {
    const service = new AssemblyAITTSService({
      apiKey: "test-key",
      settings: new AssemblyAITTSService.Settings({ voice: "aai-jane", language: Language.ES }),
    });
    (service as any)._sampleRate = 16000;
    const query = _query(service);
    expect(query.getAll("voice_id")).toEqual(["aai-jane"]);
    expect(query.getAll("language")).toEqual(["spanish"]);
    expect(query.getAll("sample_rate")).toEqual(["16000"]);
  });

  test("test_language_enum_maps_to_language_name", () => {
    const service = new AssemblyAITTSService({
      apiKey: "test-key",
      settings: new AssemblyAITTSService.Settings({ language: Language.DE_DE }),
    });
    expect((service as any)._settings.language).toEqual("german");
  });

  test("test_default_voice_is_sent_and_language_is_left_to_the_server", () => {
    const service = new AssemblyAITTSService({ apiKey: "test-key" });
    (service as any)._sampleRate = 24000;
    const query = _query(service);
    expect(query.getAll("voice_id")).toEqual([_DEFAULT_VOICE_ID]);
    expect(query.has("language")).toBe(false);
  });

  test("test_voice_none_leaves_the_voice_to_the_server", () => {
    const service = new AssemblyAITTSService({
      apiKey: "test-key",
      settings: new AssemblyAITTSService.Settings({ voice: null }),
    });
    (service as any)._sampleRate = 24000;
    const query = _query(service);
    expect(query.has("voice_id")).toBe(false);
  });

  test("test_cloned_voice_and_model_are_sent", () => {
    const service = new AssemblyAITTSService({
      apiKey: "test-key",
      settings: new AssemblyAITTSService.Settings({
        voice: "01a142a4-66f3-7315-b15f-668b6edfb595",
        model: "assemblyai-tts-1",
      }),
    });
    (service as any)._sampleRate = 24000;
    const query = _query(service);
    expect(query.getAll("voice_id")).toEqual(["01a142a4-66f3-7315-b15f-668b6edfb595"]);
    expect(query.getAll("model_id")).toEqual(["assemblyai-tts-1"]);
    expect(query.has("voice")).toBe(false);
    expect(query.has("language")).toBe(false);
  });

  test("test_voice_id_key_sets_the_voice", () => {
    // A settings update keyed `voice_id`, as other services take it, sets the voice.
    const delta = AssemblyAITTSService.Settings.fromMapping({ voice_id: "aai-mary" });
    expect(delta.voice).toEqual("aai-mary");
  });
});
