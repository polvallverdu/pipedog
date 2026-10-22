// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire-format and end-to-end tests for the Speechmatics Agent STT client and
 * service, against a local fake of the Agent STT WebSocket server.
 *
 * The fake follows the protocol of `speechmatics-agent-stt` 0.3.0 /
 * `speechmatics-rt` 1.2.1 and the Agent STT API reference. It is NOT the real
 * service: nothing here proves the real service accepts these messages.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

import {
  AgentSttClient,
  AudioEncoding,
  AudioFormat,
  ConnectionError,
  resolveUrl,
  Segment,
  ServerMessageType,
  SpeakerDiarizationConfig,
  TranscriptionConfig,
  TranscriptionError,
  TurnConfig,
  TurnDetectionMode,
} from "../src/agent_stt.ts";
import { SpeechmaticsSTTService } from "../src/stt.ts";

type Any = any;

interface FakeOptions {
  /** Reject the handshake with this status. */
  rejectStatus?: number;
  /** Answer StartRecognition with this server message instead of RecognitionStarted. */
  startReply?: Record<string, unknown>;
  /** Reply to each ForceEndOfUtterance with a segment (and end-of-turn). */
  segmentOnForce?: string;
}

class FakeAgentServer {
  readonly handshakeUrls: URL[] = [];
  readonly handshakeHeaders: Headers[] = [];
  readonly text: Any[] = [];
  readonly binaryBytes: number[] = [];
  server: ReturnType<typeof Bun.serve>;

  constructor(options: FakeOptions = {}) {
    const self = this;
    this.server = Bun.serve({
      port: 0,
      fetch(request, server) {
        self.handshakeUrls.push(new URL(request.url));
        self.handshakeHeaders.push(request.headers);
        if (options.rejectStatus) {
          return new Response("denied", { status: options.rejectStatus });
        }
        if (server.upgrade(request, { data: {} })) return undefined;
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          if (typeof message !== "string") {
            self.binaryBytes.push(message.byteLength);
            ws.send(JSON.stringify({ message: "AudioAdded", seq_no: self.binaryBytes.length }));
            return;
          }
          const parsed = JSON.parse(message);
          self.text.push(parsed);
          switch (parsed.message) {
            case "StartRecognition":
              ws.send(
                JSON.stringify(
                  options.startReply ?? {
                    message: "RecognitionStarted",
                    id: "session-1",
                    language_pack_info: { word_delimiter: " " },
                  },
                ),
              );
              break;
            case "ForceEndOfUtterance":
              if (options.segmentOnForce) {
                ws.send(
                  JSON.stringify({
                    message: "AddPartialSegment",
                    segment: { transcript: "hello", speaker: "S1" },
                    metadata: { start_time: 0.5, end_time: 1.0 },
                  }),
                );
                ws.send(
                  JSON.stringify({
                    message: "AddSegment",
                    segment: { transcript: options.segmentOnForce, speaker: "S1" },
                    metadata: { start_time: 0.5, end_time: 1.5 },
                  }),
                );
                ws.send(JSON.stringify({ message: "EndOfTurn", metadata: { end_time: 1.5 } }));
              }
              break;
            case "EndOfStream":
              ws.send(JSON.stringify({ message: "EndOfTranscript" }));
              break;
          }
        },
      },
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}/v2`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

const servers: FakeAgentServer[] = [];
function fakeServer(options: FakeOptions = {}): FakeAgentServer {
  const s = new FakeAgentServer(options);
  servers.push(s);
  return s;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

function pcm(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}

describe("resolveUrl", () => {
  test("appends the agent path segment and sm-app", () => {
    expect(resolveUrl("wss://host/v2", "pipecat/1.0")).toBe(
      "wss://host/v2/agent?sm-app=pipecat%2F1.0",
    );
  });

  test("does not append the agent segment twice, and keeps existing sm-app", () => {
    expect(resolveUrl("wss://host/v2/agent?sm-app=mine")).toBe("wss://host/v2/agent?sm-app=mine");
  });

  test("defaults to the EU endpoint", () => {
    expect(resolveUrl()).toStartWith("wss://eu2.rt.speechmatics.com/v2/agent?sm-app=");
  });
});

describe("TranscriptionConfig wire format", () => {
  test("only set fields are sent, in snake_case", () => {
    const config = new TranscriptionConfig({
      language: "en",
      model: "linden-1",
      enablePartials: true,
      diarization: "speaker",
      speakerDiarizationConfig: new SpeakerDiarizationConfig({
        maxSpeakers: 2,
        speakers: [{ label: "Agent", speakerIdentifiers: ["a1"] }],
      }),
      additionalVocab: [{ content: "pipedog", soundsLike: ["pipe dog"] }, { content: "Pipecat" }],
    });
    expect(config.toDict()).toEqual({
      language: "en",
      model: "linden-1",
      diarization: "speaker",
      additional_vocab: [{ content: "pipedog", sounds_like: ["pipe dog"] }, { content: "Pipecat" }],
      enable_partials: true,
      speaker_diarization_config: {
        max_speakers: 2,
        speakers: [{ label: "Agent", speaker_identifiers: ["a1"] }],
      },
    });
  });

  test("audio format and turn config wire forms", () => {
    expect(
      new AudioFormat({ encoding: AudioEncoding.PCM_S16LE, sampleRate: 8000 }).toDict(),
    ).toEqual({ type: "raw", encoding: "pcm_s16le", sample_rate: 8000 });
    expect(new TurnConfig({ turnDetectionMode: TurnDetectionMode.EXTERNAL }).toDict()).toEqual({
      turn_detection_mode: "external",
    });
  });

  test("Segment.fromMessage reads the singular segment shape", () => {
    const segment = Segment.fromMessage({
      message: "AddSegment",
      segment: { transcript: "Hello there.", speaker: "S1" },
      metadata: { start_time: 0.52, end_time: 3.1 },
    });
    expect(segment).toMatchObject({
      transcript: "Hello there.",
      speaker: "S1",
      startTime: 0.52,
      endTime: 3.1,
      isFinal: true,
    });
  });
});

describe("AgentSttClient against a fake server", () => {
  test("handshake, StartRecognition, audio, ForceEndOfUtterance and EndOfStream", async () => {
    const fake = fakeServer({ segmentOnForce: "hello world" });
    const client = new AgentSttClient({
      apiKey: "secret-key",
      url: fake.url,
      app: "pipecat/test",
      transcriptionConfig: new TranscriptionConfig({ language: "en", enablePartials: true }),
      turnConfig: new TurnConfig({ turnDetectionMode: TurnDetectionMode.EXTERNAL }),
      audioFormat: new AudioFormat({ encoding: AudioEncoding.PCM_S16LE, sampleRate: 16000 }),
    });
    const segments: Any[] = [];
    client.on(ServerMessageType.ADD_SEGMENT, (m) => segments.push(m));

    await client.connect();

    // Handshake: auth header, agent path, app and sdk identifiers.
    expect(fake.handshakeHeaders[0]?.get("authorization")).toBe("Bearer secret-key");
    expect(fake.handshakeHeaders[0]?.get("x-request-id")).toBeTruthy();
    const url = fake.handshakeUrls[0] as URL;
    expect(url.pathname).toBe("/v2/agent");
    expect(url.searchParams.get("sm-app")).toBe("pipecat/test");
    expect(url.searchParams.get("sm-sdk")).toStartWith("pipedog-agent-stt");

    // StartRecognition carries the audio format, transcription config and turn config.
    expect(fake.text[0]).toEqual({
      message: "StartRecognition",
      audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
      transcription_config: { language: "en", model: "linden-1", enable_partials: true },
      turn_config: { turn_detection_mode: "external" },
    });
    expect(client.isReadyForAudio).toBe(true);
    expect(client.sessionInfo.sessionId).toBe("session-1");

    // Audio is sent as binary frames; finalize stamps the audio seconds sent so far.
    await client.sendAudio(pcm(3200));
    await client.sendAudio(pcm(3200));
    expect(client.audioSecondsSent).toBeCloseTo(0.2);
    client.finalize();
    for (let i = 0; i < 100 && segments.length === 0; i++) await Bun.sleep(5);

    expect(fake.binaryBytes).toEqual([3200, 3200]);
    const force = fake.text.find((m) => m.message === "ForceEndOfUtterance");
    expect(force.timestamp).toBeCloseTo(0.2);
    expect(segments[0].segment.transcript).toBe("hello world");

    // Closing flushes with EndOfStream carrying the last acknowledged seq_no.
    await client.disconnect();
    const eos = fake.text.find((m) => m.message === "EndOfStream");
    expect(eos).toEqual({ message: "EndOfStream", last_seq_no: 2 });
    expect(client.isConnected).toBe(false);
  });

  test("an Error before RecognitionStarted raises TranscriptionError with the reason", async () => {
    const fake = fakeServer({
      startReply: { message: "Error", type: "invalid_model", reason: "Unknown model" },
    });
    const client = new AgentSttClient({ apiKey: "k", url: fake.url });

    await expect(client.connect()).rejects.toThrow(TranscriptionError);
    expect(client.isReadyForAudio).toBe(false);
  });

  test("a rejected handshake raises ConnectionError", async () => {
    const fake = fakeServer({ rejectStatus: 401 });
    const client = new AgentSttClient({ apiKey: "bad", url: fake.url });

    await expect(client.connect()).rejects.toThrow(ConnectionError);
  });

  test("audio sent before the session is ready is dropped", async () => {
    const fake = fakeServer();
    const client = new AgentSttClient({ apiKey: "k", url: fake.url });
    await client.sendAudio(pcm(100));
    expect(fake.binaryBytes).toEqual([]);
  });

  test("rejects an unsupported sample rate", () => {
    expect(
      () =>
        new AgentSttClient({
          apiKey: "k",
          audioFormat: new AudioFormat({ encoding: AudioEncoding.PCM_S16LE, sampleRate: 24000 }),
        }),
    ).toThrow();
  });
});

describe("SpeechmaticsSTTService against a fake server", () => {
  function audioFrames(n: number): Frame[] {
    const frames: Frame[] = [];
    for (let i = 0; i < n; i++) {
      frames.push(
        new InputAudioRawFrame({ audio: new Uint8Array(640), sampleRate: 16000, numChannels: 1 }),
        new SleepFrame({ sleep: 0.01 }),
      );
    }
    return frames;
  }

  test("external turns: VAD stop finalizes and a final transcription is pushed", async () => {
    const fake = fakeServer({ segmentOnForce: "hello world" });
    const service = new SpeechmaticsSTTService({
      apiKey: "test-key",
      baseUrl: `${fake.url}/agent`,
      sampleRate: 16000,
      settings: new SpeechmaticsSTTService.Settings({
        speakerActiveFormat: "@{speaker_id}: {text}",
      }),
    });

    const [down] = await runTest(service, {
      framesToSend: [
        ...audioFrames(5),
        new VADUserStoppedSpeakingFrame({ stopSecs: 0.2 }),
        new SleepFrame({ sleep: 0.3 }),
      ],
      pipelineParams: new PipelineParams({ audioInSampleRate: 16000 }),
    });

    const final = down.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
    expect(final.map((f) => f.text)).toEqual(["@S1: hello world"]);
    expect(final[0]?.userId).toBe("S1");
    expect(final[0]?.finalized).toBe(true);
    // The service pushes every partial segment the server sends as an interim transcription.
    const interim = down.filter((f) => f instanceof InterimTranscriptionFrame);
    expect(interim.map((f) => (f as InterimTranscriptionFrame).text)).toEqual(["@S1: hello"]);
    expect(fake.text[0]?.turn_config).toEqual({ turn_detection_mode: "external" });
    expect(fake.text[0]?.audio_format).toEqual({
      type: "raw",
      encoding: "pcm_s16le",
      sample_rate: 16000,
    });
    expect(fake.text.some((m) => m.message === "ForceEndOfUtterance")).toBe(true);
    expect(fake.text.some((m) => m.message === "EndOfStream")).toBe(true);
  });

  test("a rejected handshake is retried, then reported as a permanent error", async () => {
    // DIVERGENCE: the standard WebSocket API does not expose the handshake status on
    // Bun, Node and Deno, so a 401 there looks like any other failed connect and is
    // retried (Workers reports `HTTP 401` in the message, which is detected: see
    // test_is_auth_rejection_message_fallback).
    const fake = fakeServer({ rejectStatus: 401 });
    const service = new SpeechmaticsSTTService({
      apiKey: "bad-key",
      baseUrl: fake.url,
      sampleRate: 16000,
    });
    (service as Any)._sleep = async () => {};

    const [, up] = await runTest(service, {
      framesToSend: [...audioFrames(3), new SleepFrame({ sleep: 0.3 })],
      pipelineParams: new PipelineParams({ audioInSampleRate: 16000 }),
    });

    const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
    expect(errors.at(-1)?.error).toContain("failed to reconnect after 3 attempts");
    expect(fake.handshakeUrls.length).toBe(4);
    expect(service.isUsable).toBe(false);
  });
});
