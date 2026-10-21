// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// MistralSTTService against a local stand-in for Mistral's realtime
// transcription WebSocket (/v1/audio/transcriptions/realtime). The fake
// follows the protocol of the mistralai SDK (3.3.0, extra/realtime): the
// server opens with `session.created`, the client then sends
// `session.update`, and the event payloads have the SDK schemas' fields.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  STTUpdateSettingsFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { MistralSTTService } from "../src/stt.ts";

interface Session {
  query: URLSearchParams;
  /** Whether a client message arrived before `session.created` was sent. */
  early: boolean;
  created: boolean;
  /** Send an `error` event instead of `session.created`. */
  failHandshake: boolean;
  authorization: string | null;
  events: Record<string, any>[];
  audioBytes: number;
}

let server: ReturnType<typeof Bun.serve>;
const sessions: Session[] = [];
let failNextHandshake = false;

beforeAll(() => {
  server = Bun.serve<Session>({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/audio/transcriptions/realtime") {
        return new Response("not found", { status: 404 });
      }
      const data: Session = {
        query: url.searchParams,
        early: false,
        created: false,
        failHandshake: failNextHandshake,
        authorization: request.headers.get("authorization"),
        events: [],
        audioBytes: 0,
      };
      sessions.push(data);
      return srv.upgrade(request, { data }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        // The session comes a little after the upgrade, so a client that
        // doesn't wait for it would send its update too early.
        setTimeout(() => {
          if (ws.data.failHandshake) {
            ws.send(
              JSON.stringify({ type: "error", error: { message: "Invalid model", code: 4001 } }),
            );
            return;
          }
          ws.data.created = true;
          ws.send(
            JSON.stringify({
              type: "session.created",
              session: {
                request_id: "req_1",
                model: ws.data.query.get("model"),
                audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
                target_streaming_delay_ms: null,
              },
            }),
          );
        }, 30);
      },
      message(ws, raw) {
        const event = JSON.parse(String(raw));
        if (!ws.data.created) ws.data.early = true;
        ws.data.events.push(event);
        const send = (e: Record<string, unknown>) => ws.send(JSON.stringify(e));
        if (event.type === "session.update") {
          send({
            type: "session.updated",
            session: {
              request_id: "req_1",
              model: ws.data.query.get("model"),
              ...event.session,
            },
          });
        } else if (event.type === "input_audio.append") {
          const first = ws.data.audioBytes === 0;
          ws.data.audioBytes += base64ToBytes(event.audio).length;
          if (first) {
            send({ type: "transcription.language", audio_language: "fr" });
            send({ type: "transcription.text.delta", text: "Bonjour" });
            send({ type: "transcription.text.delta", text: " le monde" });
          }
        } else if (event.type === "input_audio.flush") {
          send({
            type: "transcription.done",
            model: ws.data.query.get("model"),
            text: "Bonjour le monde.",
            usage: { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 },
            language: "fr",
          });
        }
      },
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  sessions.length = 0;
  failNextHandshake = false;
});

function audio(): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 16000, numChannels: 1 });
}

test("streams audio and pushes interim and final transcriptions", async () => {
  const stt = new MistralSTTService({
    apiKey: "mistral-key",
    baseUrl: `http://127.0.0.1:${server.port}`,
    sampleRate: 16000,
    targetStreamingDelayMs: 480,
  });
  const connected: unknown[] = [];
  const disconnected: unknown[] = [];
  stt.addEventHandler("on_connected", async () => {
    connected.push(true);
  });
  stt.addEventHandler("on_disconnected", async () => {
    disconnected.push(true);
  });

  const [down] = await runTest(stt, {
    framesToSend: [
      new SleepFrame({ sleep: 0.1 }),
      new VADUserStartedSpeakingFrame(),
      audio(),
      audio(),
      new SleepFrame({ sleep: 0.1 }),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.1 }),
    ],
  });

  const session = sessions[0]!;
  expect(session.authorization).toBe("Bearer mistral-key");
  expect(session.query.get("model")).toBe("voxtral-mini-transcribe-realtime-2602");
  expect(session.query.has("target_streaming_delay_ms")).toBe(false);
  expect(session.early).toBe(false);
  expect(session.events[0]).toEqual({
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
      target_streaming_delay_ms: 480,
    },
  });
  expect(session.audioBytes).toBe(640);
  expect(session.events.some((e) => e.type === "input_audio.flush")).toBe(true);

  const interims = down.filter(
    (f): f is InterimTranscriptionFrame => f instanceof InterimTranscriptionFrame,
  );
  expect(interims.map((f) => f.text)).toEqual(["Bonjour", "Bonjour le monde"]);
  const finals = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
  expect(finals.length).toBe(1);
  expect(finals[0]!.text).toBe("Bonjour le monde.");
  expect(finals[0]!.language).toBe("fr");

  expect(connected.length).toBe(1);
  expect(disconnected.length).toBe(1);
});

test("a settings change reconnects with the new model", async () => {
  const stt = new MistralSTTService({
    apiKey: "mistral-key",
    baseUrl: `http://127.0.0.1:${server.port}`,
    sampleRate: 16000,
  });

  await runTest(stt, {
    framesToSend: [
      new SleepFrame({ sleep: 0.1 }),
      new STTUpdateSettingsFrame({
        delta: new MistralSTTService.Settings({ model: "voxtral-other" }),
      }),
      new SleepFrame({ sleep: 0.1 }),
    ],
  });

  expect(sessions.length).toBe(2);
  expect(sessions[0]!.query.get("model")).toBe("voxtral-mini-transcribe-realtime-2602");
  expect(sessions[1]!.query.get("model")).toBe("voxtral-other");
  expect(sessions[0]!.events[0]).toEqual({
    type: "session.update",
    session: { audio_format: { encoding: "pcm_s16le", sample_rate: 16000 } },
  });
});

test("an error during the handshake is reported", async () => {
  failNextHandshake = true;
  const stt = new MistralSTTService({
    apiKey: "mistral-key",
    baseUrl: `http://127.0.0.1:${server.port}`,
    sampleRate: 16000,
  });
  const errors: string[] = [];
  const original = stt.pushError.bind(stt);
  stt.pushError = async (msg: string, options?: any) => {
    errors.push(msg);
    await original(msg, options);
  };

  await runTest(stt, { framesToSend: [new SleepFrame({ sleep: 0.1 })] });

  expect(errors.some((e) => e.includes("Invalid model"))).toBe(true);
  expect(sessions[0]!.events).toEqual([]);
});
