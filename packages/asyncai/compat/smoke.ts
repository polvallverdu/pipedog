// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs both services through a pipeline:
// - AsyncAIHttpTTSService against an in-process fake `fetch`;
// - AsyncAITTSService against an in-process fake socket that follows Async's WebSocket
//   protocol (init message, forced transcripts per context, base64 audio JSON out).
// Opening a real WebSocket is core's `websocketConnect`, which core's smoke test covers.

import {
  AsyncAIHttpTTSService,
  AsyncAITTSService,
  languageToAsyncLanguage,
} from "@pipedog/asyncai/tts";
import { Queue } from "@pipedog/asyncio";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { ConnectionClosedOK, State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`asyncai smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A socket whose peer answers each sent message with `respond`. */
class FakeSocket {
  state: State = State.OPEN;
  readonly sent: string[] = [];
  #incoming = new Queue<string | null>();
  #respond: (message: string) => string[];

  constructor(respond: (message: string) => string[]) {
    this.#respond = respond;
  }

  async send(message: string): Promise<void> {
    this.sent.push(message);
    for (const reply of this.#respond(message)) this.#incoming.putNowait(reply);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.state = State.CLOSED;
    this.#incoming.putNowait(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
    while (true) {
      const message = await this.#incoming.get();
      if (message === null) return;
      yield message;
    }
  }

  async recv(): Promise<string> {
    const message = await this.#incoming.get();
    if (message === null) throw new ConnectionClosedOK(1000, "");
    return message;
  }
}

async function httpTts(): Promise<void> {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response(PCM);
  }) as typeof fetch;
  const tts = new AsyncAIHttpTTSService({
    apiKey: "smoke-key",
    sampleRate: 24000,
    fetch: fakeFetch,
    settings: new AsyncAIHttpTTSService.Settings({ voice: "voice-1" }),
  });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
  check(requests.length === 1, `http tts: ${requests.length} requests`);
  check(requests[0]!.url === "https://api.async.com/text_to_speech/streaming", "http tts url");
  check(requests[0]!.headers.get("x-api-key") === "smoke-key", "http tts key");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.length === 1 && audio[0]!.audio.length === PCM.length, "http tts audio");
}

async function websocketTts(): Promise<void> {
  const tts = new AsyncAITTSService({
    apiKey: "smoke-key",
    sampleRate: 24000,
    settings: new AsyncAITTSService.Settings({ voice: "voice-1" }),
  });
  let socket: FakeSocket | null = null;
  let connectedUrl = "";
  tts._websocketConnect = (async (url: string) => {
    connectedUrl = url;
    socket = new FakeSocket((message) => {
      const msg = JSON.parse(message);
      return msg.transcript?.trim() && msg.context_id
        ? [JSON.stringify({ context_id: msg.context_id, audio: b64(PCM), final: false })]
        : [];
    });
    return socket;
  }) as never;
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.3 })],
  });
  check(
    connectedUrl === "wss://api.async.com/text_to_speech/websocket/ws?api_key=smoke-key&version=v1",
    `ws url ${connectedUrl}`,
  );
  check(socket !== null, "ws connected");
  const sent = (socket as unknown as FakeSocket).sent.map((m) => JSON.parse(m));
  check(sent[0].voice.id === "voice-1" && sent[0].output_format.sample_rate === 24000, "ws init");
  check(
    sent.some((m) => m.transcript === "Hello." && m.force === true),
    "ws transcript",
  );
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "ws audio");
}

export default async function smoke(): Promise<Record<string, string>> {
  check(languageToAsyncLanguage(Language.EN) === "en", "language map");
  await httpTts();
  await websocketTts();
  return { http_tts: "ok", websocket_tts: "ok" };
}
