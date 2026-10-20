// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with the official Pipecat browser client
 * (@pipecat-ai/websocket-transport), whose ProtobufFrameSerializer speaks
 * frames.proto with protobuf-ts.
 *
 * The fixtures are recorded by tools/client-compat/generate.ts from the real
 * client package: the bytes the client sends (mic audio, RTVI messages), and
 * the bytes our serializer sends together with what the client decoded from
 * them.
 */

import { describe, expect, test } from "bun:test";
import {
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import fixtures from "../../../tools/client-compat/fixtures.json";
import { ProtobufFrameSerializer } from "../src/protobuf.ts";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function pcm(samples: number[]): Uint8Array {
  return new Uint8Array(Int16Array.from(samples).buffer);
}

function samplesOf(audio: Uint8Array): number[] {
  const copy = audio.slice();
  return Array.from(new Int16Array(copy.buffer, 0, copy.length / 2));
}

function withIds<T extends Frame>(frame: T, id: number, name: string): T {
  frame.id = id;
  frame.name = name;
  return frame;
}

const byName = <T extends { name: string }>(xs: T[], name: string): T => {
  const x = xs.find((f) => f.name === name);
  if (!x) throw new Error(`missing fixture ${name}`);
  return x;
};

describe("client to server (decoded by ProtobufFrameSerializer)", () => {
  const serializer = new ProtobufFrameSerializer();

  for (const fixture of fixtures.clientToServer) {
    test(fixture.name, async () => {
      const frame = await serializer.deserialize(fromHex(fixture.bytes));
      const want = fixture.expect as Record<string, any>;
      if (want.kind === "audio") {
        expect(frame).toBeInstanceOf(InputAudioRawFrame);
        const audio = frame as InputAudioRawFrame;
        expect(audio.sampleRate).toBe(want.sampleRate);
        expect(audio.numChannels).toBe(want.numChannels);
        expect(samplesOf(audio.audio)).toEqual(want.samples);
        // The client names every audio frame "audio" and leaves id at 0.
        expect(audio.name).toBe("audio");
      } else {
        expect(frame).toBeInstanceOf(InputTransportMessageFrame);
        expect((frame as InputTransportMessageFrame).message).toEqual(want.message);
      }
    });
  }
});

describe("server to client (bytes the client decoded)", () => {
  const serializer = new ProtobufFrameSerializer();
  const botReady = {
    label: "rtvi-ai",
    type: "bot-ready",
    id: "c0ffee01",
    data: { version: "1.2.0", about: { library: "pipedog", note: "ünïcödé 🐶", ratio: 0.1 } },
  };
  const frames: [string, () => Frame][] = [
    [
      "audio_24k_mono",
      () =>
        withIds(
          new OutputAudioRawFrame({
            audio: pcm([0, 100, -100, 32767, -32768, 42]),
            sampleRate: 24000,
            numChannels: 1,
          }),
          7,
          "OutputAudioRawFrame#3",
        ),
    ],
    [
      "message_bot_ready",
      () => withIds(new OutputTransportMessageUrgentFrame({ message: botReady }), 8, "x"),
    ],
    [
      "message_server_message",
      () =>
        withIds(
          new OutputTransportMessageUrgentFrame({
            message: {
              label: "rtvi-ai",
              type: "server-message",
              data: { score: 3.25, items: ["a", "ß"] },
            },
          }),
          9,
          "y",
        ),
    ],
    ["text", () => withIds(new TextFrame({ text: "hello ✓" }), 10, "TextFrame#1")],
    [
      "transcription",
      () =>
        withIds(
          new TranscriptionFrame({
            text: "héllo",
            userId: "u1",
            timestamp: "2026-01-01T00:00:00Z",
          }),
          11,
          "TranscriptionFrame#1",
        ),
    ],
    ["interruption", () => withIds(new InterruptionFrame(), 12, "InterruptionFrame#1")],
  ];

  for (const [name, make] of frames) {
    test(name, async () => {
      const fixture = byName(fixtures.serverToClient, name);
      const bytes = (await serializer.serialize(make())) as Uint8Array;
      expect(toHex(bytes)).toBe(fixture.bytes);
    });
  }

  test("the client decoded audio and RTVI messages, and only those", () => {
    const client = (name: string) => byName(fixtures.serverToClient, name).client as any;
    expect(client("audio_24k_mono")).toEqual({
      type: "audio",
      samples: [0, 100, -100, 32767, -32768, 42],
    });
    expect(client("message_bot_ready")).toEqual({ type: "message", message: botReady });
    expect(client("message_server_message").type).toBe("message");
    // The client handles only `audio` and `message`; its frames.proto predates
    // `interruption`, so that one is an unknown oneof member to it, as it is
    // with an upstream Pipecat bot.
    for (const name of ["text", "transcription", "interruption"]) {
      expect(client(name)).toEqual({ error: "Unknown frame kind" });
    }
  });
});
