// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for NeuphonicTTSService and NeuphonicHttpTTSService.
 *
 * Upstream (pipecat) has no Neuphonic test file, so these are written for the port: they
 * drive both services against local `Bun.serve` fakes of Neuphonic's WebSocket (`/speak/<lang>`,
 * `<STOP>`) and SSE (`/sse/speak/<lang>`) endpoints, whose wire format follows
 * `src/pipecat/services/neuphonic/tts.py` and the `pyneuphonic` SDK.
 */

import { describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  languageToNeuphonicLangCode,
  NeuphonicHttpTTSService,
  NeuphonicTTSService,
} from "../src/tts.ts";

type Dict = Record<string, any>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("TestLanguageMapping", () => {
  test("base languages map to their code", () => {
    expect(languageToNeuphonicLangCode(Language.EN)).toBe("en");
    expect(languageToNeuphonicLangCode(Language.ZH)).toBe("zh");
  });

  test("regional variants fall back to the base code", () => {
    expect(languageToNeuphonicLangCode(Language.PT_BR)).toBe("pt");
    expect(languageToNeuphonicLangCode(Language.ES_MX)).toBe("es");
  });
});

describe("TestNeuphonicTTSService", () => {
  const audio = Uint8Array.from({ length: 2048 }, (_, i) => (i * 3) & 0xff);

  test("connects with the query string and key header, sends <STOP>-terminated text", async () => {
    const messages: Dict[] = [];
    let requestUrl = "";
    let apiKey: string | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, srv) {
        requestUrl = request.url;
        apiKey = request.headers.get("x-api-key");
        if (srv.upgrade(request, { data: {} })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          messages.push(msg);
          if (msg.text?.trim() && msg.text.trim() !== "<STOP>") {
            ws.send(JSON.stringify({ data: { audio: b64(audio) } }));
          }
        },
      },
    });
    try {
      const tts = new NeuphonicTTSService({
        apiKey: "nk",
        url: `ws://127.0.0.1:${server.port}`,
        settings: new NeuphonicTTSService.Settings({ voice: "voice-1", temperature: 0.5 }),
      });
      const [down] = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.3 })],
      });

      expect(apiKey).toBe("nk");
      const url = new URL(requestUrl);
      expect(url.pathname).toBe("/speak/en");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        lang_code: "en",
        speed: "1.0",
        temperature: "0.5",
        encoding: "pcm_linear",
        sampling_rate: "22050",
        voice_id: "voice-1",
      });
      expect(messages.some((m) => m.text === "Hello. <STOP>")).toBe(true);
      const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
      expect(frames.reduce((n, f) => n + f.audio.length, 0)).toBe(audio.length);
      expect(frames[0]!.sampleRate).toBe(22050);
      expect(down.some((f) => f instanceof TTSStoppedFrame)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("TestNeuphonicHttpTTSService", () => {
  const audio = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) & 0xff);

  async function withSseServer<T>(
    respond: () => Response,
    fn: (
      baseUrl: string,
      requests: { path: string; key: string | null; body: Dict }[],
    ) => Promise<T>,
  ): Promise<T> {
    const requests: { path: string; key: string | null; body: Dict }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          key: request.headers.get("x-api-key"),
          body: (await request.json()) as Dict,
        });
        return respond();
      },
    });
    try {
      return await fn(`http://127.0.0.1:${server.port}`, requests);
    } finally {
      server.stop(true);
    }
  }

  test("streams the audio of each SSE data event", async () => {
    const body =
      `event: message\ndata: ${JSON.stringify({ data: { audio: b64(audio), text: "Hi" }, status_code: 200 })}\n\n` +
      `event: message\ndata: ${JSON.stringify({ data: { audio: b64(audio) }, status_code: 200 })}\n\n`;
    await withSseServer(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      async (baseUrl, requests) => {
        const tts = new NeuphonicHttpTTSService({
          apiKey: "nk",
          url: `${baseUrl}/`,
          settings: new NeuphonicHttpTTSService.Settings({ voice: "voice-2", ipaKey: "pt-br" }),
        });
        const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
        expect(requests.length).toBe(1);
        expect(requests[0]!.path).toBe("/sse/speak/en");
        expect(requests[0]!.key).toBe("nk");
        expect(requests[0]!.body).toEqual({
          text: "Hi.",
          lang_code: "en",
          encoding: "pcm_linear",
          sampling_rate: 22050,
          speed: 1,
          voice_id: "voice-2",
          ipa_key: "pt-br",
        });
        const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
        expect(frames.length).toBe(2);
        expect(frames[0]!.audio).toEqual(audio);
      },
    );
  });

  test("an SSE event with errors becomes an ErrorFrame and the stream continues", async () => {
    const body =
      `data: ${JSON.stringify({ errors: ["bad voice"], status_code: 400 })}\n\n` +
      `data: ${JSON.stringify({ data: { audio: b64(audio) } })}\n\n`;
    await withSseServer(
      () => new Response(body),
      async (baseUrl) => {
        const tts = new NeuphonicHttpTTSService({ apiKey: "nk", url: baseUrl });
        const [down, up] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });
        const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
        expect(errors.some((f) => f.error.includes("Neuphonic API error 400"))).toBe(true);
        expect(down.filter((f) => f instanceof TTSAudioRawFrame).length).toBe(1);
      },
    );
  });

  test("a non-200 response becomes an ErrorFrame", async () => {
    await withSseServer(
      () => new Response("denied", { status: 403 }),
      async (baseUrl) => {
        const tts = new NeuphonicHttpTTSService({ apiKey: "nk", url: baseUrl });
        const [down, up] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });
        const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
        expect(errors.some((f) => f.error === "Neuphonic API error: HTTP 403 - denied")).toBe(true);
      },
    );
  });
});
