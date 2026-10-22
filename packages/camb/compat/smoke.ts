// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs CambTTSService through a pipeline against an in-process fake `fetch`
// that streams PCM in chunks split mid-sample.

import { CambTTSService, languageToCambLanguage } from "@pipedog/camb/tts";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`camb smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

export default async function smoke(): Promise<Record<string, string>> {
  check(languageToCambLanguage(Language.EN) === "en-us", "language map");

  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PCM.slice(0, 501));
        controller.enqueue(PCM.slice(501));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "audio/x-pcm" } });
  }) as typeof fetch;

  const tts = new CambTTSService({ apiKey: "smoke-key", fetch: fakeFetch });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });

  check(requests.length === 1, `${requests.length} requests`);
  check(requests[0]!.url === "https://client.camb.ai/apis/tts-stream", "url");
  check(requests[0]!.headers.get("x-api-key") === "smoke-key", "api key");
  check(JSON.parse(requests[0]!.body).speech_model === "mars-flash", "model");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(
    audio.every((f) => f.audio.length % 2 === 0 && f.sampleRate === 22050),
    "aligned frames",
  );
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "audio");
  return { http_tts: "ok" };
}
