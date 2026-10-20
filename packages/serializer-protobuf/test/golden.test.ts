// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Wire compatibility with upstream: replays the vectors upstream's
 * ProtobufFrameSerializer produced (tools/golden/serializers.py) and checks
 * that ours encodes the same frames to the same bytes and decodes upstream's
 * bytes to the same frames.
 */

import { describe, expect, test } from "bun:test";
import {
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
  TextFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { ProtobufFrameSerializer } from "../src/protobuf.ts";
import golden from "./fixtures/golden.json";

type Spec = Record<string, any>;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function makeFrame(spec: Spec): Frame {
  let frame: Frame;
  switch (spec.kind) {
    case "text":
      frame = new TextFrame({ text: spec.text });
      break;
    case "audio":
      frame = new OutputAudioRawFrame({
        audio: fromHex(spec.audio),
        sampleRate: spec.sample_rate,
        numChannels: spec.num_channels,
      });
      break;
    case "transcription":
      frame = new TranscriptionFrame({
        text: spec.text,
        userId: spec.user_id,
        timestamp: spec.timestamp,
      });
      break;
    case "interruption":
      frame = new InterruptionFrame();
      break;
    case "message":
      frame = new OutputTransportMessageFrame({ message: spec.message });
      break;
    case "message_urgent":
      frame = new OutputTransportMessageUrgentFrame({ message: spec.message });
      break;
    default:
      throw new Error(`unknown kind ${spec.kind}`);
  }
  frame.id = spec.id;
  frame.name = spec.name;
  if ("pts" in spec) frame.pts = spec.pts;
  return frame;
}

const label = (spec: Spec) =>
  `${spec.kind} ${spec.name || "(no name)"} ${spec.message !== undefined ? JSON.stringify(spec.message).slice(0, 40) : ""}`;

describe("protobuf golden vectors (upstream bytes)", () => {
  for (const { input, hex } of golden.serialize as { input: Spec; hex: string | null }[]) {
    test(`serialize ${label(input)}`, async () => {
      const out = await new ProtobufFrameSerializer().serialize(makeFrame(input));
      expect(out === null ? null : toHex(out as Uint8Array)).toEqual(hex);
    });
  }

  // DIVERGENCE: where our behavior is known to differ from upstream's.
  const divergent: Record<string, string> = {
    // uint64 fields are JS numbers (see frames_pb2.ts): exact only up to 2^53.
    "text huge id": "uint64 id beyond 2^53",
  };

  for (const { label: name, hex, frame: expected, error } of golden.deserialize as {
    label: string;
    hex: string;
    frame?: Spec | null;
    error?: string;
  }[]) {
    const t = name in divergent ? test.skip : test;
    t(`deserialize ${name}`, async () => {
      const serializer = new ProtobufFrameSerializer();
      if (error !== undefined) {
        // Upstream raises protobuf's DecodeError; core's codec throws an Error.
        await expect(serializer.deserialize(fromHex(hex))).rejects.toThrow();
        return;
      }
      const frame = await serializer.deserialize(fromHex(hex));
      if (expected == null) {
        expect(frame).toBeNull();
        return;
      }
      expect(frame?.constructor.name).toEqual(expected.type);
      if (frame instanceof TextFrame && !(frame instanceof TranscriptionFrame)) {
        expect(frame.text).toEqual(expected.text);
      }
      if (frame instanceof TranscriptionFrame) {
        expect([frame.text, frame.userId, frame.timestamp]).toEqual([
          expected.text,
          expected.user_id,
          expected.timestamp,
        ]);
      }
      if (frame instanceof InputAudioRawFrame) {
        expect(toHex(frame.audio)).toEqual(expected.audio.hex);
        expect([frame.sampleRate, frame.numChannels]).toEqual([
          expected.sample_rate,
          expected.num_channels,
        ]);
      }
      if (frame instanceof InputTransportMessageFrame) {
        expect(pyJsonDumps(frame.message)).toEqual(expected.message);
      }
      if (frame instanceof InterruptionFrame) {
        expect(frame).toBeInstanceOf(InterruptionFrame);
      }
      if (expected.id !== null) expect(String(frame!.id)).toEqual(expected.id);
      if (expected.name !== null) expect(frame!.name).toEqual(expected.name);
      expect(frame!.pts).toEqual(expected.pts);
    });
  }
});
