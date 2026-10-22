// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_bland_tts.py

/**
 * Tests for BlandTTSService and BlandHttpTTSService.
 *
 * Porting notes:
 * - The `websockets` server and the aiohttp test server are `Bun.serve` servers on a free
 *   local port. A `Bun.serve` WebSocket handler is per-message, so the per-connection
 *   flow of upstream's handlers is a `message` callback over a per-connection `data` object.
 * - `aiohttp_session=session` is not ported (the HTTP service takes an optional `fetch`),
 *   so the HTTP tests use the global `fetch`.
 * - `patch("pipecat.services.bland.tts._READY_TIMEOUT_SECONDS", 0.05)` sets the
 *   `_readyTimeout` instance field (ES module bindings can't be patched).
 * - `AsyncMock()` is `mock(async () => ...)`; `logger.add(sink, level="WARNING")` is
 *   `logger.addSink`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { CancelledError } from "@pipedog/asyncio";
import {
  BotStoppedSpeakingFrame,
  ErrorFrame,
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { BlandHttpTTSService, BlandTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

const DEFAULT_VOICE_ID = "29158307-9893-4149-8a75-bc9ce313d64e";
const OTHER_VOICE_ID = "c18a1cd5-91ef-4b06-841a-e58b8b487e8c";

const AUDIO_CHUNK_1 = new Uint8Array(1024).map((_, i) => (i % 2 === 0 ? 0 : 1));
const AUDIO_CHUNK_2 = new Uint8Array(1024).map((_, i) => (i % 2 === 0 ? 2 : 3));

/** Bare little-endian int16 PCM, which is what `container: raw` returns. */
function pcmBytes(numSamples = 4096): Uint8Array {
  const out = new Uint8Array(numSamples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 2000) - 1000, true);
  }
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

function audioOf(frames: Frame[]): Uint8Array {
  return concat(
    frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame).map((f) => f.audio),
  );
}

const sinkCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of sinkCleanups.splice(0)) cleanup();
});

// --- /v2/tts/ws ----------------------------------------------------------------------

interface Captured {
  messages: Dict[];
  authHeader?: string | null;
  sessions?: number;
  startedContexts?: Set<string>;
  doneSent?: boolean;
  [key: string]: any;
}

type Ws = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

interface ConnState {
  session: number;
}

/**
 * `async with serve(handler, ...)`: a WebSocket server running `onMessage` per message.
 * `onOpen` runs once per connection, after `captured.sessions` is incremented.
 */
async function withWsServer<T>(
  captured: Captured,
  handlers: {
    onOpen?: (ws: Ws, state: ConnState) => void;
    onMessage: (ws: Ws, msg: Dict, state: ConnState) => void;
  },
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve<ConnState>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      captured.authHeader = request.headers.get("Authorization");
      captured.sessions = (captured.sessions ?? 0) + 1;
      if (srv.upgrade(request, { data: { session: captured.sessions } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        handlers.onOpen?.(ws, ws.data);
      },
      message(ws, raw) {
        const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        handlers.onMessage(ws, msg, ws.data);
      },
    },
  });
  try {
    return await fn(`ws://127.0.0.1:${server.port}/v2/tts/ws`);
  } finally {
    server.stop(true);
  }
}

/** Build a fake Bland realtime server following the documented turn flow. */
function wsServerHandler(
  captured: Captured,
  options: {
    initError?: Dict | null;
    turnError?: Dict | null;
    endReason?: string;
    readyEncoding?: string;
    readySampleRate?: number | null;
    acknowledgeInit?: boolean;
  } = {},
) {
  const {
    initError = null,
    turnError = null,
    endReason = "complete",
    readyEncoding = "pcm_s16le",
    readySampleRate = null,
    acknowledgeInit = true,
  } = options;

  return {
    onMessage(ws: Ws, msg: Dict) {
      captured.messages.push(msg);
      const msgType = msg.type;

      if (msgType === "init") {
        if (initError !== null) {
          ws.send(JSON.stringify({ type: "error", ...initError }));
          ws.close();
          return;
        }
        if (!acknowledgeInit) {
          return;
        }
        const requestedRate = msg.audio?.sample_rate ?? 48000;
        ws.send(
          JSON.stringify({
            type: "ready",
            session_id: "test-session",
            encoding: readyEncoding,
            sample_rate: readySampleRate !== null ? readySampleRate : requestedRate,
          }),
        );
      } else if (msgType === "speak") {
        const contextId = msg.context_id;
        if (turnError !== null) {
          ws.send(JSON.stringify({ type: "error", context_id: contextId, ...turnError }));
          return;
        }
        captured.startedContexts ??= new Set();
        if (!captured.startedContexts.has(contextId)) {
          captured.startedContexts.add(contextId);
          ws.send(JSON.stringify({ type: "utterance_start", context_id: contextId }));
        }
      } else if (msgType === "end_of_turn") {
        const contextId = msg.context_id;
        if (turnError !== null) {
          return;
        }
        ws.send(AUDIO_CHUNK_1);
        ws.send(AUDIO_CHUNK_2);
        ws.send(
          JSON.stringify({
            type: "utterance_end",
            context_id: contextId,
            reason: endReason,
            frames: 2,
            duration_ms: 100,
          }),
        );
      } else if (msgType === "close") {
        ws.send(JSON.stringify({ type: "done", session_id: "test-session" }));
        captured.doneSent = true;
        ws.close();
      }
    },
  };
}

function ofType(captured: Captured, type: string): Dict[] {
  return captured.messages.filter((m) => m.type === type);
}

function errorsOf(down: Frame[], up: Frame[]): ErrorFrame[] {
  return [...down, ...up].filter((f): f is ErrorFrame => f instanceof ErrorFrame);
}

describe("TestBlandTTSService", () => {
  test("test_bland_tts_protocol_roundtrip", async () => {
    // init/speak/end_of_turn are sent, and the turn's audio is emitted.
    const captured: Captured = { messages: [] };

    const [downFrames, upFrames] = await withWsServer(
      captured,
      wsServerHandler(captured),
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

        return await runTest(tts, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hello from Bland." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
      },
    );

    const frameTypes = downFrames.map((frame) => frame.constructor);
    expect(frameTypes).toContain(TTSStartedFrame);
    expect(frameTypes).toContain(TTSAudioRawFrame);
    expect(frameTypes).toContain(TTSStoppedFrame);
    expect(errorsOf(downFrames, upFrames).length).toBe(0);

    const audioFrames = downFrames.filter(
      (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
    );
    expect(audioFrames.every((frame) => frame.sampleRate === 24000)).toBe(true);
    expect(audioFrames.every((frame) => frame.numChannels === 1)).toBe(true);
    expect(audioOf(downFrames)).toEqual(concat([AUDIO_CHUNK_1, AUDIO_CHUNK_2]));

    expect(captured.authHeader).toBe("Bearer test-key");
    const init = ofType(captured, "init")[0]!;
    expect(init.voice).toBe(DEFAULT_VOICE_ID);
    expect(init.audio).toEqual({ encoding: "pcm_s16le", sample_rate: 24000 });
    expect("controls" in init).toBe(false);
    expect("auto_formatting" in init).toBe(false);

    const speak = ofType(captured, "speak")[0]!;
    const endOfTurn = ofType(captured, "end_of_turn")[0]!;
    expect(speak.text).toBe("Hello from Bland.");
    // the turn is ended under the id its deltas were sent with
    expect(endOfTurn.context_id).toBe(speak.context_id);
  });

  test("test_bland_tts_token_streaming_sends_tokens_verbatim", async () => {
    // In the default TOKEN mode, LLM tokens map 1:1 to speak messages, unaltered.
    const captured: Captured = { messages: [] };

    const [downFrames, upFrames] = await withWsServer(
      captured,
      wsServerHandler(captured),
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

        return await runTest(tts, {
          framesToSend: [
            new LLMFullResponseStartFrame(),
            new LLMTextFrame({ text: "Unbelieva" }),
            new LLMTextFrame({ text: "ble" }),
            new LLMTextFrame({ text: " isn't it?" }),
            new LLMFullResponseEndFrame(),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
      },
    );

    expect(errorsOf(downFrames, upFrames).length).toBe(0);
    expect(downFrames.some((frame) => frame instanceof TTSAudioRawFrame)).toBe(true);

    const speaks = ofType(captured, "speak");
    // Bland appends each delta verbatim, so an inserted space would split words.
    expect(speaks.map((m) => m.text)).toEqual(["Unbelieva", "ble", " isn't it?"]);
    // every delta of one response belongs to one turn, ended once
    expect(new Set(speaks.map((m) => m.context_id)).size).toBe(1);
    expect(ofType(captured, "end_of_turn").length).toBe(1);
  });

  test("test_bland_tts_sentence_mode_appends_trailing_space", async () => {
    // In SENTENCE mode a trailing space separates consecutive generations.
    const captured: Captured = { messages: [] };

    const [downFrames, upFrames] = await withWsServer(
      captured,
      wsServerHandler(captured),
      async (url) => {
        const tts = new BlandTTSService({
          apiKey: "test-key",
          url,
          sampleRate: 24000,
          textAggregationMode: TextAggregationMode.SENTENCE,
        });

        return await runTest(tts, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hello from Bland." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
      },
    );

    expect(errorsOf(downFrames, upFrames).length).toBe(0);
    expect(ofType(captured, "speak")[0]!.text).toBe("Hello from Bland. ");
  });

  test("test_bland_tts_init_carries_controls", async () => {
    // Voice and controls are fixed at init for the life of the session.
    const captured: Captured = { messages: [] };

    await withWsServer(captured, wsServerHandler(captured), async (url) => {
      const tts = new BlandTTSService({
        apiKey: "test-key",
        url,
        sampleRate: 24000,
        settings: new BlandTTSService.Settings({
          voice: OTHER_VOICE_ID,
          expressiveness: 0.9,
          stability: 0.4,
        }),
      });

      await runTest(tts, { framesToSend: [] });
    });

    const init = ofType(captured, "init")[0]!;
    expect(init.voice).toBe(OTHER_VOICE_ID);
    expect(init.controls).toEqual({ expressiveness: 0.9, stability: 0.4 });
  });

  test("test_bland_tts_partial_controls", async () => {
    // Only controls the caller set are sent, so unset ones keep Bland's defaults.
    const captured: Captured = { messages: [] };

    await withWsServer(captured, wsServerHandler(captured), async (url) => {
      const tts = new BlandTTSService({
        apiKey: "test-key",
        url,
        sampleRate: 24000,
        settings: new BlandTTSService.Settings({ stability: 0.4 }),
      });

      await runTest(tts, { framesToSend: [] });
    });

    expect(ofType(captured, "init")[0]!.controls).toEqual({ stability: 0.4 });
  });

  test("test_bland_tts_init_carries_auto_formatting", async () => {
    // auto_formatting is fixed at init, like the controls.
    const captured: Captured = { messages: [] };

    await withWsServer(captured, wsServerHandler(captured), async (url) => {
      const tts = new BlandTTSService({
        apiKey: "test-key",
        url,
        sampleRate: 24000,
        settings: new BlandTTSService.Settings({ autoFormatting: true }),
      });

      await runTest(tts, { framesToSend: [] });
    });

    const init = ofType(captured, "init")[0]!;
    expect(init.auto_formatting).toBe(true);
    expect("controls" in init).toBe(false);
  });

  test("test_bland_tts_auto_formatting_update_reconnects", async () => {
    // Changing auto_formatting opens a new session, since init fixes it.
    const captured: Captured = { messages: [] };

    await withWsServer(captured, wsServerHandler(captured), async (url) => {
      const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

      await runTest(tts, {
        framesToSend: [
          new TTSUpdateSettingsFrame({
            delta: new BlandTTSService.Settings({ autoFormatting: true }),
          }),
          new SleepFrame({ sleep: 0.3 }),
        ],
      });
    });

    const inits = ofType(captured, "init");
    expect(inits.length).toBe(2);
    expect("auto_formatting" in inits[0]!).toBe(false);
    expect(inits[1]!.auto_formatting).toBe(true);
  });

  test("test_bland_tts_unsupported_pipeline_rate_falls_back", async () => {
    // A rate Bland cannot render is replaced by its native 48 kHz.
    const captured: Captured = { messages: [] };
    const lines: string[] = [];
    const remove = logger.addSink((record) => {
      if (record.level === "WARNING" || record.level === "ERROR") lines.push(record.message);
    });
    sinkCleanups.push(remove);

    let downFrames: Frame[];
    try {
      [downFrames] = await withWsServer(captured, wsServerHandler(captured), async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 22050 });

        return await runTest(tts, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hi." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
      });
    } finally {
      remove();
    }

    // The substitution is never silent: a pipeline running at a rate Bland
    // cannot render pays a resample, and the log says so.
    const logged = lines.join("\n");
    expect(logged.includes("22050") && logged.includes("48000")).toBe(true);
    expect(ofType(captured, "init")[0]!.audio.sample_rate).toBe(48000);
    const audioFrames = downFrames.filter(
      (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
    );
    // frames are tagged with the rate Bland actually rendered; the output
    // transport resamples to the pipeline rate
    expect(audioFrames.every((frame) => frame.sampleRate === 48000)).toBe(true);
  });

  test("test_bland_tts_interruption_cancels_without_reconnecting", async () => {
    // Barge-in sends cancel, so the session and its warm voice survive.
    const tts = new BlandTTSService({ apiKey: "test-key", sampleRate: 24000 });

    const websocket = { send: mock(async (_msg: string) => {}), close: mock(async () => {}) };
    tts._websocket = websocket as never;

    await tts.onAudioContextInterrupted("turn-17");

    const sent = websocket.send.mock.calls.map((call) => JSON.parse(call[0]));
    expect(sent).toEqual([{ type: "cancel", context_id: "turn-17" }]);
    expect(websocket.close).not.toHaveBeenCalled();
  });

  test("test_bland_tts_interruption_cancels_the_turn", async () => {
    // An interrupted turn is cancelled on the server without closing the session.
    const tts = new BlandTTSService({ apiKey: "test-key", sampleRate: 24000 });

    const websocket = { send: mock(async (_msg: string) => {}), close: mock(async () => {}) };
    tts._websocket = websocket as never;

    await tts.onAudioContextInterrupted("turn-17");

    const sent = websocket.send.mock.calls.map((call) => JSON.parse(call[0]));
    expect(sent).toEqual([{ type: "cancel", context_id: "turn-17" }]);
  });

  for (const code of ["insufficient_credits", "rate_limited"]) {
    test(`test_bland_tts_turn_error_surfaces[${code}]`, async () => {
      // A turn-scoped error frame becomes an ErrorFrame carrying code and message.
      const captured: Captured = { messages: [] };
      const error = { code, message: "Turn admission refused." };

      const [tts, downFrames, upFrames] = await withWsServer(
        captured,
        wsServerHandler(captured, { turnError: error }),
        async (url) => {
          const service = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

          const [down, up] = await runTest(service, {
            framesToSend: [
              new TTSSpeakFrame({ text: "Hi." }),
              new SleepFrame({ sleep: 0.3 }),
              new BotStoppedSpeakingFrame(),
            ],
          });
          return [service, down, up] as const;
        },
      );

      const errors = errorsOf(downFrames, upFrames);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.error).toContain(code);
      expect(errors[0]!.error).toContain("Turn admission refused.");
      expect(tts.getAudioContexts()).toEqual([]);
    });
  }

  test("test_bland_tts_failed_turn_surfaces", async () => {
    // A turn that ends as `failed` is closed rather than left waiting for audio.
    const captured: Captured = { messages: [] };

    const [tts, downFrames] = await withWsServer(
      captured,
      wsServerHandler(captured, { endReason: "failed" }),
      async (url) => {
        const service = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

        const [down] = await runTest(service, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hi." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
        return [service, down] as const;
      },
    );

    expect(downFrames.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
    expect(tts.getAudioContexts()).toEqual([]);
  });

  test("test_bland_tts_server_preemption_releases_audio_context", async () => {
    // A server-side terminal cleans up even if Pipecat did not interrupt first.
    const captured: Captured = { messages: [] };

    const tts = await withWsServer(
      captured,
      wsServerHandler(captured, { endReason: "preempted" }),
      async (url) => {
        const service = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
        await runTest(service, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hi." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
        return service;
      },
    );

    expect(tts.getAudioContexts()).toEqual([]);
  });

  test("test_bland_tts_rejected_init_surfaces", async () => {
    // A session Bland refuses fails at connect, not on the first turn.
    const captured: Captured = { messages: [] };
    const error = { code: "voice_not_found", message: "Voice was not found." };

    const [downFrames, upFrames] = await withWsServer(
      captured,
      wsServerHandler(captured, { initError: error }),
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

        return await runTest(tts, { framesToSend: [] });
      },
    );

    const errors = errorsOf(downFrames, upFrames);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.error).toContain("voice_not_found");
  });

  test("test_bland_tts_init_timeout_closes_provisional_connection", async () => {
    // A peer that upgrades but never acknowledges init cannot hang startup.
    const captured: Captured = { messages: [] };

    const [downFrames, upFrames] = await withWsServer(
      captured,
      wsServerHandler(captured, { acknowledgeInit: false }),
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
        tts["_readyTimeout"] = 0.05;
        return await runTest(tts, { framesToSend: [] });
      },
    );

    const errors = errorsOf(downFrames, upFrames);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("test_bland_tts_cancelled_init_closes_provisional_connection", async () => {
    // Task cancellation during init must not leak the upgraded socket.
    const tts = new BlandTTSService({ apiKey: "test-key" });
    // Connecting reads the rate setup() resolves, and this test has no setup.
    tts["_blandSampleRate"] = 48000;
    const websocket = {
      state: State.OPEN,
      send: mock(async (_msg: string) => {}),
      recv: mock(async () => {
        throw new CancelledError();
      }),
      close: mock(async () => {}),
    };
    tts._websocketConnect = mock(async () => websocket as never);

    await expect(tts._connectWebsocket()).rejects.toBeInstanceOf(CancelledError);

    expect(websocket.close).toHaveBeenCalledTimes(1);
  });

  for (const [name, Service] of [
    ["BlandTTSService", BlandTTSService],
    ["BlandHttpTTSService", BlandHttpTTSService],
  ] as const) {
    test(`test_bland_tts_requires_nonempty_api_key[${name}]`, () => {
      expect(() => new Service({ apiKey: "" })).toThrow(/API key/);
    });
  }

  const mismatched: [string, number][] = [
    ["mulaw", 24000],
    ["pcm_s16le", 16000],
  ];
  for (const [encoding, sampleRate] of mismatched) {
    test(`test_bland_tts_rejects_mismatched_ready_format[${encoding}-${sampleRate}]`, async () => {
      // Audio must never be tagged with a format the server did not acknowledge.
      const captured: Captured = { messages: [] };

      const [downFrames, upFrames] = await withWsServer(
        captured,
        wsServerHandler(captured, { readyEncoding: encoding, readySampleRate: sampleRate }),
        async (url) => {
          const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
          return await runTest(tts, { framesToSend: [] });
        },
      );

      const errors = errorsOf(downFrames, upFrames);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.error).toContain("unexpected audio format");
    });
  }

  test("test_bland_tts_close_settles_the_session", async () => {
    // Shutdown asks Bland to settle usage instead of dropping the socket.
    const captured: Captured = { messages: [] };

    await withWsServer(captured, wsServerHandler(captured), async (url) => {
      const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

      await runTest(tts, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Hi." }),
          new SleepFrame({ sleep: 0.3 }),
          new BotStoppedSpeakingFrame(),
        ],
      });
    });

    expect(ofType(captured, "close").length).toBe(1);
    expect(captured.doneSent).toBe(true);
    expect(captured.sessions).toBe(1);
  });
});

// --- /v2/tts -------------------------------------------------------------------------

/** An HTTP server answering POST /v2/tts with `respond`, recording headers and bodies. */
async function withHttpServer<T>(
  respond: () => Response,
  fn: (baseUrl: string, requests: { auth: string | null; body: Dict }[]) => Promise<T>,
): Promise<T> {
  const requests: { auth: string | null; body: Dict }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v2/tts")
        return new Response("not found", { status: 404 });
      requests.push({
        auth: request.headers.get("Authorization"),
        body: (await request.json()) as Dict,
      });
      return respond();
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/v2`, requests);
  } finally {
    server.stop(true);
  }
}

describe("TestBlandHttpTTSService", () => {
  test("test_run_bland_http_tts_success", async () => {
    // Sends the documented request and emits PCM frames from the response.
    const payload = pcmBytes();

    await withHttpServer(
      () => new Response(payload, { headers: { "Content-Type": "audio/pcm" } }),
      async (baseUrl, requests) => {
        const tts = new BlandHttpTTSService({
          apiKey: "test-key",
          baseUrl: `${baseUrl}/`,
          sampleRate: 24000,
        });
        const [downFrames] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hello from Bland." })],
        });

        const frameTypes = downFrames.map((f) => f.constructor);
        expect(frameTypes).toContain(TTSStartedFrame);
        expect(frameTypes).toContain(TTSStoppedFrame);

        const { auth, body } = requests[0]!;
        expect(auth).toBe("Bearer test-key");
        expect(body.text).toBe("Hello from Bland.");
        expect(body.voice).toBe(DEFAULT_VOICE_ID);
        // 24000 is a rate Bland renders directly, so it is requested as-is.
        expect(body.audio).toEqual({
          encoding: "pcm_s16le",
          sample_rate: 24000,
          container: "raw",
        });
        expect("controls" in body).toBe(false);
        expect("auto_formatting" in body).toBe(false);
        // fields the request shape does not define
        expect("language" in body).toBe(false);
        expect("output_format" in body).toBe(false);
        expect("voice_id" in body).toBe(false);

        const audio = audioOf(downFrames);
        expect(audio).toEqual(payload);
        expect(String.fromCharCode(...audio.slice(0, 4))).not.toBe("RIFF");
        expect(
          new Set(
            downFrames
              .filter((f) => f instanceof TTSAudioRawFrame)
              .map((f) => (f as TTSAudioRawFrame).sampleRate),
          ),
        ).toEqual(new Set([24000]));
      },
    );
  });

  test("test_bland_http_tts_sends_auto_formatting", async () => {
    // auto_formatting reaches the /v2/tts body when set.
    await withHttpServer(
      () => new Response(pcmBytes(), { headers: { "Content-Type": "audio/pcm" } }),
      async (baseUrl, requests) => {
        const tts = new BlandHttpTTSService({
          apiKey: "test-key",
          baseUrl,
          sampleRate: 24000,
          settings: new BlandHttpTTSService.Settings({ autoFormatting: true }),
        });
        await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Call 7327412065." })] });

        expect(requests[0]!.body.auto_formatting).toBe(true);
      },
    );
  });

  test("test_bland_http_tts_resamples_unsupported_pipeline_rate", async () => {
    // A pipeline rate Bland cannot emit falls back to 48 kHz and is resampled down.
    const payload = pcmBytes(4800);

    await withHttpServer(
      () => new Response(payload, { headers: { "Content-Type": "audio/pcm" } }),
      async (baseUrl, requests) => {
        const tts = new BlandHttpTTSService({ apiKey: "test-key", baseUrl, sampleRate: 22050 });
        const [downFrames] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });

        expect(requests[0]!.body.audio.sample_rate).toBe(48000);
        const audio = audioOf(downFrames);
        expect(audio.length).toBeGreaterThan(0);
        expect(audio).not.toEqual(payload);
        expect(
          new Set(
            downFrames
              .filter((f) => f instanceof TTSAudioRawFrame)
              .map((f) => (f as TTSAudioRawFrame).sampleRate),
          ),
        ).toEqual(new Set([22050]));
      },
    );
  });

  test("test_bland_http_tts_reassembles_audio_split_across_chunks", async () => {
    // A split at an odd byte lands mid-sample; nothing may be dropped or reordered.
    const payload = pcmBytes();
    const splits = [1, 3, 1000, 2001, payload.length];

    await withHttpServer(
      () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let start = 0;
            for (const end of splits) {
              controller.enqueue(payload.slice(start, end));
              start = end;
              await Bun.sleep(5);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "audio/pcm" } });
      },
      async (baseUrl) => {
        const tts = new BlandHttpTTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });
        const [downFrames] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });

        expect(audioOf(downFrames)).toEqual(payload);
      },
    );
  });

  test("test_bland_http_tts_settings_payload", async () => {
    // Settings map into the request body.
    await withHttpServer(
      () => new Response(pcmBytes(), { headers: { "Content-Type": "audio/pcm" } }),
      async (baseUrl, requests) => {
        const tts = new BlandHttpTTSService({
          apiKey: "test-key",
          baseUrl,
          sampleRate: 24000,
          settings: new BlandHttpTTSService.Settings({
            voice: OTHER_VOICE_ID,
            expressiveness: 0.9,
            stability: 0.4,
          }),
        });
        await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });

        const body = requests[0]!.body;
        expect(body.voice).toBe(OTHER_VOICE_ID);
        expect(body.controls).toEqual({ expressiveness: 0.9, stability: 0.4 });
      },
    );
  });

  test("test_bland_http_tts_partial_controls", async () => {
    // Only controls the caller set are sent, so unset ones keep Bland's defaults.
    await withHttpServer(
      () => new Response(pcmBytes(), { headers: { "Content-Type": "audio/pcm" } }),
      async (baseUrl, requests) => {
        const tts = new BlandHttpTTSService({
          apiKey: "test-key",
          baseUrl,
          sampleRate: 24000,
          settings: new BlandHttpTTSService.Settings({ stability: 0.4 }),
        });
        await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });

        expect(requests[0]!.body.controls).toEqual({ stability: 0.4 });
      },
    );
  });

  test("test_bland_http_tts_error_response", async () => {
    // A non-200 response yields an ErrorFrame carrying the v2 error code and message.
    await withHttpServer(
      () =>
        Response.json(
          { error: { code: "voice_not_found", message: "Voice was not found." } },
          { status: 404 },
        ),
      async (baseUrl) => {
        const tts = new BlandHttpTTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });
        const [, upFrames] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });

        const errors = upFrames.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]!.error).toContain("voice_not_found");
        expect(errors[0]!.error).toContain("Voice was not found.");
      },
    );
  });

  test("test_bland_http_tts_non_json_error_response", async () => {
    // A gateway error with an HTML body still surfaces as an ErrorFrame.
    await withHttpServer(
      () =>
        new Response("<html>gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      async (baseUrl) => {
        const tts = new BlandHttpTTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });
        const [, upFrames] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });

        const errors = upFrames.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]!.error).toContain("502");
      },
    );
  });
});

// --- turns that cannot finish --------------------------------------------------------

/**
 * Refuses admission for the turn's context, once, as the server does.
 *
 * A refused context is recorded and its later deltas dropped silently.
 */
function refusingServer(captured: Captured, code = "insufficient_credits") {
  return {
    onMessage(ws: Ws, msg: Dict) {
      captured.messages.push(msg);
      if (msg.type === "init") {
        ws.send(
          JSON.stringify({
            type: "ready",
            session_id: "s1",
            encoding: "pcm_s16le",
            sample_rate: 24000,
          }),
        );
      } else if (msg.type === "speak") {
        const contextId = msg.context_id;
        captured.refused ??= new Set();
        if (captured.refused.has(contextId)) {
          return;
        }
        captured.refused.add(contextId);
        ws.send(
          JSON.stringify({
            type: "error",
            context_id: contextId,
            code,
            message: "wallet depleted",
          }),
        );
      } else if (msg.type === "close") {
        ws.send(JSON.stringify({ type: "done", session_id: "s1" }));
        ws.close();
      }
    },
  };
}

describe("TestTurnsThatCannotFinish", () => {
  test("test_bland_tts_reports_a_refused_turn", async () => {
    // A refused turn's error reaches the pipeline, and later deltas are still sent.
    const captured: Captured = { messages: [] };

    const [down, up] = await withWsServer(captured, refusingServer(captured), async (url) => {
      const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

      return await runTest(tts, {
        framesToSend: [
          new LLMFullResponseStartFrame(),
          new LLMTextFrame({ text: "first" }),
          new SleepFrame({ sleep: 0.2 }),
          new LLMTextFrame({ text: " second" }),
          new SleepFrame({ sleep: 0.2 }),
          new LLMTextFrame({ text: " third" }),
          new LLMFullResponseEndFrame(),
          new SleepFrame({ sleep: 0.2 }),
          new BotStoppedSpeakingFrame(),
        ],
      });
    });

    const speaks = ofType(captured, "speak");
    expect(speaks.map((m) => m.text)).toEqual(["first", " second", " third"]);
    const errors = errorsOf(down, up);
    const refusals = errors.filter((f) => f.error.includes("insufficient_credits"));
    expect(refusals.length).toBe(1);
  });

  test("test_bland_tts_continues_a_turn_whose_socket_died_midway", async () => {
    // Losing the socket mid-turn sends the rest of the turn to the new session.
    const sessions: Dict[][] = [];

    const captured: Captured = { messages: [] };
    await withWsServer(
      captured,
      {
        onOpen(_ws, state) {
          sessions[state.session - 1] = [];
        },
        onMessage(ws, msg, state) {
          const messages = sessions[state.session - 1]!;
          const firstSession = state.session === 1;
          messages.push(msg);
          if (msg.type === "init") {
            ws.send(
              JSON.stringify({
                type: "ready",
                session_id: `s${state.session}`,
                encoding: "pcm_s16le",
                sample_rate: 24000,
              }),
            );
          } else if (msg.type === "speak" && firstSession) {
            ws.close(1011, "injected failure");
          } else if (msg.type === "close") {
            ws.send(JSON.stringify({ type: "done", session_id: "s" }));
            ws.close();
          }
        },
      },
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });

        await runTest(tts, {
          framesToSend: [
            new LLMFullResponseStartFrame(),
            new LLMTextFrame({ text: "The weather is clear" }),
            new SleepFrame({ sleep: 0.3 }),
            new LLMTextFrame({ text: " and warm today." }),
            new LLMFullResponseEndFrame(),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
      },
    );

    // The new session knows nothing of the old turn, so the rest of it goes out
    // as a new turn.
    const firstSpeaks = sessions[0]!.filter((m) => m.type === "speak");
    const laterSpeaks = sessions
      .slice(1)
      .flatMap((messages) => messages.filter((m) => m.type === "speak"));
    expect(laterSpeaks.map((m) => m.text)).toEqual([" and warm today."]);
    expect(laterSpeaks[0]!.context_id).not.toBe(firstSpeaks[0]!.context_id);
  });
});

// --- a turn the server has ended ------------------------------------------------------

/** Ends the first turn as `failed`, the way an oversized pause marker does. */
function failingTurnServer(captured: Captured, sendErrorFirst = true) {
  return {
    onMessage(ws: Ws, msg: Dict) {
      captured.messages.push(msg);
      if (msg.type === "init") {
        ws.send(
          JSON.stringify({
            type: "ready",
            session_id: "s1",
            encoding: "pcm_s16le",
            sample_rate: msg.audio?.sample_rate ?? 48000,
          }),
        );
      } else if (msg.type === "speak") {
        const contextId = msg.context_id;
        captured.failed ??= new Set();
        if (captured.failed.has(contextId)) {
          return;
        }
        captured.failed.add(contextId);
        ws.send(JSON.stringify({ type: "utterance_start", context_id: contextId }));
        if (sendErrorFirst) {
          ws.send(
            JSON.stringify({
              type: "error",
              context_id: contextId,
              code: "invalid_request",
              message: "Pause marker `<|30|>` exceeds the maximum.",
            }),
          );
        }
        ws.send(
          JSON.stringify({
            type: "utterance_end",
            context_id: contextId,
            reason: "failed",
            frames: 0,
            duration_ms: 1,
          }),
        );
      } else if (msg.type === "close") {
        ws.send(JSON.stringify({ type: "done", session_id: "s1" }));
        ws.close();
      }
    },
  };
}

describe("TestTurnTheServerHasEnded", () => {
  test("test_bland_tts_reports_a_failed_turn_once", async () => {
    // The `error` frame carries the detail; the terminal must not add a vaguer one.
    const captured: Captured = { messages: [] };

    const [down, up] = await withWsServer(captured, failingTurnServer(captured), async (url) => {
      const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
      return await runTest(tts, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Hold on <|30|> there." }),
          new SleepFrame({ sleep: 0.3 }),
          new BotStoppedSpeakingFrame(),
        ],
      });
    });

    // The context separately reports completing with no audio; the turn itself
    // is reported once.
    const errors = errorsOf(down, up);
    const turnErrors = errors.filter((f) => !f.error.includes("completed with no audio"));
    expect(turnErrors.map((f) => f.error).length).toBe(1);
    expect(turnErrors[0]!.error).toContain("invalid_request");
  });

  test("test_bland_tts_closes_a_failed_turn_with_no_error_frame", async () => {
    // A bare `failed` terminal closes the turn.
    const captured: Captured = { messages: [] };

    const [tts, down] = await withWsServer(
      captured,
      failingTurnServer(captured, false),
      async (url) => {
        const service = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
        const [downFrames] = await runTest(service, {
          framesToSend: [
            new TTSSpeakFrame({ text: "Hi." }),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        });
        return [service, downFrames] as const;
      },
    );

    expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
    expect(tts.getAudioContexts()).toEqual([]);
  });

  test("test_bland_tts_idle_close_is_not_a_pipeline_error", async () => {
    // Bland reaps an idle session itself; the replacement session is routine.
    const captured: Captured = { messages: [], reaped: false };

    const [down, up] = await withWsServer(
      captured,
      {
        onMessage(ws, message) {
          captured.messages.push(message);
          if (message.type === "init") {
            ws.send(
              JSON.stringify({
                type: "ready",
                session_id: "s1",
                encoding: "pcm_s16le",
                sample_rate: message.audio?.sample_rate ?? 48000,
              }),
            );
            // Reap the first session the way the 60s idle timeout does, and
            // hold the one that replaces it open.
            if (!captured.reaped) {
              captured.reaped = true;
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "idle_timeout",
                  message: "Session idle for 60s.",
                }),
              );
              ws.close(1011, "idle");
            }
          }
        },
      },
      async (url) => {
        const tts = new BlandTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
        return await runTest(tts, { framesToSend: [new SleepFrame({ sleep: 0.4 })] });
      },
    );

    // A reaped session is replaced, and nothing about that is the application's
    // problem to hear about.
    const inits = captured.messages.filter((m) => m.type === "init");
    expect(inits.length).toBe(2);
    const errors = errorsOf(down, up).map((f) => f.error);
    expect(errors).toEqual([]);
    // The handler never answers `close`, so shutdown waits out the 5 s settle timeout
    // (as upstream's does), which is the whole of Bun's default test timeout.
  }, 15000);
});
