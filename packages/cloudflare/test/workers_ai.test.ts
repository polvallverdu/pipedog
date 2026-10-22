// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Every Workers AI service against a local fake (test/fake_workers_ai.ts), over
// both paths: the `AI` binding (a fake `env.AI`) and the REST API.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { EndOfTurnState } from "@pipedog/core/audio/turn/base_turn_analyzer";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { WorkersAIClient, WorkersAIError } from "../src/client.ts";
import { WorkersAIFluxSTTService } from "../src/flux_stt.ts";
import { WorkersAIMeloTTSService } from "../src/melotts.ts";
import { WorkersAISmartTurnAnalyzer } from "../src/smart_turn.ts";
import { WorkersAINova3STTService } from "../src/stt.ts";
import { WorkersAIAuraHttpTTSService, WorkersAIAuraTTSService } from "../src/tts.ts";
import { WorkersAIWhisperModel, WorkersAIWhisperSTTService } from "../src/whisper.ts";
import {
  ACCOUNT_ID,
  API_TOKEN,
  AURA_PCM,
  type FakeWorkersAI,
  MELO_MP3,
  startFakeWorkersAI,
} from "./fake_workers_ai.ts";

const FRAME_SECONDS = 0.02;

let fake: FakeWorkersAI;

beforeAll(() => {
  fake = startFakeWorkersAI();
});

afterAll(() => {
  fake.stop();
});

function audioFrames(count: number, sampleRate = 16000): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      new InputAudioRawFrame({
        audio: new Uint8Array(2 * Math.round(sampleRate * FRAME_SECONDS)),
        sampleRate,
        numChannels: 1,
      }),
    );
    frames.push(new SleepFrame({ sleep: FRAME_SECONDS }));
  }
  return frames;
}

function joinAudio(frames: Frame[]): Uint8Array {
  const audio = frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  const out = new Uint8Array(audio.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of audio) {
    out.set(f.audio, offset);
    offset += f.audio.length;
  }
  return out;
}

const params16k = new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 });

describe("WorkersAIClient", () => {
  test("needs the binding or credentials", () => {
    expect(() => new WorkersAIClient({})).toThrow("AI binding");
    expect(() => new WorkersAIClient({ accountId: ACCOUNT_ID })).toThrow("API token");
  });

  test("the binding takes precedence and needs no token", () => {
    const client = new WorkersAIClient({ ai: fake.binding, accountId: "x", apiToken: "y" });
    expect(client.mode).toBe("binding");
  });

  test("REST URLs", () => {
    const client = new WorkersAIClient({ accountId: "acc", apiToken: "tok" });
    expect(client.mode).toBe("rest");
    expect(client.runUrl("@cf/openai/whisper")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/openai/whisper",
    );
    expect(client.openAIBaseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1");
  });

  test("a REST failure carries the status and Cloudflare's reasons", async () => {
    fake.failNext(WorkersAIWhisperModel.LARGE_V3_TURBO, 429);
    const error = await fake
      .client("rest")
      .run(WorkersAIWhisperModel.LARGE_V3_TURBO, { audio: "" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkersAIError);
    expect((error as WorkersAIError).status).toBe(429);
    expect((error as WorkersAIError).message).toContain("Capacity temporarily exceeded");
  });

  test("a bad token is a 401", async () => {
    const client = new WorkersAIClient({
      accountId: ACCOUNT_ID,
      apiToken: "wrong",
      baseUrl: fake.baseUrl,
    });
    const error = await client.run("@cf/openai/whisper", {}).catch((e: unknown) => e);
    expect((error as WorkersAIError).status).toBe(401);
  });
});

for (const via of ["rest", "binding"] as const) {
  describe(`over ${via}`, () => {
    test("Flux: turn events become transcriptions; session params are the model's input", async () => {
      const before = fake.requests.length;
      const stt = new WorkersAIFluxSTTService({
        client: fake.client(via),
        settings: new WorkersAIFluxSTTService.Settings({ eotThreshold: 0.8, keyterm: ["Pipedog"] }),
      });
      const [down] = await runTest(stt, {
        framesToSend: audioFrames(12),
        pipelineParams: params16k,
      });
      await sleep(0.05);

      const finals = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
      expect(finals.map((f) => f.text)).toEqual(["hello cloudflare"]);
      const interims = down.filter(
        (f): f is InterimTranscriptionFrame => f instanceof InterimTranscriptionFrame,
      );
      expect(interims.map((f) => f.text)).toContain("hello");

      const request = fake.requests.slice(before).find((r) => r.websocket)!;
      expect(request.via).toBe(via);
      expect(request.model).toBe("@cf/deepgram/flux");
      expect(request.input).toMatchObject({
        encoding: "linear16",
        sample_rate: "16000",
        eot_threshold: "0.8",
      });
      expect(request.input).not.toHaveProperty("model");
      if (via === "rest") {
        expect(request.authorization).toBe(`Bearer ${API_TOKEN}`);
        expect(request.input.keyterm).toBe("Pipedog");
      } else {
        expect(request.input.keyterm).toEqual(["Pipedog"]);
        expect(request.options).toEqual({ websocket: true });
      }
    });

    test("Nova-3: Deepgram results become transcriptions", async () => {
      const before = fake.requests.length;
      const stt = new WorkersAINova3STTService({ client: fake.client(via) });
      const [down] = await runTest(stt, {
        framesToSend: audioFrames(12),
        pipelineParams: params16k,
      });

      const finals = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
      expect(finals.map((f) => f.text)).toEqual(["hello nova"]);
      const request = fake.requests.slice(before).find((r) => r.websocket)!;
      expect(request.model).toBe("@cf/deepgram/nova-3");
      expect(request.input).toMatchObject({
        encoding: "linear16",
        sample_rate: "16000",
        language: "en",
      });
      expect(request.input).not.toHaveProperty("model");
    });

    test("Whisper turbo: one request per segment, base64 WAV and the language", async () => {
      const before = fake.requests.length;
      const stt = new WorkersAIWhisperSTTService({
        client: fake.client(via),
        settings: new WorkersAIWhisperSTTService.Settings({ language: Language.EN_US }),
      });
      const [down] = await runTest(stt, {
        framesToSend: [
          new VADUserStartedSpeakingFrame({}),
          ...audioFrames(10),
          new VADUserStoppedSpeakingFrame({}),
          new SleepFrame({ sleep: 0.1 }),
        ],
        pipelineParams: params16k,
      });

      const finals = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
      expect(finals.map((f) => f.text)).toEqual(["hello from whisper-large-v3-turbo"]);
      const request = fake.requests.slice(before).find((r) => !r.websocket)!;
      expect(request.via).toBe(via);
      expect(request.model).toBe("@cf/openai/whisper-large-v3-turbo");
      expect(request.input.language).toBe("en");
      expect(request.input.task).toBe("transcribe");
      const wav = Buffer.from(String(request.input.audio), "base64");
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    });

    test("Whisper (original): the WAV as an array of bytes", async () => {
      const before = fake.requests.length;
      const stt = new WorkersAIWhisperSTTService({
        client: fake.client(via),
        settings: new WorkersAIWhisperSTTService.Settings({ model: WorkersAIWhisperModel.TINY_EN }),
      });
      const [down] = await runTest(stt, {
        framesToSend: [
          new VADUserStartedSpeakingFrame({}),
          ...audioFrames(5),
          new VADUserStoppedSpeakingFrame({}),
          new SleepFrame({ sleep: 0.1 }),
        ],
        pipelineParams: params16k,
      });
      const finals = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
      expect(finals.map((f) => f.text)).toEqual(["hello from whisper-tiny-en"]);
      const request = fake.requests.slice(before).find((r) => !r.websocket)!;
      const audio = request.input.audio as number[];
      expect(Array.isArray(audio)).toBe(true);
      expect(String.fromCharCode(...audio.slice(0, 4))).toBe("RIFF");
      expect(request.input).not.toHaveProperty("language");
    });

    test("Aura (WebSocket): Speak and Flush, PCM back", async () => {
      const sessionsBefore = fake.sessions.length;
      const before = fake.requests.length;
      const tts = new WorkersAIAuraTTSService({
        client: fake.client(via),
        sampleRate: 24000,
        settings: new WorkersAIAuraTTSService.Settings({ voice: "asteria" }),
      });
      const [down] = await runTest(tts, {
        framesToSend: [
          new TTSSpeakFrame({ text: "Hello from Workers AI." }),
          new SleepFrame({ sleep: 0.2 }),
        ],
      });

      expect(joinAudio(down)).toEqual(AURA_PCM);
      const request = fake.requests.slice(before).find((r) => r.websocket)!;
      expect(request.model).toBe("@cf/deepgram/aura-2-en");
      expect(request.input).toMatchObject({
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: "24000",
      });
      const session = fake.sessions[sessionsBefore]!;
      const types = session.textMessages.map((m) => (JSON.parse(m) as { type: string }).type);
      expect(types.slice(0, 2)).toEqual(["Speak", "Flush"]);
      expect(JSON.parse(session.textMessages[0]!).text).toContain("Hello from Workers AI.");
      expect((tts as unknown as { _settings: { model: string } })._settings.model).toBe(
        "@cf/deepgram/aura-2-en",
      );
    });

    test("Aura (HTTP): raw PCM at the service rate", async () => {
      const before = fake.requests.length;
      const tts = new WorkersAIAuraHttpTTSService({
        client: fake.client(via),
        sampleRate: 24000,
        settings: new WorkersAIAuraHttpTTSService.Settings({ model: "@cf/deepgram/aura-2-es" }),
      });
      const [down] = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "Hola." })],
      });
      expect(joinAudio(down)).toEqual(AURA_PCM);
      const request = fake.requests.slice(before).find((r) => !r.websocket)!;
      expect(request.model).toBe("@cf/deepgram/aura-2-es");
      expect(request.input).toEqual({
        text: "Hola.",
        speaker: "aquila",
        encoding: "linear16",
        container: "none",
        sample_rate: 24000,
      });
      if (via === "binding") expect(request.options).toEqual({ returnRawResponse: true });
    });

    test("MeloTTS: MP3 through the decoder, mixed to mono PCM", async () => {
      const decoded: Uint8Array[] = [];
      const left = new Float32Array(240).fill(0.5);
      const right = new Float32Array(240).fill(-0.5);
      const tts = new WorkersAIMeloTTSService({
        client: fake.client(via),
        sampleRate: 24000,
        settings: new WorkersAIMeloTTSService.Settings({ language: Language.FR }),
        decodeAudio: (mp3) => {
          decoded.push(mp3);
          return { channelData: [left, right.map(() => 0.5)], sampleRate: 24000 };
        },
      });
      const before = fake.requests.length;
      const [down] = await runTest(tts, {
        framesToSend: [new TTSSpeakFrame({ text: "Bonjour." })],
      });
      expect(decoded).toEqual([MELO_MP3]);
      const pcm = joinAudio(down);
      expect(pcm.length).toBe(480);
      expect(new Int16Array(pcm.buffer, pcm.byteOffset, 240)[0]).toBe(Math.round(0.5 * 0x7fff));
      const request = fake.requests.slice(before).find((r) => !r.websocket)!;
      expect(request.input).toEqual({ prompt: "Bonjour.", lang: "fr" });
    });

    test("Smart Turn v2: float32 base64 in, is_complete out", async () => {
      const before = fake.requests.length;
      const analyzer = new WorkersAISmartTurnAnalyzer({ client: fake.client(via) });
      analyzer.setSampleRate(16000);
      const chunk = new Uint8Array(640);
      for (let i = 0; i < 30; i++) analyzer.appendAudio(chunk, true);
      const [state, metrics] = await analyzer.analyzeEndOfTurn();
      expect(state).toBe(EndOfTurnState.COMPLETE);
      expect((metrics as { probability: number }).probability).toBeCloseTo(0.93);
      const request = fake.requests.slice(before).at(-1)!;
      expect(request.model).toBe("@cf/pipecat-ai/smart-turn-v2");
      expect(request.input.dtype).toBe("float32");
      // The 0.5 s of pre-speech padding is only there when buffered; here 30 x 20 ms of speech.
      expect(Buffer.from(String(request.input.audio), "base64").length).toBe(30 * 320 * 4);

      for (let i = 0; i < 5; i++) analyzer.appendAudio(chunk, true);
      const [short] = await analyzer.analyzeEndOfTurn();
      expect(short).toBe(EndOfTurnState.INCOMPLETE);
    });
  });
}

test("MeloTTS without a decoder fails each request with an explanation", async () => {
  const tts = new WorkersAIMeloTTSService({ client: fake.client("binding"), sampleRate: 24000 });
  const [down, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
  const errors = [...down, ...up].filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(errors.some((e) => e.error.includes("decodeAudio"))).toBe(true);
});

test("Smart Turn: a failed request is an incomplete prediction", async () => {
  fake.failNext("@cf/pipecat-ai/smart-turn-v2", 500);
  const analyzer = new WorkersAISmartTurnAnalyzer({ client: fake.client("rest") });
  analyzer.setSampleRate(16000);
  for (let i = 0; i < 30; i++) analyzer.appendAudio(new Uint8Array(640), true);
  const [state, metrics] = await analyzer.analyzeEndOfTurn();
  expect(state).toBe(EndOfTurnState.INCOMPLETE);
  expect((metrics as { probability: number }).probability).toBe(0);
});

test("binding WebSockets are accepted before use", async () => {
  const client = fake.client("binding");
  const ws = await client.connectWebSocket("@cf/deepgram/flux", { sample_rate: "16000" });
  expect((ws.webSocket as WebSocket & { accepted?: boolean }).accepted).toBe(true);
  await ws.close();
});

test("a binding without a WebSocket fails the connect with the status", async () => {
  const client = new WorkersAIClient({
    ai: { run: async () => new Response("nope", { status: 400 }) },
  });
  const error = await client.connectWebSocket("@cf/deepgram/flux", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WorkersAIError);
  expect((error as WorkersAIError).status).toBe(400);
});
