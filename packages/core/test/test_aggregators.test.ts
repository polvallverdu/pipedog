// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_aggregators.py

import { describe, expect, test } from "bun:test";

import {
  type Frame,
  ImageRawFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  OutputAudioRawFrame,
  OutputImageRawFrame,
  TextFrame,
} from "../src/frames/frames.ts";
import { GatedAggregator } from "../src/processors/aggregators/gated.ts";
import { SentenceAggregator } from "../src/processors/aggregators/sentence.ts";
import { runTest } from "../src/tests/utils.ts";

const encoder = new TextEncoder();

describe("TestSentenceAggregator", () => {
  test("test_sentence_aggregator", async () => {
    const aggregator = new SentenceAggregator();

    const sentence = "Hello, world. How are you? I am fine!";

    const framesToSend: Frame[] = [];
    for (const word of sentence.split(" ")) {
      framesToSend.push(new TextFrame({ text: `${word} ` }));
    }

    const expectedDownFrames = [TextFrame, TextFrame, TextFrame];

    const [receivedDown] = await runTest(aggregator, {
      framesToSend,
      expectedDownFrames,
    });
    expect((receivedDown.at(-3) as TextFrame).text).toEqual("Hello, world. ");
    expect((receivedDown.at(-2) as TextFrame).text).toEqual("How are you? ");
    expect((receivedDown.at(-1) as TextFrame).text).toEqual("I am fine! ");
  });
});

describe("TestGatedAggregator", () => {
  test("test_gated_aggregator", async () => {
    const gatedAggregator = new GatedAggregator(
      (frame) => frame instanceof ImageRawFrame,
      (frame) => frame instanceof LLMFullResponseStartFrame,
      false,
    );

    const framesToSend: Frame[] = [
      new LLMFullResponseStartFrame(),
      new TextFrame({ text: "Hello, " }),
      new TextFrame({ text: "world." }),
      new OutputAudioRawFrame({
        audio: encoder.encode("hello"),
        sampleRate: 16000,
        numChannels: 1,
      }),
      new OutputImageRawFrame({ image: encoder.encode("image"), size: [0, 0], format: "RGB" }),
      new OutputAudioRawFrame({
        audio: encoder.encode("world"),
        sampleRate: 16000,
        numChannels: 1,
      }),
      new LLMFullResponseEndFrame(),
    ];

    const expectedDownFrames = [
      OutputImageRawFrame,
      LLMFullResponseStartFrame,
      TextFrame,
      TextFrame,
      OutputAudioRawFrame,
      OutputAudioRawFrame,
      LLMFullResponseEndFrame,
    ];

    await runTest(gatedAggregator, {
      framesToSend,
      expectedDownFrames,
    });
  });
});
