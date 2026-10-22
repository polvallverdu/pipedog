// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it
// imports every module and runs `ElevenLabsDialogueTTSService` (Text-to-Dialogue)
// against an in-process fake WebSocket that speaks its protocol (`voices`
// registration, `inputs`, `close_context` in; `audio`, `is_final` out). The other
// services are constructed.

import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ElevenLabsDialogueTTSService } from "@pipedog/elevenlabs/dialogue/tts";
import { ElevenLabsRealtimeSTTService, ElevenLabsSTTService } from "@pipedog/elevenlabs/stt";
import { ElevenLabsHttpTTSService, ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`elevenlabs smoke: ${message}`);
}

class FakeWebSocket extends EventTarget {
  readyState = 1;
  binaryType = "arraybuffer";
  protocol = "";
  sent: any[] = [];

  reply(msg: object) {
    queueMicrotask(() =>
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) })),
    );
  }

  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.context_id !== "pipecat-keepalive" && msg.close_context) {
      this.reply({ context_id: msg.context_id, is_final: true });
    } else if (msg.inputs) {
      this.reply({
        context_id: msg.context_id,
        audio: btoa(String.fromCharCode(1, 0, 2, 0)),
        alignment: {
          chars: ["H", "i"],
          char_start_times_ms: [0, 50],
          char_durations_ms: [50, 50],
        },
      });
    }
  }

  close() {
    this.readyState = 3;
  }
}

async function dialogue(): Promise<void> {
  const ws = new FakeWebSocket();
  let url = "";
  const service: any = new ElevenLabsDialogueTTSService({
    apiKey: "key",
    sampleRate: 24000,
    settings: new ElevenLabsDialogueTTSService.Settings({ voice: "voice-1", stability: 0.5 }),
  });
  service._websocketConnect = async (u: string, options: any) => {
    url = u;
    check(options.additionalHeaders["xi-api-key"] === "key", "api key header");
    return new WebsocketClientConnection(ws as unknown as WebSocket);
  };
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.3 })],
    startTimeout: 3,
  });
  check(url.includes("/v1/text-to-dialogue/multi-stream-input?model_id=eleven_v4_turbo"), url);
  const voices = ws.sent.filter((m) => m.voices);
  check(voices.length >= 2, "voices registrations (keepalive + context)");
  check(
    ws.sent.some((m) => m.inputs?.[0]?.text === "Hi. "),
    "inputs",
  );
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    "audio frame",
  );
}

export default async function smoke(): Promise<Record<string, string>> {
  new ElevenLabsSTTService({ apiKey: "key" });
  new ElevenLabsRealtimeSTTService({ apiKey: "key" });
  new ElevenLabsTTSService({ apiKey: "key" });
  new ElevenLabsHttpTTSService({ apiKey: "key" });
  await dialogue();
  return { dialogue: "ok" };
}
