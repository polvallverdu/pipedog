// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_twilio_serializer.py

/**
 * Tests for TwilioFrameSerializer deserialize().
 *
 * Malformed JSON and messages missing expected fields are ignored rather than
 * raised, since the transport's receive loop ends the call on any exception.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";

import { TwilioFrameSerializer } from "../src/twilio.ts";

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

describe("TestTwilioDeserializeRobustness", () => {
  let serializer: TwilioFrameSerializer;

  beforeEach(async () => {
    serializer = new TwilioFrameSerializer({
      streamSid: STREAM_SID,
      params: new TwilioFrameSerializer.InputParams({ autoHangUp: false }),
    });
    await serializer.setup(
      frameProcessorSetup(null, {
        audioInSampleRate: SAMPLE_RATE,
        audioOutSampleRate: SAMPLE_RATE,
      }),
    );
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
