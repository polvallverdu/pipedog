// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_xai_tts.py

/**
 * Tests for XAIHttpTTSService and XAITTSService.
 *
 * Porting notes:
 * - The aiohttp test server and the `websockets` server are `Bun.serve`
 *   servers on a free local port.
 * - `aiohttp_session=session` is not ported (the service takes an optional
 *   `fetch`), so the HTTP tests use the global `fetch`.
 * - `patch.object(tts_service, "_connect", AsyncMock())` → instance mocks.
 */

import { expect, mock, test } from "bun:test";
import {
  AggregatedTextFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import {
  _xaiWordTimes,
  XAIHttpTTSService,
  XAITTSService,
  XAITTSSettings,
  XAIWebsocketTTSSettings,
} from "../src/tts.ts";

type Dict = Record<string, any>;

function bytesOf(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** `parse_qs(urlparse(path).query)`. */
function parseQs(path: string | null): Record<string, string[]> {
  const params = new URL(path ?? "", "http://localhost").searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    out[key] = params.getAll(key);
  }
  return out;
}

function sleepAfterSpeak(duration: number): SleepFrame {
  return new SleepFrame({ sleep: duration });
}

/** An HTTP server that answers POST /v1/tts with `respond`, recording request bodies. */
async function withHttpServer<T>(
  respond: () => Response,
  fn: (baseUrl: string, bodies: Dict[]) => Promise<T>,
): Promise<T> {
  const bodies: Dict[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Dict);
      return respond();
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/v1/tts`, bodies);
  } finally {
    server.stop(true);
  }
}

interface Captured {
  requestPath: string | null;
  authHeader: string | null;
  messages: Dict[];
}

type WsHandler = (ws: { send(data: string): void }, msg: Dict) => void;

/** `async with serve(handler, ...)`: a WebSocket server running `handler` per message. */
async function withWsServer<T>(
  handler: WsHandler,
  fn: (baseUrl: string, captured: Captured) => Promise<T>,
): Promise<T> {
  const captured: Captured = { requestPath: null, authHeader: null, messages: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      captured.requestPath = `${url.pathname}${url.search}`;
      captured.authHeader = request.headers.get("Authorization");
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        captured.messages.push(msg);
        handler(ws, msg);
      },
    },
  });
  try {
    return await fn(`ws://127.0.0.1:${server.port}/v1/tts`, captured);
  } finally {
    server.stop(true);
  }
}

test("test_run_xai_tts_success", async () => {
  // xAI TTS should send the documented request body and emit PCM frames.
  const pcmAudio = bytesOf([0, 1, 2, 3], 1024);

  await withHttpServer(
    () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Split mid-sample to check that emitted frames stay sample-aligned.
          controller.enqueue(pcmAudio.slice(0, 2047));
          await Bun.sleep(10);
          controller.enqueue(pcmAudio.slice(2047));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "audio/pcm" } });
    },
    async (baseUrl, requestBodies) => {
      const ttsService = new XAIHttpTTSService({
        apiKey: "test-key",
        baseUrl,
        sampleRate: 24000,
      });

      const [downFrames] = await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello from xAI." })],
      });

      const frameTypes = downFrames.map((frame) => frame.constructor);
      expect(frameTypes).toContain(AggregatedTextFrame);
      expect(frameTypes).toContain(TTSStartedFrame);
      expect(frameTypes).toContain(TTSStoppedFrame);
      expect(frameTypes).toContain(TTSTextFrame);

      const audioFrames = downFrames.filter(
        (frame): frame is TTSAudioRawFrame => frame instanceof TTSAudioRawFrame,
      );
      expect(audioFrames.length).toBeGreaterThan(0);
      expect(audioFrames.every((frame) => frame.sampleRate === 24000)).toBe(true);
      expect(audioFrames.every((frame) => frame.numChannels === 1)).toBe(true);
      expect(audioFrames.every((frame) => frame.audio.length % 2 === 0)).toBe(true);
      expect(concat(audioFrames.map((frame) => frame.audio))).toEqual(pcmAudio);

      expect(requestBodies.length).toBe(1);
      expect(requestBodies[0]).toEqual({
        text: "Hello from xAI.",
        voice_id: "eve",
        language: "en",
        output_format: {
          codec: "pcm",
          sample_rate: 24000,
        },
      });
    },
  );
});

test("test_run_xai_websocket_tts_success", async () => {
  // xAI WS TTS should send text.delta+text.done and emit frames from audio.delta+audio.done.
  const audioBytes = bytesOf([0, 1, 2, 3], 1024);

  await withWsServer(
    (ws, msg) => {
      if (msg.type === "text.done") {
        ws.send(JSON.stringify({ type: "audio.delta", delta: b64(audioBytes) }));
        ws.send(JSON.stringify({ type: "audio.done", trace_id: "test-trace" }));
      }
    },
    async (baseUrl, captured) => {
      const ttsService = new XAITTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });

      const [downFrames] = await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello from xAI." }), sleepAfterSpeak(0.3)],
      });

      const frameTypes = downFrames.map((frame) => frame.constructor);
      expect(frameTypes).toContain(TTSStartedFrame);
      expect(frameTypes).toContain(TTSAudioRawFrame);
      expect(frameTypes).toContain(TTSStoppedFrame);

      const audioFrames = downFrames.filter(
        (frame): frame is TTSAudioRawFrame => frame instanceof TTSAudioRawFrame,
      );
      expect(audioFrames.length).toBeGreaterThan(0);
      expect(audioFrames.every((frame) => frame.sampleRate === 24000)).toBe(true);
      expect(audioFrames.every((frame) => frame.numChannels === 1)).toBe(true);
      expect(concat(audioFrames.map((frame) => frame.audio))).toEqual(audioBytes);

      expect(captured.authHeader).toBe("Bearer test-key");
      const query = parseQs(captured.requestPath);
      expect(query.voice).toEqual(["eve"]);
      expect(query.language).toEqual(["en"]);
      expect(query.codec).toEqual(["pcm"]);
      expect(query.sample_rate).toEqual(["24000"]);

      const typesSent = captured.messages.map((m) => m.type);
      expect(typesSent).toContain("text.delta");
      expect(typesSent).toContain("text.done");
      const deltaMsg = captured.messages.find((m) => m.type === "text.delta")!;
      // A trailing space is appended so consecutive sentence segments don't glue.
      expect(deltaMsg.delta).toBe("Hello from xAI. ");
    },
  );
});

test("test_xai_websocket_interruption_sends_text_clear", async () => {
  // On barge-in the WS service cancels via text.clear and keeps the socket open.
  const ttsService: any = new XAITTSService({ apiKey: "test-key", sampleRate: 24000 });

  const websocket = { state: State.OPEN, send: mock(async (_data: string) => {}) };
  ttsService._websocket = websocket;

  const connectSpy = mock(async () => {});
  const disconnectSpy = mock(async () => {});
  ttsService._connect = connectSpy;
  ttsService._disconnect = disconnectSpy;

  await ttsService.onAudioContextInterrupted("ctx-1");

  const sent = websocket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
  expect(sent).toContainEqual({ type: "text.clear" });
  expect(connectSpy).not.toHaveBeenCalled();
  expect(disconnectSpy).not.toHaveBeenCalled();
});

test("test_xai_websocket_settings_in_url", async () => {
  // Tunable settings appear as query params; booleans are lowercased for the URL.
  await withWsServer(
    (ws, msg) => {
      if (msg.type === "text.done") {
        ws.send(JSON.stringify({ type: "audio.done", trace_id: "t" }));
      }
    },
    async (baseUrl, captured) => {
      const ttsService = new XAITTSService({
        apiKey: "test-key",
        baseUrl,
        sampleRate: 24000,
        settings: new XAIWebsocketTTSSettings({
          speed: 1.2,
          optimizeStreamingLatency: 2,
          textNormalization: true,
          withTimestamps: false,
        }),
      });

      await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello from xAI." }), sleepAfterSpeak(0.3)],
      });

      const query = parseQs(captured.requestPath);
      expect(query.speed).toEqual(["1.2"]);
      expect(query.optimize_streaming_latency).toEqual(["2"]);
      expect(query.text_normalization).toEqual(["true"]);
      expect(query.with_timestamps).toEqual(["false"]);
    },
  );
});

test("test_xai_http_settings_in_body", async () => {
  // Tunable settings and language=auto appear in the HTTP request body.
  await withHttpServer(
    () =>
      new Response(bytesOf([0, 1, 2, 3], 1024), {
        status: 200,
        headers: { "Content-Type": "audio/pcm" },
      }),
    async (baseUrl, requestBodies) => {
      const ttsService = new XAIHttpTTSService({
        apiKey: "test-key",
        baseUrl,
        sampleRate: 24000,
        settings: new XAITTSSettings({
          language: "auto",
          speed: 1.2,
          optimizeStreamingLatency: 2,
          textNormalization: true,
        }),
      });

      await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello from xAI." })],
      });

      expect(requestBodies.length).toBe(1);
      const body = requestBodies[0]!;
      expect(body.language).toBe("auto");
      expect(body.speed).toBe(1.2);
      expect(body.optimize_streaming_latency).toBe(2);
      expect(body.text_normalization).toBe(true);
      expect("with_timestamps" in body).toBe(false);
    },
  );
});

test("test_xai_websocket_audio_clear_handled", async () => {
  // A server audio.clear ack is handled without producing an error.
  const audioBytes = bytesOf([0, 1, 2, 3], 1024);

  await withWsServer(
    (ws, msg) => {
      if (msg.type === "text.done") {
        ws.send(JSON.stringify({ type: "audio.clear" }));
        ws.send(JSON.stringify({ type: "audio.delta", delta: b64(audioBytes) }));
        ws.send(JSON.stringify({ type: "audio.done", trace_id: "t" }));
      }
    },
    async (baseUrl) => {
      const ttsService = new XAITTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });

      const [downFrames, upFrames] = await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello from xAI." }), sleepAfterSpeak(0.3)],
      });

      expect([...downFrames, ...upFrames].some((frame) => frame instanceof ErrorFrame)).toBe(false);
    },
  );
});

test("test_xai_word_times_splits_and_carries_partials", () => {
  // Character timings convert to absolute word starts, carrying partials across chunks.
  // Chunk 1: "Hi there" — "there" has no terminating space, so it is partial.
  const chars = ["H", "i", " ", "t", "h", "e", "r", "e"];
  const times = chars.map((_, i) => [i * 0.1, (i + 1) * 0.1]);
  const [wordTimes, partial, partialStart] = _xaiWordTimes(chars, times);
  expect(wordTimes).toEqual([["Hi", 0.0]]);
  expect(partial).toBe("there");
  expect(partialStart).toBeCloseTo(0.3);

  // Chunk 2: "! ok" — finishes "there!" then starts a new partial "ok". xAI
  // times are absolute across the utterance, so they are used as-is (no offset).
  const chars2 = ["!", " ", "o", "k"];
  const times2 = [
    [2.0, 2.05],
    [2.05, 2.1],
    [2.1, 2.15],
    [2.15, 2.2],
  ];
  const [wordTimes2, partial2, partial2Start] = _xaiWordTimes(
    chars2,
    times2,
    partial,
    partialStart,
  );
  expect(wordTimes2.length).toBe(1);
  expect(wordTimes2[0]![0]).toBe("there!");
  expect(wordTimes2[0]![1]).toBeCloseTo(0.3);
  expect(partial2).toBe("ok");
  expect(partial2Start).toBeCloseTo(2.1);
});

test("test_xai_word_times_length_mismatch_is_safe", () => {
  // A chars/times length mismatch yields no words and preserves the partial.
  const [wordTimes, partial, partialStart] = _xaiWordTimes(["a", "b"], [[0.0, 0.1]], "x", 1.0);
  expect(wordTimes).toEqual([]);
  expect(partial).toBe("x");
  expect(partialStart).toBe(1.0);
});

function textOf(frames: Frame[]): string {
  return frames
    .filter((frame): frame is TTSTextFrame => frame instanceof TTSTextFrame)
    .map((frame) => frame.text)
    .join("");
}

test("test_xai_websocket_emits_word_timestamps", async () => {
  // With withTimestamps enabled, the WS service emits TTSTextFrames per word.
  const audioBytes = bytesOf([0, 1, 2, 3], 1024);
  const chars = [..."Hello world"];
  const times = chars.map((_, i) => [i * 0.1, (i + 1) * 0.1]);

  await withWsServer(
    (ws, msg) => {
      if (msg.type === "text.done") {
        ws.send(
          JSON.stringify({
            type: "audio.delta",
            delta: b64(audioBytes),
            audio_timestamps: { graph_chars: chars, graph_times: times },
            audio_duration: 1.1,
          }),
        );
        ws.send(JSON.stringify({ type: "audio.done", trace_id: "t" }));
      }
    },
    async (baseUrl) => {
      const ttsService = new XAITTSService({
        apiKey: "test-key",
        baseUrl,
        sampleRate: 24000,
        settings: new XAIWebsocketTTSSettings({ withTimestamps: true }),
      });

      const [downFrames] = await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello world" }), sleepAfterSpeak(0.3)],
      });

      const joined = textOf(downFrames);
      expect(joined).toContain("Hello");
      expect(joined).toContain("world");
    },
  );
});

test("test_xai_websocket_word_timestamps_from_audioless_delta", async () => {
  // xAI sends timestamps in their own (audio-less) deltas; they must still emit words.
  const audioBytes = bytesOf([0, 1, 2, 3], 1024);
  const chars = [..."Hi there"];
  const times = chars.map((_, i) => [i * 0.1, (i + 1) * 0.1]);

  await withWsServer(
    (ws, msg) => {
      if (msg.type === "text.done") {
        // Audio arrives first with no timestamps...
        ws.send(JSON.stringify({ type: "audio.delta", delta: b64(audioBytes) }));
        // ...then timestamps arrive in a delta carrying no audio.
        ws.send(
          JSON.stringify({
            type: "audio.delta",
            delta: "",
            audio_timestamps: { graph_chars: chars, graph_times: times },
          }),
        );
        ws.send(JSON.stringify({ type: "audio.done", trace_id: "t" }));
      }
    },
    async (baseUrl) => {
      const ttsService = new XAITTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });

      const [downFrames] = await runTest(ttsService, {
        framesToSend: [new TTSSpeakFrame({ text: "Hi there" }), sleepAfterSpeak(0.3)],
      });

      const joined = textOf(downFrames);
      expect(joined).toContain("Hi");
      expect(joined).toContain("there");
    },
  );
});
