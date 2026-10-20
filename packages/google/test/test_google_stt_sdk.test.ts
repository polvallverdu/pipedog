// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GoogleSTTService through the real `@google-cloud/speech` v2 client, against
 * a local gRPC server that implements `google.cloud.speech.v2.Speech` from the
 * SDK's own .proto files. Proves the SDK adapter (client options, the
 * `_streamingRecognize` bidi stream, request and response shapes) without
 * network access or credentials.
 *
 * The request shapes asserted here were compared field by field with what
 * upstream pipecat (google-cloud-speech 2.41) sends for the same settings;
 * they match, except that the JS SDK also puts proto3 `false` defaults on the
 * wire (same meaning: these fields have no presence).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { GoogleSTTService, GoogleSTTSettings } from "../src/stt.ts";
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

const AUDIO = Uint8Array.from({ length: 320 }, (_, i) => i & 0xff);

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

function audioFrame(sampleRate = 16000): InputAudioRawFrame {
  return new InputAudioRawFrame({ audio: AUDIO, sampleRate, numChannels: 1 });
}

/** Answer the first audio request of each call with an interim and a final result. */
function transcribeOnFirstAudio(final = "hello world") {
  return (call: grpc.ServerDuplexStream<any, any>) => {
    let answered = false;
    call.on("data", (req: any) => {
      if (req.audio && !answered) {
        answered = true;
        call.write({ results: [{ alternatives: [{ transcript: "hel" }], is_final: false }] });
        call.write({ results: [] });
        call.write({
          results: [
            {
              alternatives: [{ transcript: final, confidence: 0.92 }],
              is_final: true,
              language_code: "en-us",
            },
          ],
        });
      }
    });
    call.on("end", () => call.end());
  };
}

let server: FakeGrpcServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const transcriptions = (frames: Frame[]) =>
  frames.filter((f) => f instanceof InterimTranscriptionFrame || f instanceof TranscriptionFrame);

describe("GoogleSTTService over @google-cloud/speech", () => {
  test("Chirp 3 config, audio and interim/final transcriptions", async () => {
    server = await startFakeSpeechServer(transcribeOnFirstAudio());
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      location: "us",
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
      settings: new GoogleSTTSettings({
        model: "chirp_3",
        languages: [Language.EN_US, Language.ES_ES],
        enableWordTimeOffsets: true,
        enableVoiceActivityEvents: true,
        adaptation: {
          phrase_sets: [
            "projects/test-project/locations/us/phraseSets/catalog",
            { phrases: [{ value: "pipecat", boost: 15.0 }] },
          ],
        },
        denoiserConfig: { denoise_audio: true, snr_threshold: 10.0 },
      }),
    });

    const [down] = await runTest(stt, {
      framesToSend: [audioFrame(), audioFrame(), new SleepFrame({ sleep: 0.3 })],
    });

    expect(server.calls).toHaveLength(1);
    const [config, ...audio] = server.calls[0]!.requests;
    expect(config).toEqual({
      recognizer: "projects/test-project/locations/us/recognizers/_",
      streaming_config: {
        config: {
          explicit_decoding_config: {
            encoding: "LINEAR16",
            sample_rate_hertz: 16000,
            audio_channel_count: 1,
          },
          language_codes: ["en-US", "es-ES"],
          model: "chirp_3",
          features: {
            enable_automatic_punctuation: true,
            enable_spoken_punctuation: false,
            enable_spoken_emojis: false,
            profanity_filter: false,
            enable_word_time_offsets: true,
            enable_word_confidence: false,
          },
          adaptation: {
            phrase_sets: [
              { phrase_set: "projects/test-project/locations/us/phraseSets/catalog" },
              { inline_phrase_set: { phrases: [{ value: "pipecat", boost: 15 }] } },
            ],
          },
          denoiser_config: { denoise_audio: true, snr_threshold: 10 },
        },
        streaming_features: { enable_voice_activity_events: true, interim_results: true },
      },
    });
    expect(audio).toEqual([{ audio: b64(AUDIO) }, { audio: b64(AUDIO) }]);
    // The SDK's own client header, i.e. the request went through gapic.
    expect(String(server.calls[0]!.metadata["x-goog-api-client"])).toContain("gapic/");

    const results = transcriptions(down);
    expect(results.map((f) => f.constructor.name)).toEqual([
      "InterimTranscriptionFrame",
      "TranscriptionFrame",
    ]);
    const final = results[1] as TranscriptionFrame;
    expect(final.text).toBe("hello world");
    expect(final.language).toBe(Language.EN_US);
    expect(final.finalized).toBe(true);
    // `result` is the SDK's decoded StreamingRecognitionResult.
    expect((final.result as any).isFinal).toBe(true);
    expect((final.result as any).alternatives[0].confidence).toBeCloseTo(0.92);
  });

  test("telephony model drops adaptation; default features and interim results", async () => {
    server = await startFakeSpeechServer(transcribeOnFirstAudio());
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 8000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
      settings: new GoogleSTTSettings({
        model: "telephony",
        languages: [Language.FR_FR],
        adaptation: { phrase_sets: [{ phrases: [{ value: "x" }] }] },
      }),
    });
    await runTest(stt, { framesToSend: [audioFrame(8000), new SleepFrame({ sleep: 0.2 })] });

    const config = server.calls[0]!.requests[0] as any;
    expect(config.recognizer).toBe("projects/test-project/locations/global/recognizers/_");
    expect(config.streaming_config.config.model).toBe("telephony");
    expect(config.streaming_config.config.language_codes).toEqual(["fr-FR"]);
    expect(config.streaming_config.config.adaptation).toBeUndefined();
    expect(config.streaming_config.config.explicit_decoding_config.sample_rate_hertz).toBe(8000);
  });

  test("credentialsPath: the SDK reads the project ID from the key file", async () => {
    server = await startFakeSpeechServer(transcribeOnFirstAudio());
    const dir = mkdtempSync(join(tmpdir(), "pipedog-google-"));
    try {
      const keyFile = join(dir, "key.json");
      writeFileSync(keyFile, CREDENTIALS);
      const stt = new GoogleSTTService({
        credentialsPath: keyFile,
        sampleRate: 16000,
        clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
      });
      const [down] = await runTest(stt, {
        framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.2 })],
      });
      const config = server.calls[0]!.requests[0] as any;
      expect(config.recognizer).toBe("projects/test-project/locations/global/recognizers/_");
      // Defaults: latest_long, en-US.
      expect(config.streaming_config.config.model).toBe("latest_long");
      expect(config.streaming_config.config.language_codes).toEqual(["en-US"]);
      expect(transcriptions(down)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streaming limit: the request stream is closed and a new one is opened", async () => {
    server = await startFakeSpeechServer(transcribeOnFirstAudio());
    class ShortLimitSTT extends GoogleSTTService {
      static override readonly STREAMING_LIMIT = 300;
    }
    const stt = new ShortLimitSTT({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
    });
    const [down] = await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.5 }),
        // Past the limit: this chunk closes the first stream and opens the second.
        audioFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });

    expect(server.calls).toHaveLength(2);
    const [first, second] = server.calls as [any, any];
    // The first stream got the config and one chunk, then was half-closed.
    expect(first.requests.map((r: any) => Object.keys(r))).toEqual([
      ["recognizer", "streaming_config"],
      ["audio"],
    ]);
    expect(first.ended).toBe(true);
    // The second starts over with the config, then the chunk that hit the limit.
    expect(second.requests.map((r: any) => Object.keys(r))).toEqual([
      ["recognizer", "streaming_config"],
      ["audio"],
    ]);
    expect(second.requests[0]).toEqual(first.requests[0]);
    expect(stt._restartCounter).toBe(1);
    expect(transcriptions(down).map((f) => f.constructor.name)).toEqual([
      "InterimTranscriptionFrame",
      "TranscriptionFrame",
      "InterimTranscriptionFrame",
      "TranscriptionFrame",
    ]);
  });

  test("ABORTED: the error is reported and the stream reconnects", async () => {
    server = await startFakeSpeechServer((call, _record, index) => {
      if (index === 0) {
        // Google aborts a stream that received no audio for a while.
        call.on("data", () => {
          call.emit(
            "error",
            grpcError(
              grpc.status.ABORTED,
              "Stream timed out after receiving no more client requests.",
            ),
          );
        });
        return;
      }
      transcribeOnFirstAudio("after reconnect")(call);
    });
    const stt = new GoogleSTTService({
      credentials: CREDENTIALS,
      sampleRate: 16000,
      clientOptions: insecureClientOptions("@google-cloud/speech", server.port),
    });
    const [down, up] = await runTest(stt, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.3 }),
        audioFrame(),
        // _streamAudio waits 1s before reconnecting.
        new SleepFrame({ sleep: 1.5 }),
      ],
    });

    expect(server.calls.length).toBe(2);
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain("ABORTED");
    expect((errors[0]!.exception as { code?: number }).code).toBe(grpc.status.ABORTED);
    const final = transcriptions(down).find((f) => f instanceof TranscriptionFrame);
    expect(final?.text).toBe("after reconnect");
  });
});
