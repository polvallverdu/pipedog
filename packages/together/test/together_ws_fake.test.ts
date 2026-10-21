// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// TogetherSTTService and TogetherTTSService against a local WebSocket fake
// (Bun.serve): the handshake, the wire messages, and the frames pushed.

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
import { TogetherSTTService } from "../src/stt.ts";
import { TogetherTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

interface Captured {
  url: string;
  headers: Record<string, string | null>;
  messages: Dict[];
}

function fakeServer(captured: Captured, onMessage: (ws: any, msg: Dict) => void) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      captured.url = request.url;
      captured.headers.authorization = request.headers.get("Authorization");
      captured.headers.openaiBeta = request.headers.get("OpenAI-Beta");
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

test("stt: streams audio, commits on VAD stop, and pushes transcripts", async () => {
  const captured: Captured = { url: "", headers: {}, messages: [] };
  const server = fakeServer(captured, (ws, msg) => {
    if (msg.type === "input_audio_buffer.commit") {
      ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "item_1" }));
      ws.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          transcript: "Hello",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: " Hello world. ",
        }),
      );
    }
  });

  let down: Frame[];
  try {
    const stt = new TogetherSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${server.port}/v1`,
    });
    const audio = new Uint8Array(640).fill(1);
    [down] = await runTest(stt, {
      framesToSend: [
        new SleepFrame({ sleep: 0.2 }),
        new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });
  } finally {
    server.stop(true);
  }

  const url = new URL(captured.url);
  expect(url.pathname).toBe("/v1/realtime");
  expect(url.searchParams.get("intent")).toBe("transcription");
  expect(url.searchParams.get("model")).toBe("openai/whisper-large-v3");
  expect(url.searchParams.get("turn_detection")).toBe("none");
  expect(url.searchParams.get("input_audio_format")).toBe("pcm_s16le_16000");
  expect(captured.headers.authorization).toBe("Bearer test-key");
  expect(captured.headers.openaiBeta).toBe("realtime=v1");

  const append = captured.messages.find((m) => m.type === "input_audio_buffer.append");
  expect(append).toBeDefined();
  expect(base64ToBytes(append!.audio)).toEqual(new Uint8Array(640).fill(1));
  expect(captured.messages.at(-1)).toEqual({ type: "input_audio_buffer.commit" });

  const interim = down.filter((f) => f instanceof InterimTranscriptionFrame);
  expect(interim.map((f) => (f as InterimTranscriptionFrame).text)).toEqual(["Hello"]);
  const finals = down.filter((f) => f instanceof TranscriptionFrame);
  expect(finals.map((f) => (f as TranscriptionFrame).text)).toEqual(["Hello world."]);
});

test("tts: sets the voice, sends the text, and plays the audio deltas", async () => {
  const pcm = new Uint8Array(960);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  const captured: Captured = { url: "", headers: {}, messages: [] };
  const server = fakeServer(captured, (ws, msg) => {
    if (msg.type === "input_text_buffer.commit") {
      ws.send(
        JSON.stringify({ type: "conversation.item.audio_output.delta", delta: bytesToBase64(pcm) }),
      );
      ws.send(JSON.stringify({ type: "conversation.item.audio_output.done", item_id: "i1" }));
    }
  });

  let down: Frame[];
  try {
    const tts = new TogetherTTSService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${server.port}/v1/audio/speech/websocket`,
      settings: new TogetherTTSService.Settings({
        voice: "af_bella(2)+af_heart(1)",
        extraParams: { pronunciation_dict: ["Pipecat/pipe cat"] },
      }),
    });
    [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello world." }), new SleepFrame({ sleep: 0.4 })],
    });
  } finally {
    server.stop(true);
  }

  expect(captured.url).toContain("voice=af_bella%282%29%2Baf_heart%281%29");
  expect(captured.headers.authorization).toBe("Bearer test-key");
  expect(captured.messages[0]).toEqual({
    type: "tts_session.updated",
    session: {
      voice: "af_bella(2)+af_heart(1)",
      extra_params: { pronunciation_dict: ["Pipecat/pipe cat"] },
    },
  });
  expect(captured.messages).toContainEqual({
    type: "input_text_buffer.append",
    text: "Hello world.",
  });
  expect(captured.messages).toContainEqual({ type: "input_text_buffer.commit" });

  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const joined = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    joined.set(f.audio, offset);
    offset += f.audio.length;
  }
  expect(joined).toEqual(pcm);
  expect(audio.every((f) => f.sampleRate === 24000)).toBe(true);
  expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
});
