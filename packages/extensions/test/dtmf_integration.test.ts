// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Checks the IVR extension against the pieces around it: the telephony
// serializers' DTMF frames, core's DTMFAggregator and core's DTMF audio.

import { describe, expect, test } from "bun:test";

import { loadDtmfAudio } from "@pipedog/core/audio/dtmf/utils";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  InputDTMFFrame,
  LLMTextFrame,
  OutputAudioRawFrame,
  OutputDTMFUrgentFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { DTMFAggregator } from "@pipedog/core/processors/aggregators/dtmf_aggregator";
import { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { runTest } from "@pipedog/core/tests/utils";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import {
  TelnyxFrameSerializer,
  TelnyxFrameSerializerInputParams,
} from "@pipedog/serializer-telnyx/telnyx";
import {
  TwilioFrameSerializer,
  TwilioFrameSerializerInputParams,
} from "@pipedog/serializer-twilio/twilio";

import { IVRProcessor } from "../src/ivr_navigator.ts";

function setupFor(rate: number): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    taskManager: null as unknown as BaseTaskManager,
    audioInSampleRate: rate,
  });
}

const processor = () => new IVRProcessor({ classifierPrompt: "classify", ivrPrompt: "navigate" });

describe("IVR with telephony DTMF", () => {
  test("IVR output DTMF becomes audio the Twilio serializer sends as media", async () => {
    const [down] = await runTest(processor(), {
      framesToSend: [new LLMTextFrame({ text: "<dtmf>1</dtmf><dtmf>#</dtmf>" })],
    });
    const dtmf = down.filter((f): f is OutputDTMFUrgentFrame => f instanceof OutputDTMFUrgentFrame);
    expect(dtmf.map((f) => f.buttons)).toEqual([["1"], ["#"]]);

    // What BaseOutputTransport does with the frame when the transport has no
    // native DTMF: a tone as audio, which the serializer puts on the wire.
    const serializer = new TwilioFrameSerializer({
      streamSid: "MZ123",
      callSid: "CA123",
      params: new TwilioFrameSerializerInputParams({ autoHangUp: false }),
    });
    await serializer.setup(setupFor(8000));
    for (const frame of dtmf) {
      for (const button of frame.buttons ?? []) {
        const audio = await loadDtmfAudio(button, { sampleRate: 8000 });
        const wire = await serializer.serialize(
          new OutputAudioRawFrame({ audio, sampleRate: 8000, numChannels: 1 }),
        );
        const message = JSON.parse(wire as string);
        expect(message.event).toEqual("media");
        expect(message.streamSid).toEqual("MZ123");
        expect(message.media.payload.length).toBeGreaterThan(0);
      }
    }
  });

  test("Twilio DTMF events reach the LLM as a DTMFAggregator transcription", async () => {
    const serializer = new TwilioFrameSerializer({
      streamSid: "MZ123",
      callSid: "CA123",
      params: new TwilioFrameSerializerInputParams({ autoHangUp: false }),
    });
    await serializer.setup(setupFor(8000));
    const frames: InputDTMFFrame[] = [];
    for (const digit of ["1", "2", "#"]) {
      const frame = await serializer.deserialize(
        JSON.stringify({ event: "dtmf", dtmf: { digit } }),
      );
      expect(frame).toBeInstanceOf(InputDTMFFrame);
      frames.push(frame as InputDTMFFrame);
    }

    const [down] = await runTest(new DTMFAggregator(), { framesToSend: frames });
    const transcription = down.find(
      (f): f is TranscriptionFrame => f instanceof TranscriptionFrame,
    );
    expect(transcription?.text).toEqual("DTMF: 12#");
  });

  test("Telnyx DTMF events produce the same frames", async () => {
    const serializer = new TelnyxFrameSerializer({
      streamId: "stream",
      callControlId: "call",
      outboundEncoding: "PCMU",
      inboundEncoding: "PCMU",
      params: new TelnyxFrameSerializerInputParams({ autoHangUp: false }),
    });
    await serializer.setup(setupFor(8000));
    const frame = await serializer.deserialize(
      JSON.stringify({ event: "dtmf", dtmf: { digit: "5" } }),
    );
    expect(frame).toBeInstanceOf(InputDTMFFrame);
    expect((frame as InputDTMFFrame).button).toEqual("5");
  });

  test("a digit outside the keypad is ignored with a warning", async () => {
    const [down] = await runTest(processor(), {
      framesToSend: [new LLMTextFrame({ text: "<dtmf>x</dtmf>" })],
    });
    expect(down.some((f) => f instanceof OutputDTMFUrgentFrame)).toBe(false);
  });
});
