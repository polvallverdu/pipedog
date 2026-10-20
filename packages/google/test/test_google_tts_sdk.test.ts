// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The Cloud Text-to-Speech services through the real
 * `@google-cloud/text-to-speech` client, against a local gRPC server that
 * implements `google.cloud.texttospeech.v1.TextToSpeech` from the SDK's own
 * .proto files: `GoogleHttpTTSService` (`SynthesizeSpeech`; upstream also
 * uses the gRPC client here despite the name), `GoogleTTSService` and the GCP
 * backend of `GeminiTTSService` (`StreamingSynthesize`).
 *
 * The requests asserted here are the ones upstream pipecat
 * (google-cloud-texttospeech 2.38) sends for the same settings: a field by
 * field comparison against the same fake server found no differences.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import {
  GeminiTTSService,
  GeminiTTSSettings,
  GoogleHttpTTSService,
  GoogleHttpTTSSettings,
  GoogleTTSService,
  GoogleTTSSettings,
} from "../src/tts.ts";
import {
  type FakeGrpcServer,
  grpc,
  grpcError,
  insecureClientOptions,
  startFakeTextToSpeechServer,
} from "./google_fakes.ts";

const CREDENTIALS = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  client_email: "svc@test-project.iam.gserviceaccount.com",
  private_key: "not-a-real-key",
});

/** 44 bytes of WAV header, then 960 bytes of PCM. */
const WAV = Uint8Array.from({ length: 44 + 960 }, (_, i) => i & 0xff);
const PCM = WAV.subarray(44);
const TEXT = "Hello <world> & you.";

let server: FakeGrpcServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const clientOptions = () => insecureClientOptions("@google-cloud/text-to-speech", server!.port);

const audioOf = (frames: Frame[]) => {
  const chunks = frames.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const out = new Uint8Array(chunks.reduce((n, f) => n + f.audio.length, 0));
  let o = 0;
  for (const f of chunks) {
    out.set(f.audio, o);
    o += f.audio.length;
  }
  return { chunks, audio: out };
};

/**
 * Stream the PCM back in pieces once the text arrives, and finish when the
 * client half-closes (it sends the config and one input, then ends).
 */
function streamPcm(call: grpc.ServerDuplexStream<any, any>) {
  call.on("data", (req: any) => {
    if (req.input) {
      call.write({ audio_content: Buffer.from(PCM.subarray(0, 700)) });
      call.write({ audio_content: Buffer.alloc(0) });
      call.write({ audio_content: Buffer.from(PCM.subarray(700)) });
    }
  });
  call.on("end", () => call.end());
}

describe("GoogleHttpTTSService over @google-cloud/text-to-speech", () => {
  test("Chirp 3 HD voice: plain text, speaking rate, WAV header stripped", async () => {
    server = await startFakeTextToSpeechServer({
      synthesizeSpeech: () => ({ audio_content: Buffer.from(WAV) }),
    });
    const tts = new GoogleHttpTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      clientOptions: clientOptions(),
      settings: new GoogleHttpTTSSettings({ speakingRate: 1.2 }),
    });
    const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });

    expect(server.calls.map((c) => c.method)).toEqual(["SynthesizeSpeech"]);
    expect(server.calls[0]!.requests[0]).toEqual({
      input: { text: TEXT },
      voice: { language_code: "en-US", name: "en-US-Chirp3-HD-Charon" },
      audio_config: { audio_encoding: "LINEAR16", sample_rate_hertz: 24000, speaking_rate: 1.2 },
    });
    const { chunks, audio } = audioOf(down);
    expect(audio).toEqual(PCM);
    expect(chunks.every((f) => f.sampleRate === 24000 && f.numChannels === 1)).toBe(true);
  });

  test("other voices get SSML", async () => {
    server = await startFakeTextToSpeechServer({
      synthesizeSpeech: () => ({ audio_content: Buffer.from(WAV) }),
    });
    const tts = new GoogleHttpTTSService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: clientOptions(),
      settings: new GoogleHttpTTSSettings({
        voice: "en-US-Neural2-A",
        pitch: "+2st",
        rate: "fast",
        volume: "loud",
        emphasis: "strong",
        gender: "female",
        googleStyle: "calm",
        speakingRate: 1.5,
      }),
    });
    await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });
    expect(server.calls[0]!.requests[0]).toEqual({
      input: {
        ssml:
          "<speak><voice name='en-US-Neural2-A' language='en-US' gender='female'>" +
          "<prosody pitch='+2st' rate='fast' volume='loud'><emphasis level='strong'>" +
          "<google:style name='calm'>Hello &lt;world&gt; &amp; you.</google:style></emphasis>" +
          "</prosody></voice></speak>",
      },
      voice: { language_code: "en-US", name: "en-US-Neural2-A" },
      // speakingRate is only sent for Chirp and Journey voices.
      audio_config: { audio_encoding: "LINEAR16", sample_rate_hertz: 16000 },
    });
  });

  test("a gRPC error becomes an ErrorFrame", async () => {
    server = await startFakeTextToSpeechServer({
      synthesizeSpeech: () => grpcError(grpc.status.INVALID_ARGUMENT, "Voice does not exist."),
    });
    const tts = new GoogleHttpTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      clientOptions: clientOptions(),
    });
    const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    // (TTSService then also reports the context that produced no audio.)
    expect(errors[0]?.error).toBe(
      "TTS generation error: 3 INVALID_ARGUMENT: Voice does not exist.",
    );
  });
});

describe("GoogleTTSService over @google-cloud/text-to-speech", () => {
  test("Chirp 3 HD streaming_synthesize: config, input, audio", async () => {
    server = await startFakeTextToSpeechServer({ streamingSynthesize: streamPcm });
    const tts = new GoogleTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      clientOptions: clientOptions(),
      settings: new GoogleTTSSettings({ voice: "en-US-Chirp3-HD-Charon", speakingRate: 1.1 }),
    });
    const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });

    expect(server.calls).toHaveLength(1);
    const call = server.calls[0]!;
    expect(call.method).toBe("StreamingSynthesize");
    expect(call.requests).toEqual([
      {
        streaming_config: {
          voice: { language_code: "en-US", name: "en-US-Chirp3-HD-Charon" },
          streaming_audio_config: {
            audio_encoding: "PCM",
            sample_rate_hertz: 24000,
            speaking_rate: 1.1,
          },
        },
      },
      { input: { text: TEXT } },
    ]);
    expect(call.ended).toBe(true);
    expect(audioOf(down).audio).toEqual(PCM);
  });

  test("voice cloning key", async () => {
    server = await startFakeTextToSpeechServer({ streamingSynthesize: streamPcm });
    const tts = new GoogleTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      voiceCloningKey: "clone-key",
      clientOptions: clientOptions(),
    });
    await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });
    expect(server.calls[0]!.requests[0]).toEqual({
      streaming_config: {
        voice: { language_code: "en-US", voice_clone: { voice_cloning_key: "clone-key" } },
        streaming_audio_config: { audio_encoding: "PCM", sample_rate_hertz: 24000 },
      },
    });
  });

  test("an interruption cancels the streaming call", async () => {
    server = await startFakeTextToSpeechServer({
      streamingSynthesize: (call) => {
        call.on("data", (req: any) => {
          // Send one chunk and then hang, like a long utterance.
          if (req.input) call.write({ audio_content: Buffer.from(PCM) });
        });
      },
    });
    const tts = new GoogleTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      clientOptions: clientOptions(),
    });
    await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: TEXT }),
        new SleepFrame({ sleep: 0.3 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.cancelled).toBe(true);
  });

  test("several utterances reuse one client", async () => {
    server = await startFakeTextToSpeechServer({ streamingSynthesize: streamPcm });
    const tts = new GoogleTTSService({
      credentials: CREDENTIALS,
      sampleRate: 24000,
      clientOptions: clientOptions(),
    });
    const [down] = await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "One." }),
        new TTSSpeakFrame({ text: "Two." }),
        new TTSSpeakFrame({ text: "Three." }),
      ],
    });
    expect(server.calls.map((c) => (c.requests[1] as any).input.text)).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
    expect(audioOf(down).audio.length).toBe(3 * PCM.length);
  });
});

describe("GeminiTTSService (GCP backend) over @google-cloud/text-to-speech", () => {
  test("single speaker with prompt", async () => {
    server = await startFakeTextToSpeechServer({ streamingSynthesize: streamPcm });
    const tts = new GeminiTTSService({
      credentials: CREDENTIALS,
      clientOptions: clientOptions(),
      settings: new GeminiTTSSettings({
        model: "gemini-2.5-flash-tts",
        voice: "Kore",
        prompt: "Say this cheerfully",
      }),
    });
    const [down] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });
    expect(server.calls[0]!.requests).toEqual([
      {
        streaming_config: {
          voice: { language_code: "en-US", name: "Kore", model_name: "gemini-2.5-flash-tts" },
          streaming_audio_config: { audio_encoding: "PCM", sample_rate_hertz: 24000 },
        },
      },
      { input: { text: TEXT, prompt: "Say this cheerfully" } },
    ]);
    const { chunks, audio } = audioOf(down);
    expect(audio).toEqual(PCM);
    expect(chunks.every((f) => f.sampleRate === 24000)).toBe(true);
  });

  test("multi-speaker", async () => {
    server = await startFakeTextToSpeechServer({ streamingSynthesize: streamPcm });
    const tts = new GeminiTTSService({
      credentials: CREDENTIALS,
      clientOptions: clientOptions(),
      settings: new GeminiTTSSettings({
        model: "gemini-2.5-pro-tts",
        voice: "Puck",
        multiSpeaker: true,
        speakerConfigs: [{ speaker_alias: "Sam" }, { speaker_alias: "Bob", speaker_id: "Kore" }],
      }),
    });
    await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Sam: Hi! Bob: Hey." })] });
    expect(server.calls[0]!.requests[0]).toEqual({
      streaming_config: {
        voice: {
          language_code: "en-US",
          model_name: "gemini-2.5-pro-tts",
          multi_speaker_voice_config: {
            speaker_voice_configs: [
              { speaker_alias: "Sam", speaker_id: "Puck" },
              { speaker_alias: "Bob", speaker_id: "Kore" },
            ],
          },
        },
        streaming_audio_config: { audio_encoding: "PCM", sample_rate_hertz: 24000 },
      },
    });
  });

  test("a gRPC error becomes an ErrorFrame", async () => {
    server = await startFakeTextToSpeechServer({
      streamingSynthesize: (call) => {
        call.on("data", () => call.emit("error", grpcError(grpc.status.PERMISSION_DENIED, "no")));
      },
    });
    const tts = new GeminiTTSService({ credentials: CREDENTIALS, clientOptions: clientOptions() });
    const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: TEXT })] });
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors[0]?.error).toBe("Gemini GCP TTS generation error: 7 PERMISSION_DENIED: no");
  });
});
