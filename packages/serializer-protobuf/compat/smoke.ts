// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: replays the upstream golden vectors
// (test/fixtures/golden.json) on each runtime, so the wire format (varints,
// UTF-8, Python-style JSON of transport messages) is checked on every engine.

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
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";

import { ProtobufFrameSerializer } from "../src/protobuf.ts";
import golden from "../test/fixtures/golden.json" with { type: "json" };

type Spec = Record<string, any>;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`serializer-protobuf smoke: ${message}`);
}

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

// Frame classes by upstream name (bundlers may rename classes, so no `constructor.name`).
const TYPES: Record<string, new (...args: any[]) => Frame> = {
  TextFrame,
  TranscriptionFrame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
};

// Known divergences, see test/golden.test.ts.
const DIVERGENT = new Set(["message NaN", "text huge id", "invalid utf-8 string"]);

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");
  const serializer = new ProtobufFrameSerializer();
  for (const { input, hex } of golden.serialize as { input: Spec; hex: string | null }[]) {
    const out = await serializer.serialize(makeFrame(input));
    const got = out === null ? null : toHex(out as Uint8Array);
    check(got === hex, `serialize ${input.kind} ${input.name}: ${got} != ${hex}`);
  }
  for (const v of golden.deserialize as {
    label: string;
    hex: string;
    frame?: Spec | null;
    error?: string;
  }[]) {
    if (DIVERGENT.has(v.label)) continue;
    let frame: Frame | null;
    try {
      frame = await serializer.deserialize(fromHex(v.hex));
    } catch (e) {
      check(v.error !== undefined, `deserialize ${v.label} threw ${e}`);
      continue;
    }
    check(v.error === undefined, `deserialize ${v.label} should throw`);
    if (v.frame == null) {
      check(frame === null, `deserialize ${v.label} should give null`);
      continue;
    }
    const Type = TYPES[v.frame.type];
    check(Type && frame instanceof Type, `deserialize ${v.label}: not a ${v.frame.type}`);
    if (frame instanceof InputTransportMessageFrame) {
      check(pyJsonDumps(frame.message) === v.frame.message, `deserialize ${v.label}: message`);
    }
    if (frame instanceof InputAudioRawFrame) {
      check(toHex(frame.audio) === v.frame.audio.hex, `deserialize ${v.label}: audio`);
    }
  }
}
