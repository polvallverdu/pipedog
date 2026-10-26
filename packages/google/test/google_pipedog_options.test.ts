// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * pipedog-only options of the Google speech services (no upstream test):
 * `finalizeOnVadStop` and `languageCodes` on GoogleSTTService, the `client`
 * and `bufferOnlyStartup` options and `GeminiTTSSettings.speakingRate`, and
 * gRPC CANCELLED treated as a quiet stop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  TranscriptionFrame,
  type TTSAudioRawFrame,
  TTSSpeakFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { GoogleSTTService, GoogleSTTSettings } from "../src/stt.ts";
import {
  GeminiTTSService,
  GeminiTTSSettings,
  type GoogleAudioResponse,
  type GoogleCloudTTSClient,
  type GoogleStreamingSynthesizeRequest,
  GoogleTTSService,
} from "../src/tts.ts";
import {
  type FakeGrpcServer,
  grpc,
  grpcError,
  insecureClientOptions,
  startFakeSpeechServer,
} from "./google_fakes.ts";

const CREDENTIALS = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  client_email: "svc@test-project.iam.gserviceaccount.com",
  private_key: "not-a-real-key",
});

const AUDIO = new Uint8Array(320);
const audioFrame = () =>
  new InputAudioRawFrame({ audio: AUDIO, sampleRate: 16000, numChannels: 1 });

let server: FakeGrpcServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const finals = (frames: Frame[]) =>
  frames.filter((f) => f instanceof TranscriptionFrame) as TranscriptionFrame[];

describe("GoogleSTTService finalizeOnVadStop", () => {
  test("VAD stop half-closes the stream; its finals become one finalized frame", async () => {
    // Like Google: no final until the request stream ends, then two segments.
    server = await startFakeSpeechServer((call, _record, index) => {
      call.on("data", () => {});
      call.on("end", () => {
        call.write({
          results: [{ alternatives: [{ transcript: `one ${index}` }], is_final: true }],
        });
        call.write({ results: [{ alternatives: [{ transcript: "two " }], is_final: true }] });
        call.end();
      });
    });
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
      finalizeOnVadStop: true,
    });
    const [down] = await runTest(stt, {
      framesToSend: [
        audioFrame(),
        audioFrame(),
        new VADUserStoppedSpeakingFrame(),
        // Audio after the half-close waits for the next stream.
        audioFrame(),
        new SleepFrame({ sleep: 0.4 }),
      ],
    });

    expect(server.calls.length).toBe(2);
    const [first, second] = server.calls as [any, any];
    expect(first.ended).toBe(true);
    expect(first.requests.map((r: any) => Object.keys(r)[0])).toEqual([
      "recognizer",
      "audio",
      "audio",
    ]);
    expect(second.requests.map((r: any) => Object.keys(r)[0])).toEqual(["recognizer", "audio"]);

    const results = finals(down);
    expect(results.map((f) => f.text)).toEqual(["one 0 two"]);
    expect(results[0]!.finalized).toBe(true);
  });

  test("off by default: a VAD stop does not end the stream", async () => {
    server = await startFakeSpeechServer((call) => {
      call.on("data", () => {});
      call.on("end", () => call.end());
    });
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
    });
    await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new VADUserStoppedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });
    expect(server.calls.length).toBe(1);
    expect(server.calls[0]!.requests.filter((r) => "audio" in r)).toHaveLength(2);
  });
});

describe("GoogleSTTService languageCodes", () => {
  test("codes are sent as-is and the detected language labels the transcript", async () => {
    server = await startFakeSpeechServer((call) => {
      call.on("data", (req: any) => {
        if (req.audio) {
          call.write({
            results: [
              { alternatives: [{ transcript: "hola" }], is_final: true, language_code: "es-ES" },
            ],
          });
        }
      });
      call.on("end", () => call.end());
    });
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
      settings: new GoogleSTTSettings({ model: "chirp_3", languageCodes: ["auto"] }),
    });
    const [down] = await runTest(stt, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })],
    });
    const config = server.calls[0]!.requests[0] as any;
    expect(config.streaming_config.config.language_codes).toEqual(["auto"]);
    expect(finals(down)[0]!.language as string).toBe("es-ES");
  });
});

describe("GoogleSTTService gRPC CANCELLED", () => {
  test("a cancelled call is not reported as an error", async () => {
    server = await startFakeSpeechServer((call, _record, index) => {
      call.on("data", () => {
        if (index === 0)
          call.emit("error", grpcError(grpc.status.CANCELLED, "Cancelled on client"));
      });
      call.on("end", () => call.end());
    });
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
    });
    const [, up] = await runTest(stt, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.3 })],
    });
    expect(up.filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
  });
});

/** A Cloud TTS client that records requests and streams back `chunks`. */
function fakeTtsClient(chunks: Uint8Array[] | Error) {
  const requests: GoogleStreamingSynthesizeRequest[][] = [];
  const client: GoogleCloudTTSClient = {
    async synthesizeSpeech() {
      throw new Error("unused");
    },
    async streamingSynthesize(input) {
      const sent: GoogleStreamingSynthesizeRequest[] = [];
      requests.push(sent);
      for await (const request of input) sent.push(request);
      return (async function* (): AsyncGenerator<GoogleAudioResponse> {
        if (chunks instanceof Error) throw chunks;
        for (const audioContent of chunks) yield { audioContent };
      })();
    },
  };
  return { client, requests };
}

describe("Google Cloud TTS client and streaming options", () => {
  test("GeminiTTSService: injected client and speakingRate in the streaming config", async () => {
    const { client, requests } = fakeTtsClient([new Uint8Array(100)]);
    const tts = new GeminiTTSService({
      client,
      settings: new GeminiTTSSettings({ voice: "Kore", speakingRate: 1.25 }),
    });
    await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.1 })],
    });
    expect(requests).toHaveLength(1);
    const config = (requests[0]![0] as any).streamingConfig;
    expect(config.streamingAudioConfig).toEqual({
      audioEncoding: "PCM",
      sampleRateHertz: 24000,
      speakingRate: 1.25,
    });
  });

  test("GeminiTTSService: no speakingRate by default", async () => {
    const { client, requests } = fakeTtsClient([new Uint8Array(100)]);
    const tts = new GeminiTTSService({ client });
    await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.1 })],
    });
    expect(
      (requests[0]![0] as any).streamingConfig.streamingAudioConfig.speakingRate,
    ).toBeUndefined();
  });

  test("bufferOnlyStartup passes audio on as it arrives after the first chunk", async () => {
    const pieces = async (bufferOnlyStartup: boolean) => {
      const { client } = fakeTtsClient([10000, 20000, 5001, 3001].map((n) => new Uint8Array(n)));
      const tts = new GoogleTTSService({ client, sampleRate: 24000, bufferOnlyStartup }) as any;
      tts._sampleRate = 24000;
      const sizes: number[] = [];
      const config = { voice: {}, streamingAudioConfig: { audioEncoding: "PCM" } };
      for await (const frame of tts._streamTts(config, "Hi.", "ctx")) {
        sizes.push((frame as TTSAudioRawFrame).audio.length);
      }
      return sizes;
    };
    // chunkSize is 24000 bytes at 24 kHz (0.5 s of 16-bit mono).
    expect(await pieces(false)).toEqual([24000, 14002]);
    // Startup waits for 24000 bytes, then each response goes on (odd byte held).
    expect(await pieces(true)).toEqual([30000, 5000, 3002]);
  });

  const cancelled = () => Object.assign(new Error("1 CANCELLED: Cancelled on client"), { code: 1 });
  for (const [name, make] of [
    ["GoogleTTSService", () => new GoogleTTSService({ client: fakeTtsClient(cancelled()).client })],
    ["GeminiTTSService", () => new GeminiTTSService({ client: fakeTtsClient(cancelled()).client })],
  ] as const) {
    test(`${name}: a gRPC CANCELLED stream ends quietly`, async () => {
      const [down, up] = await runTest(make(), {
        framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.1 })],
      });
      const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
      expect(errors.filter((f) => f.error.includes("CANCELLED"))).toHaveLength(0);
    });
  }

  test("other gRPC errors are still reported", async () => {
    const unavailable = Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
    const tts = new GeminiTTSService({ client: fakeTtsClient(unavailable).client });
    const [down, up] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.1 })],
    });
    const errors = [...down, ...up].filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors.filter((f) => f.error.includes("UNAVAILABLE"))).toHaveLength(1);
  });
});
