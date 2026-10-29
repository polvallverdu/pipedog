// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_minimax_tts_language.py

/**
 * Tests for MiniMax TTS language name mapping and emotions.
 *
 * The tests after the two ported ones are not in upstream: they drive
 * `MiniMaxHttpTTSService` against a local `Bun.serve` fake of the T2A endpoint.
 */

import { describe, expect, test } from "bun:test";
import { ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  languageToMinimaxLanguage,
  MiniMaxHttpTTSService,
  MiniMaxTTSSettings,
} from "../src/tts.ts";

type Dict = Record<string, any>;

test("test_minimax_base_language_uses_name", () => {
  expect(languageToMinimaxLanguage(Language.PT)).toBe("Portuguese");
});

test("test_minimax_regional_variant_uses_base_language_name", () => {
  // MiniMax names languages without regions, so a regional variant uses its base name.
  expect(languageToMinimaxLanguage(Language.PT_BR)).toBe("Portuguese");
  expect(languageToMinimaxLanguage(Language.EN_US)).toBe("English");
});

// Skipped: exercises only the deprecated `MiniMaxHttpTTSService.InputParams` / `params`
// constructor argument (deprecated since 0.0.105 upstream), which is not ported.
describe.each(["calm", "whisper", "happy", "neutral"])(
  "test_minimax_input_params_accept_documented_emotions[%s]",
  (_emotion) => {
    test.skip("test_minimax_input_params_accept_documented_emotions", () => {});
  },
);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dataEvent(payload: Dict): string {
  return `data:${JSON.stringify(payload)}\n\n`;
}

async function withServer<T>(
  respond: () => Response,
  fn: (baseUrl: string, requests: { url: URL; headers: Headers; body: Dict }[]) => Promise<T>,
): Promise<T> {
  const requests: { url: URL; headers: Headers; body: Dict }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        url: new URL(request.url),
        headers: request.headers,
        body: (await request.json()) as Dict,
      });
      return respond();
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}/v1/t2a_v2`, requests);
  } finally {
    server.stop(true);
  }
}

describe("TestMiniMaxHttpTTSService", () => {
  const PCM_1 = Uint8Array.from({ length: 640 }, (_, i) => i & 0xff);
  const PCM_2 = Uint8Array.from({ length: 320 }, (_, i) => (i * 3) & 0xff);

  test("streams the hex audio of each data block and skips the aggregated final block", async () => {
    const body =
      dataEvent({ data: { audio: hex(PCM_1), status: 1 }, base_resp: { status_code: 0 } }) +
      dataEvent({ data: { audio: hex(PCM_2), status: 1 } }) +
      // The final block carries the whole utterance again, plus extra_info.
      dataEvent({
        data: { audio: hex(PCM_1) + hex(PCM_2), status: 2 },
        extra_info: { audio_length: 1 },
      });
    await withServer(
      () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      async (baseUrl, requests) => {
        const tts = new MiniMaxHttpTTSService({
          apiKey: "k",
          baseUrl,
          groupId: "g1",
          sampleRate: 24000,
          settings: new MiniMaxHttpTTSService.Settings({
            voice: "Lively_Girl",
            emotion: "happy",
            languageBoost: "English",
          }),
        });
        const [down] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
        });
        expect(requests.length).toBe(1);
        const request = requests[0]!;
        expect(request.url.searchParams.get("GroupId")).toBe("g1");
        expect(request.headers.get("authorization")).toBe("Bearer k");
        expect(request.body).toEqual({
          stream: true,
          voice_setting: { voice_id: "Lively_Girl", speed: 1, vol: 1, pitch: 0, emotion: "happy" },
          audio_setting: { bitrate: 128000, format: "pcm", channel: 1, sample_rate: 24000 },
          model: "speech-2.8-turbo",
          text: "Hello.",
          language_boost: "English",
        });
        const audio = down.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
        // The first two data blocks are complete; the last block has no successor and is
        // never extracted (as upstream), which is also what drops the aggregated audio.
        expect(audio.map((f) => f.audio)).toEqual([PCM_1, PCM_2]);
      },
    );
  });

  test("a non-200 response becomes an ErrorFrame", async () => {
    await withServer(
      () => new Response("nope", { status: 500 }),
      async (baseUrl) => {
        const tts = new MiniMaxHttpTTSService({
          apiKey: "k",
          baseUrl,
          groupId: "g",
          sampleRate: 24000,
        });
        const [down, up] = await runTest(tts, {
          framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
        });
        const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
        expect(errors.some((f) => f.error === "MiniMax TTS error: HTTP 500")).toBe(true);
      },
    );
  });

  test("settings from a legacy voice_setting mapping", () => {
    const delta = MiniMaxTTSSettings.fromMapping({
      voice_setting: { speed: 1.2, vol: 3, pitch: 2, emotion: "calm" },
      model: "speech-2.6-hd",
    });
    expect(delta.speed).toBe(1.2);
    expect(delta.volume).toBe(3);
    expect(delta.pitch).toBe(2);
    expect(delta.emotion).toBe("calm");
    expect(delta.model).toBe("speech-2.6-hd");
    expect(delta).toBeInstanceOf(MiniMaxTTSSettings);
  });
});
