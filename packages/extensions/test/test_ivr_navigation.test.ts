// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ivr_navigation.py

import { describe, expect, test } from "bun:test";

import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import {
  AggregatedTextFrame,
  LLMFullResponseEndFrame,
  LLMMessagesUpdateFrame,
  LLMTextFrame,
  OutputDTMFUrgentFrame,
  TextFrame,
  VADParamsUpdateFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";

import { IVRProcessor, IVRStatus } from "../src/ivr_navigator.ts";

// Test prompts
const classifierPrompt = "Classify as IVR or conversation";
const ivrPrompt = "Navigate to the billing department";

function makeProcessor(): IVRProcessor {
  // Create just the IVR processor to test in isolation
  return new IVRProcessor({
    classifierPrompt,
    ivrPrompt,
    ivrVadParams: new VADParams({ stopSecs: 2.0 }),
  });
}

describe("TestIVRNavigation", () => {
  test("test_switch_to_ivr_mode", async () => {
    // Test switching to IVR mode from conversation mode.
    const processor = makeProcessor();

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<mode>ivr</mode>" })],
      // No frames expected - mode selection doesn't push TextFrame
      expectedDownFrames: [],
      expectedUpFrames: [
        LLMMessagesUpdateFrame, // Initialize the mode detection prompt
        LLMMessagesUpdateFrame, // Switch to the ivr prompt
        VADParamsUpdateFrame, // Switch to the ivr VAD parameters
      ],
    });
  });

  test("test_switch_to_conversation_mode", async () => {
    // Test switching to conversation mode when conversation is detected.
    const processor = makeProcessor();

    let conversationHandlerCalled = false;
    let receivedProcessor: unknown = null;
    let receivedHistory: unknown = null;

    processor.addEventHandler("on_conversation_detected", async (ivrProcessor, history) => {
      conversationHandlerCalled = true;
      receivedProcessor = ivrProcessor;
      receivedHistory = history;
    });

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<mode>conversation</mode>" })],
      expectedDownFrames: [],
      expectedUpFrames: [
        LLMMessagesUpdateFrame, // Initialize the mode detection prompt
      ],
    });

    // Verify the event handler was called
    expect(conversationHandlerCalled).toBe(true);
    expect(receivedProcessor).toBe(processor);
    expect(receivedHistory).toEqual([]);
  });

  test("test_basic_dtmf_navigation", async () => {
    // Test basic DTMF tone generation from LLM responses.
    const processor = makeProcessor();

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<dtmf>1</dtmf>" })],
      expectedDownFrames: [
        OutputDTMFUrgentFrame,
        TextFrame, // Context frame with skipTts=true
      ],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });
  });

  test("test_multiple_dtmf_navigation", async () => {
    // Test several DTMF tones in a row.
    const processor = makeProcessor();

    await runTest(processor, {
      framesToSend: [
        new LLMTextFrame({ text: "<dtmf>1</dtmf>" }),
        new LLMTextFrame({ text: "<dtmf>2</dtmf>" }),
        new LLMTextFrame({ text: "<dtmf>3</dtmf>" }),
        new LLMTextFrame({ text: "<dtmf>4</dtmf>" }),
      ],
      expectedDownFrames: [
        OutputDTMFUrgentFrame,
        TextFrame,
        OutputDTMFUrgentFrame,
        TextFrame,
        OutputDTMFUrgentFrame,
        TextFrame,
        OutputDTMFUrgentFrame,
        TextFrame,
      ],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });
  });

  test("test_ivr_wait", async () => {
    // Test that `<ivr>wait</ivr>` only adds the context frame.
    const processor = makeProcessor();

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<ivr>wait</ivr>" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });
  });

  test("test_ivr_stuck", async () => {
    // Test that on_ivr_status_changed event handler is called when stuck.
    const processor = makeProcessor();

    let stuckHandlerCalled = false;
    let receivedProcessor: unknown = null;
    let receivedStatus: IVRStatus | null = null;

    processor.addEventHandler("on_ivr_status_changed", async (ivrProcessor, status) => {
      if (status === "stuck") {
        stuckHandlerCalled = true;
        receivedProcessor = ivrProcessor;
        receivedStatus = status;
      }
    });

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<ivr>stuck</ivr>" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });

    expect(stuckHandlerCalled).toBe(true);
    expect(receivedProcessor).toBe(processor);
    expect(receivedStatus === IVRStatus.STUCK).toBe(true);
  });

  test("test_ivr_completed", async () => {
    // Test that on_ivr_status_changed event handler is called when completed.
    const processor = makeProcessor();

    let completedHandlerCalled = false;
    let receivedProcessor: unknown = null;
    let receivedStatus: IVRStatus | null = null;

    processor.addEventHandler("on_ivr_status_changed", async (ivrProcessor, status) => {
      if (status === "completed") {
        completedHandlerCalled = true;
        receivedProcessor = ivrProcessor;
        receivedStatus = status;
      }
    });

    await runTest(processor, {
      framesToSend: [new LLMTextFrame({ text: "<ivr>completed</ivr>" })],
      expectedDownFrames: [TextFrame],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });

    expect(completedHandlerCalled).toBe(true);
    expect(receivedProcessor).toBe(processor);
    expect(receivedStatus === IVRStatus.COMPLETED).toBe(true);
  });

  test("test_normal_text_passthrough", async () => {
    // Test that normal LLM text (no XML) passes through unchanged.
    const processor = makeProcessor();

    await runTest(processor, {
      framesToSend: [
        new LLMTextFrame({ text: "Hello, I'm trying to reach billing." }),
        new LLMFullResponseEndFrame(),
      ],
      expectedDownFrames: [
        AggregatedTextFrame, // LLMTextFrames aggregated and converted to AggregatedTextFrame
        LLMFullResponseEndFrame,
      ],
      expectedUpFrames: [LLMMessagesUpdateFrame],
    });
  });
});
