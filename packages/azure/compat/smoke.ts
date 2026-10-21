// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. On every runtime (bun, node, deno, workerd):
// - imports every module of the package;
// - constructs every service class (none opens a connection or needs an SDK to construct);
// - runs AzureHttpTTSService through a pipeline against an in-process fake `fetch`, and
//   AzureImageGenServiceREST's submit/poll/download flow against another.
// The WebSocket services (STT, streaming TTS, Realtime, Voice Live) go through core's
// `websocketConnect`, which the core and transport smoke tests cover on every runtime.

import { AzureVoiceLiveLLMAdapter } from "@pipedog/azure/azure_voice_live_adapter";
import { languageToAzureLanguage } from "@pipedog/azure/common";
import { AzureImageGenServiceREST } from "@pipedog/azure/image";
import { AzureLLMService } from "@pipedog/azure/llm";
import { AzureRealtimeLLMService } from "@pipedog/azure/realtime/llm";
import { AzureSTTService } from "@pipedog/azure/stt";
import { AzureHttpTTSService, AzureTTSService } from "@pipedog/azure/tts";
import * as voiceLiveEvents from "@pipedog/azure/voice_live/events";
import { AzureVoiceLiveLLMService } from "@pipedog/azure/voice_live/llm";
import { TTSAudioRawFrame, TTSSpeakFrame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`azure smoke: ${message}`);
}

const PCM = Uint8Array.from({ length: 960 }, (_, i) => (i * 7) & 0xff);

async function httpTts(): Promise<void> {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response(PCM, { headers: { "Content-Type": "audio/basic" } });
  }) as typeof fetch;
  const tts = new AzureHttpTTSService({
    apiKey: "smoke-key",
    region: "eastus",
    sampleRate: 24000,
    fetch: fakeFetch,
  });
  const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
  check(requests.length === 1, `http tts: ${requests.length} requests`);
  check(requests[0]!.url.startsWith("https://eastus.tts.speech.microsoft.com/"), "http tts url");
  check(requests[0]!.body.includes("en-US-SaraNeural"), "http tts ssml");
  const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  check(audio.reduce((n, f) => n + f.audio.length, 0) === PCM.length, "http tts audio");
}

async function imageGen(): Promise<void> {
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("generations:submit")) {
      return new Response("{}", { headers: { "operation-location": "https://smoke/op" } });
    }
    if (url === "https://smoke/op") {
      return Response.json({ status: "succeeded", result: { data: [{ url: "https://smoke/i" }] } });
    }
    return new Response(new Uint8Array([0]));
  }) as typeof fetch;
  const service = new AzureImageGenServiceREST({
    apiKey: "smoke-key",
    endpoint: "https://smoke.openai.azure.com/",
    fetch: fakeFetch,
    decodeImage: () => ({ image: new Uint8Array(3), size: [1, 1] }),
  });
  const frames = [];
  for await (const f of service.runImageGen("a cat")) frames.push(f);
  check(frames[0] instanceof URLImageRawFrame, "image frame");
}

export default async function smoke(): Promise<Record<string, string>> {
  check(languageToAzureLanguage(Language.EN) === "en-US", "language map");
  check(typeof voiceLiveEvents === "object", "voice live events");
  check(typeof AzureVoiceLiveLLMAdapter === "function", "voice live adapter");

  new AzureLLMService({ apiKey: "k", endpoint: "https://r.openai.azure.com/openai/v1" });
  new AzureLLMService({ apiKey: "k", endpoint: "https://r.openai.azure.com" });
  new AzureRealtimeLLMService({
    apiKey: "k",
    baseUrl: "wss://r.openai.azure.com/openai/v1/realtime",
  });
  new AzureVoiceLiveLLMService({ apiKey: "k", endpoint: "https://r.services.ai.azure.com" });
  new AzureSTTService({ apiKey: "k", region: "eastus" });
  new AzureTTSService({ apiKey: "k", region: "eastus" });

  await httpTts();
  await imageGen();
  return { http_tts: "ok", image: "ok" };
}
