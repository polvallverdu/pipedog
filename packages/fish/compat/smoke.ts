// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it
// runs `FishAudioTTSService` against an in-process fake WebSocket that speaks Fish's
// MessagePack protocol (`start`, `text`, `flush`, `stop` in; `audio`, `finish` out), so
// `@msgpack/msgpack` runs on the runtime under test.

import { decode, encode } from "@msgpack/msgpack";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { FishAudioTTSService } from "@pipedog/fish/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`fish smoke: ${message}`);
}

class FakeWebSocket extends EventTarget {
  readyState = 1;
  binaryType = "arraybuffer";
  protocol = "";
  events: any[] = [];

  send(data: Uint8Array) {
    const msg = decode(data) as any;
    this.events.push(msg);
    if (msg.event === "flush") {
      const audio = encode({ event: "audio", audio: new Uint8Array([1, 0, 2, 0]) });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: audio })));
    }
  }

  close() {
    this.readyState = 3;
  }
}

export default async function smoke(): Promise<Record<string, string>> {
  const ws = new FakeWebSocket();
  let headers: Record<string, string> = {};
  const service: any = new FishAudioTTSService({
    apiKey: "key",
    sampleRate: 24000,
    settings: new FishAudioTTSService.Settings({ voice: "voice-1", model: "s2.1-pro" }),
  });
  service._websocketConnect = async (_url: string, options: any) => {
    headers = options.additionalHeaders;
    return new WebsocketClientConnection(ws as unknown as WebSocket);
  };
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.2 })],
    startTimeout: 3,
  });
  check(
    headers.Authorization === "Bearer key" && headers.model === "s2.1-pro",
    "handshake headers",
  );
  const kinds = ws.events.map((e) => e.event);
  check(
    kinds[0] === "start" && kinds.includes("text") && kinds.includes("flush"),
    `events ${kinds}`,
  );
  check(ws.events[0].request.reference_id === "voice-1", "start request");
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    "audio frame",
  );
  return { websocket: "ok" };
}
