// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for the OpenAI API, for the end-to-end test: transcription
// returns the scripted question, chat streams a canned answer chosen from the
// last user message, and speech returns a 24 kHz PCM tone. The realtime
// transcription websocket (/v1/realtime) detects speech by its energy, as the
// server's VAD would, and transcribes each utterance as the scripted question.

import {
  ANSWER,
  GREETING,
  type ProviderMock,
  SCRIPTED_QUESTION,
  tonePcm,
} from "./mock_provider.ts";

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export interface MockOpenAI extends ProviderMock {
  /** WebSocket base URL for the realtime API (`OpenAIRealtimeSTTService`'s `baseUrl`). */
  realtimeUrl: string;
  /** The `Authorization` header of each realtime connection. */
  realtimeAuth: (string | null)[];
  /** When set, chat completions fail with a server error. */
  failChat: boolean;
  /** The messages of each chat completion request. */
  chats: { role: string; content: unknown }[][];
  /** Each chat completion request: its `Authorization` header and JSON body. */
  chatRequests: { authorization: string | null; body: Record<string, any> }[];
}

/** RMS above which a 16-bit chunk counts as speech. */
const SPEECH_RMS = 500;
/** Silence that ends an utterance, in seconds. */
const END_OF_SPEECH_SECS = 0.5;
/** The realtime API's audio rate. */
const REALTIME_RATE = 24000;

interface RealtimeSession {
  speaking: boolean;
  silenceSecs: number;
  items: number;
}

function rms(pcm: Int16Array): number {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

/** The server side of a realtime transcription session. */
function handleRealtimeMessage(
  socket: Bun.ServerWebSocket<RealtimeSession>,
  raw: string | Buffer,
  mock: MockOpenAI,
): void {
  const event = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
  const session = socket.data;
  if (event.type === "session.update") {
    send({ type: "session.updated", session: event.session ?? {} });
  } else if (event.type === "input_audio_buffer.append") {
    const bytes = Buffer.from(event.audio, "base64");
    mock.heard += bytes.length;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const loud = rms(pcm) > SPEECH_RMS;
    if (loud && !session.speaking) {
      session.speaking = true;
      session.silenceSecs = 0;
      send({ type: "input_audio_buffer.speech_started" });
    } else if (session.speaking) {
      session.silenceSecs = loud ? 0 : session.silenceSecs + pcm.length / REALTIME_RATE;
      if (session.silenceSecs >= END_OF_SPEECH_SECS) {
        session.speaking = false;
        const itemId = `item_${++session.items}`;
        send({ type: "input_audio_buffer.speech_stopped" });
        send({ type: "input_audio_buffer.committed", item_id: itemId });
        send({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          transcript: SCRIPTED_QUESTION,
        });
      }
    }
  }
}

export function startMockOpenAI(): MockOpenAI {
  const mock: MockOpenAI = {
    baseUrl: "",
    realtimeUrl: "",
    realtimeAuth: [],
    failChat: false,
    chats: [],
    chatRequests: [],
    heard: 0,
    asked: [],
    spoken: [],
    stop: () => server.stop(true),
  };

  const server = Bun.serve<RealtimeSession>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "session.created" }));
      },
      message(socket, raw) {
        handleRealtimeMessage(socket, raw, mock);
      },
    },
    async fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === "/v1/realtime") {
        mock.realtimeAuth.push(request.headers.get("authorization"));
        const data: RealtimeSession = { speaking: false, silenceSecs: 0, items: 0 };
        return server.upgrade(request, { data })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 });

      if (pathname === "/v1/audio/transcriptions") {
        const form = await request.formData();
        const file = form.get("file") as File;
        mock.heard += file.size;
        return Response.json({ text: SCRIPTED_QUESTION });
      }

      if (pathname === "/v1/chat/completions") {
        if (mock.failChat) {
          return Response.json(
            { error: { message: "mock chat failure", type: "server_error" } },
            { status: 500 },
          );
        }
        const body = (await request.json()) as {
          messages: { role: string; content: unknown }[];
        } & Record<string, any>;
        mock.chatRequests.push({ authorization: request.headers.get("authorization"), body });
        mock.chats.push(body.messages);
        const last = [...body.messages].reverse().find((m) => m.role === "user");
        const question = typeof last?.content === "string" ? last.content : "";
        mock.asked.push(question);
        const answer = question.includes("capital") ? ANSWER : GREETING;
        return new Response(
          chunk({ role: "assistant", content: answer }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      if (pathname === "/v1/audio/speech") {
        const body = (await request.json()) as { input: string };
        mock.spoken.push(body.input);
        return new Response(tonePcm(), { headers: { "content-type": "application/octet-stream" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  mock.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  mock.realtimeUrl = `ws://127.0.0.1:${server.port}/v1/realtime`;
  return mock;
}
