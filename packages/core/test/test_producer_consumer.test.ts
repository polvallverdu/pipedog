// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_producer_consumer.py

import { describe, test } from "bun:test";

import { type Frame, InputAudioRawFrame, TextFrame } from "../src/frames/frames.ts";
import { ParallelPipeline } from "../src/pipeline/parallel_pipeline.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { ConsumerProcessor } from "../src/processors/consumer_processor.ts";
import { ProducerProcessor } from "../src/processors/producer_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

async function textFrameFilter(frame: Frame): Promise<boolean> {
  return frame instanceof TextFrame;
}

describe("TestProducerConsumerProcessor", () => {
  test("test_produce_passthrough", async () => {
    const producer = new ProducerProcessor({ filter: textFrameFilter });
    const consumer = new ConsumerProcessor({ producer });
    const pipeline = new Pipeline([producer, consumer]);
    const framesToSend = [
      new TextFrame({ text: "Hello!" }),
      new SleepFrame(), // So we let the consumer go first.
    ];
    const expectedDownFrames = [
      TextFrame, // Consumer frame
      TextFrame, // Pass-through frame
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_produce_no_passthrough", async () => {
    const producer = new ProducerProcessor({ filter: textFrameFilter, passthrough: false });
    const consumer = new ConsumerProcessor({ producer });
    const pipeline = new Pipeline([producer, consumer]);
    const framesToSend = [new TextFrame({ text: "Hello!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_produce_multiple_consumer_no_passthrough", async () => {
    const producer = new ProducerProcessor({ filter: textFrameFilter, passthrough: false });
    const consumer1 = new ConsumerProcessor({ producer });
    const consumer2 = new ConsumerProcessor({ producer });
    const pipeline = new Pipeline([producer, consumer1, consumer2]);
    const framesToSend = [new TextFrame({ text: "Hello!" })];
    const expectedDownFrames = [
      TextFrame, // From consumer1 or consumer2 (depending on who runs first)
      TextFrame, // From consumer1 or consumer2 (depending on who runs first)
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_produce_parallel_pipeline_no_passthrough", async () => {
    const producer = new ProducerProcessor({ filter: textFrameFilter, passthrough: false });
    const consumer = new ConsumerProcessor({ producer });
    const pipeline = new Pipeline([new ParallelPipeline([producer], [consumer])]);
    const framesToSend = [new TextFrame({ text: "Hello!" })];
    const expectedDownFrames = [TextFrame];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_produce_passthrough_transform", async () => {
    async function audioTransformer(_: Frame): Promise<Frame> {
      return new InputAudioRawFrame({
        audio: new Uint8Array(0),
        sampleRate: 16000,
        numChannels: 1,
      });
    }

    const producer = new ProducerProcessor({
      filter: textFrameFilter,
      transformer: audioTransformer,
    });
    const consumer = new ConsumerProcessor({ producer });
    const pipeline = new Pipeline([producer, consumer]);
    const framesToSend = [
      new TextFrame({ text: "Hello!" }),
      new SleepFrame(), // So we let the consumer go first.
    ];
    const expectedDownFrames = [
      InputAudioRawFrame, // Consumer frame
      TextFrame, // Pass-through frame
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });

  test("test_produce_passthrough_consumer_transform", async () => {
    async function audioTransformer(_: Frame): Promise<Frame> {
      return new InputAudioRawFrame({
        audio: new Uint8Array(0),
        sampleRate: 16000,
        numChannels: 1,
      });
    }

    const producer = new ProducerProcessor({ filter: textFrameFilter });
    const consumer = new ConsumerProcessor({ producer, transformer: audioTransformer });
    const pipeline = new Pipeline([producer, consumer]);
    const framesToSend = [
      new TextFrame({ text: "Hello!" }),
      new SleepFrame(), // So we let the consumer go first.
    ];
    const expectedDownFrames = [
      InputAudioRawFrame, // Consumer frame
      TextFrame, // Pass-through frame
    ];
    await runTest(pipeline, { framesToSend, expectedDownFrames });
  });
});
