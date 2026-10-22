// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs both services through a pipeline:
// - BlandHttpTTSService against an in-process fake `fetch`;
// - BlandTTSService against an in-process fake socket that follows Bland's realtime protocol
//   (init/ready, speak/end_of_turn, binary audio, utterance_end, close/done).
// Opening a real WebSocket is core's `websocketConnect`, which core's smoke test covers.

import { Queue } from "@pipedog/asyncio";
import { BlandHttpTTSService, BlandTTSService } from "@pipedog/bland/tts";
import { TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame } from "@pipedog/core/frames/frames";
import { ConnectionClosedOK, State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`bland smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

/** A socket whose peer answers each sent message with `respond`. */
class FakeSocket {
  state: State = State.OPEN;
  readonly sent: string[] = [];
  #incoming = new Queue<string | Uint8Array | null>();
  #respond: (message: string) => (string | Uint8Array)[];

  constructor(respond: (message: string) => (string | Uint8Array)[]) {
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

  async *[Symbol.asyncIterator](): AsyncGenerator<string | Uint8Array, void, unknown> {
    while (true) {
      const message = await this.#incoming.get();
      if (message === null) return;
      yield message;
    }
  }

  async recv(): Promise<string | Uint8Array> {
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
    return new Response(PCM, { headers: { "Content-Type": "audio/pcm" } });
  }) as typeof fetch;
  const tts = new BlandHttpTTSService({ apiKey: "smoke-key", sampleRate: 24000, fetch: fakeFetch });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
  check(requests.length === 1, `http tts: ${requests.length} requests`);
  check(requests[0]!.url === "https://api.bland.ai/v2/tts", "http tts url");
  check(requests[0]!.headers.get("authorization") === "Bearer smoke-key", "http tts auth");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "http tts audio");
}

async function websocketTts(): Promise<void> {
  const tts = new BlandTTSService({ apiKey: "smoke-key", sampleRate: 24000 });
  let socket: FakeSocket | null = null;
  let connectOptions: { additionalHeaders?: Record<string, string> | null } = {};
  tts._websocketConnect = (async (_url: string, options: typeof connectOptions) => {
    connectOptions = options;
    socket = new FakeSocket((message) => {
      const msg = JSON.parse(message);
      if (msg.type === "init") {
        return [
          JSON.stringify({
            type: "ready",
            session_id: "s",
            encoding: "pcm_s16le",
            sample_rate: msg.audio.sample_rate,
          }),
        ];
      }
      if (msg.type === "speak") {
        return [JSON.stringify({ type: "utterance_start", context_id: msg.context_id })];
      }
      if (msg.type === "end_of_turn") {
        return [
          PCM,
          JSON.stringify({ type: "utterance_end", context_id: msg.context_id, reason: "complete" }),
        ];
      }
      if (msg.type === "close") return [JSON.stringify({ type: "done", session_id: "s" })];
      return [];
    });
    return socket;
  }) as never;
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.3 })],
  });
  check(connectOptions.additionalHeaders?.Authorization === "Bearer smoke-key", "ws auth header");
  check(socket !== null, "ws connected");
  const types = (socket as unknown as FakeSocket).sent.map((m) => JSON.parse(m).type);
  check(types.join(",") === "init,speak,end_of_turn,close", `ws messages ${types.join(",")}`);
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "ws audio");
  check(
    down.some((f) => f instanceof TTSStoppedFrame),
    "ws stopped",
  );
}

export default async function smoke(): Promise<Record<string, string>> {
  await httpTts();
  await websocketTts();
  return { http_tts: "ok", websocket_tts: "ok" };
}
