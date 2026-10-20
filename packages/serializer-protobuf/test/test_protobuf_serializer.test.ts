// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_protobuf_serializer.py

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type InputAudioRawFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
  TextFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { ProtobufFrameSerializer } from "../src/protobuf.ts";

describe("TestProtobufFrameSerializer", () => {
  let serializer: ProtobufFrameSerializer;

  beforeEach(() => {
    serializer = new ProtobufFrameSerializer();
  });

  test("test_roundtrip", async () => {
    const textFrame = new TextFrame({ text: "hello world" });
    let frame = await serializer.deserialize((await serializer.serialize(textFrame))!);
    expect((frame as TextFrame).text).toEqual(textFrame.text);

    const transcriptionFrame = new TranscriptionFrame({
      text: "Hello there!",
      userId: "123",
      timestamp: "2021-01-01",
    });
    frame = await serializer.deserialize((await serializer.serialize(transcriptionFrame))!);
    expect((frame as TranscriptionFrame).text).toEqual(transcriptionFrame.text);
    expect((frame as TranscriptionFrame).userId).toEqual(transcriptionFrame.userId);
    expect((frame as TranscriptionFrame).timestamp).toEqual(transcriptionFrame.timestamp);

    const audioFrame = new OutputAudioRawFrame({
      audio: new TextEncoder().encode("1234567890"),
      sampleRate: 16000,
      numChannels: 1,
    });
    frame = await serializer.deserialize((await serializer.serialize(audioFrame))!);
    expect((frame as InputAudioRawFrame).audio).toEqual(audioFrame.audio);
    expect((frame as InputAudioRawFrame).sampleRate).toEqual(audioFrame.sampleRate);
    expect((frame as InputAudioRawFrame).numChannels).toEqual(audioFrame.numChannels);
  });

  test("test_interruption_frame_roundtrip", async () => {
    const interruptionFrame = new InterruptionFrame();
    const frame = await serializer.deserialize((await serializer.serialize(interruptionFrame))!);
    expect(frame).toBeInstanceOf(InterruptionFrame);
  });
});
