// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end tests of AssemblyAISTTService against a mock Universal-Streaming v3
 * server (`Bun.serve`). No upstream counterpart: upstream's tests drive the
 * handlers directly; these check the wire protocol the service speaks over a
 * real websocket (URL, `Authorization` header, binary audio chunks, `Begin` /
 * `Turn` / `Termination` messages, `Terminate`, `ForceEndpoint`).
 *
 * The mock follows https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api.
 * Nothing here talks to the real service.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { AssemblyAISTTService } from "../src/stt.ts";

type Json = Record<string, any>;

const turn = (transcript: string, endOfTurn: boolean, formatted = endOfTurn): Json => ({
  type: "Turn",
  turn_order: 0,
  turn_is_formatted: formatted,
  end_of_turn: endOfTurn,
  transcript,
  end_of_turn_confidence: 0.9,
  words: [{ start: 0, end: 100, text: transcript, confidence: 0.9, word_is_final: endOfTurn }],
});

class MockAssemblyAI {
  server: ReturnType<typeof Bun.serve>;
  urls: string[] = [];
  authorizations: (string | null)[] = [];
  audio: Uint8Array[] = [];
  json: Json[] = [];
  /** Sent when the first audio chunk arrives. */
  onAudio: (send: (message: Json) => void) => void = () => {};

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        this.urls.push(req.url);
        this.authorizations.push(req.headers.get("authorization"));
        if (srv.upgrade(req)) return undefined;
        return new Response("expected a websocket", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.send(JSON.stringify({ type: "Begin", id: "abc", expires_at: 1234567890 }));
        },
        message: (ws, message) => {
          const send = (m: Json) => ws.send(JSON.stringify(m));
          if (typeof message === "string") {
            const parsed = JSON.parse(message) as Json;
            this.json.push(parsed);
            if (parsed.type === "Terminate") {
              send({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 2 });
            } else if (parsed.type === "ForceEndpoint") {
              send(turn("hello world", true));
            }
          } else {
            const first = this.audio.length === 0;
            this.audio.push(new Uint8Array(message as Uint8Array));
            if (first) this.onAudio(send);
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://localhost:${this.server.port}/v3/ws`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

let mock: MockAssemblyAI;
beforeEach(() => {
  mock = new MockAssemblyAI();
});
afterEach(() => {
  mock.stop();
});

// 50 ms of 16 kHz PCM16 mono.
const CHUNK = new Uint8Array(1600);
const audioFrame = () =>
  new InputAudioRawFrame({ audio: CHUNK, sampleRate: 16000, numChannels: 1 });

describe("AssemblyAISTTService against a mock server", () => {
  test("connects with the key in Authorization and the settings in the query", async () => {
    const service = new AssemblyAISTTService({
      apiKey: "secret",
      apiEndpointBaseUrl: mock.url,
    });

    await runTest(service, { framesToSend: [new SleepFrame({ sleep: 0.2 })] });

    expect(mock.authorizations[0]).toBe("secret");
    const url = new URL(mock.urls[0] as string);
    expect(url.pathname).toBe("/v3/ws");
    expect(url.searchParams.get("speech_model")).toBe("universal-3-6-pro");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    // Pipecat turn mode: max_turn_silence tracks min_turn_silence (100 ms on U3 Pro).
    expect(url.searchParams.get("min_turn_silence")).toBe("100");
    expect(url.searchParams.get("max_turn_silence")).toBe("100");
  });

  test("streams audio in 50 ms binary chunks and terminates on stop", async () => {
    const service = new AssemblyAISTTService({ apiKey: "secret", apiEndpointBaseUrl: mock.url });

    await runTest(service, {
      framesToSend: [audioFrame(), audioFrame(), new SleepFrame({ sleep: 0.2 })],
    });

    expect(mock.audio.length).toBe(2);
    for (const chunk of mock.audio) expect(chunk.length).toBe(1600);
    expect(mock.json.map((m) => m.type)).toContain("Terminate");
  });

  test("turns a partial Turn into an interim and a final into a transcription", async () => {
    mock.onAudio = (send) => {
      send(turn("hello", false));
      send(turn("hello world", true));
    };
    const service = new AssemblyAISTTService({ apiKey: "secret", apiEndpointBaseUrl: mock.url });

    const [down] = await runTest(service, {
      framesToSend: [audioFrame(), new SleepFrame({ sleep: 0.3 })],
    });

    const interim = down.filter((f) => f instanceof InterimTranscriptionFrame);
    const final = down.filter((f) => f instanceof TranscriptionFrame);
    expect(interim.map((f) => (f as InterimTranscriptionFrame).text)).toEqual(["hello"]);
    expect(final.map((f) => (f as TranscriptionFrame).text)).toEqual(["hello world"]);
  });

  test("sends ForceEndpoint when the VAD stops the user", async () => {
    const service = new AssemblyAISTTService({ apiKey: "secret", apiEndpointBaseUrl: mock.url });

    const [down] = await runTest(service, {
      framesToSend: [
        audioFrame(),
        new SleepFrame({ sleep: 0.1 }),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });

    expect(mock.json.some((m) => m.type === "ForceEndpoint")).toBe(true);
    const final = down.filter((f) => f instanceof TranscriptionFrame) as TranscriptionFrame[];
    expect(final.map((f) => f.text)).toEqual(["hello world"]);
    expect(final[0]?.finalized).toBe(true);
  });
});
