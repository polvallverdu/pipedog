// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_perception.py

/** Tests for the reading of how the user spoke in RTVIObserver's user-input messages. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PerceptionCapabilities, PerceptionSignal } from "../src/expressive/perception.ts";
import {
  type Frame,
  InterimTranscriptionFrame,
  PerceptionMetadataFrame,
  TranscriptionFrame,
} from "../src/frames/frames.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { RTVIObserver } from "../src/processors/frameworks/rtvi/observer.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";

const READING = [
  new PerceptionSignal({
    name: "tone",
    labels: [
      ["frustrated", 0.86],
      ["neutral", 0.1],
    ],
  }),
  new PerceptionSignal({ name: "speech_rate", value: 4.1 }),
];

type SendMock = ReturnType<typeof mock<(message: unknown, excludeNone?: boolean) => Promise<void>>>;

/** An observer whose `sendRtviMessage` is mocked, as upstream does with AsyncMock. */
function mockedObserver(): { observer: RTVIObserver; send: SendMock } {
  const observer = new RTVIObserver();
  const send: SendMock = mock(async (_message: unknown, _excludeNone?: boolean) => {});
  (observer as unknown as { sendRtviMessage: SendMock }).sendRtviMessage = send;
  return { observer, send };
}

function userInputs(send: SendMock): RTVI.UserInputMessageData[] {
  return send.mock.calls
    .map((call) => call[0])
    .filter((message): message is RTVI.UserInputMessage => message instanceof RTVI.UserInputMessage)
    .map((message) => message.data);
}

describe("TestRTVIObserverPerception", () => {
  async function userInputFor(frame: Frame): Promise<RTVI.UserInputMessageData> {
    const { observer, send } = mockedObserver();
    const transport = new BaseOutputTransport(new TransportParams());
    await observer.onPushFrame(
      new FramePushed({
        source: transport,
        destination: transport,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
    const sent = userInputs(send);
    expect(sent.length).toEqual(1);
    return sent[0]!;
  }

  test("test_a_reading_travels_with_its_transcription", async () => {
    const data = await userInputFor(
      new InterimTranscriptionFrame({
        text: "Can you tell me",
        userId: "",
        timestamp: "now",
        perception: READING,
      }),
    );

    expect(data.final).toBe(false);
    // model_dump(include={"perception"})
    expect({ perception: data.modelDump().perception }).toEqual({
      perception: [
        {
          name: "tone",
          labels: [
            { label: "frustrated", confidence: 0.86 },
            { label: "neutral", confidence: 0.1 },
          ],
          value: null,
        },
        { name: "speech_rate", labels: [], value: 4.1 },
      ],
    });
  });

  test("test_a_transcription_without_a_reading_has_no_perception", async () => {
    const data = await userInputFor(
      new TranscriptionFrame({ text: "Where's my order?", userId: "", timestamp: "now" }),
    );

    expect(data.perception).toBeNull();
  });
});

/** A transcription waits for a perceiver after the STT, such as PipecatToneReader. */
describe("TestRTVIObserverPerceptionAfterTheSTT", () => {
  let observer: RTVIObserver;
  let send: SendMock;
  let stt: FrameProcessor;
  let reader: FrameProcessor;
  let aggregator: FrameProcessor;

  beforeEach(() => {
    ({ observer, send } = mockedObserver());
    stt = new FrameProcessor({ name: "stt" });
    reader = new FrameProcessor({ name: "reader" });
    aggregator = new FrameProcessor({ name: "aggregator" });
  });

  async function push(
    frame: Frame,
    source: FrameProcessor,
    destination: FrameProcessor,
    options: { firstPush: boolean },
  ): Promise<void> {
    await observer.onPushFrame(
      new FramePushed({
        source,
        destination,
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
        firstPush: options.firstPush,
      }),
    );
  }

  async function announceReader(): Promise<void> {
    const metadata = new PerceptionMetadataFrame({
      serviceName: "reader",
      perception: new PerceptionCapabilities(),
    });
    await push(metadata, reader, aggregator, { firstPush: true });
    // Passed along, it doesn't make the next processor a perceiver.
    await push(metadata, aggregator, stt, { firstPush: false });
  }

  test("test_a_transcription_is_reported_once_read", async () => {
    await announceReader();
    const frame = new TranscriptionFrame({
      text: "Oh great, it's late.",
      userId: "",
      timestamp: "now",
    });

    await push(frame, stt, reader, { firstPush: true });
    expect(userInputs(send)).toEqual([]);

    frame.perception = READING;
    await push(frame, reader, aggregator, { firstPush: false });
    await push(frame, aggregator, stt, { firstPush: false });

    const inputs = userInputs(send);
    expect(inputs.length).toEqual(1);
    const data = inputs[0]!;
    expect(data.text).toEqual("Oh great, it's late.");
    expect((data.perception ?? []).map((signal) => signal.name)).toEqual(["tone", "speech_rate"]);
  });

  test("test_without_a_perceiver_a_transcription_is_reported_when_first_pushed", async () => {
    const frame = new TranscriptionFrame({
      text: "Where's my order?",
      userId: "",
      timestamp: "now",
    });

    await push(frame, stt, reader, { firstPush: true });
    await push(frame, reader, aggregator, { firstPush: false });

    expect(userInputs(send).length).toEqual(1);
  });
});
