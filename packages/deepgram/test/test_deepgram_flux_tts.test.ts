// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_deepgram_flux_tts.py

/** Tests for DeepgramFluxTTSService. */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sleep, waitFor } from "@pipedog/asyncio";
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
  TTSUpdateSettingsFrame,
  VADUserStartedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { TextAggregationMode, TTSService } from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import type { Server, ServerWebSocket } from "bun";

import { DeepgramFluxTTSService } from "../src/flux/tts.ts";

type Dict = Record<string, any>;

const AUDIO_CHUNK_1 = new Uint8Array(1024).map((_, i) => (i % 2 === 0 ? 0x00 : 0x01));
const AUDIO_CHUNK_2 = new Uint8Array(1024).map((_, i) => (i % 2 === 0 ? 0x02 : 0x03));

interface Captured {
  messages: Dict[];
  request_path?: string;
  auth_header?: string | null;
  speech_started?: boolean;
}

interface _HandlerOptions {
  warningFirst?: boolean;
  endTurn?: boolean;
  rejectConfigure?: boolean;
  audioDelay?: number;
}

interface _ConnectionData {
  chain: Promise<void>;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Build a fake Flux TTS server following the documented turn flow.
 *
 * With `endTurn: false` the handler withholds SpeechMetadata, leaving the
 * turn open the way it is while Flux is still synthesizing audio. With
 * `rejectConfigure: true` it answers a Configure with ConfigureFailure.
 *
 * Messages are handled one at a time, in order, as `async for` does upstream.
 */
function _fluxServer(captured: Captured, options: _HandlerOptions = {}): Server<_ConnectionData> {
  const warningFirst = options.warningFirst ?? false;
  const endTurn = options.endTurn ?? true;
  const rejectConfigure = options.rejectConfigure ?? false;
  const audioDelay = options.audioDelay ?? 0;

  async function handle(ws: ServerWebSocket<_ConnectionData>, raw: string | Buffer) {
    const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Dict;
    captured.messages.push(msg);
    if (msg.type === "Speak" && !captured.speech_started) {
      captured.speech_started = true;
      ws.send(
        JSON.stringify({
          type: "Connected",
          request_id: "test-request",
          model_name: "flux-alexis-en",
        }),
      );
      if (warningFirst) {
        ws.send(
          JSON.stringify({
            type: "Warning",
            code: "TEXT_TRUNCATED",
            description: "Input text was truncated.",
          }),
        );
      }
      ws.send(JSON.stringify({ type: "SpeechStarted", speech_id: "dg_sp_test" }));
    } else if (msg.type === "Configure" && rejectConfigure) {
      ws.send(
        JSON.stringify({
          type: "ConfigureFailure",
          code: "SPEED_OUT_OF_RANGE",
          field: "speed",
          value: msg.speed,
          description: "Speed must be between 0.5 and 1.5.",
        }),
      );
    } else if (msg.type === "Flush") {
      await Bun.sleep(audioDelay * 1000);
      // Flux sends the flush ack before the turn's remaining audio;
      // SpeechMetadata arrives only after all audio.
      ws.send(AUDIO_CHUNK_1);
      ws.send(JSON.stringify({ type: "Flushed", speech_id: "dg_sp_test" }));
      ws.send(AUDIO_CHUNK_2);
      if (endTurn) {
        ws.send(
          JSON.stringify({
            type: "SpeechMetadata",
            speech_id: "dg_sp_test",
            audio_duration_ms: 100,
            input_character_count: 17,
            billable_character_count: 17,
          }),
        );
      }
    }
  }

  return Bun.serve<_ConnectionData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      captured.request_path = `${url.pathname}${url.search}`;
      captured.auth_header = request.headers.get("Authorization");
      if (srv.upgrade(request, { data: { chain: Promise.resolve() } })) {
        return undefined;
      }
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        ws.data.chain = ws.data.chain.then(() => handle(ws, message)).catch(() => {});
      },
    },
  });
}

/** `async with serve(...)`: run `fn` against a fake server, then stop it. */
async function _withServer<T>(
  captured: Captured,
  options: _HandlerOptions,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = _fluxServer(captured, options);
  try {
    return await fn(`ws://127.0.0.1:${server.port}/v2/speak`);
  } finally {
    server.stop(true);
  }
}

/** `parse_qs(urlparse(path).query)`. */
function _parseQs(path: string | undefined): Record<string, string[]> {
  const params = new URL(path ?? "", "http://localhost").searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    out[key] = params.getAll(key);
  }
  return out;
}

function _isError(frame: Frame): boolean {
  return frame instanceof ErrorFrame;
}

interface _StubWebsocket {
  state: State;
  send: ReturnType<typeof mock>;
}

function _stubWebsocket(): _StubWebsocket {
  return { state: State.OPEN, send: mock(async (_data: string) => {}) };
}

function _setWebsocket(service: DeepgramFluxTTSService, websocket: _StubWebsocket): void {
  (service as unknown as { _websocket: _StubWebsocket })._websocket = websocket;
}

function _sent(websocket: _StubWebsocket): Dict[] {
  return websocket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Dict);
}

const restorers: (() => void)[] = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

/** `patch.object(service, name, new=AsyncMock())`, undone after the test. */
function _patchAsync(target: object, name: string) {
  const spy = spyOn(target as Record<string, () => Promise<void>>, name).mockImplementation(
    async () => {},
  );
  restorers.push(() => spy.mockRestore());
  return spy;
}

test("test_flux_tts_protocol_roundtrip", async () => {
  // Speak/Flush are sent, and audio (including post-Flushed audio) is emitted.
  const captured: Captured = { messages: [] };

  const [downFrames, upFrames] = await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
    });

    return await runTest(ttsService, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from Flux." }),
        new SleepFrame({ sleep: 0.3 }),
        // The output transport sends this once playback ends; runTest has no
        // transport.
        new BotStoppedSpeakingFrame(),
      ],
    });
  });

  expect(downFrames.some((f) => f instanceof TTSStartedFrame)).toBe(true);
  expect(downFrames.some((f) => f instanceof TTSAudioRawFrame)).toBe(true);
  expect(downFrames.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
  expect([...downFrames, ...upFrames].some(_isError)).toBe(false);

  const audioFrames = downFrames.filter(
    (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
  );
  expect(audioFrames.every((f) => f.sampleRate === 24000)).toBe(true);
  expect(audioFrames.every((f) => f.numChannels === 1)).toBe(true);
  // Audio sent after Flushed but before SpeechMetadata must not be dropped.
  expect(concat(...audioFrames.map((f) => f.audio))).toEqual(concat(AUDIO_CHUNK_1, AUDIO_CHUNK_2));

  expect(captured.auth_header).toBe("Token test-key");
  const query = _parseQs(captured.request_path);
  expect(query.model).toEqual(["flux-heather-en"]);
  expect(query.encoding).toEqual(["linear16"]);
  expect(query.sample_rate).toEqual(["24000"]);

  const typesSent = captured.messages.map((m) => m.type);
  expect(typesSent).toContain("Flush");
  const speakMsg = captured.messages.find((m) => m.type === "Speak")!;
  // In the default token streaming mode, text is sent verbatim.
  expect(speakMsg.text).toBe("Hello from Flux.");
});

test("test_flux_uninterruptible_speech_waits_for_audio_after_interruption", async () => {
  // An uninterruptible utterance survives barge-in before Flux returns its audio.
  const captured: Captured = { messages: [] };
  const [down, up] = await _withServer(captured, { audioDelay: 0.2 }, async (url) => {
    const tts = new DeepgramFluxTTSService({ apiKey: "test-key", url, sampleRate: 24000 });
    const speech = new TTSSpeakFrame({ text: "Mm-hmm.", appendToContext: false });
    speech.interruptible = false;
    return await waitFor(
      () =>
        runTest(tts, {
          framesToSend: [
            speech,
            new SleepFrame({ sleep: 0.05 }),
            new VADUserStartedSpeakingFrame(),
            new InterruptionFrame(),
            new SleepFrame({ sleep: 0.3 }),
            new BotStoppedSpeakingFrame(),
          ],
        }),
      5,
    );
  });
  expect(captured.messages.some((message) => message.type === "Interrupt")).toBe(false);
  expect([...down, ...up].some(_isError)).toBe(false);
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(concat(...audio.map((f) => f.audio))).toEqual(concat(AUDIO_CHUNK_1, AUDIO_CHUNK_2));
  const text = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  expect(text.map((f) => f.text)).toEqual(["Mm-hmm."]);
  expect([...audio, ...text].every((f) => !f.interruptible)).toBe(true);
});

test("test_flux_tts_token_streaming_sends_tokens_verbatim", async () => {
  // In the default TOKEN mode, LLM tokens map 1:1 to Speak messages, unaltered.
  const captured: Captured = { messages: [] };

  const [downFrames, upFrames] = await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
    });

    return await runTest(ttsService, {
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
  });

  expect([...downFrames, ...upFrames].some(_isError)).toBe(false);
  expect(downFrames.some((f) => f instanceof TTSAudioRawFrame)).toBe(true);

  const speakTexts = captured.messages.filter((m) => m.type === "Speak").map((m) => m.text);
  // No spaces may be inserted between tokens: Flux never strips whitespace
  // between Speak messages, so an added space would split words.
  expect(speakTexts).toEqual(["Unbelieva", "ble", " isn't it?"]);
  expect(captured.messages.filter((m) => m.type === "Flush").length).toBe(1);
});

test("test_flux_tts_sentence_mode_appends_trailing_space", async () => {
  // In SENTENCE mode a trailing space separates consecutive generations.
  const captured: Captured = { messages: [] };

  const [downFrames, upFrames] = await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
      textAggregationMode: TextAggregationMode.SENTENCE,
    });

    return await runTest(ttsService, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from Flux." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    });
  });

  expect([...downFrames, ...upFrames].some(_isError)).toBe(false);
  const speakMsg = captured.messages.find((m) => m.type === "Speak")!;
  expect(speakMsg.text).toBe("Hello from Flux. ");
});

test("test_flux_tts_interruption_sends_interrupt_and_keeps_connection", async () => {
  // On barge-in the service sends Interrupt and keeps the session open.
  const ttsService = new DeepgramFluxTTSService({ apiKey: "test-key", sampleRate: 24000 });

  const websocket = _stubWebsocket();
  _setWebsocket(ttsService, websocket);

  _patchAsync(TTSService.prototype, "onAudioContextInterrupted");
  const connectSpy = _patchAsync(ttsService, "_connect");
  const disconnectSpy = _patchAsync(ttsService, "_disconnect");
  await ttsService.onAudioContextInterrupted("test-context");

  expect(disconnectSpy).not.toHaveBeenCalled();
  expect(connectSpy).not.toHaveBeenCalled();
  // Interrupt takes no other fields: the schema rejects unknown ones and
  // closes the connection.
  expect(_sent(websocket)).toEqual([{ type: "Interrupt" }]);
});

test("test_flux_tts_interruption_leaves_no_active_audio_context", async () => {
  // A barge-in sends Interrupt and leaves no context for in-flight audio.
  //
  // Binary frames carry no speech_id, so audio is attributed to whichever
  // context is active. Clearing it is what keeps audio the server generated
  // before it processed the Interrupt out of the next turn.
  const captured: Captured = { messages: [] };

  const ttsService = await _withServer(captured, { endTurn: false }, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
    });

    await runTest(ttsService, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from Flux." }),
        new SleepFrame({ sleep: 0.2 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });
    return ttsService;
  });

  expect(captured.messages.some((m) => m.type === "Interrupt")).toBe(true);
  expect(ttsService.getActiveAudioContextId()).toBeNull();
  expect(ttsService.getAudioContexts().length).toBe(0);
});

test("test_flux_tts_completed_turn_is_not_interrupted", async () => {
  // A barge-in after the turn ended server-side sends no Interrupt.
  //
  // A context is removed once its SpeechMetadata arrives, so an interruption
  // past that point has no turn left to cancel.
  const captured: Captured = { messages: [] };

  await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
    });

    await runTest(ttsService, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello from Flux." }),
        new SleepFrame({ sleep: 0.3 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });
  });

  expect(captured.messages.some((m) => m.type === "Interrupt")).toBe(false);
});

test("test_flux_tts_warning_is_not_fatal", async () => {
  // A server Warning is logged but does not produce an ErrorFrame.
  const captured: Captured = { messages: [] };

  const [downFrames, upFrames] = await _withServer(
    captured,
    { warningFirst: true },
    async (url) => {
      const ttsService = new DeepgramFluxTTSService({
        apiKey: "test-key",
        url,
        sampleRate: 24000,
      });

      return await runTest(ttsService, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Hello from Flux." }),
          new SleepFrame({ sleep: 0.3 }),
          new BotStoppedSpeakingFrame(),
        ],
      });
    },
  );

  expect([...downFrames, ...upFrames].some(_isError)).toBe(false);
  expect(downFrames.some((f) => f instanceof TTSAudioRawFrame)).toBe(true);
});

test("test_flux_tts_configure_failure_pushes_error", async () => {
  // A rejected settings update reaches application code as a non-fatal error.
  const captured: Captured = { messages: [] };

  const [downFrames, upFrames] = await _withServer(
    captured,
    { rejectConfigure: true },
    async (url) => {
      const ttsService = new DeepgramFluxTTSService({
        apiKey: "test-key",
        url,
        sampleRate: 24000,
      });

      return await runTest(ttsService, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Hello from Flux." }),
          new SleepFrame({ sleep: 0.3 }),
          new BotStoppedSpeakingFrame(),
          new TTSUpdateSettingsFrame({
            delta: new DeepgramFluxTTSService.Settings({ speed: 1.1 }),
          }),
          new SleepFrame({ sleep: 0.3 }),
        ],
      });
    },
  );

  expect(captured.messages.some((m) => m.type === "Configure")).toBe(true);
  const errors = [...downFrames, ...upFrames].filter(
    (f): f is ErrorFrame => f instanceof ErrorFrame,
  );
  // ConfigureFailure should surface as an ErrorFrame
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]!.error).toContain("SPEED_OUT_OF_RANGE");
});

test("test_flux_tts_query_params", async () => {
  // Connection config and settings appear as query parameters.
  const captured: Captured = { messages: [] };

  const ttsService = await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 8000,
      mipOptOut: true,
      tag: ["tag-a", "tag-b"],
      settings: new DeepgramFluxTTSService.Settings({
        voice: "flux-thalia-en",
        speed: 1.05,
        expressivity: -1,
      }),
    });

    await runTest(ttsService, { framesToSend: [] });
    return ttsService;
  });

  const query = _parseQs(captured.request_path);
  expect(query.model).toEqual(["flux-thalia-en"]);
  expect((ttsService as unknown as { _settings: { model: unknown } })._settings.model).toBe(
    "flux-thalia-en",
  );
  expect(query.encoding).toEqual(["linear16"]);
  expect(query.sample_rate).toEqual(["8000"]);
  expect(query.speed).toEqual(["1.05"]);
  expect(query.expressivity).toEqual(["-1"]);
  expect(query.mip_opt_out).toEqual(["true"]);
  expect(query.tag).toEqual(["tag-a", "tag-b"]);
});

test("test_flux_tts_unset_voice_controls_are_omitted", async () => {
  // Speed and expressivity are left out of the query string when unset.
  const captured: Captured = { messages: [] };

  await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 24000,
    });

    await runTest(ttsService, { framesToSend: [] });
  });

  const query = _parseQs(captured.request_path);
  expect("speed" in query).toBe(false);
  expect("expressivity" in query).toBe(false);
});

/** Build a service with a stub open websocket, without connecting. */
function _connectedService(
  options: Partial<ConstructorParameters<typeof DeepgramFluxTTSService>[0]> = {},
): [DeepgramFluxTTSService, _StubWebsocket] {
  const ttsService = new DeepgramFluxTTSService({
    apiKey: "test-key",
    sampleRate: 24000,
    ...options,
  });
  const websocket = _stubWebsocket();
  _setWebsocket(ttsService, websocket);
  return [ttsService, websocket];
}

type _Internals = {
  _updateSettings(delta: unknown): Promise<Record<string, unknown>>;
  _settings: { speed: unknown; expressivity: unknown };
};

function _internals(service: DeepgramFluxTTSService): _Internals {
  return service as unknown as _Internals;
}

test("test_flux_tts_speed_update_sends_configure", async () => {
  // A speed change is applied on the open connection, without reconnecting.
  const [ttsService, websocket] = _connectedService();

  const connectSpy = _patchAsync(ttsService, "_connect");
  const disconnectSpy = _patchAsync(ttsService, "_disconnect");
  await _internals(ttsService)._updateSettings(new DeepgramFluxTTSService.Settings({ speed: 1.1 }));

  expect(disconnectSpy).not.toHaveBeenCalled();
  expect(connectSpy).not.toHaveBeenCalled();
  expect(_sent(websocket)).toEqual([{ type: "Configure", speed: 1.1 }]);
  expect(_internals(ttsService)._settings.speed).toBe(1.1);
});

test("test_flux_tts_cleared_speed_configures_default_rate", async () => {
  // Clearing speed restores Flux's default rate explicitly.
  const [ttsService, websocket] = _connectedService({
    settings: new DeepgramFluxTTSService.Settings({ speed: 1.15 }),
  });

  await _internals(ttsService)._updateSettings(
    new DeepgramFluxTTSService.Settings({ speed: null }),
  );

  expect(_sent(websocket)).toEqual([{ type: "Configure", speed: 1.0 }]);
});

test("test_flux_tts_expressivity_update_reconnects", async () => {
  // Expressivity is fixed for a connection, so a change reconnects.
  const [ttsService, websocket] = _connectedService();

  const connectSpy = _patchAsync(ttsService, "_connect");
  const disconnectSpy = _patchAsync(ttsService, "_disconnect");
  await _internals(ttsService)._updateSettings(
    new DeepgramFluxTTSService.Settings({ expressivity: 2 }),
  );

  expect(disconnectSpy).toHaveBeenCalled();
  expect(connectSpy).toHaveBeenCalled();
  expect(websocket.send).not.toHaveBeenCalled();
  expect(_internals(ttsService)._settings.expressivity).toBe(2);
});

test("test_flux_tts_unsupported_sample_rate_warns", async () => {
  // An unsupported sample rate is reported once, when connecting.
  const captured: Captured = { messages: [] };

  const warningSpy = spyOn(logger, "warning");
  restorers.push(() => warningSpy.mockRestore());

  await _withServer(captured, {}, async (url) => {
    const ttsService = new DeepgramFluxTTSService({
      apiKey: "test-key",
      url,
      sampleRate: 22050,
    });

    await runTest(ttsService, { framesToSend: [] });
  });

  expect(warningSpy.mock.calls.some((call) => String(call[0]).includes("22050"))).toBe(true);
  const query = _parseQs(captured.request_path);
  expect(query.sample_rate).toEqual(["22050"]);
});

/**
 * Stands in for `websockets.exceptions.InvalidStatus`, the exception
 * `websockets` raises when a handshake is rejected: it carries the HTTP
 * response with its status code and headers.
 */
class InvalidStatus extends Error {
  response: { status_code: number; headers: Headers };

  constructor(response: { status_code: number; headers: Headers }) {
    super(`server rejected WebSocket connection: HTTP ${response.status_code}`);
    this.name = "InvalidStatus";
    this.response = response;
  }
}

/** Build the exception `websockets` raises when a handshake is rejected. */
function _websocketRejection(statusCode: number, reason: string | null = null): InvalidStatus {
  const headers = reason ? new Headers({ "dg-error": reason }) : new Headers();
  return new InvalidStatus({ status_code: statusCode, headers });
}

/**
 * Upstream monkeypatches `pipecat.services.websocket_service.websocket_connect`;
 * here the service's `_websocketConnect` (the mixin's wrapper around it) is
 * replaced on the instance.
 */
function _patchWebsocketConnect(
  service: DeepgramFluxTTSService,
  fake: (...args: unknown[]) => Promise<never>,
): void {
  (service as unknown as { _websocketConnect: typeof fake })._websocketConnect = fake;
}

test("test_flux_tts_refused_setting_makes_the_service_unusable", async () => {
  // A setting Deepgram refuses won't be accepted on a retry, so the service gives up.
  const reason = "'expressivity' must be between -2 and 2. Got: 99.";

  const fakeWebsocketConnect = async (..._args: unknown[]): Promise<never> => {
    throw _websocketRejection(400, reason);
  };

  const service = new DeepgramFluxTTSService({ apiKey: "test-key", sampleRate: 24000 });
  _patchWebsocketConnect(service, fakeWebsocketConnect);
  const connectionErrors: unknown[] = [];

  service.eventHandler("on_connection_error", async (_service: unknown, error: unknown) => {
    connectionErrors.push(error);
  });

  await service._connectWebsocket();
  // Event handlers run as background tasks; let it finish.
  await sleep(0);

  expect(service.isUsable).toBe(false);
  expect(connectionErrors).toEqual([`Deepgram refused the connection (HTTP 400): ${reason}`]);
});

test("test_flux_tts_server_error_leaves_the_service_usable", async () => {
  const fakeWebsocketConnect = async (..._args: unknown[]): Promise<never> => {
    throw _websocketRejection(503);
  };

  const service = new DeepgramFluxTTSService({ apiKey: "test-key", sampleRate: 24000 });
  _patchWebsocketConnect(service, fakeWebsocketConnect);

  await service._connectWebsocket();

  expect(service.isUsable).toBe(true);
});
