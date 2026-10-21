// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for the OpenAI API, for the end-to-end test: transcription
// returns the scripted question, chat streams a canned answer chosen from the
// last user message, and speech returns a 24 kHz PCM tone. It records what it
// receives so the test can check what the bot sent.

export const SCRIPTED_QUESTION = "What is the capital of Germany?";
export const ANSWER = "The capital of Germany is Berlin.";
export const GREETING = "Hello, I am your voice assistant. Ask me anything.";

export interface MockOpenAI {
  /** Base URL to use as the OpenAI `baseUrl` (ends in `/v1`). */
  baseUrl: string;
  /** Byte size of each audio file sent for transcription. */
  transcriptions: number[];
  /** The messages of each chat completion request. */
  chats: { role: string; content: unknown }[][];
  /** The text of each speech synthesis request. */
  speeches: string[];
  stop(): void;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** 0.5 s of a 440 Hz tone, 24 kHz mono 16-bit little-endian PCM. */
function tonePcm(): ArrayBuffer {
  const samples = 12000;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++)
    pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return pcm.buffer;
}

export function startMockOpenAI(): MockOpenAI {
  const mock: MockOpenAI = {
    baseUrl: "",
    transcriptions: [],
    chats: [],
    speeches: [],
    stop: () => server.stop(true),
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST") return new Response("not found", { status: 404 });

      if (pathname === "/v1/audio/transcriptions") {
        const form = await request.formData();
        const file = form.get("file") as File;
        mock.transcriptions.push(file.size);
        return Response.json({ text: SCRIPTED_QUESTION });
      }

      if (pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        mock.chats.push(body.messages);
        const last = [...body.messages].reverse().find((m) => m.role === "user");
        const answer =
          typeof last?.content === "string" && last.content.includes("capital") ? ANSWER : GREETING;
        return new Response(
          chunk({ role: "assistant", content: answer }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      if (pathname === "/v1/audio/speech") {
        const body = (await request.json()) as { input: string };
        mock.speeches.push(body.input);
        return new Response(tonePcm(), { headers: { "content-type": "application/octet-stream" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  mock.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  return mock;
}
