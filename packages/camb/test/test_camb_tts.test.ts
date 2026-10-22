// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for CambTTSService.
 *
 * Upstream (pipecat) has no Camb test file, so these are written for the port. They drive
 * the service against a local `Bun.serve` fake of Camb's `POST /tts-stream`, whose wire
 * format follows the `camb-sdk` 1.5.4 client (`camb/text_to_speech/raw_client.py`) that
 * upstream calls, and Camb's API reference.
 */

import { describe, expect, test } from "bun:test";
import { ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  _getAlignedAudio,
  CambTTSService,
  languageToCambLanguage,
  MODEL_SAMPLE_RATES,
} from "../src/tts.ts";

type Dict = Record<string, any>;

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function withServer<T>(
  respond: () => Response,
  fn: (baseUrl: string, requests: { path: string; key: string | null; body: Dict }[]) => Promise<T>,
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
    return await fn(`http://127.0.0.1:${server.port}/apis`, requests);
  } finally {
    server.stop(true);
  }
}

describe("TestHelpers", () => {
  test("aligned audio keeps whole 16-bit samples and returns the odd byte", () => {
    const [aligned, rest] = _getAlignedAudio(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(aligned).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(rest).toEqual(Uint8Array.from([5]));
    expect(_getAlignedAudio(new Uint8Array(0))).toEqual([new Uint8Array(0), new Uint8Array(0)]);
  });

  test("language mapping", () => {
    expect(languageToCambLanguage(Language.EN)).toBe("en-us");
    expect(languageToCambLanguage(Language.PT_BR)).toBe("pt-br");
    // A variant that is not mapped falls back to its base language's code.
    expect(languageToCambLanguage(Language.EN_NZ)).toBe("en-us");
  });
});

describe("TestCambTTSService", () => {
  const pcm = Uint8Array.from({ length: 3000 }, (_, i) => (i * 13) & 0xff);

  test("posts the SDK's request and streams sample-aligned frames at the model's rate", async () => {
    await withServer(
      () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Split mid-sample to check that emitted frames stay aligned.
            controller.enqueue(pcm.slice(0, 1001));
            await Bun.sleep(5);
            controller.enqueue(pcm.slice(1001, 2000));
            await Bun.sleep(5);
            controller.enqueue(pcm.slice(2000));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "audio/x-pcm" } });
      },
      async (baseUrl, requests) => {
        const tts = new CambTTSService({
          apiKey: "ck",
          baseUrl,
          settings: new CambTTSService.Settings({ model: "mars-pro", voice: 12345 }),
        });
        const [down] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
        });

        expect(requests.length).toBe(1);
        expect(requests[0]!.path).toBe("/apis/tts-stream");
        expect(requests[0]!.key).toBe("ck");
        expect(requests[0]!.body).toEqual({
          text: "Hello.",
          voice_id: 12345,
          language: "en-us",
          speech_model: "mars-pro",
          output_configuration: { format: "pcm_s16le" },
        });
        const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
        expect(frames.every((f) => f.audio.length % 2 === 0)).toBe(true);
        expect(frames.every((f) => f.sampleRate === MODEL_SAMPLE_RATES["mars-pro"])).toBe(true);
        expect(concat(frames.map((f) => f.audio))).toEqual(pcm);
      },
    );
  });

  test("user instructions are sent only for mars-instruct", async () => {
    await withServer(
      () => new Response(pcm),
      async (baseUrl, requests) => {
        for (const model of ["mars-flash", "mars-instruct"]) {
          const tts = new CambTTSService({
            apiKey: "ck",
            baseUrl,
            settings: new CambTTSService.Settings({ model, userInstructions: "Whisper." }),
          });
          await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
        }
        expect("user_instructions" in requests[0]!.body).toBe(false);
        expect(requests[1]!.body.user_instructions).toBe("Whisper.");
        expect(requests[1]!.body.speech_model).toBe("mars-instruct");
      },
    );
  });

  test("an explicit sample rate wins over the model's", async () => {
    await withServer(
      () => new Response(pcm),
      async (baseUrl) => {
        const tts = new CambTTSService({ apiKey: "ck", baseUrl, sampleRate: 24000 });
        const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
        const frames = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((f) => f.sampleRate === 24000)).toBe(true);
      },
    );
  });

  test("an API error becomes an ErrorFrame", async () => {
    await withServer(
      () => Response.json({ detail: [{ msg: "bad voice" }] }, { status: 422 }),
      async (baseUrl) => {
        const tts = new CambTTSService({ apiKey: "ck", baseUrl });
        const [down, up] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hi." })],
        });
        const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
        expect(errors.some((f) => f.error.startsWith("Camb.ai TTS error: status_code: 422"))).toBe(
          true,
        );
        expect(errors.some((f) => f.error.includes("bad voice"))).toBe(true);
      },
    );
  });
});
