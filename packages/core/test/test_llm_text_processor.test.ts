// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_text_processor.py

/** Tests for `LLMTextProcessor`. */

import { expect, mock, test } from "bun:test";

import {
  AggregatedTextFrame,
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  type OutputAudioRawFrame,
  type StartFrame,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMTextProcessor } from "../src/processors/aggregators/llm_text_processor.ts";
import * as RTVI from "../src/processors/frameworks/rtvi/models.ts";
import { RTVIObserver, RTVIObserverParams } from "../src/processors/frameworks/rtvi/observer.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import { MatchAction, PatternPairAggregator } from "../src/utils/text/pattern_pair_aggregator.ts";

// Messages are inspected loosely, as upstream does.
type Patchable = any;

async function upper(text: string, _textType: string): Promise<string> {
  return text.toUpperCase();
}

async function drop(_text: string, _textType: string): Promise<string> {
  return "";
}

async function fail(_text: string, _textType: string): Promise<string> {
  throw new Error("boom");
}

function _response(...texts: string[]): Frame[] {
  return [
    new LLMFullResponseStartFrame(),
    ...texts.map((text) => new LLMTextFrame({ text })),
    new LLMFullResponseEndFrame(),
  ];
}

function _aggregated(frames: Frame[]): AggregatedTextFrame[] {
  return frames.filter((f): f is AggregatedTextFrame => f instanceof AggregatedTextFrame);
}

async function _aggregations(
  processor: LLMTextProcessor,
  ...texts: string[]
): Promise<[AggregatedTextFrame[], Frame[]]> {
  const [down, up] = await runTest(processor, { framesToSend: _response(...texts) });
  return [_aggregated(down), up];
}

/** A "*" transform rewrites every aggregation, flushed text included. */
test("test_transform_rewrites_text_and_raw_text", async () => {
  const [plain] = await _aggregations(new LLMTextProcessor(), "Hello there. ", "Bye");
  const [frames] = await _aggregations(
    new LLMTextProcessor({ textTransforms: [["*", upper]] }),
    "Hello there. ",
    "Bye",
  );
  expect(frames.map((f) => f.text)).toEqual(plain.map((f) => f.text.toUpperCase()));
  expect(frames.map((f) => f.rawText)).toEqual(plain.map((f) => f.text.toUpperCase()));
  expect(frames.map((f) => f.textType)).toEqual(plain.map((f) => f.textType));
});

function _codeAggregator(): PatternPairAggregator {
  const aggregator = new PatternPairAggregator();
  aggregator.addPattern("code", "<code>", "</code>", MatchAction.AGGREGATE);
  return aggregator;
}

/** A transform for one type leaves the other types alone and keeps delimiters. */
test("test_transform_applies_to_its_type_only", async () => {
  const text = "Run this <code>print(1)</code> now. ";
  const [plain] = await _aggregations(
    new LLMTextProcessor({ textAggregator: _codeAggregator() }),
    text,
  );
  const [frames] = await _aggregations(
    new LLMTextProcessor({ textAggregator: _codeAggregator(), textTransforms: [["code", upper]] }),
    text,
  );

  const code = frames.filter((f) => f.textType === "code");
  expect(code.length).toEqual(1);
  expect(code[0]!.text).toEqual("PRINT(1)");
  expect(code[0]!.rawText).toEqual("<code>PRINT(1)</code>");
  const others = frames.filter((f) => f.textType !== "code").map((f) => [f.text, f.rawText]);
  expect(others).toEqual(
    plain.filter((f) => f.textType !== "code").map((f) => [f.text, f.rawText]),
  );
  expect(others.length).toEqual(2);
});

test("test_transform_leaving_whitespace_drops_the_aggregation", async () => {
  const [frames] = await _aggregations(
    new LLMTextProcessor({ textTransforms: [["*", drop]] }),
    "Leaked reasoning. ",
  );
  expect(frames).toEqual([]);
});

test("test_failing_transform_drops_the_aggregation_and_reports", async () => {
  const [frames, up] = await _aggregations(
    new LLMTextProcessor({ textTransforms: [["*", fail]] }),
    "Hello there. ",
  );
  expect(frames).toEqual([]);
  const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(errors.length).toEqual(1);
  expect(errors[0]!.error).toContain("boom");
});

test("test_add_and_remove_text_transformer", async () => {
  const processor = new LLMTextProcessor();
  processor.addTextTransformer(upper);
  processor.removeTextTransformer(upper);
  const [frames] = await _aggregations(processor, "Hello there. ");
  expect(frames.map((f) => f.text)).toEqual(["Hello there."]);
});

/** An output transport that takes every audio frame without playing it. */
class _OutputTransport extends BaseOutputTransport {
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    await this.setTransportReady(frame);
  }

  override async writeAudioFrame(_frame: OutputAudioRawFrame): Promise<boolean> {
    return true;
  }
}

function _speech(contextId: string): TTSAudioRawFrame {
  const audio = new Uint8Array(2 * 1600);
  for (let i = 0; i < audio.length; i += 2) {
    audio[i] = 0x10;
    audio[i + 1] = 0x27;
  }
  return new TTSAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1, contextId });
}

/**
 * A speech-to-speech service stops its speech before it ends the response.
 *
 * The last sentence has no following text to close it, so the processor
 * still holds it when the speech stops. It was spoken before the stop and
 * goes out ahead of it.
 */
test("test_held_text_is_pushed_before_tts_stopped", async () => {
  const [downFrames] = await runTest(new LLMTextProcessor(), {
    framesToSend: [
      new LLMTextFrame({ text: "Hello there. " }),
      new LLMTextFrame({ text: "It's provider-agnostic." }),
      new TTSStoppedFrame(),
      new LLMFullResponseEndFrame(),
    ],
    expectedDownFrames: [
      AggregatedTextFrame,
      AggregatedTextFrame,
      TTSStoppedFrame,
      LLMFullResponseEndFrame,
    ],
  });
  expect(_aggregated(downFrames).map((f) => f.text)).toEqual([
    "Hello there.",
    "It's provider-agnostic.",
  ]);
});

/**
 * A reply's last sentence reaches clients before the user speaks again.
 *
 * Text that reaches the output transport after the bot stopped speaking
 * waits for the next speech, and the user's next turn interrupts before
 * that.
 */
test("test_speech_to_speech_reply_ends_with_its_last_sentence", async () => {
  const observer = new RTVIObserver(null, { params: new RTVIObserverParams() });
  const sendRtviMessage = mock(async (_message: Patchable) => {});
  (observer as Patchable).sendRtviMessage = sendRtviMessage;
  const transport = new _OutputTransport(new TransportParams({ audioOutEnabled: true }));

  await runTest(new Pipeline([new LLMTextProcessor(), transport]), {
    framesToSend: [
      new LLMFullResponseStartFrame(),
      new TTSStartedFrame({ contextId: "reply" }),
      _speech("reply"),
      new LLMTextFrame({ text: "Hello there. " }),
      _speech("reply"),
      new LLMTextFrame({ text: "It's provider-agnostic." }),
      new TTSStoppedFrame({ contextId: "reply" }),
      new LLMFullResponseEndFrame(),
      new SleepFrame({ sleep: 0.5 }),
      // The user starts their next turn.
      new InterruptionFrame(),
      new SleepFrame({ sleep: 0.1 }),
    ],
    observers: [observer],
  });

  const sent = sendRtviMessage.mock.calls
    .filter((call) => call[0] instanceof RTVI.BotOutputMessage)
    .map((call) => call[0].data.text);
  expect(sent).toEqual(["Hello there.", "It's provider-agnostic."]);
});
