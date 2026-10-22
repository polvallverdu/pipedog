// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs ResembleAITTSService through a pipeline against an in-process fake
// socket that follows Resemble's WebSocket protocol (a JSON request in, `audio` messages
// and `audio_end` out).
// Opening a real WebSocket is core's `websocketConnect`, which core's smoke test covers.

import { Queue } from "@pipedog/asyncio";
import { TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame } from "@pipedog/core/frames/frames";
import { ConnectionClosedOK, State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ResembleAITTSService } from "@pipedog/resembleai/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`resembleai smoke: ${message}`);
}

// More than the 44100-byte jitter buffer the service fills before it starts playback.
const PCM = Uint8Array.from({ length: 50000 }, (_, i) => (i * 7) & 0xff);

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

export default async function smoke(): Promise<Record<string, string>> {
  const tts = new ResembleAITTSService({
    apiKey: "smoke-key",
    settings: new ResembleAITTSService.Settings({ voice: "voice-1" }),
  });
  let socket: FakeSocket | null = null;
  let connectOptions: { additionalHeaders?: Record<string, string> | null } = {};
  tts._websocketConnect = (async (_url: string, options: typeof connectOptions) => {
    connectOptions = options;
    socket = new FakeSocket((message) => {
      const msg = JSON.parse(message);
      return [
        JSON.stringify({ type: "audio", request_id: msg.request_id, audio_content: b64(PCM) }),
        JSON.stringify({ type: "audio_end", request_id: msg.request_id }),
      ];
    });
    return socket;
  }) as never;

  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.3 })],
  });

  check(connectOptions.additionalHeaders?.Authorization === "Bearer smoke-key", "auth header");
  check(socket !== null, "connected");
  const sent = JSON.parse((socket as unknown as FakeSocket).sent[0]!);
  check(
    sent.voice_uuid === "voice-1" && sent.data === "Hello." && sent.sample_rate === 22050,
    "request",
  );
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "audio");
  check(
    down.some((f) => f instanceof TTSStoppedFrame),
    "stopped",
  );
  return { websocket_tts: "ok" };
}
