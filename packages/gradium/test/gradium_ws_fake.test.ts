// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// GradiumSTTService and GradiumTTSService against a local WebSocket fake
// (Bun.serve): the handshake headers, the wire messages, and the frames
// pushed. Upstream has no TTS test; this file is pipedog's own.

import { expect, test } from "bun:test";
import {
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { base64ToBytes, bytesToBase64 } from "@pipedog/core/utils/base64";
import { GradiumSTTService } from "../src/stt.ts";
import { GradiumTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

interface Captured {
  headers: Record<string, string | null>;
  messages: Dict[];
}

function fakeServer(captured: Captured, onMessage: (ws: any, msg: Dict) => void) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      captured.headers.apiKey = request.headers.get("x-api-key");
      captured.headers.apiSource = request.headers.get("x-api-source");
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Dict;
        captured.messages.push(msg);
        onMessage(ws, msg);
      },
    },
  });
}

test("stt: sets up, streams 80 ms chunks, flushes on VAD stop and pushes transcripts", async () => {
  const captured: Captured = { headers: {}, messages: [] };
  const server = fakeServer(captured, (ws, msg) => {
    if (msg.type === "setup") {
      ws.send(JSON.stringify({ type: "ready", request_id: "r1", sample_rate: 16000 }));
    } else if (msg.type === "flush") {
      ws.send(JSON.stringify({ type: "text", text: "Hello", start_s: 0.1 }));
      ws.send(JSON.stringify({ type: "text", text: "world", start_s: 0.5 }));
      ws.send(JSON.stringify({ type: "flushed", flush_id: msg.flush_id }));
    }
  });

  let down: Frame[];
  try {
    const stt = new GradiumSTTService({
      apiKey: "test-key",
      apiEndpointBaseUrl: `ws://127.0.0.1:${server.port}/api/speech/asr`,
      sampleRate: 16000,
    });
    // 80 ms at 16 kHz is 2560 bytes: send exactly two chunks' worth.
    const audio = new Uint8Array(5120).fill(1);
    [down] = await runTest(stt, {
      framesToSend: [
        new SleepFrame({ sleep: 0.2 }),
        new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.5 }),
      ],
    });
  } finally {
    server.stop(true);
  }

  expect(captured.headers.apiKey).toBe("test-key");
  expect(captured.headers.apiSource).toBe("pipecat");
  expect(captured.messages[0]).toEqual({
    type: "setup",
    model_name: "default",
    input_format: "pcm_16000",
    json_config: { language: "en", delay_in_frames: 12 },
  });
  const audioMsgs = captured.messages.filter((m) => m.type === "audio");
  expect(audioMsgs).toHaveLength(2);
  expect(base64ToBytes(audioMsgs[0]!.audio)).toEqual(new Uint8Array(2560).fill(1));
  expect(captured.messages.at(-1)).toEqual({ type: "flush", flush_id: "1" });

  const interim = down.filter((f) => f instanceof InterimTranscriptionFrame);
  expect(interim.map((f) => (f as InterimTranscriptionFrame).text)).toEqual([
    "Hello",
    "Hello world",
  ]);
  const finals = down.filter((f) => f instanceof TranscriptionFrame);
  expect(finals.map((f) => (f as TranscriptionFrame).text)).toEqual(["Hello world"]);
});

test("tts: sets up the request, sends the text, and plays the audio", async () => {
  const pcm = new Uint8Array(960);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  const captured: Captured = { headers: {}, messages: [] };
  const server = fakeServer(captured, (ws, msg) => {
    if (msg.type === "setup") {
      ws.send(
        JSON.stringify({ type: "ready", request_id: "r1", client_req_id: msg.client_req_id }),
      );
    } else if (msg.type === "text") {
      ws.send(
        JSON.stringify({
          type: "audio",
          audio: bytesToBase64(pcm),
          client_req_id: msg.client_req_id,
        }),
      );
    } else if (msg.type === "end_of_stream") {
      ws.send(JSON.stringify({ type: "end_of_stream", client_req_id: msg.client_req_id }));
    }
  });

  let down: Frame[];
  try {
    const tts = new GradiumTTSService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${server.port}/api/speech/tts`,
      settings: new GradiumTTSService.Settings({ voice: "voice-123" }),
    });
    [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello world." }), new SleepFrame({ sleep: 0.4 })],
    });
  } finally {
    server.stop(true);
  }

  expect(captured.headers.apiKey).toBe("test-key");
  expect(captured.headers.apiSource).toBe("pipecat");
  const setup = captured.messages[0]!;
  expect(setup).toMatchObject({
    type: "setup",
    output_format: "pcm",
    voice_id: "voice-123",
    close_ws_on_eos: false,
  });
  const contextId = setup.client_req_id as string;
  expect(contextId).toBeTruthy();
  expect(captured.messages[1]).toEqual({
    type: "text",
    text: "Hello world.",
    client_req_id: contextId,
  });
  expect(captured.messages).toContainEqual({ type: "end_of_stream", client_req_id: contextId });

  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const joined = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    joined.set(f.audio, offset);
    offset += f.audio.length;
  }
  expect(joined).toEqual(pcm);
  expect(audio.every((f) => f.sampleRate === 48000)).toBe(true);
  expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
});
