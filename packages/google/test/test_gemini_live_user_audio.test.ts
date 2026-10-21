// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for user-audio streaming in GeminiLiveLLMService.
 *
 * These tests drive the service's audio/turn handlers directly with a fake
 * session and assert on the `sendRealtimeInput` calls made to the service.
 * They cover the server-VAD-disabled activity-window contract (audio is buffered
 * while the user isn't in a turn and the pre-roll is replayed after activityStart)
 * and the server-VAD-enabled path (audio is streamed continuously).
 */

import { expect, test } from "bun:test";
import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import {
  InputAudioRawFrame,
  SpeechControlParamsFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import {
  AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS,
  GeminiLiveLLMService,
  GeminiVADParams,
} from "../src/gemini_live/llm.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

type Call = Record<string, unknown>;

/** Records the payloads passed to `sendRealtimeInput`. */
class _FakeSession {
  calls: Call[] = [];

  sendRealtimeInput(params: Call): void {
    this.calls.push(params);
  }

  sendClientContent(params: Call): void {
    this.calls.push({ clientContent: params });
  }

  close(): void {}

  /** The JS SDK carries audio as base64; decode it back to bytes. */
  audioPayloads(): Uint8Array[] {
    return this.calls
      .filter((c) => "audio" in c)
      .map((c) => new Uint8Array(Buffer.from((c.audio as { data: string }).data, "base64")));
  }

  /** Ordered list of call kinds: 'audio', 'activity_start', 'activity_end'. */
  kinds(): string[] {
    const kinds: string[] = [];
    for (const c of this.calls) {
      if ("audio" in c) {
        kinds.push("audio");
      } else if ("activityStart" in c) {
        kinds.push("activity_start");
      } else if ("activityEnd" in c) {
        kinds.push("activity_end");
      }
    }
    return kinds;
  }
}

// Test access to protected members, as upstream does with `service._session` etc.
type Internals = {
  _session: _FakeSession;
  _readyForRealtimeInput: boolean;
  _userAudioPrerollBuffer: Uint8Array;
  startTtfbMetrics: () => Promise<void>;
  _sendUserAudio(frame: InputAudioRawFrame): Promise<void>;
  _handleUserStartedSpeaking(frame: UserStartedSpeakingFrame): Promise<void>;
  _handleUserStoppedSpeaking(frame: UserStoppedSpeakingFrame): Promise<void>;
  _handleSpeechControlParams(frame: SpeechControlParamsFrame): void;
};

/** Construct a service wired to a fake session. The constructor does no I/O. */
function _makeService(options: { vadDisabled: boolean; prerollSecs?: number | null }): Internals {
  const vad = options.vadDisabled ? new GeminiVADParams({ disabled: true }) : null;
  const service = new GeminiLiveLLMService({
    apiKey: "test-key",
    settings: new GeminiLiveLLMService.Settings({ vad }),
    userAudioPrerollSecs: options.prerollSecs ?? null,
  }) as unknown as Internals;
  service._session = new _FakeSession();
  service._readyForRealtimeInput = true;

  // startTtfbMetrics touches metrics machinery that needs a started
  // pipeline; stub it out so the turn handlers can run in isolation.
  service.startTtfbMetrics = async () => {};
  return service;
}

function _audioFrame(options: { sampleRate?: number; data?: Uint8Array } = {}): InputAudioRawFrame {
  const data = options.data ?? new Uint8Array(320).map((_, i) => (i % 2 === 0 ? 0x01 : 0x02));
  return new InputAudioRawFrame({
    audio: data,
    sampleRate: options.sampleRate ?? 16000,
    numChannels: 1,
  });
}

const b = (...bytes: number[]) => new Uint8Array(bytes);
const totalLen = (payloads: Uint8Array[]) => payloads.reduce((n, p) => n + p.length, 0);

// ---------------------------------------------------------------------------
// Manual-VAD mode: honor the activity-window contract
// ---------------------------------------------------------------------------

test("test_manual_vad_buffers_audio_until_turn_starts", async () => {
  // While idle, audio is buffered as pre-roll and not streamed to the service.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  await service._sendUserAudio(_audioFrame({ data: b(0xaa, 0xbb) }));
  await service._sendUserAudio(_audioFrame({ data: b(0xcc, 0xdd) }));

  expect(session.kinds()).toEqual([]); // idle audio must be buffered, not sent
  expect(service._userAudioPrerollBuffer).toEqual(b(0xaa, 0xbb, 0xcc, 0xdd));
});

test("test_manual_vad_flushes_preroll_after_activity_start", async () => {
  // activity_start is followed by a replay of the buffered pre-roll audio.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  await service._sendUserAudio(_audioFrame({ data: b(0xaa, 0xbb) }));
  await service._sendUserAudio(_audioFrame({ data: b(0xcc, 0xdd) }));

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());

  // activity_start must come first, immediately followed by the pre-roll audio.
  expect(session.kinds()).toEqual(["activity_start", "audio"]);
  // pre-roll must replay buffered onset
  expect(session.audioPayloads()).toEqual([b(0xaa, 0xbb, 0xcc, 0xdd)]);
  // Buffer is cleared so the pre-roll isn't replayed again.
  expect(service._userAudioPrerollBuffer).toEqual(b());
});

test("test_manual_vad_streams_audio_during_turn", async () => {
  // Once the turn has started, audio is streamed in-band.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  // No pre-roll buffered yet, so only activity_start was sent.
  expect(session.kinds()).toEqual(["activity_start"]);

  await service._sendUserAudio(_audioFrame({ data: b(0x11, 0x22) }));
  await service._sendUserAudio(_audioFrame({ data: b(0x33, 0x44) }));

  expect(session.kinds()).toEqual(["activity_start", "audio", "audio"]);
  expect(session.audioPayloads()).toEqual([b(0x11, 0x22), b(0x33, 0x44)]);
});

test("test_manual_vad_sends_activity_end_on_turn_stop", async () => {
  // Turn stop sends activity_end.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  await service._sendUserAudio(_audioFrame({ data: b(0x11, 0x22) }));
  await service._handleUserStoppedSpeaking(new UserStoppedSpeakingFrame());

  expect(session.kinds()).toEqual(["activity_start", "audio", "activity_end"]);
});

test("test_manual_vad_preroll_capped_to_default_window", async () => {
  // Before VAD params are known, the pre-roll keeps DEFAULT_USER_AUDIO_PREROLL_SECS.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  const sampleRate = 16000;
  // One full second of audio at 16kHz mono / 16-bit = 32000 bytes; the buffer
  // should keep only the most recent DEFAULT_USER_AUDIO_PREROLL_SECS (0.5s) =
  // 16000 bytes.
  const oneSecond = new Uint8Array(32000);
  await service._sendUserAudio(_audioFrame({ sampleRate, data: oneSecond }));

  expect(service._userAudioPrerollBuffer.length).toEqual(16000);

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  expect(totalLen(session.audioPayloads())).toEqual(16000);
});

test("test_manual_vad_preroll_sized_from_vad_start_secs", async () => {
  // A SpeechControlParamsFrame sizes the pre-roll to start_secs + margin.
  const service = _makeService({ vadDisabled: true });
  const session = service._session;

  const startSecs = 0.5;
  service._handleSpeechControlParams(
    new SpeechControlParamsFrame({ vadParams: new VADParams({ startSecs }) }),
  );

  // Send 2s of audio — comfortably more than the window — so the buffer is
  // capped to (startSecs + margin), not limited by how much we sent.
  await service._sendUserAudio(_audioFrame({ sampleRate: 16000, data: new Uint8Array(64000) }));

  // 16kHz mono / 16-bit = 2 bytes/sample.
  const expected = Math.trunc(
    16000 * 1 * 2 * (startSecs + AUTOSIZED_USER_AUDIO_PREROLL_MARGIN_SECS),
  );
  expect(service._userAudioPrerollBuffer.length).toEqual(expected);

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  expect(totalLen(session.audioPayloads())).toEqual(expected);
});

test("test_manual_vad_preroll_override_pins_value_and_ignores_vad_params", async () => {
  // An explicit userAudioPrerollSecs pins the pre-roll; VAD params don't resize it.
  //
  // This is the escape hatch for setups using a non-default turn-start strategy,
  // where the onset-to-turn-start gap isn't governed by VAD startSecs.
  const service = _makeService({ vadDisabled: true, prerollSecs: 0.1 });
  const session = service._session;

  // The override must win over an incoming SpeechControlParamsFrame.
  service._handleSpeechControlParams(
    new SpeechControlParamsFrame({ vadParams: new VADParams({ startSecs: 0.5 }) }),
  );

  // 0.1s at 16kHz mono / 16-bit = trunc(16000 * 1 * 2 * 0.1) = 3200 bytes.
  const oneSecond = new Uint8Array(32000);
  await service._sendUserAudio(_audioFrame({ sampleRate: 16000, data: oneSecond }));

  expect(service._userAudioPrerollBuffer.length).toEqual(3200);

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  expect(totalLen(session.audioPayloads())).toEqual(3200);
});

// ---------------------------------------------------------------------------
// Server-VAD mode: stream continuously (unchanged behavior)
// ---------------------------------------------------------------------------

test("test_server_vad_streams_audio_when_idle", async () => {
  // With server-side VAD, audio is streamed continuously, even while idle.
  const service = _makeService({ vadDisabled: false });
  const session = service._session;

  await service._sendUserAudio(_audioFrame({ data: b(0xaa, 0xbb) }));
  await service._sendUserAudio(_audioFrame({ data: b(0xcc, 0xdd) }));

  expect(session.kinds()).toEqual(["audio", "audio"]);
  expect(session.audioPayloads()).toEqual([b(0xaa, 0xbb), b(0xcc, 0xdd)]);
  // No pre-roll buffer is maintained in server-VAD mode (it's never flushed).
  expect(service._userAudioPrerollBuffer).toEqual(b());
});

test("test_server_vad_does_not_send_activity_markers", async () => {
  // With server-side VAD, the client doesn't send activity_start/_end.
  const service = _makeService({ vadDisabled: false });
  const session = service._session;

  await service._handleUserStartedSpeaking(new UserStartedSpeakingFrame());
  await service._handleUserStoppedSpeaking(new UserStoppedSpeakingFrame());

  expect(session.kinds()).not.toContain("activity_start");
  expect(session.kinds()).not.toContain("activity_end");
});
