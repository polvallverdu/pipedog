// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_client_serializer.py

/** Tests for `RTVIClientSerializer`. */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  FunctionCallInProgressFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMTextFrame,
  OutputAudioRawFrame,
  OutputTransportMessageFrame,
  TranscriptionFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import { RTVIClientSerializer } from "../src/rtvi_client.ts";

function _server(msgType: string, data: Record<string, unknown> | null = null): string {
  return JSON.stringify({ label: RTVI.MESSAGE_LABEL, type: msgType, data });
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

describe("TestRTVIClientDeserialize", () => {
  let s: RTVIClientSerializer;

  beforeEach(() => {
    s = new RTVIClientSerializer();
  });

  test("test_llm_lifecycle", async () => {
    expect(await s.deserialize(_server("bot-llm-started"))).toBeInstanceOf(
      LLMFullResponseStartFrame,
    );
    const frame = (await s.deserialize(_server("bot-llm-text", { text: "Paris" }))) as LLMTextFrame;
    expect(frame).toBeInstanceOf(LLMTextFrame);
    expect(frame.text).toEqual("Paris");
    expect(await s.deserialize(_server("bot-llm-stopped"))).toBeInstanceOf(LLMFullResponseEndFrame);
  });

  test("test_llm_marker", async () => {
    let frame = (await s.deserialize(
      _server("bot-llm-marker", {
        text: "◐",
        kind: "short",
        raw: "◐ wait",
        markers: ["●", "◐", "○"],
      }),
    )) as LLMMarkerResponseFrame;
    expect(frame).toBeInstanceOf(LLMMarkerResponseFrame);
    expect([frame.marker, frame.kind, frame.raw]).toEqual(["◐", "short", "◐ wait"]);
    expect(frame.markers).toEqual(["●", "◐", "○"]);
    // A response that carried no marker reports an empty text.
    frame = (await s.deserialize(
      _server("bot-llm-marker", { text: "", raw: "Hi" }),
    )) as LLMMarkerResponseFrame;
    expect([frame.marker, frame.kind, frame.raw]).toEqual([null, null, "Hi"]);
  });

  test("test_tts_text", async () => {
    const frame = (await s.deserialize(
      _server("bot-tts-text", { text: "Hello there!" }),
    )) as TTSTextFrame;
    expect(frame).toBeInstanceOf(TTSTextFrame);
    expect(frame.text).toEqual("Hello there!");
  });

  test("test_speaking_and_interruption", async () => {
    expect(await s.deserialize(_server("bot-started-speaking"))).toBeInstanceOf(
      BotStartedSpeakingFrame,
    );
    expect(await s.deserialize(_server("bot-stopped-speaking"))).toBeInstanceOf(
      BotStoppedSpeakingFrame,
    );
    expect(await s.deserialize(_server("bot-interrupted"))).toBeInstanceOf(InterruptionFrame);
  });

  test("test_user_transcription_final_vs_interim", async () => {
    const final = (await s.deserialize(
      _server("user-transcription", { text: "hello", user_id: "u", timestamp: "t", final: true }),
    )) as TranscriptionFrame;
    expect(final).toBeInstanceOf(TranscriptionFrame);
    expect(final.text).toEqual("hello");
    expect(final.userId).toEqual("u");

    const interim = (await s.deserialize(
      _server("user-transcription", { text: "hel", final: false }),
    )) as InterimTranscriptionFrame;
    expect(interim).toBeInstanceOf(InterimTranscriptionFrame);
    expect(interim.text).toEqual("hel");
  });

  test("test_function_call", async () => {
    const frame = (await s.deserialize(
      _server("llm-function-call-in-progress", {
        function_name: "get_weather",
        tool_call_id: "c1",
        arguments: { city: "Paris" },
      }),
    )) as FunctionCallInProgressFrame;
    expect(frame).toBeInstanceOf(FunctionCallInProgressFrame);
    expect(frame.functionName).toEqual("get_weather");
    expect(frame.arguments).toEqual({ city: "Paris" });
  });

  test("test_unknown_and_non_rtvi_dropped", async () => {
    expect(await s.deserialize(_server("bot-ready", { version: "2.0.0" }))).toBeNull();
    expect(await s.deserialize(_server("metrics", {}))).toBeNull();
    expect(await s.deserialize(JSON.stringify({ type: "bot-llm-text" }))).toBeNull(); // no label
    expect(await s.deserialize("not json")).toBeNull();
  });
});

describe("TestRTVIClientSerialize", () => {
  let s: RTVIClientSerializer;

  beforeEach(() => {
    s = new RTVIClientSerializer();
  });

  test("test_output_audio_becomes_raw_audio", async () => {
    const frame = new OutputAudioRawFrame({
      audio: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      sampleRate: 16000,
      numChannels: 1,
    });
    const out = JSON.parse((await s.serialize(frame)) as string);
    expect(out.label).toEqual(RTVI.MESSAGE_LABEL);
    expect(out.type).toEqual("raw-audio");
    expect(out.data.sampleRate).toEqual(16000);
    expect(out.data.numChannels).toEqual(1);
    expect(b64decode(out.data.base64Audio)).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });

  test("test_client_message_passthrough", async () => {
    const msg = {
      label: RTVI.MESSAGE_LABEL,
      type: "send-text",
      id: "1",
      data: { content: "hi", options: { run_immediately: true } },
    };
    const out = JSON.parse(
      (await s.serialize(new OutputTransportMessageFrame({ message: msg }))) as string,
    );
    expect(out).toEqual(msg);
  });

  test("test_non_rtvi_transport_message_dropped", async () => {
    const out = await s.serialize(new OutputTransportMessageFrame({ message: { foo: "bar" } }));
    expect(out).toBeNull();
  });
});
