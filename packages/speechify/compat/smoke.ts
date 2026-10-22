// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd) it imports
// the package and runs SpeechifyHttpTTSService through a pipeline against an in-process fake
// `fetch` that answers with Speechify's Server-Sent Events stream.

import { TTSAudioRawFrame, TTSSpeakFrame, TTSTextFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  languageToSpeechifyLanguage,
  SPEECHIFY_API_VERSION,
  SpeechifyHttpTTSService,
} from "@pipedog/speechify/tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`speechify smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export default async function smoke(): Promise<Record<string, string>> {
  check(languageToSpeechifyLanguage(Language.EN) === "en-US", "language map");

  const requests: { url: string; headers: Headers; body: string }[] = [];
  const body =
    `event: speech.chunk\ndata: ${JSON.stringify({
      audio: b64(PCM),
      speech_marks: [
        { type: "word", value: "Hello", start: 0, end: 5, start_time: 0, end_time: 400 },
      ],
    })}\n\n` +
    `event: speech.chunk\ndata: ${JSON.stringify({
      speech_marks: [
        { type: "word", value: "world.", start: 6, end: 12, start_time: 400, end_time: 900 },
      ],
    })}\n\n` +
    `event: speech.done\ndata: ${JSON.stringify({ audio_duration_ms: 900 })}\n\n`;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;

  const tts = new SpeechifyHttpTTSService({
    apiKey: "smoke-key",
    sampleRate: 24000,
    fetch: fakeFetch,
  });
  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello world." })],
  });

  check(requests.length === 1, `${requests.length} requests`);
  check(requests[0]!.url === "https://api.speechify.ai/v1/audio/stream/with-timestamps", "url");
  check(requests[0]!.headers.get("speechify-version") === SPEECHIFY_API_VERSION, "version header");
  check(JSON.parse(requests[0]!.body).output_format === "pcm_24000", "output format");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "audio");
  const words = down.filter((f) => f instanceof TTSTextFrame) as TTSTextFrame[];
  check(words.map((f) => f.text).join("|") === "Hello|world.", "word timestamps");
  return { http_tts: "ok" };
}
