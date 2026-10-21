// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_realtime_user_audio.py

/**
 * Tests for user-audio streaming in OpenAIRealtimeLLMService.
 *
 * These tests drive the service's audio/turn handlers directly with a fake
 * `sendClientEvent` and assert on the client events emitted to the service.
 * They cover the manual turn-detection (server-VAD-disabled) pre-roll behavior —
 * audio is appended to the input buffer and mirrored into a rolling pre-roll
 * buffer that is replayed after an interruption clears the input buffer — the
 * server-VAD-enabled path, where no pre-roll is maintained, and resampling of
 * pipeline audio to the session's fixed 24 kHz input rate.
 */

import { expect, test } from "bun:test";

import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import { InputAudioRawFrame, SpeechControlParamsFrame } from "@pipedog/core/frames/frames";

import { OPENAI_SAMPLE_RATE } from "../src/_constants.ts";
import * as events from "../src/realtime/events.ts";
import { AudioConfiguration, AudioInput, SessionProperties } from "../src/realtime/events.ts";
import {
  AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS,
  OpenAIRealtimeLLMService,
} from "../src/realtime/llm.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function b64decode(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** Records the client events sent via `sendClientEvent`. */
class _EventRecorder {
  events: unknown[] = [];

  call = async (event: unknown): Promise<void> => {
    this.events.push(event);
  };

  kinds(): string[] {
    return this.events.map((e) => (e as object).constructor.name);
  }

  appendPayloads(): string[] {
    return this.events
      .filter(
        (e): e is events.InputAudioBufferAppendEvent =>
          e instanceof events.InputAudioBufferAppendEvent,
      )
      .map((e) => e.audio);
  }
}

/** The protected members these tests reach into, as upstream does. */
interface Internals {
  _sendUserAudio(frame: InputAudioRawFrame): Promise<void>;
  _handleInterruption(): Promise<void>;
  _handleSpeechControlParams(frame: SpeechControlParamsFrame): void;
  _userAudioPrerollBuffer: Uint8Array;
  sendClientEvent: (event: unknown) => Promise<void>;
  stopAllMetrics: () => Promise<void>;
}

/** Construct a service wired to a fake sendClientEvent. The constructor does no I/O. */
function _makeService(options: {
  manualTurnDetection: boolean;
  prerollSecs?: number | null;
}): [Internals, _EventRecorder] {
  const settings = options.manualTurnDetection
    ? new OpenAIRealtimeLLMService.Settings({
        sessionProperties: new SessionProperties({
          audio: new AudioConfiguration({ input: new AudioInput({ turnDetection: false }) }),
        }),
      })
    : null;

  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings,
    userAudioPrerollSecs: options.prerollSecs ?? null,
  }) as unknown as Internals;

  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;

  // _handleInterruption stops metrics, which needs a started pipeline; stub
  // it out so the handler can run in isolation.
  service.stopAllMetrics = async () => {};
  return [service, recorder];
}

function _audioFrame(options: { sampleRate?: number; data?: Uint8Array } = {}): InputAudioRawFrame {
  return new InputAudioRawFrame({
    audio: options.data ?? repeat([0x01, 0x02], 160),
    sampleRate: options.sampleRate ?? OPENAI_SAMPLE_RATE,
    numChannels: 1,
  });
}

// ---------------------------------------------------------------------------
// Manual turn detection: maintain and replay the pre-roll
// ---------------------------------------------------------------------------

test("test_manual_mode_appends_and_buffers_audio", async () => {
  // Audio is appended to the input buffer and mirrored into the pre-roll buffer.
  const [service, recorder] = _makeService({ manualTurnDetection: true });

  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xaa, 0xbb]) }));
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xcc, 0xdd]) }));

  expect(recorder.kinds()).toEqual(["InputAudioBufferAppendEvent", "InputAudioBufferAppendEvent"]);
  expect(recorder.appendPayloads()).toEqual([
    b64encode(new Uint8Array([0xaa, 0xbb])),
    b64encode(new Uint8Array([0xcc, 0xdd])),
  ]);
  expect(Array.from(service._userAudioPrerollBuffer)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
});

test("test_manual_mode_replays_preroll_after_interruption", async () => {
  // An interruption clears the input buffer, then replays the buffered onset.
  const [service, recorder] = _makeService({ manualTurnDetection: true });

  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xaa, 0xbb]) }));
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xcc, 0xdd]) }));

  await service._handleInterruption();

  // Clear must come before the replay append, and the response cancel after.
  expect(recorder.kinds()).toEqual([
    "InputAudioBufferAppendEvent",
    "InputAudioBufferAppendEvent",
    "InputAudioBufferClearEvent",
    "InputAudioBufferAppendEvent",
    "ResponseCancelEvent",
  ]);
  // The replay re-appends the full buffered onset.
  expect(recorder.appendPayloads().at(-1)).toEqual(
    b64encode(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])),
  );
  // The buffer is left intact (rolling window), so a later interruption can replay again.
  expect(Array.from(service._userAudioPrerollBuffer)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
});

test("test_manual_mode_interruption_with_empty_buffer_skips_replay", async () => {
  // With nothing buffered, the interruption clears and cancels but replays nothing.
  const [service, recorder] = _makeService({ manualTurnDetection: true });

  await service._handleInterruption();

  expect(recorder.kinds()).toEqual(["InputAudioBufferClearEvent", "ResponseCancelEvent"]);
});

test("test_manual_mode_preroll_capped_to_default_window", async () => {
  // Before VAD params are known, the pre-roll keeps DEFAULT_USER_AUDIO_PREROLL_SECS.
  const [service] = _makeService({ manualTurnDetection: true });

  // 1s at 24kHz mono / 16-bit = 48000 bytes; buffer should keep the most
  // recent 0.5s = 24000 bytes.
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array(48000) }));

  expect(service._userAudioPrerollBuffer.length).toEqual(24000);
});

test("test_manual_mode_preroll_sized_from_vad_start_secs", async () => {
  // A SpeechControlParamsFrame sizes the pre-roll to start_secs + margin.
  const [service] = _makeService({ manualTurnDetection: true });

  const startSecs = 0.5;
  service._handleSpeechControlParams(
    new SpeechControlParamsFrame({ vadParams: new VADParams({ startSecs }) }),
  );
  // Send 2s of audio — comfortably more than the window — so the buffer is
  // capped to (start_secs + margin), not limited by how much we sent.
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array(96000) }));

  // 24kHz mono / 16-bit = 2 bytes/sample.
  const expected = Math.trunc(
    24000 * 1 * 2 * (startSecs + AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS),
  );
  expect(service._userAudioPrerollBuffer.length).toEqual(expected);
});

test("test_manual_mode_preroll_override_pins_value_and_ignores_vad_params", async () => {
  // An explicit userAudioPrerollSecs pins the pre-roll; VAD params don't resize it.
  const [service] = _makeService({ manualTurnDetection: true, prerollSecs: 0.1 });

  service._handleSpeechControlParams(
    new SpeechControlParamsFrame({ vadParams: new VADParams({ startSecs: 0.5 }) }),
  );
  // 0.1s at 24kHz mono / 16-bit = 4800 bytes.
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array(48000) }));

  expect(service._userAudioPrerollBuffer.length).toEqual(4800);
});

// ---------------------------------------------------------------------------
// Server-side turn detection: no pre-roll, no clear/replay on interruption
// ---------------------------------------------------------------------------

test("test_server_mode_appends_without_buffering", async () => {
  // With server-side turn detection, audio is appended but no pre-roll is kept.
  const [service, recorder] = _makeService({ manualTurnDetection: false });

  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xaa, 0xbb]) }));
  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xcc, 0xdd]) }));

  expect(recorder.kinds()).toEqual(["InputAudioBufferAppendEvent", "InputAudioBufferAppendEvent"]);
  expect(Array.from(service._userAudioPrerollBuffer)).toEqual([]);
});

test("test_server_mode_interruption_does_not_clear_or_replay", async () => {
  // With server-side turn detection, an interruption doesn't touch the input buffer.
  const [service, recorder] = _makeService({ manualTurnDetection: false });

  await service._sendUserAudio(_audioFrame({ data: new Uint8Array([0xaa, 0xbb]) }));
  await service._handleInterruption();

  expect(recorder.kinds()).not.toContain("InputAudioBufferClearEvent");
  expect(recorder.kinds()).not.toContain("ResponseCancelEvent");
});

// ---------------------------------------------------------------------------
// Resampling to the session's 24 kHz input rate
// ---------------------------------------------------------------------------

/** Send 1s of audio in 20ms frames, the way an input transport delivers it. */
async function _sendOneSecond(service: Internals, sampleRate: number): Promise<void> {
  const frameBytes = Math.floor((sampleRate * 2) / 50);
  for (let i = 0; i < 50; i++) {
    await service._sendUserAudio(
      _audioFrame({ sampleRate, data: repeat([0x01, 0x02], Math.floor(frameBytes / 2)) }),
    );
  }
}

test("test_pipeline_audio_is_resampled_to_24khz", async () => {
  // 16 kHz pipeline audio reaches the input buffer as 24 kHz audio.
  const [service, recorder] = _makeService({ manualTurnDetection: false });

  await _sendOneSecond(service, 16000);

  const sent = recorder.appendPayloads().reduce((n, p) => n + b64decode(p).length, 0);
  // 1s at 24kHz is 48000 bytes, less what the streaming resampler still holds.
  expect(sent).toBeGreaterThanOrEqual(46000);
  expect(sent).toBeLessThanOrEqual(48000);
});

test("test_preroll_holds_resampled_audio", async () => {
  // The pre-roll holds 24 kHz audio, sized at 24 kHz, whatever the pipeline rate.
  const [service] = _makeService({ manualTurnDetection: true });

  await _sendOneSecond(service, 16000);

  // The default 0.5s window at 24kHz mono / 16-bit.
  expect(service._userAudioPrerollBuffer.length).toEqual(24000);
});
