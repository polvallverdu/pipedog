// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GeminiSTTService through the real `@google/genai` Live client, against a
 * local WebSocket server that speaks enough of `BidiGenerateContent`:
 * `setup` → `setupComplete`, `realtimeInput` audio and `audioStreamEnd`, and
 * `serverContent` with interim and final input transcriptions.
 *
 * Compared with upstream pipecat (google-genai 2.31 for Python) against the
 * same fake: the same setup, audio and stream-end messages and the same
 * frames. The SDKs differ only in encoding: Python puts the API key in an
 * `x-goog-api-key` header and some nested keys in snake_case, JS puts the key
 * in the `key` query parameter and uses camelCase (both are valid proto
 * JSON); JS keeps only the caller's `x-goog-api-client` value
 * (`pipecat/<version>`) where Python appends it to its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiSTTService, GeminiSTTSettings } from "../src/gemini_live/stt.ts";
import { type FakeGenaiServer, type LiveSocket, startFakeGenaiServer } from "./google_fakes.ts";

const AUDIO = Uint8Array.from({ length: 320 }, (_, i) => i & 0xff);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

let server: FakeGenaiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

/** Answer audio with an interim transcription and the stream end with the final one. */
function transcriber(final = "hola mundo") {
  return (m: Record<string, any>, socket: LiveSocket) => {
    if (m.realtimeInput?.audio) {
      socket.send({
        serverContent: { interimInputTranscription: { text: "hola", languageCode: "es-ES" } },
      });
    }
    if (m.realtimeInput?.audioStreamEnd) {
      socket.send({
        serverContent: {
          inputTranscription: { text: final, finished: true, languageCode: "es-ES" },
        },
      });
    }
  };
}

const utterance = () => [
  new VADUserStartedSpeakingFrame(),
  new InputAudioRawFrame({ audio: AUDIO, sampleRate: 16000, numChannels: 1 }),
  new SleepFrame({ sleep: 0.1 }),
  new VADUserStoppedSpeakingFrame(),
  new SleepFrame({ sleep: 0.3 }),
];

const transcriptions = (frames: Frame[]) =>
  frames.filter((f) => f instanceof InterimTranscriptionFrame || f instanceof TranscriptionFrame);

describe("GeminiSTTService over @google/genai Live", () => {
  test("gemini-3.5-transcribe-live: setup, audio, stream end, transcriptions", async () => {
    server = startFakeGenaiServer({ onLiveMessage: transcriber() });
    const stt = new GeminiSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
    });
    const [down] = await runTest(stt, { framesToSend: utterance() });

    expect(server.sessions).toHaveLength(1);
    const session = server.sessions[0]!;
    expect(session.path.replace(/^\/+/, "/")).toBe(
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    );
    expect(session.query).toEqual({ key: "test-key" });
    expect(session.headers["x-goog-api-client"]).toMatch(/^pipecat\//);
    expect(session.messages).toEqual([
      {
        setup: {
          model: "models/gemini-3.5-transcribe-live",
          generationConfig: { responseModalities: ["TEXT"] },
          inputAudioTranscription: { languageAuto: {} },
        },
      },
      { realtimeInput: { audio: { data: b64(AUDIO), mimeType: "audio/pcm;rate=16000" } } },
      { realtimeInput: { audioStreamEnd: true } },
    ]);
    expect(session.closed).toBe(true);

    const results = transcriptions(down);
    expect(results.map((f) => [f.constructor.name, f.text, f.language])).toEqual([
      ["InterimTranscriptionFrame", "hola", Language.ES_ES],
      ["TranscriptionFrame", "hola mundo", Language.ES_ES],
    ]);
    expect((results[1] as TranscriptionFrame).finalized).toBe(true);
  });

  test("language hints, adaptation phrases and SMART mode", async () => {
    server = startFakeGenaiServer({ onLiveMessage: transcriber() });
    const stt = new GeminiSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
      settings: new GeminiSTTSettings({
        languages: [Language.ES_ES, Language.EN_US],
        adaptationPhrases: ["oatmilk"],
        mode: "SMART",
      }),
    });
    await runTest(stt, { framesToSend: utterance() });
    expect(server.sessions[0]!.messages[0]).toEqual({
      setup: {
        model: "models/gemini-3.5-transcribe-live",
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: {
          languageHints: { languageCodes: ["es-ES", "en-US"] },
          adaptationPhrases: ["oatmilk"],
          mode: "SMART",
        },
      },
    });
  });

  test("a refused connection fails setup instead of hanging", async () => {
    // A port with nothing listening.
    const closed = startFakeGenaiServer();
    const url = closed.url;
    await closed.stop();

    const stt = new GeminiSTTService({ apiKey: "test-key", httpOptions: { baseUrl: url } });
    const started = Date.now();
    const [, up] = await runTest(stt, {
      framesToSend: [new SleepFrame({ sleep: 0.1 })],
      startTimeout: 5,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors.length).toBeGreaterThan(0);
  });

  test("the server closing the socket during setup fails setup with its reason", async () => {
    server = startFakeGenaiServer({
      autoSetupComplete: false,
      onLiveMessage: (m, socket) => {
        if ("setup" in m) socket.close(1008, "API key not valid. Please pass a valid API key.");
      },
    });
    const stt = new GeminiSTTService({ apiKey: "bad", httpOptions: { baseUrl: server.url } });
    const [, up] = await runTest(stt, {
      framesToSend: [new SleepFrame({ sleep: 0.1 })],
      startTimeout: 5,
    });
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors.map((e) => e.error).join("\n")).toContain(
      "Gemini Live connection closed (code 1008): API key not valid.",
    );
  });

  test("a dropped connection is reopened", async () => {
    let sessions = 0;
    server = startFakeGenaiServer({
      onLiveOpen: () => {
        sessions += 1;
      },
      onLiveMessage: (m, socket, session) => {
        // The first session drops on its first audio chunk.
        if (sessions === 1 && session === server!.sessions[0] && m.realtimeInput?.audio) {
          socket.close(1011, "Internal error");
          return;
        }
        transcriber("again")(m, socket);
      },
    });
    const stt = new GeminiSTTService({
      apiKey: "test-key",
      sampleRate: 16000,
      httpOptions: { baseUrl: server.url },
    });
    const [down, up] = await runTest(stt, {
      framesToSend: [
        new InputAudioRawFrame({ audio: AUDIO, sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.3 }),
        ...utterance(),
      ],
    });
    expect(server.sessions.length).toBe(2);
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors.map((e) => e.error)).toEqual([
      "connection error: Gemini Live connection closed (code 1011): Internal error",
    ]);
    expect(transcriptions(down).at(-1)?.text).toBe("again");
  });
});
