// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end tests of the Azure Speech wire protocols against fake servers:
 * the WebSocket synthesis protocol (AzureTTSService), the REST synthesis
 * endpoint (AzureHttpTTSService) and the WebSocket conversation recognition
 * protocol (AzureSTTService).
 */

import { expect, test } from "bun:test";

import {
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

import {
  buildBinaryMessage,
  buildTextMessage,
  parseSpeechMessage,
  type SpeechMessage,
  wavStreamHeader,
} from "../src/speech_protocol.ts";
import { AzureSTTService } from "../src/stt.ts";
import { AzureHttpTTSService, AzureTTSService } from "../src/tts.ts";

function toBytes(data: string | Buffer | ArrayBuffer | Uint8Array): string | Uint8Array {
  if (typeof data === "string") return data;
  return new Uint8Array(data as ArrayBuffer);
}

/** A binary audio message from the service, with its stream id. */
function serviceAudio(requestId: string, streamId: string, body: Uint8Array): Uint8Array {
  const headers = `Path: audio\r\nX-RequestId: ${requestId}\r\nX-StreamId: ${streamId}\r\n`;
  const out = new Uint8Array(2 + headers.length + body.length);
  out[0] = (headers.length >> 8) & 0xff;
  out[1] = headers.length & 0xff;
  for (let i = 0; i < headers.length; i++) out[2 + i] = headers.charCodeAt(i);
  out.set(body, 2 + headers.length);
  return out;
}

function wordBoundary(text: string, offsetTicks: number): Record<string, unknown> {
  return {
    Type: "WordBoundary",
    Data: { Offset: offsetTicks, Duration: 1_000_000, text: { Text: text, Length: text.length } },
  };
}

test("protocol messages round-trip", () => {
  const text = parseSpeechMessage(
    buildTextMessage("speech.config", "ABC", "application/json", "{}"),
  );
  expect(text.path).toEqual("speech.config");
  expect(text.requestId).toEqual("ABC");
  expect(text.headers["content-type"]).toEqual("application/json");
  expect(text.text).toEqual("{}");

  const body = new Uint8Array([1, 2, 3, 4]);
  const binary = parseSpeechMessage(buildBinaryMessage("audio", "ABC", body, "audio/x-wav"));
  expect(binary.path).toEqual("audio");
  expect(binary.headers["content-type"]).toEqual("audio/x-wav");
  expect(binary.binary).toEqual(body);

  const header = wavStreamHeader(16000);
  expect(header.length).toEqual(44);
  expect(String.fromCharCode(...header.subarray(0, 4))).toEqual("RIFF");
  expect(new DataView(header.buffer).getUint32(24, true)).toEqual(16000);
});

test("AzureTTSService streams audio and word timestamps over the synthesis socket", async () => {
  const pcm = new Uint8Array(4800);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 7;

  const received: SpeechMessage[] = [];
  let query: URLSearchParams | null = null;
  let keyHeader: string | null = null;

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname !== "/tts/cognitiveservices/websocket/v1") {
        return new Response("not found", { status: 404 });
      }
      query = url.searchParams;
      keyHeader = request.headers.get("ocp-apim-subscription-key");
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const message = parseSpeechMessage(toBytes(data));
        received.push(message);
        if (message.path !== "ssml") return;
        const id = message.requestId;
        ws.send(buildTextMessage("turn.start", id, "application/json", "{}"));
        ws.send(
          buildTextMessage("response", id, "application/json", '{"audio":{"streamId":"S1"}}'),
        );
        ws.send(
          buildTextMessage(
            "audio.metadata",
            id,
            "application/json",
            JSON.stringify({
              Metadata: [
                wordBoundary("Hello", 500_000),
                wordBoundary("there", 3_000_000),
                wordBoundary(".", 6_000_000),
              ],
            }),
          ),
        );
        ws.send(serviceAudio(id, "S1", pcm.subarray(0, 2400)));
        // Another stream's audio is not this request's.
        ws.send(serviceAudio(id, "OTHER", new Uint8Array(100)));
        ws.send(serviceAudio(id, "S1", pcm.subarray(2400)));
        ws.send(buildTextMessage("turn.end", id, "application/json", "{}"));
      },
    },
  });

  let downFrames: Frame[];
  try {
    const tts = new AzureTTSService({
      apiKey: "test-key",
      privateEndpoint: `http://127.0.0.1:${server.port}/`,
      sampleRate: 24000,
      // No redirect for the custom endpoint.
      fetch: async () => new Response("", { status: 404 }),
    });
    [downFrames] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello there." }), new SleepFrame({ sleep: 0.3 })],
    });
  } finally {
    server.stop(true);
  }

  expect(keyHeader as string | null).toEqual("test-key");
  expect((query as URLSearchParams | null)?.get("Ocp-Apim-Subscription-Key")).toEqual("test-key");

  const paths = received.map((m) => m.path);
  expect(paths).toEqual(["speech.config", "synthesis.context", "ssml"]);
  const context = JSON.parse(received[1]!.text ?? "{}");
  expect(context.synthesis.audio.outputFormat).toEqual("raw-24khz-16bit-mono-pcm");
  expect(context.synthesis.audio.metadataOptions.wordBoundaryEnabled).toBe(true);
  expect(received[2]!.headers["content-type"]).toEqual("application/ssml+xml");
  expect(received[2]!.text).toContain("Hello there.");
  expect(received[2]!.requestId).toEqual(received[1]!.requestId);

  const audio = downFrames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const joined = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    joined.set(f.audio, offset);
    offset += f.audio.length;
  }
  expect(joined).toEqual(pcm);

  const words = downFrames.filter((f): f is TTSTextFrame => f instanceof TTSTextFrame);
  expect(words.map((w) => w.text)).toEqual(["Hello", "there."]);

  // The last word arrives before the stop frame.
  const lastWord = downFrames.indexOf(words.at(-1)!);
  const stopped = downFrames.findIndex((f) => f instanceof TTSStoppedFrame);
  expect(stopped).toBeGreaterThan(lastWord);
});

test("AzureHttpTTSService posts SSML and yields the raw PCM", async () => {
  const pcm = new Uint8Array(960);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 5;

  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(pcm, { status: 200 });
  }) as typeof fetch;

  const tts = new AzureHttpTTSService({
    apiKey: "test-key",
    region: "westeurope",
    sampleRate: 16000,
    fetch: fakeFetch,
  });
  const [downFrames] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Fish & chips" })],
  });

  expect(requestUrl).toEqual("https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
  const headers = requestInit?.headers as Record<string, string>;
  expect(headers["Ocp-Apim-Subscription-Key"]).toEqual("test-key");
  expect(headers["Content-Type"]).toEqual("application/ssml+xml");
  expect(headers["X-Microsoft-OutputFormat"]).toEqual("raw-16khz-16bit-mono-pcm");
  expect(String(requestInit?.body)).toContain("Fish &amp; chips");

  const audio = downFrames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const total = audio.reduce((n, f) => n + f.audio.length, 0);
  expect(total).toEqual(pcm.length);
});

test("AzureHttpTTSService reports an HTTP error", async () => {
  const fakeFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
  const tts = new AzureHttpTTSService({ apiKey: "k", region: "eastus", fetch: fakeFetch });
  const [, upFrames] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hi" })],
  });
  const errors = upFrames.filter((f) => f.name.startsWith("ErrorFrame"));
  expect(errors.length).toBeGreaterThan(0);
});

test("AzureSTTService recognizes over the conversation socket", async () => {
  const received: SpeechMessage[] = [];
  let query: URLSearchParams | null = null;
  let answered = false;

  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname !== "/speech/recognition/conversation/cognitiveservices/v1") {
        return new Response("not found", { status: 404 });
      }
      query = url.searchParams;
      if (srv.upgrade(request)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const message = parseSpeechMessage(toBytes(data));
        received.push(message);
        const isAudio =
          message.path === "audio" &&
          message.binary !== null &&
          message.headers["content-type"] === undefined;
        if (!isAudio || answered) return;
        answered = true;
        const id = message.requestId;
        ws.send(buildTextMessage("turn.start", id, "application/json", "{}"));
        ws.send(
          buildTextMessage("speech.hypothesis", id, "application/json", '{"Text":"hello wor"}'),
        );
        ws.send(
          buildTextMessage(
            "speech.phrase",
            id,
            "application/json",
            '{"RecognitionStatus":"Success","DisplayText":"Hello world.","Offset":0,"Duration":1}',
          ),
        );
        ws.send(buildTextMessage("turn.end", id, "application/json", "{}"));
      },
    },
  });

  let downFrames: Frame[];
  try {
    const stt = new AzureSTTService({
      apiKey: "test-key",
      privateEndpoint: `ws://127.0.0.1:${server.port}/`,
      sampleRate: 16000,
      settings: new AzureSTTService.Settings({
        profanity: "raw",
        segmentationSilenceTimeoutMs: 800,
      }),
    });
    [downFrames] = await runTest(stt, {
      framesToSend: [
        new SleepFrame({ sleep: 0.1 }),
        new InputAudioRawFrame({ audio: new Uint8Array(320), sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });
  } finally {
    server.stop(true);
  }

  const q = query as URLSearchParams | null;
  expect(q?.get("language")).toEqual("en-US");
  expect(q?.get("format")).toEqual("simple");
  expect(q?.get("profanity")).toEqual("raw");
  expect(q?.get("segmentationSilenceTimeoutMs")).toEqual("800");
  expect(q?.get("Ocp-Apim-Subscription-Key")).toEqual("test-key");

  expect(received.slice(0, 3).map((m) => m.path)).toEqual([
    "speech.config",
    "speech.context",
    "audio",
  ]);
  expect(JSON.parse(received[0]!.text ?? "{}").recognition).toEqual("conversation");
  expect(received[2]!.headers["content-type"]).toEqual("audio/x-wav");
  expect(received[2]!.binary?.length).toEqual(44);

  // After turn.end the next turn starts with a new request id.
  const contexts = received.filter((m) => m.path === "speech.context");
  expect(contexts.length).toBeGreaterThanOrEqual(2);
  expect(contexts[1]!.requestId).not.toEqual(contexts[0]!.requestId);

  const interim = downFrames.filter((f) => f instanceof InterimTranscriptionFrame);
  expect(interim.map((f) => (f as InterimTranscriptionFrame).text)).toEqual(["hello wor"]);
  const finals = downFrames.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
  expect(finals.map((f) => f.text)).toEqual(["Hello world."]);
  expect(finals[0]!.finalized).toBe(true);
});
