// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_exotel_serializer.py

/** Tests for ExotelFrameSerializer wire format. */

import { beforeEach, describe, expect, test } from "bun:test";

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  type InputAudioRawFrame,
  InterruptionFrame,
  OutputAudioRawFrame,
} from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";

import { ExotelFrameSerializer } from "../src/exotel.ts";

const STREAM_SID = "stream123";
const SAMPLE_RATE = 8000;

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

/** `b"\x01\x02" * n` */
function repeat(pattern: number[], n: number): Uint8Array {
  const out = new Uint8Array(pattern.length * n);
  for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length] as number;
  return out;
}

describe("TestExotelSerializeWireFormat", () => {
  let serializer: ExotelFrameSerializer;

  beforeEach(async () => {
    serializer = new ExotelFrameSerializer({ streamSid: STREAM_SID, callSid: "call123" });
    await serializer.setup(
      frameProcessorSetup(null, {
        audioInSampleRate: SAMPLE_RATE,
        audioOutSampleRate: SAMPLE_RATE,
      }),
    );
  });

  test("test_media_event", async () => {
    const frame = new OutputAudioRawFrame({
      audio: repeat([0, 0], 160),
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
    const message = JSON.parse((await serializer.serialize(frame)) as string);
    expect(message.event).toEqual("media");
    expect(message.stream_sid).toEqual(STREAM_SID);
    expect(message.media).toHaveProperty("payload");
  });

  test("test_clear_event", async () => {
    const message = JSON.parse((await serializer.serialize(new InterruptionFrame())) as string);
    expect(message).toEqual({ event: "clear", stream_sid: STREAM_SID });
  });
});

describe("TestExotelDeserialize", () => {
  let serializer: ExotelFrameSerializer;

  beforeEach(async () => {
    serializer = new ExotelFrameSerializer({ streamSid: STREAM_SID });
    await serializer.setup(
      frameProcessorSetup(null, {
        audioInSampleRate: SAMPLE_RATE,
        audioOutSampleRate: SAMPLE_RATE,
      }),
    );
  });

  test("test_media_round_trip", async () => {
    const audio = repeat([1, 2], 160);
    const outbound = await serializer.serialize(
      new OutputAudioRawFrame({ audio, sampleRate: SAMPLE_RATE, numChannels: 1 }),
    );
    const frame = (await serializer.deserialize(outbound as string)) as InputAudioRawFrame;
    expect(frame.audio).toEqual(audio);
    expect(frame.sampleRate).toEqual(SAMPLE_RATE);
  });

  test("test_malformed_json_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize("not json");
    expect(frame).toBeNull();
  });

  test("test_media_event_missing_payload_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize(JSON.stringify({ event: "media", media: {} }));
    expect(frame).toBeNull();
  });
});
