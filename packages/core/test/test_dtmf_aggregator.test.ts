// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_dtmf_aggregator.py

import { describe, expect, test } from "bun:test";

import { KeypadEntry } from "../src/audio/dtmf/types.ts";
import {
  EndFrame,
  type Frame,
  InputDTMFFrame,
  InterruptionFrame,
  TranscriptionFrame,
} from "../src/frames/frames.ts";
import { DTMFAggregator } from "../src/processors/aggregators/dtmf_aggregator.ts";
import { type FrameType, runTest, SleepFrame } from "../src/tests/utils.ts";

function transcriptionsOf(frames: Frame[]): TranscriptionFrame[] {
  return frames.filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame);
}

describe("TestDTMFAggregator", () => {
  test("test_basic_aggregation_with_pound", async () => {
    // Test basic DTMF aggregation ending with pound key.
    const aggregator = new DTMFAggregator();
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new InputDTMFFrame({ button: KeypadEntry.THREE }),
      new InputDTMFFrame({ button: KeypadEntry.POUND }),
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      InputDTMFFrame,
      InputDTMFFrame,
      TranscriptionFrame,
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    // Find and verify the TranscriptionFrame
    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(1);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 123#");
    expect(transcriptionFrames[0]!.finalized).toBe(true);
  });

  test("test_timeout_aggregation", async () => {
    // Test DTMF aggregation with timeout flush.
    const aggregator = new DTMFAggregator({ timeout: 0.1 });
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new SleepFrame(), // This should trigger timeout
      new InputDTMFFrame({ button: KeypadEntry.THREE }),
      new SleepFrame(), // This should trigger another timeout
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      TranscriptionFrame, // First aggregation "12"
      InputDTMFFrame,
      InterruptionFrame,
      TranscriptionFrame, // Second aggregation "3"
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    // Find the TranscriptionFrames
    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(2);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 12");
    expect(transcriptionFrames[1]!.text).toEqual("DTMF: 3");
    expect(transcriptionFrames.every((f) => f.finalized)).toBe(true);
  });

  test("test_multiple_aggregations", async () => {
    // Test multiple DTMF sequences with pound termination.
    const aggregator = new DTMFAggregator({ timeout: 0.2 });
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new InputDTMFFrame({ button: KeypadEntry.POUND }), // First sequence
      new SleepFrame(),
      new InputDTMFFrame({ button: KeypadEntry.FOUR }),
      new InputDTMFFrame({ button: KeypadEntry.FIVE }),
      new SleepFrame(), // Second sequence via timeout
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      InputDTMFFrame,
      TranscriptionFrame, // "12#"
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      TranscriptionFrame, // "45"
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(2);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 12#");
    expect(transcriptionFrames[1]!.text).toEqual("DTMF: 45");
  });

  test("test_end_frame_flush", async () => {
    // Test that EndFrame flushes pending aggregation.
    const aggregator = new DTMFAggregator({ timeout: 1.0 });
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new SleepFrame(), // Allow time for aggregation
      new EndFrame(),
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      TranscriptionFrame, // Should flush before EndFrame
      EndFrame,
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
      sendEndFrame: false, // We're sending one in the test to test EndFrame logic
    });

    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(1);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 12");
  });

  test("test_custom_prefix", async () => {
    // Test custom prefix configuration.
    const aggregator = new DTMFAggregator({ prefix: "Menu: " });
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.POUND }),
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      TranscriptionFrame,
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(1);
    expect(transcriptionFrames[0]!.text).toEqual("Menu: 1#");
  });

  test("test_custom_termination_digit", async () => {
    // Test custom termination digit configuration.
    const aggregator = new DTMFAggregator({ terminationDigit: KeypadEntry.STAR });
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new InputDTMFFrame({ button: KeypadEntry.STAR }), // Custom terminator
    ];
    const expectedDownFrames = [
      InputDTMFFrame,
      InterruptionFrame,
      InputDTMFFrame,
      InputDTMFFrame,
      TranscriptionFrame,
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(1);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 12*");
  });

  test("test_all_keypad_entries", async () => {
    // Test all possible keypad entries.
    const aggregator = new DTMFAggregator();
    const framesToSend = [
      new InputDTMFFrame({ button: KeypadEntry.ZERO }),
      new InputDTMFFrame({ button: KeypadEntry.ONE }),
      new InputDTMFFrame({ button: KeypadEntry.TWO }),
      new InputDTMFFrame({ button: KeypadEntry.THREE }),
      new InputDTMFFrame({ button: KeypadEntry.FOUR }),
      new InputDTMFFrame({ button: KeypadEntry.FIVE }),
      new InputDTMFFrame({ button: KeypadEntry.SIX }),
      new InputDTMFFrame({ button: KeypadEntry.SEVEN }),
      new InputDTMFFrame({ button: KeypadEntry.EIGHT }),
      new InputDTMFFrame({ button: KeypadEntry.NINE }),
      new InputDTMFFrame({ button: KeypadEntry.STAR }),
      new InputDTMFFrame({ button: KeypadEntry.POUND }),
    ];

    // All the InputDTMFFrames plus one TranscriptionFrame
    const expectedDownFrames: FrameType[] = [
      InputDTMFFrame,
      InterruptionFrame,
      ...Array<FrameType>(framesToSend.length - 1).fill(InputDTMFFrame),
      TranscriptionFrame,
    ];

    const [receivedDownFrames] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });

    const transcriptionFrames = transcriptionsOf(receivedDownFrames);
    expect(transcriptionFrames.length).toEqual(1);
    expect(transcriptionFrames[0]!.text).toEqual("DTMF: 0123456789*#");
  });
});
