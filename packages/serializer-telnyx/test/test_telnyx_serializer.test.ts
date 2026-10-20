// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_telnyx_serializer.py

/**
 * Tests for TelnyxFrameSerializer.
 *
 * serialize() passes OutputTransportMessageFrame/OutputTransportMessageUrgentFrame
 * through to the wire, like the other telephony serializers. deserialize() ignores
 * malformed JSON and messages missing expected fields rather than raising, since
 * the transport's receive loop ends the call on any exception.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  OutputTransportMessageFrame,
  OutputTransportMessageUrgentFrame,
} from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";

import { TelnyxFrameSerializer } from "../src/telnyx.ts";

const STREAM_ID = "stream123";
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

async function makeSerializer(): Promise<TelnyxFrameSerializer> {
  const serializer = new TelnyxFrameSerializer({
    streamId: STREAM_ID,
    outboundEncoding: "PCMU",
    inboundEncoding: "PCMU",
    params: new TelnyxFrameSerializer.InputParams({ autoHangUp: false }),
  });
  await serializer.setup(
    frameProcessorSetup(null, {
      audioInSampleRate: SAMPLE_RATE,
      audioOutSampleRate: SAMPLE_RATE,
    }),
  );
  return serializer;
}

describe("TestTelnyxOutputTransportMessagePassthrough", () => {
  let serializer: TelnyxFrameSerializer;

  beforeEach(async () => {
    serializer = await makeSerializer();
  });

  test("test_output_transport_message_frame_is_passed_through", async () => {
    const payload = { foo: "bar" };
    const result = await serializer.serialize(
      new OutputTransportMessageFrame({ message: payload }),
    );
    expect(JSON.parse(result as string)).toEqual(payload);
  });

  test("test_output_transport_message_urgent_frame_is_passed_through", async () => {
    const payload = { foo: "urgent" };
    const result = await serializer.serialize(
      new OutputTransportMessageUrgentFrame({ message: payload }),
    );
    expect(JSON.parse(result as string)).toEqual(payload);
  });
});

describe("TestTelnyxDeserializeRobustness", () => {
  let serializer: TelnyxFrameSerializer;

  beforeEach(async () => {
    serializer = await makeSerializer();
  });

  test("test_malformed_json_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize("not json");
    expect(frame).toBeNull();
  });

  test("test_media_event_missing_payload_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize(JSON.stringify({ event: "media", media: {} }));
    expect(frame).toBeNull();
  });

  test("test_message_missing_event_key_is_ignored_not_raised", async () => {
    const frame = await serializer.deserialize(JSON.stringify({ foo: "bar" }));
    expect(frame).toBeNull();
  });
});
