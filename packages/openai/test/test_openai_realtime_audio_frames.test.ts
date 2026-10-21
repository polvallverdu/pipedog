// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_realtime_audio_frames.py

/**
 * Tests for audio frame emission in OpenAIRealtimeLLMService.
 *
 * These tests drive the service's receive task handler with scripted Realtime
 * API server events and assert on the frames pushed downstream. They cover
 * single-item responses (the common case) and multi-item responses (the
 * `gpt-realtime-2` pattern), in both overlapping and non-overlapping
 * orderings of `response.output_audio.done` events.
 */

import { expect, test } from "bun:test";
import type { Frame } from "@pipedog/core/frames/frames";
import { TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { bytesToBase64 } from "@pipedog/core/utils/base64";

import * as events from "../src/realtime/events.ts";
import { OpenAIRealtimeLLMService } from "../src/realtime/llm.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** The protected members these tests reach into, as upstream does. */
interface Internals {
  pushFrame: (frame: Frame, direction?: FrameDirection) => Promise<void>;
  sendClientEvent: (event: events.ClientEvent) => Promise<void>;
  _websocket: unknown;
  _currentAudioResponse: { itemId: string } | null;
  _receiveTaskHandler(): Promise<void>;
  _truncateCurrentAudioResponse(): Promise<void>;
}

/** Construct a service with no real connection. The constructor does no I/O. */
function _makeService(): Internals {
  return new OpenAIRealtimeLLMService({ apiKey: "test-key" }) as unknown as Internals;
}

/** Minimal async-iterable websocket that yields scripted JSON strings. */
class _FakeWebSocket {
  #messages: string[];

  constructor(messages: string[]) {
    this.#messages = [...messages];
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        if (this.#messages.length === 0) {
          return { done: true, value: undefined };
        }
        return { done: false, value: this.#messages.shift()! };
      },
    };
  }
}

/** Build a `response.output_audio.delta` event dict. */
function _audioDelta(options: {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex?: number;
  audioBytes?: Uint8Array;
}): Record<string, unknown> {
  const audioBytes = options.audioBytes ?? new Uint8Array(480);
  return {
    type: "response.output_audio.delta",
    event_id: `evt_delta_${options.itemId}_${audioBytes.length}`,
    response_id: options.responseId,
    item_id: options.itemId,
    output_index: options.outputIndex,
    content_index: options.contentIndex ?? 0,
    delta: bytesToBase64(audioBytes),
  };
}

/** Build a `response.output_audio.done` event dict. */
function _audioDone(options: {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex?: number;
}): Record<string, unknown> {
  return {
    type: "response.output_audio.done",
    event_id: `evt_done_${options.itemId}`,
    response_id: options.responseId,
    item_id: options.itemId,
    output_index: options.outputIndex,
    content_index: options.contentIndex ?? 0,
  };
}

/** Build a `response.done` event dict with minimal valid usage stats. */
function _responseDone(options: { responseId: string }): Record<string, unknown> {
  return {
    type: "response.done",
    event_id: `evt_response_done_${options.responseId}`,
    response: {
      id: options.responseId,
      object: "realtime.response",
      status: "completed",
      status_details: null,
      output: [],
      usage: {
        total_tokens: 10,
        input_tokens: 5,
        output_tokens: 5,
        input_token_details: {
          cached_tokens: 0,
          text_tokens: 5,
          audio_tokens: 0,
        },
        output_token_details: {
          text_tokens: 5,
          audio_tokens: 0,
        },
      },
    },
  };
}

/** Records frames passed to a service's `pushFrame`. */
class _FrameRecorder {
  frames: Frame[] = [];

  readonly call = async (
    frame: Frame,
    _direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> => {
    this.frames.push(frame);
  };

  ofTypes(...types: Array<abstract new (...args: any[]) => Frame>): Frame[] {
    return this.frames.filter((f) => types.some((t) => f instanceof t));
  }
}

/** Records outgoing client events sent via `sendClientEvent`. */
class _EventRecorder {
  events: events.ClientEvent[] = [];

  readonly call = async (event: events.ClientEvent): Promise<void> => {
    this.events.push(event);
  };
}

/** Feed scripted server-event dicts through the receive handler. */
async function _drive(service: Internals, scripted: Record<string, unknown>[]): Promise<void> {
  service._websocket = new _FakeWebSocket(scripted.map((e) => JSON.stringify(e)));
  await service._receiveTaskHandler();
}

// ---------------------------------------------------------------------------
// Single-item happy path (regression guard — passes today, must keep passing)
// ---------------------------------------------------------------------------

test("test_single_item_response_unchanged", async () => {
  // A 1-item response emits exactly one Started/Stopped pair around audio.
  const service = _makeService();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  const responseId = "resp_single";
  const itemA = "item_A";

  const scripted = [
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDone({ responseId, itemId: itemA, outputIndex: 0 }),
    _responseDone({ responseId }),
  ];
  await _drive(service, scripted);

  const started = recorder.ofTypes(TTSStartedFrame);
  const stopped = recorder.ofTypes(TTSStoppedFrame);
  const audio = recorder.ofTypes(TTSAudioRawFrame);

  expect(started.length).toBe(1); // single-item should push exactly one TTSStartedFrame
  expect(stopped.length).toBe(1); // single-item should push exactly one TTSStoppedFrame
  expect(audio.length).toBe(2); // should push one TTSAudioRawFrame per delta

  // Started precedes all audio; Stopped follows all audio.
  const startedIdx = recorder.frames.indexOf(started[0]!);
  const stoppedIdx = recorder.frames.indexOf(stopped[0]!);
  expect(
    audio.every(
      (f) => startedIdx < recorder.frames.indexOf(f) && recorder.frames.indexOf(f) < stoppedIdx,
    ),
  ).toBe(true);

  // Tracking points at the single item.
  expect(service._currentAudioResponse).not.toBeNull();
  expect(service._currentAudioResponse!.itemId).toBe(itemA);
});

// ---------------------------------------------------------------------------
// Single-item interrupt (regression guard — passes today, must keep passing)
// ---------------------------------------------------------------------------

test("test_interrupt_during_single_item_truncates_against_that_item", async () => {
  // Interrupting mid-stream sends a truncate event for the active item.
  const service = _makeService();
  service.pushFrame = new _FrameRecorder().call;
  const sent = new _EventRecorder();
  service.sendClientEvent = sent.call;

  const responseId = "resp_single_interrupt";
  const itemA = "item_A";

  const scripted = [
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
  ];
  await _drive(service, scripted);

  // Simulate interrupt mid-stream (before audio.done / response.done).
  await service._truncateCurrentAudioResponse();

  const truncates = sent.events.filter(
    (e) => e instanceof events.ConversationItemTruncateEvent,
  ) as events.ConversationItemTruncateEvent[];
  expect(truncates.length).toBe(1); // interrupt should send exactly one truncate event
  expect(truncates[0]!.itemId).toBe(itemA);
  expect(truncates[0]!.contentIndex).toBe(0);
  expect(truncates[0]!.audioEndMs).toBeGreaterThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// Multi-item: overlapping audio.done (matches gpt-realtime-2 reproductions)
// ---------------------------------------------------------------------------

test("test_multi_item_response_overlapping_emits_single_tts_turn", async () => {
  // Both audio.done events arrive after item B has started — one TTS pair.
  const service = _makeService();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  const responseId = "resp_multi_overlap";
  const itemA = "item_A";
  const itemB = "item_B";

  const scripted = [
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    // item B begins before item A's audio.done arrives
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
    _audioDone({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDone({ responseId, itemId: itemB, outputIndex: 1 }),
    _responseDone({ responseId }),
  ];
  await _drive(service, scripted);

  const started = recorder.ofTypes(TTSStartedFrame);
  const stopped = recorder.ofTypes(TTSStoppedFrame);
  const audio = recorder.ofTypes(TTSAudioRawFrame);

  expect(started.length).toBe(1); // multi-item turn should emit exactly one TTSStartedFrame
  expect(stopped.length).toBe(1); // multi-item turn should emit exactly one TTSStoppedFrame
  expect(audio.length).toBe(4); // all four audio deltas should be forwarded in order

  // Stopped is pushed on response.done — after both audio.done events.
  const lastAudioDoneIdx = Math.max(
    ...recorder.frames.flatMap((f, i) => (f instanceof TTSAudioRawFrame ? [i] : [])),
  );
  const stoppedIdx = recorder.frames.indexOf(stopped[0]!);
  // TTSStoppedFrame should be pushed at response.done, after all audio frames
  expect(stoppedIdx).toBeGreaterThan(lastAudioDoneIdx);

  // All audio frames fall strictly between the bracketing pair.
  const startedIdx = recorder.frames.indexOf(started[0]!);
  expect(
    audio.every(
      (f) => startedIdx < recorder.frames.indexOf(f) && recorder.frames.indexOf(f) < stoppedIdx,
    ),
  ).toBe(true);

  // Last-item-wins truncation tracking.
  expect(service._currentAudioResponse).not.toBeNull();
  expect(service._currentAudioResponse!.itemId).toBe(itemB);
});

// ---------------------------------------------------------------------------
// Multi-item: non-overlapping audio.done (theoretical future-proofing)
// ---------------------------------------------------------------------------

test("test_multi_item_response_non_overlapping_emits_single_tts_turn", async () => {
  // audio.done A arrives before item B begins — still one TTS pair.
  const service = _makeService();
  const recorder = new _FrameRecorder();
  service.pushFrame = recorder.call;

  const responseId = "resp_multi_seq";
  const itemA = "item_A";
  const itemB = "item_B";

  const scripted = [
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDone({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
    _audioDone({ responseId, itemId: itemB, outputIndex: 1 }),
    _responseDone({ responseId }),
  ];
  await _drive(service, scripted);

  const started = recorder.ofTypes(TTSStartedFrame);
  const stopped = recorder.ofTypes(TTSStoppedFrame);
  const audio = recorder.ofTypes(TTSAudioRawFrame);

  expect(started.length).toBe(1); // even with non-overlapping done events, only one Started
  expect(stopped.length).toBe(1); // even with non-overlapping done events, only one Stopped
  expect(audio.length).toBe(4);

  const startedIdx = recorder.frames.indexOf(started[0]!);
  const stoppedIdx = recorder.frames.indexOf(stopped[0]!);
  expect(
    audio.every(
      (f) => startedIdx < recorder.frames.indexOf(f) && recorder.frames.indexOf(f) < stoppedIdx,
    ),
  ).toBe(true);

  expect(service._currentAudioResponse).not.toBeNull();
  expect(service._currentAudioResponse!.itemId).toBe(itemB);
});

// ---------------------------------------------------------------------------
// Multi-item interrupt: truncates against the active (latest) item
// ---------------------------------------------------------------------------

test("test_interrupt_during_second_item_truncates_against_second_item", async () => {
  // Interrupt during item B's audio sends truncate for item B (last-item-wins).
  const service = _makeService();
  service.pushFrame = new _FrameRecorder().call;
  const sent = new _EventRecorder();
  service.sendClientEvent = sent.call;

  const responseId = "resp_multi_interrupt";
  const itemA = "item_A";
  const itemB = "item_B";

  const scripted = [
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemA, outputIndex: 0 }),
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
    _audioDelta({ responseId, itemId: itemB, outputIndex: 1 }),
  ];
  await _drive(service, scripted);

  await service._truncateCurrentAudioResponse();

  const truncates = sent.events.filter(
    (e) => e instanceof events.ConversationItemTruncateEvent,
  ) as events.ConversationItemTruncateEvent[];
  expect(truncates.length).toBe(1);
  expect(truncates[0]!.itemId).toBe(itemB); // must truncate the active (latest) item
  expect(truncates[0]!.contentIndex).toBe(0);
});
