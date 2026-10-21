// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Behavior tests for the Inworld TTS services against local fake servers
 * (no upstream counterpart): the WebSocket protocol (context create, text,
 * close, audio, word timestamps, fallback text) and the HTTP streaming and
 * non-streaming responses.
 */

import { expect, test } from "bun:test";
import {
  BotStoppedSpeakingFrame,
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";

import { InworldHttpTTSService, InworldTTSService, InworldTTSSettings } from "../src/tts.ts";

type Dict = Record<string, any>;

const PCM = new Uint8Array(960).map((_, i) => i % 251);

function wav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  out.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  out.set(pcm, 44);
  return out;
}

function joinAudio(frames: Frame[]): Uint8Array {
  const audio = frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const out = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    out.set(f.audio, offset);
    offset += f.audio.length;
  }
  return out;
}

interface WsCaptured {
  headers: Record<string, string | null>;
  messages: Dict[];
}

/** A fake Inworld bidirectional TTS server. */
function wsServer(captured: WsCaptured, options: { timestamps: boolean }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      captured.headers.authorization = request.headers.get("Authorization");
      captured.headers.userAgent = request.headers.get("X-User-Agent");
      captured.headers.requestId = request.headers.get("X-Request-Id");
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Dict;
        captured.messages.push(msg);
        const contextId = msg.contextId;
        if (msg.create) {
          ws.send(JSON.stringify({ result: { contextId, contextCreated: {} } }));
        } else if (msg.send_text?.text) {
          const audioChunk: Dict = { audioContent: bytesToBase64(wav(PCM)) };
          if (options.timestamps) {
            audioChunk.timestampInfo = {
              wordAlignment: {
                words: ["Hello", "world."],
                wordStartTimeSeconds: [0.0, 0.4],
                wordEndTimeSeconds: [0.35, 0.8],
              },
            };
          }
          ws.send(JSON.stringify({ result: { contextId, audioChunk } }));
        } else if (msg.close_context) {
          ws.send(JSON.stringify({ result: { contextId, flushCompleted: {} } }));
          ws.send(JSON.stringify({ result: { contextId, contextClosed: {} } }));
        }
      },
    },
  });
}

async function runWs(options: { timestamps: boolean }): Promise<[Frame[], WsCaptured]> {
  const captured: WsCaptured = { headers: {}, messages: [] };
  const server = wsServer(captured, options);
  try {
    const tts = new InworldTTSService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${server.port}/tts/v1/voice:streamBidirectional`,
      sampleRate: 24000,
      settings: new InworldTTSSettings({ temperature: 0.8, speakingRate: 1.2 }),
    });
    const [down] = await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "Hello world." }),
        new SleepFrame({ sleep: 0.3 }),
        new BotStoppedSpeakingFrame(),
      ],
    });
    return [down, captured];
  } finally {
    server.stop(true);
  }
}

test("websocket: authenticates and speaks a context end to end", async () => {
  const [down, captured] = await runWs({ timestamps: true });

  expect(captured.headers.authorization).toBe("Basic test-key");
  expect(captured.headers.userAgent).toMatch(/^pipecat\//);
  expect(captured.headers.requestId).toBeTruthy();

  const create = captured.messages.find((m) => m.create);
  expect(create).toBeDefined();
  expect(create!.create).toEqual({
    voiceId: "Ashley",
    modelId: "inworld-tts-2",
    audioConfig: { audioEncoding: "PCM", sampleRateHertz: 24000, speakingRate: 1.2 },
    temperature: 0.8,
    autoMode: true,
    timestampTransportStrategy: "ASYNC",
    maxBufferDelayMs: 3000,
    bufferCharThreshold: 250,
    timestampType: "WORD",
  });
  const contextId = create!.contextId;
  // One create per context, even though the turn opened it eagerly.
  expect(captured.messages.filter((m) => m.create).length).toBe(1);
  const sendText = captured.messages.find((m) => m.send_text?.text);
  expect(sendText).toEqual({ send_text: { text: "Hello world. " }, contextId });
  expect(captured.messages.some((m) => m.close_context && m.contextId === contextId)).toBe(true);

  expect(down.some((f) => f instanceof TTSStartedFrame)).toBe(true);
  expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
  // The WAV header is stripped.
  expect(joinAudio(down)).toEqual(PCM);
  const words = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame).map((f) => f.text);
  expect(words.join(" ")).toBe("Hello world.");
});

test("websocket: without timestamps the full text is pushed as a fallback", async () => {
  const [down] = await runWs({ timestamps: false });
  const texts = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  // The service pushes the whole text itself (upstream behavior); the base
  // class also force-completes the unspoken sentence when the context ends.
  expect(texts[0]?.text).toBe("Hello world.");
  expect(texts.every((f) => f.text === "Hello world.")).toBe(true);
  expect(joinAudio(down)).toEqual(PCM);
});

interface HttpCaptured {
  url?: string;
  headers?: Headers;
  body?: Dict;
}

/** A `fetch` that sends the service's requests to a local server instead of api.inworld.ai. */
function redirectFetch(port: number, captured: HttpCaptured): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.url = url.toString();
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
  }) as typeof fetch;
}

function httpServer(captured: HttpCaptured, respond: (path: string) => Response) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captured.headers = request.headers;
      captured.body = (await request.json()) as Dict;
      return respond(new URL(request.url).pathname);
    },
  });
}

test("http streaming: reads newline-delimited chunks with word timestamps", async () => {
  const captured: HttpCaptured = {};
  const half = PCM.length / 2;
  const lines = [
    JSON.stringify({ result: { audioContent: bytesToBase64(wav(PCM.slice(0, half))) } }),
    JSON.stringify({
      result: {
        audioContent: bytesToBase64(PCM.slice(half)),
        timestampInfo: {
          wordAlignment: {
            words: ["Hi", "there."],
            wordStartTimeSeconds: [0.0, 0.2],
            wordEndTimeSeconds: [0.15, 0.5],
          },
        },
      },
    }),
  ];
  const server = httpServer(captured, () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
        // Split mid-line, as a network stream may.
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    });
    return new Response(body);
  });
  let down: Frame[];
  try {
    const tts = new InworldHttpTTSService({
      apiKey: "test-key",
      fetch: redirectFetch(server.port as number, captured),
      sampleRate: 24000,
    });
    [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hi there." }), new SleepFrame({ sleep: 0.2 })],
    });
  } finally {
    server.stop(true);
  }

  expect(captured.url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
  expect(captured.headers?.get("Authorization")).toBe("Basic test-key");
  expect(captured.body).toEqual({
    text: "Hi there.",
    voiceId: "Ashley",
    modelId: "inworld-tts-2",
    audioConfig: { audioEncoding: "PCM", sampleRateHertz: 24000 },
    timestampType: "WORD",
    timestampTransportStrategy: "ASYNC",
  });
  expect(joinAudio(down)).toEqual(PCM);
  const words = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame).map((f) => f.text);
  expect(words.join(" ")).toBe("Hi there.");
});

test("http non-streaming: strips the WAV header and pushes fallback text", async () => {
  const captured: HttpCaptured = {};
  const server = httpServer(captured, () =>
    Response.json({ audioContent: bytesToBase64(wav(PCM)) }),
  );
  let down: Frame[];
  try {
    const tts = new InworldHttpTTSService({
      apiKey: "test-key",
      fetch: redirectFetch(server.port as number, captured),
      streaming: false,
      sampleRate: 24000,
    });
    [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "No timestamps." }), new SleepFrame({ sleep: 0.2 })],
    });
  } finally {
    server.stop(true);
  }

  expect(captured.url).toBe("https://api.inworld.ai/tts/v1/voice");
  expect(joinAudio(down)).toEqual(PCM);
  const texts = down.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  expect(texts[0]?.text).toBe("No timestamps.");
  expect(texts.every((f) => f.text === "No timestamps.")).toBe(true);
});

test("http: an error status becomes an ErrorFrame", async () => {
  const captured: HttpCaptured = {};
  const server = httpServer(captured, () => new Response("bad voice", { status: 400 }));
  let up: Frame[];
  try {
    const tts = new InworldHttpTTSService({
      apiKey: "test-key",
      fetch: redirectFetch(server.port as number, captured),
      sampleRate: 24000,
    });
    [, up] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.1 })],
    });
  } finally {
    server.stop(true);
  }
  const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(errors.some((e) => e.error === "Inworld API error: bad voice")).toBe(true);
});

test("settings: fromMapping flattens the legacy nested audioConfig", () => {
  const delta = InworldTTSSettings.fromMapping({
    voiceId: "Dennis",
    modelId: "inworld-tts-1",
    audioConfig: { speakingRate: 0.9 },
    temperature: 1.1,
  });
  expect(delta).toBeInstanceOf(InworldTTSSettings);
  expect(delta.voice).toBe("Dennis");
  expect(delta.model).toBe("inworld-tts-1");
  expect(delta.speakingRate).toBe(0.9);
  expect(delta.temperature).toBe(1.1);
  expect(delta.extra).toEqual({});
});
