// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it
// runs `HumeTTSService` against an in-process fake `fetch` that streams Hume's
// newline-delimited JSON (audio and word-timestamp chunks).

import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { HumeTTSService } from "@pipedog/hume/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`hume smoke: ${message}`);
}

export default async function smoke(): Promise<Record<string, string>> {
  let seen: { url: string; key: string | null; body: any } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      key: (init.headers as Record<string, string>)["X-Hume-Api-Key"] ?? null,
      body: JSON.parse(init.body as string),
    };
    const lines = [
      { type: "audio", audio: btoa(String.fromCharCode(...new Uint8Array(2000).fill(1))) },
      {
        type: "timestamp",
        timestamp: { type: "word", text: "Hello", time: { begin: 0, end: 300 } },
      },
    ];
    return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { status: 200 });
  }) as unknown as typeof fetch;

  const service = new HumeTTSService({
    apiKey: "key",
    fetch: fakeFetch,
    settings: new HumeTTSService.Settings({ voice: "voice-1" }),
  });
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
    startTimeout: 3,
  });
  const request = seen as { url: string; key: string | null; body: any } | null;
  check(request?.url === "https://api.hume.ai/v0/tts/stream/json", "url");
  check(request.key === "key", "api key header");
  check(request.body.utterances[0].voice.id === "voice-1", "voice");
  check(
    down.some((f) => f instanceof TTSAudioRawFrame),
    "audio frame",
  );
  return { http: "ok" };
}
