// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs MiniMaxHttpTTSService through a pipeline against an in-process fake
// `fetch` that answers with MiniMax's streamed `data:` blocks of hex audio.

import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { languageToMinimaxLanguage, MiniMaxHttpTTSService } from "@pipedog/minimax/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`minimax smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async function smoke(): Promise<Record<string, string>> {
  check(languageToMinimaxLanguage(Language.PT_BR) === "Portuguese", "language map");

  const requests: { url: string; headers: Headers; body: string }[] = [];
  const body =
    `data:${JSON.stringify({ data: { audio: hex(PCM), status: 1 } })}\n\n` +
    `data:${JSON.stringify({ data: { audio: hex(PCM), status: 1 } })}\n\n` +
    `data:${JSON.stringify({ data: { audio: hex(PCM), status: 2 }, extra_info: {} })}\n\n`;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;

  const tts = new MiniMaxHttpTTSService({
    apiKey: "smoke-key",
    groupId: "smoke-group",
    sampleRate: 24000,
    fetch: fakeFetch,
  });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });

  check(requests.length === 1, `${requests.length} requests`);
  check(requests[0]!.url === "https://api.minimax.io/v1/t2a_v2?GroupId=smoke-group", "url");
  check(requests[0]!.headers.get("authorization") === "Bearer smoke-key", "auth");
  check(JSON.parse(requests[0]!.body).audio_setting.sample_rate === 24000, "audio setting");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  // The last block has no successor and carries the aggregated audio: it is not emitted.
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length * 2, "audio");
  return { http_tts: "ok" };
}
