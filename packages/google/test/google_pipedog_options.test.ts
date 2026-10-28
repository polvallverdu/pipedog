// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * pipedog-only options of the Google speech services (no upstream test):
 * `finalizeOnVadStop`, `languageCodes` and `setLanguageCodes()` on
 * GoogleSTTService, the `client`, `sharedClient` and `bufferOnlyStartup`
 * options, `prewarm()`, `GeminiTTSSettings.speakingRate`, GeminiTTSService's
 * `retryOnBlocked`, the audio cache with the Google TTS services, and gRPC
 * CANCELLED treated as a quiet stop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  BotStartedSpeakingFrame,
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  TranscriptionFrame,
  type TTSAudioRawFrame,
  TTSAudioRawFrame as TTSAudioRawFrameClass,
  TTSSpeakFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { TTSAudioCache } from "@pipedog/core/services/tts_audio_cache";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { GoogleSTTService, GoogleSTTSettings } from "../src/stt.ts";
import {
  GeminiTTSBlockedError,
  GeminiTTSService,
  GeminiTTSSettings,
  type GoogleAudioResponse,
  type GoogleCloudTTSClient,
  type GoogleStreamingSynthesizeRequest,
  GoogleTTSService,
  getSharedGoogleCloudTTSClient,
  isGeminiTTSBlockedError,
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

//
// GeminiTTSService retryOnBlocked (#91)
//

/** gRPC INVALID_ARGUMENT as Cloud TTS fails a Gemini sentence it blocks. */
const blockedError = () =>
  grpcError(
    grpc.status.INVALID_ARGUMENT,
    "The request was blocked because it may violate our usage guidelines.",
  );

/**
 * A Cloud TTS client whose streaming calls follow `script`, one entry per
 * call: the audio chunks it streams, then the error it fails with, if any.
 */
function scriptedTtsClient(script: { chunks?: Uint8Array[]; error?: Error }[]) {
  const texts: string[] = [];
  const configs: any[] = [];
  const client: GoogleCloudTTSClient = {
    async synthesizeSpeech() {
      throw new Error("unused");
    },
    async streamingSynthesize(input) {
      const step = script[texts.length] ?? { chunks: [new Uint8Array(100)] };
      for await (const request of input) {
        if ("streamingConfig" in request) configs.push(request.streamingConfig);
        else texts.push(request.input.text);
      }
      return (async function* (): AsyncGenerator<GoogleAudioResponse> {
        for (const audioContent of step.chunks ?? []) yield { audioContent };
        if (step.error) throw step.error;
      })();
    },
  };
  return { client, texts, configs };
}

/** Run `runTts` outside a pipeline, as `warmAudioCache` does. */
async function synthesize(tts: GeminiTTSService, text: string): Promise<Frame[]> {
  (tts as any)._sampleRate = 24000;
  const frames: Frame[] = [];
  for await (const frame of tts.runTts(text, "ctx")) frames.push(frame);
  return frames;
}

const audioBytes = (frames: Frame[]) =>
  frames
    .filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrameClass)
    .reduce((n, f) => n + f.audio.length, 0);

describe("GeminiTTSService retryOnBlocked", () => {
  test("isGeminiTTSBlockedError matches only the usage-guidelines block", () => {
    expect(isGeminiTTSBlockedError(blockedError())).toBe(true);
    expect(isGeminiTTSBlockedError(new GeminiTTSBlockedError("PROHIBITED_CONTENT"))).toBe(true);
    expect(
      isGeminiTTSBlockedError(
        new Error('{"error":{"code":400,"message":"... violates our usage policies ..."}}'),
      ),
    ).toBe(true);
    expect(isGeminiTTSBlockedError(grpcError(grpc.status.INVALID_ARGUMENT, "Bad voice"))).toBe(
      false,
    );
    expect(isGeminiTTSBlockedError(new Error("14 UNAVAILABLE"))).toBe(false);
  });

  test("off by default: a blocked sentence is an ErrorFrame, not retried", async () => {
    const { client, texts } = scriptedTtsClient([{ error: blockedError() }]);
    const frames = await synthesize(new GeminiTTSService({ client }), "Hi.");
    expect(texts).toEqual(["Hi."]);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(1);
  });

  test("a sentence blocked before any audio is requested again, unchanged", async () => {
    const { client, texts } = scriptedTtsClient([
      { error: blockedError() },
      { chunks: [new Uint8Array(100)] },
    ]);
    const tts = new GeminiTTSService({
      client,
      retryOnBlocked: { restartText: (t) => `Sorry, ${t}` },
    });
    const frames = await synthesize(tts, "Hi.");
    expect(texts).toEqual(["Hi.", "Hi."]);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
    expect(audioBytes(frames)).toBe(100);
  });

  test("a sentence blocked midway starts over with restartText", async () => {
    const { client, texts } = scriptedTtsClient([
      { chunks: [new Uint8Array(30000)], error: blockedError() },
      { chunks: [new Uint8Array(100)] },
    ]);
    const tts = new GeminiTTSService({
      client,
      retryOnBlocked: { restartText: (t) => `Sorry, ${t}` },
    });
    const frames = await synthesize(tts, "Hi there.");
    expect(texts).toEqual(["Hi there.", "Sorry, Hi there."]);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
    // The 24000-byte chunk that went out, then the whole restarted sentence.
    expect(audioBytes(frames)).toBe(24100);
  });

  test("retries spent: the fallback settings get one more attempt", async () => {
    const { client, texts, configs } = scriptedTtsClient([
      { error: blockedError() },
      { error: blockedError() },
      { error: blockedError() },
      { chunks: [new Uint8Array(100)] },
    ]);
    const tts = new GeminiTTSService({
      client,
      settings: new GeminiTTSSettings({ prompt: "Warm and friendly" }),
      retryOnBlocked: {
        retries: 2,
        fallback: new GeminiTTSSettings({ model: null, voice: "en-US-Chirp3-HD-Kore" }),
      },
    });
    const frames = await synthesize(tts, "Hi.");
    expect(texts).toEqual(["Hi.", "Hi.", "Hi.", "Hi."]);
    expect(configs.map((c) => [c.voice.name, c.voice.modelName])).toEqual([
      ["Kore", "gemini-3.1-flash-tts-preview"],
      ["Kore", "gemini-3.1-flash-tts-preview"],
      ["Kore", "gemini-3.1-flash-tts-preview"],
      ["en-US-Chirp3-HD-Kore", null],
    ]);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
    // The service's own settings are untouched.
    expect((tts as any)._settings.voice).toBe("Kore");
  });

  test("a fallback function supplies the frames", async () => {
    const { client } = scriptedTtsClient([{ error: blockedError() }, { error: blockedError() }]);
    const seen: string[] = [];
    const tts = new GeminiTTSService({
      client,
      retryOnBlocked: {
        fallback: async function* (text, contextId) {
          seen.push(text);
          yield new TTSAudioRawFrameClass({
            audio: new Uint8Array(10),
            sampleRate: 24000,
            numChannels: 1,
            contextId,
          });
        },
      },
    });
    const frames = await synthesize(tts, "Hi.");
    expect(seen).toEqual(["Hi."]);
    expect(audioBytes(frames)).toBe(10);
  });

  test("still blocked after the retries: one ErrorFrame", async () => {
    const { client, texts } = scriptedTtsClient([
      { error: blockedError() },
      { error: blockedError() },
    ]);
    const frames = await synthesize(new GeminiTTSService({ client, retryOnBlocked: true }), "Hi.");
    expect(texts).toHaveLength(2);
    const errors = frames.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain("usage guidelines");
  });

  test("other errors are not retried", async () => {
    const unavailable = grpcError(grpc.status.UNAVAILABLE, "down");
    const { client, texts } = scriptedTtsClient([{ error: unavailable }]);
    const frames = await synthesize(new GeminiTTSService({ client, retryOnBlocked: true }), "Hi.");
    expect(texts).toHaveLength(1);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(1);
  });

  test("GenAI backend: a blocked response with no audio is retried", async () => {
    let calls = 0;
    const tts = new GeminiTTSService({ apiKey: "test-key", retryOnBlocked: true });
    (tts as any)._client = {
      models: {
        async generateContentStream() {
          calls += 1;
          const chunks =
            calls === 1
              ? [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }]
              : [
                  {
                    candidates: [
                      { content: { parts: [{ inlineData: { data: new Uint8Array(100) } }] } },
                    ],
                  },
                ];
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    };
    const frames = await synthesize(tts, "Hi.");
    expect(calls).toBe(2);
    expect(frames.filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
    expect(audioBytes(frames)).toBe(100);
  });

  test("in a pipeline: no ErrorFrame, the retried audio plays", async () => {
    const { client } = scriptedTtsClient([
      { error: blockedError() },
      { chunks: [new Uint8Array(100)] },
    ]);
    const [down, up] = await runTest(new GeminiTTSService({ client, retryOnBlocked: true }), {
      framesToSend: [new TTSSpeakFrame({ text: "Hi." }), new SleepFrame({ sleep: 0.1 })],
    });
    expect([...down, ...up].filter((f) => f instanceof ErrorFrame)).toHaveLength(0);
    expect(audioBytes(down)).toBe(100);
  });

  test("a restarted sentence is not stored by warmAudioCache", async () => {
    const { client } = scriptedTtsClient([
      { chunks: [new Uint8Array(30000)], error: blockedError() },
      { chunks: [new Uint8Array(100)] },
    ]);
    const audioCache = new TTSAudioCache();
    const tts = new GeminiTTSService({ client, audioCache, retryOnBlocked: true });
    expect(await tts.warmAudioCache("Hi.", { sampleRate: 24000 })).toBe(0);
    expect(audioCache.size).toBe(0);
  });
});

//
// Audio cache with the Google TTS services (#92)
//

describe("Google TTS audio cache", () => {
  test("GeminiTTSService (GCP): a warmed sentence is served without calling the client", async () => {
    const { client, texts } = scriptedTtsClient([{ chunks: [new Uint8Array(4800)] }]);
    const audioCache = new TTSAudioCache();
    // Warmed before the pipeline starts, as while an outbound call rings.
    const tts = new GeminiTTSService({ client, audioCache });
    expect(await tts.warmAudioCache("Hello there.", { sampleRate: 24000 })).toBe(1);
    expect(texts).toEqual(["Hello there."]);

    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello there." }), new SleepFrame({ sleep: 0.1 })],
    });
    expect(texts).toHaveLength(1);
    expect(audioBytes(down)).toBe(4800);
  });

  test("GeminiTTSService (GenAI): a warmed sentence is served without calling the client", async () => {
    let calls = 0;
    const audioCache = new TTSAudioCache();
    const tts = new GeminiTTSService({ apiKey: "test-key", audioCache });
    (tts as any)._client = {
      models: {
        async generateContentStream() {
          calls += 1;
          return (async function* () {
            yield {
              candidates: [
                { content: { parts: [{ inlineData: { data: new Uint8Array(4800) } }] } },
              ],
            };
          })();
        },
      },
    };
    expect(await tts.warmAudioCache("Hello there.", { sampleRate: 24000 })).toBe(1);
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello there." }), new SleepFrame({ sleep: 0.1 })],
    });
    expect(calls).toBe(1);
    expect(audioBytes(down)).toBe(4800);
  });

  test("the key covers text, voice, language, prompt, speaking rate, sample rate and backend", () => {
    const key = (options: ConstructorParameters<typeof GeminiTTSService>[0], text = "Hi.") => {
      const tts = new GeminiTTSService({ client: scriptedTtsClient([]).client, ...options }) as any;
      tts._sampleRate = options?.sampleRate ?? 24000;
      return tts._audioCacheKey(text) as string;
    };
    const base = key({});
    expect(key({})).toBe(base);
    const variants = [
      key({}, "Hello."),
      key({ settings: new GeminiTTSSettings({ voice: "Puck" }) }),
      key({ settings: new GeminiTTSSettings({ language: "es-ES" }) }),
      key({ settings: new GeminiTTSSettings({ prompt: "Calm" }) }),
      key({ settings: new GeminiTTSSettings({ speakingRate: 1.2 }) }),
      key({ settings: new GeminiTTSSettings({ model: "gemini-2.5-pro-tts" }) }),
      key({ sampleRate: 16000 }),
      key({ apiKey: "test-key" }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test("GoogleTTSService: the key covers the voice cloning key, without holding it", () => {
    const key = (voiceCloningKey?: string) => {
      const tts = new GoogleTTSService({
        client: scriptedTtsClient([]).client,
        voiceCloningKey,
      }) as any;
      tts._sampleRate = 24000;
      return tts._audioCacheKey("Hi.") as string;
    };
    expect(key("secret-a")).not.toBe(key("secret-b"));
    expect(key("secret-a")).not.toBe(key());
    expect(key("secret-a")).not.toContain("secret-a");
  });
});

//
// Shared clients and prewarm (#93)
//

/** A fake `@google-cloud/text-to-speech` module that counts clients and records prewarm calls. */
function fakeTextToSpeechModule(options: { tokenError?: Error } = {}) {
  const log: string[] = [];
  let clients = 0;
  class TextToSpeechClient {
    auth = {
      getAccessToken: async () => {
        log.push("token");
        if (options.tokenError) throw options.tokenError;
        return "token";
      },
    };
    constructor() {
      clients += 1;
    }
    async initialize() {
      log.push("initialize");
      return {
        waitForReady: (_deadline: number, callback: (error?: Error | null) => void) => {
          log.push("ready");
          callback(null);
        },
      };
    }
  }
  return { module: { v1: { TextToSpeechClient } }, log, clients: () => clients };
}

describe("Cloud TTS sharedClient and prewarm", () => {
  test("services with sharedClient and the same endpoint share one client", () => {
    const { module } = fakeTextToSpeechModule();
    const options = { credentials: CREDENTIALS, textToSpeechModule: module, sharedClient: true };
    const a = new GoogleTTSService(options) as any;
    const b = new GeminiTTSService(options) as any;
    const c = new GoogleTTSService({ ...options, location: "us-central1" }) as any;
    const d = new GoogleTTSService({ ...options, sharedClient: false }) as any;
    expect(a._client).toBe(b._client);
    expect(a._client).toBe(
      getSharedGoogleCloudTTSClient({ credentials: JSON.parse(CREDENTIALS), module }),
    );
    expect(c._client).not.toBe(a._client);
    expect(d._client).not.toBe(a._client);
  });

  test("prewarm builds the client, waits for the channel and fetches a token", async () => {
    const fake = fakeTextToSpeechModule();
    const tts = new GeminiTTSService({ credentials: CREDENTIALS, textToSpeechModule: fake.module });
    expect(await tts.prewarm()).toBe(true);
    expect(fake.clients()).toBe(1);
    expect(fake.log).toEqual(["initialize", "ready", "token"]);
  });

  test("prewarm fails soft", async () => {
    const fake = fakeTextToSpeechModule({ tokenError: new Error("no credentials") });
    const tts = new GoogleTTSService({ credentials: CREDENTIALS, textToSpeechModule: fake.module });
    expect(await tts.prewarm()).toBe(false);
  });

  test("prewarm on the GenAI backend has nothing to do", async () => {
    expect(await new GeminiTTSService({ apiKey: "test-key" }).prewarm()).toBe(true);
  });
});

/** A fake `@google-cloud/speech` module that counts clients and records prewarm calls. */
function fakeSpeechModule() {
  const log: string[] = [];
  let clients = 0;
  class SpeechClient {
    auth = {
      getAccessToken: async () => {
        log.push("token");
        return "token";
      },
    };
    constructor() {
      clients += 1;
    }
    async getProjectId() {
      return "test-project";
    }
    async initialize() {
      log.push("initialize");
      return {
        waitForReady: (_deadline: number, callback: (error?: Error | null) => void) => {
          log.push("ready");
          callback(null);
        },
      };
    }
  }
  return { module: { v2: { SpeechClient } }, log, clients: () => clients };
}

describe("GoogleSTTService sharedClient and prewarm", () => {
  test("services with sharedClient share one client; prewarm connects it", async () => {
    const fake = fakeSpeechModule();
    const options = { credentials: CREDENTIALS, speechModule: fake.module, sharedClient: true };
    const a = new GoogleSTTService(options);
    const b = new GoogleSTTService(options);
    expect(await a.prewarm()).toBe(true);
    expect(await b.prewarm()).toBe(true);
    expect(fake.clients()).toBe(1);
    expect(fake.log).toEqual(["initialize", "ready", "token", "initialize", "ready", "token"]);
    expect((a as any)._client).toBe((b as any)._client);

    await new GoogleSTTService({ ...options, sharedClient: false }).prewarm();
    expect(fake.clients()).toBe(2);
  });

  test("prewarm fails soft", async () => {
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      speechModule: {
        v2: {
          SpeechClient: class {
            constructor() {
              throw new Error("boom");
            }
          },
        },
      },
    });
    expect(await stt.prewarm()).toBe(false);
  });
});

//
// GoogleSTTService setLanguageCodes (#89)
//

describe("GoogleSTTService setLanguageCodes", () => {
  const startServer = () =>
    startFakeSpeechServer((call) => {
      call.on("data", () => {});
      call.on("end", () => call.end());
    });
  const languageCodes = (call: any) => call.requests[0].streaming_config.config.language_codes;

  const newStt = () =>
    new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", (server as FakeGrpcServer).port),
    });
  /** Call setLanguageCodes once the first stream is open. */
  const setOnConnect = (stt: GoogleSTTService, codes: string[] | (() => string[])) => {
    let first = true;
    stt.addEventHandler("on_connected", async () => {
      if (!first) return;
      first = false;
      await stt.setLanguageCodes(codes);
    });
  };
  const audioRequests = (call: any) => call.requests.filter((r: any) => r.audio).length;

  test("new codes wait for the bot to speak, then reconnect", async () => {
    server = await startServer();
    const stt = newStt();
    let evaluated = 0;
    setOnConnect(stt, () => {
      evaluated += 1;
      return ["es-ES", "en-US"];
    });
    await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new BotStartedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        // The function is read again, and the codes have not changed.
        new BotStartedSpeakingFrame(),
        new SleepFrame({ sleep: 0.1 }),
      ],
    });
    expect(evaluated).toBeGreaterThanOrEqual(2);
    expect(server.calls.length).toBe(2);
    expect(server.calls.map(audioRequests)).toEqual([2, 1]);
    expect(languageCodes(server.calls[0])).toEqual(["en-US"]);
    expect(languageCodes(server.calls[1])).toEqual(["es-ES", "en-US"]);
  });

  test("while the user speaks over the bot, the reconnect waits for their turn to end", async () => {
    server = await startServer();
    const stt = newStt();
    setOnConnect(stt, ["es-ES"]);
    await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStartedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStoppedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new UserStoppedSpeakingFrame(),
        audioFrame(),
        new SleepFrame({ sleep: 0.2 }),
      ],
    });
    expect(server.calls.length).toBe(2);
    expect(server.calls.map(audioRequests)).toEqual([3, 1]);
    expect(languageCodes(server.calls[1])).toEqual(["es-ES"]);
  });

  test("updating the language settings replaces the codes", async () => {
    server = await startServer();
    const stt = newStt();
    await stt.setLanguageCodes(() => ["es-ES"]);
    await (stt as any)._updateSettings(new GoogleSTTSettings({ languageCodes: ["de-DE"] }));
    await runTest(stt, {
      framesToSend: [audioFrame(), new BotStartedSpeakingFrame(), new SleepFrame({ sleep: 0.2 })],
    });
    expect(server.calls.length).toBe(1);
    expect(languageCodes(server.calls[0])).toEqual(["de-DE"]);
  });

  test("before the stream opens the codes apply at once", async () => {
    server = await startServer();
    const stt = newStt();
    await stt.setLanguageCodes(["fr-FR"]);
    await runTest(stt, { framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })] });
    expect(server.calls.length).toBe(1);
    expect(languageCodes(server.calls[0])).toEqual(["fr-FR"]);
  });
});
