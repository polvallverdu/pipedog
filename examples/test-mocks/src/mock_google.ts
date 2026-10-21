// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for the Gemini API, for the end-to-end test: the Live websocket
// transcribes the user's audio as the scripted question, the chat endpoint
// streams a canned answer chosen from the last user message, and the speech
// endpoint returns a 24 kHz PCM tone. Like mock_openai.ts, it records what it
// receives. It serves the endpoints the SDK uses under `baseUrl`.

import {
  ANSWER,
  GREETING,
  type ProviderMock,
  SCRIPTED_QUESTION,
  tonePcm,
} from "./mock_provider.ts";

interface Part {
  text?: string;
}

interface Content {
  role?: string;
  parts?: Part[];
}

function textOf(content: Content | undefined): string {
  return (content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** The question the chat model is answering: the last user turn's text. */
function lastUserText(contents: Content[]): string {
  const user = [...contents].reverse().find((c) => c.role === "user" || c.role === undefined);
  return user ? textOf(user) : "";
}

function sseEvent(event: unknown): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(text: string): Response {
  return sseEvent({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
  });
}

/** Mock Live session: acknowledges setup, and transcribes the audio when it ends. */
function handleLiveMessage(
  socket: Bun.ServerWebSocket<unknown>,
  raw: string | Buffer,
  mock: ProviderMock,
): void {
  const message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  if (message.setup) {
    socket.send(JSON.stringify({ setupComplete: {} }));
  } else if (message.realtimeInput?.audio) {
    mock.heard += Buffer.from(message.realtimeInput.audio.data, "base64").length;
  } else if (message.realtimeInput?.audioStreamEnd) {
    socket.send(
      JSON.stringify({
        serverContent: { inputTranscription: { text: SCRIPTED_QUESTION, finished: true } },
      }),
    );
  }
}

export function startMockGoogle(): ProviderMock {
  const mock: ProviderMock = {
    baseUrl: "",
    heard: 0,
    asked: [],
    spoken: [],
    stop: () => server.stop(true),
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      message(socket, raw) {
        handleLiveMessage(socket, raw, mock);
      },
    },
    async fetch(request, server) {
      const { pathname } = new URL(request.url);

      // The SDK joins "/ws/" onto a base URL that already ends in "/", hence "//ws/".
      if (pathname.includes("/ws/")) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }

      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const body = (await request.json()) as {
        contents: Content[];
        generationConfig?: { responseModalities?: string[] };
      };

      if (pathname.endsWith(":streamGenerateContent")) {
        // Speech synthesis streams too: its request asks for AUDIO output.
        if (body.generationConfig?.responseModalities?.includes("AUDIO")) {
          const text = textOf(body.contents[0]);
          mock.spoken.push(text);
          const data = Buffer.from(tonePcm()).toString("base64");
          return sseEvent({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ inlineData: { mimeType: "audio/pcm", data } }],
                },
              },
            ],
          });
        }
        const question = lastUserText(body.contents);
        mock.asked.push(question);
        return sse(question.includes("capital") ? ANSWER : GREETING);
      }

      return new Response("not found", { status: 404 });
    },
  });

  mock.baseUrl = `http://127.0.0.1:${server.port}`;
  return mock;
}
