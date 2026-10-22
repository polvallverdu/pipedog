// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_smallest_tts.py

/**
 * Tests for SmallestTTSService word-timestamp and continuation handling.
 *
 * Porting notes:
 * - `pytest.approx` → `toBeCloseTo`.
 * - `_build_msg(text, context_id=..., continue_transcript=...)` →
 *   `_buildMsg(text, { contextId, continueTranscript })`.
 * - Fake websockets are duck-typed objects with `state`, `send`, `close` and
 *   `[Symbol.asyncIterator]`, assigned to `_websocket` / returned by an
 *   overridden `_websocketConnect`.
 */

import { expect, test } from "bun:test";
import { Queue } from "@pipedog/asyncio";
import { TTSAudioRawFrame, TTSSpeakFrame, TTSTextFrame } from "@pipedog/core/frames/frames";
import { State } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { SmallestTTSService } from "../src/tts.ts";

const CTX = "ctx-1";

function wordMsg(word: string, start: number, end: number, requestId: string, wordId = 0): string {
  return JSON.stringify({
    request_id: requestId,
    status: "word_timestamp",
    data: { id: wordId, word, start, end },
  });
}

function makeService(): SmallestTTSService {
  return new SmallestTTSService({ apiKey: "test-key" });
}

test("test_word_timestamps_enabled_by_default", () => {
  // Word timestamps are on by default and drive text-frame emission.
  const service: any = new SmallestTTSService({ apiKey: "test-key" });
  expect(service._wordTimestamps).toBe(true);
  // Word events produce the TTSTextFrames, so the base must not push whole text.
  expect(service._pushTextFrames).toBe(false);
  expect(service._buildMsg("hi").word_timestamps).toBe(true);
});

test("test_word_timestamps_disabled_pushes_whole_text", () => {
  // Disabling word timestamps flips the service back to whole-text frames.
  const service: any = new SmallestTTSService({ apiKey: "test-key", wordTimestamps: false });
  expect(service._wordTimestamps).toBe(false);
  expect(service._pushTextFrames).toBe(true);
  expect("word_timestamps" in service._buildMsg("hi")).toBe(false);
});

test("test_build_msg_defaults_to_continuing_context", () => {
  // Without an explicit override, a fragment continues its context.
  const msg = makeService()._buildMsg("hi", { contextId: CTX });
  expect(msg.context_id).toBe(CTX);
  expect(msg.continue).toBe(true);
});

test("test_build_msg_can_close_context", () => {
  // `continueTranscript: false` marks the fragment as the last one.
  const msg = makeService()._buildMsg("hi", { contextId: CTX, continueTranscript: false });
  expect(msg.continue).toBe(false);
});

test("test_build_msg_omits_buffer_delay_by_default", () => {
  // The server's own default buffering window applies unless overridden.
  expect("max_buffer_delay_ms" in makeService()._buildMsg("hi")).toBe(false);
});

test("test_build_msg_includes_buffer_delay_when_set", () => {
  const service = new SmallestTTSService({ apiKey: "test-key", maxBufferDelayMs: 1500 });
  expect(service._buildMsg("hi").max_buffer_delay_ms).toBe(1500);
});

test("test_build_msg_omits_content_filter_by_default", () => {
  // The server's own default (filter off) applies unless an action is set.
  expect("content_filter" in makeService()._buildMsg("hi")).toBe(false);
});

for (const action of ["reject", "flag"]) {
  test(`test_build_msg_enables_content_filter_with_action[${action}]`, () => {
    const service = new SmallestTTSService({
      apiKey: "test-key",
      settings: new SmallestTTSService.Settings({ contentFilter: action }),
    });
    expect(service._buildMsg("hi").content_filter).toEqual({ enabled: true, action });
  });
}

test("test_flush_audio_closes_the_active_context", async () => {
  // flushAudio sends an empty, `continue: false` fragment for the context.
  const service: any = makeService();

  const sent: any[] = [];
  service._websocket = {
    state: null, // unused by flushAudio
    async send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
  service.getActiveAudioContextId = () => CTX;

  await service.flushAudio();

  expect(sent).toHaveLength(1);
  expect(sent[0].context_id).toBe(CTX);
  expect(sent[0].continue).toBe(false);
  expect(sent[0].text).toBe("");
});

test("test_flush_audio_is_a_noop_without_a_connection", async () => {
  // No message is sent if the websocket isn't connected.
  const service: any = makeService();
  service._websocket = null;
  service.getActiveAudioContextId = () => CTX;

  // Should not raise even though there's nowhere to send.
  await service.flushAudio();
});

/** Run `_receiveMessages` over a scripted stream, capturing word timestamps. */
async function drive(service: any, messages: string[]): Promise<[string, number][]> {
  const captured: [string, number][] = [];

  const noop = async () => {};

  async function* fakeWs() {
    for (const message of messages) {
      yield message;
    }
  }

  service.addWordTimestamps = async (wordTimes: [string, number][]) => {
    captured.push(...wordTimes);
  };
  service.appendToAudioContext = noop;
  service.stopTtfbMetrics = noop;
  service.stopAllMetrics = noop;
  service.getActiveAudioContextId = () => CTX;
  service._getWebsocket = fakeWs;

  await service._receiveMessages();
  return captured;
}

function expectWords(captured: [string, number][], expected: [string, number][]): void {
  expect(captured).toHaveLength(expected.length);
  expected.forEach(([word, start], i) => {
    expect(captured[i]![0]).toBe(word);
    expect(captured[i]![1]).toBeCloseTo(start);
  });
}

test("test_word_timestamps_offset_across_requests", async () => {
  // Later requests in a turn are shifted onto the turn's playback timeline.
  //
  // Smallest reports per-request timestamps that reset to ~0 each request and
  // only emits one `complete` for the whole turn, so the request boundary is
  // detected by a change in `request_id`. The second request's words must be
  // offset by the prior request's last-word `end`.
  const service = makeService();

  // Request A (id "a"): word at 0.2s, ending at 0.5s.
  // Request B (id "b", same turn): word at 0.1s -> 0.1 + 0.5 = 0.6s.
  const messages = [wordMsg("Hello", 0.2, 0.5, "a"), wordMsg("World", 0.1, 0.4, "b")];
  const captured = await drive(service, messages);

  expectWords(captured, [
    ["Hello", 0.2],
    ["World", 0.6],
  ]);
});

test("test_offset_accumulates_across_multiple_requests", async () => {
  // The offset compounds across three sequential requests in one turn.
  const service = makeService();

  const messages = [
    wordMsg("one", 0.0, 1.0, "a"),
    wordMsg("two", 0.0, 2.0, "b"), // offset by 1.0
    wordMsg("three", 0.5, 1.0, "c"), // offset by 1.0 + 2.0
  ];
  const captured = await drive(service, messages);

  expectWords(captured, [
    ["one", 0.0],
    ["two", 1.0],
    ["three", 3.5],
  ]);
});

test("test_multiple_words_in_one_request_share_offset", async () => {
  // All words within a request use the same offset; only `end` grows.
  const service = makeService();

  const messages = [
    wordMsg("a", 0.0, 0.4, "r1", 0),
    wordMsg("b", 0.4, 0.9, "r1", 1),
    wordMsg("c", 0.1, 0.5, "r2", 0), // offset by 0.9
  ];
  const captured = await drive(service, messages);

  expectWords(captured, [
    ["a", 0.0],
    ["b", 0.4],
    ["c", 1.0],
  ]);
});

test("test_word_timestamp_offset_resets_on_new_turn", async () => {
  // onTurnContextCreated (a new LLM turn) clears the accumulated offset.
  const service: any = makeService();

  // First turn: two requests, so the offset accumulates to 0.5.
  await drive(service, [wordMsg("Hello", 0.2, 0.5, "a"), wordMsg("World", 0.1, 0.4, "b")]);
  expect(service._cumulativeTime).toBeCloseTo(0.5);

  // A new turn resets the timeline.
  await service.onTurnContextCreated("ctx-2");
  expect(service._cumulativeTime).toBe(0.0);
  expect(service._wtRequestId).toBeNull();

  const captured = await drive(service, [wordMsg("Fresh", 0.3, 0.6, "c")]);
  expectWords(captured, [["Fresh", 0.3]]);
});

/** Answers each text fragment with audio and the timestamp of its first word. */
class FakeSpeakingWebsocket {
  state: State = State.OPEN;
  readonly #messages = new Queue<string>();

  async send(data: string): Promise<void> {
    const text: string = JSON.parse(data).text;
    if (text.trim()) {
      const audio = btoa(String.fromCharCode(...new Array(1600).fill([0, 1]).flat()));
      this.#messages.putNowait(JSON.stringify({ status: "chunk", data: { audio } }));
      this.#messages.putNowait(wordMsg(text.split(/\s+/)[0]!, 0.0, 0.1, "r1"));
    }
  }

  async close(): Promise<void> {}

  [Symbol.asyncIterator]() {
    return {
      next: async () => ({ value: await this.#messages.get(), done: false as const }),
    };
  }
}

test("test_speaks_with_word_timestamps", async () => {
  // Spoken text produces audio and a word frame for each timed word.
  const service: any = new SmallestTTSService({
    apiKey: "test-key",
    sampleRate: 16000,
    stopFrameTimeoutS: 0.2,
  });
  const websocket = new FakeSpeakingWebsocket();

  service._websocketConnect = async () => websocket;
  const [down] = await runTest(service, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello." }), new SleepFrame({ sleep: 0.4 })],
  });
  expect(down.some((f) => f instanceof TTSAudioRawFrame)).toBe(true);
  expect(
    down.filter((f) => f instanceof TTSTextFrame).map((f) => (f as TTSTextFrame).text),
  ).toEqual(["Hello."]);
});
