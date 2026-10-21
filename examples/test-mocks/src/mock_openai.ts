// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A stand-in for the OpenAI API, for the end-to-end test: transcription
// returns the scripted question, chat streams a canned answer chosen from the
// last user message, and speech returns a 24 kHz PCM tone.

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

export function startMockOpenAI(): ProviderMock {
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
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST") return new Response("not found", { status: 404 });

      if (pathname === "/v1/audio/transcriptions") {
        const form = await request.formData();
        const file = form.get("file") as File;
        mock.heard += file.size;
        return Response.json({ text: SCRIPTED_QUESTION });
      }

      if (pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
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
  return mock;
}
