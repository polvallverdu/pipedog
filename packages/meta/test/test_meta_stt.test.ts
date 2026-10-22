// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_meta_stt.py

/**
 * Tests for the Meta streaming STT service handshake and event handling.
 *
 * Porting notes:
 * - `monkeypatch.setattr("pipecat.services.websocket_service.websocket_connect", fake)`
 *   → assigning the instance's `_websocketConnect`.
 * - `AsyncMock(side_effect=...)` on `push_frame` and friends → assigned async
 *   functions.
 * - `service._sample_rate = rate` → `service._sampleRate = rate`.
 */

import { describe, expect, test } from "bun:test";
import {
  type ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { State } from "@pipedog/core/services/websocket_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import { MetaSTTService } from "../src/stt.ts";

/** A websocket that replays server messages and records what was sent. */
class FakeWebsocket {
  readonly #messages: (string | Uint8Array)[];
  readonly #ack: string;
  state: State;
  sent: (string | Uint8Array)[] = [];
  closed = false;

  constructor(
    messages: (string | Uint8Array)[] = [],
    options: { ack?: unknown; state?: State } = {},
  ) {
    this.#messages = messages;
    this.#ack = JSON.stringify(
      options.ack === undefined ? { sessionId: "stream-123" } : options.ack,
    );
    this.state = options.state ?? State.OPEN;
  }

  async send(payload: string | Uint8Array): Promise<void> {
    this.sent.push(payload);
  }

  async recv(): Promise<string> {
    return this.#ack;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = State.CLOSED;
  }

  async *[Symbol.asyncIterator]() {
    for (const message of this.#messages) {
      yield message;
    }
  }
}

function patchConnect(service: any, websocket: FakeWebsocket): FakeWebsocket {
  service._websocketConnect = async () => websocket;
  return websocket;
}

function makeService(
  sampleRate = 16000,
  options: { settings?: InstanceType<typeof MetaSTTService.Settings> } = {},
): any {
  const service: any = new MetaSTTService({ apiKey: "test-key", ...options });
  // sampleRate is normally set from StartFrame, which these tests skip.
  service._sampleRate = sampleRate;
  return service;
}

function handshake(websocket: FakeWebsocket): any {
  return JSON.parse(websocket.sent[0] as string);
}

async function connected(
  sampleRate = 16000,
  options: { settings?: InstanceType<typeof MetaSTTService.Settings> } = {},
): Promise<[any, FakeWebsocket]> {
  const websocket = new FakeWebsocket();
  const service = makeService(sampleRate, options);
  patchConnect(service, websocket);
  await service._connectWebsocket();
  return [service, websocket];
}

test("test_handshake_carries_credential_and_session_config", async () => {
  const [, websocket] = await connected();

  const hs = handshake(websocket);
  expect(hs.authorization.accessToken).toBe("Bearer test-key");
  expect(hs.model).toBe("muse-voice-transcribe-1.0");
  expect(hs.mode).toBe("ENDPOINTING");
  expect(hs.partialMode).toBe("CUMULATIVE");
  expect(hs.emitAudioProgress).toBe(false);
  expect(hs.languageBias).toEqual(["English"]);
});

test("test_handshake_language_bias_replaces_the_single_language", async () => {
  const [, websocket] = await connected(16000, {
    settings: new MetaSTTService.Settings({ languageBias: [Language.EN, Language.FR] }),
  });

  expect(handshake(websocket).languageBias).toEqual(["English", "French"]);
});

test("test_handshake_omits_language_bias_when_language_is_unset", async () => {
  const [, websocket] = await connected(16000, {
    settings: new MetaSTTService.Settings({ language: null }),
  });

  expect("languageBias" in handshake(websocket)).toBe(false);
});

describe("test_audio_encoding_follows_the_pipeline_sample_rate", () => {
  for (const [sampleRate, encoding] of [
    [16000, "PCM_16KHZ"],
    [24000, "PCM_24KHZ"],
    [8000, "PCM_16KHZ"],
  ] as const) {
    test(`${sampleRate} -> ${encoding}`, async () => {
      const [, websocket] = await connected(sampleRate);

      expect(handshake(websocket).audioEncoding).toBe(encoding);
    });
  }
});

test("test_off_rate_audio_is_resampled_before_it_is_sent", async () => {
  const [service, websocket] = await connected(8000);

  // The stream resampler buffers, so a single short chunk yields nothing.
  for (let i = 0; i < 10; i++) {
    for await (const _ of service.runStt(new Uint8Array(1600))) {
      // Frames arrive from the receive task, not from here.
    }
  }

  let audioSent = 0;
  for (const chunk of websocket.sent) {
    if (chunk instanceof Uint8Array) audioSent += chunk.length;
  }
  // 8 kHz in, 16 kHz out: twice the bytes, less what the resampler still holds.
  const ratio = audioSent / (2 * 10 * 1600);
  expect(ratio).toBeGreaterThan(0.9);
  expect(ratio).toBeLessThanOrEqual(1.0);
});

test("test_native_rate_audio_is_sent_unchanged", async () => {
  const [service, websocket] = await connected(24000);

  const audio = new Uint8Array(480).fill(1);
  for await (const _ of service.runStt(audio)) {
    // Frames arrive from the receive task, not from here.
  }

  expect(websocket.sent.at(-1)).toEqual(audio);
});

test("test_accepted_handshake_readies_the_session", async () => {
  const [service] = await connected();

  expect(service._sessionReady.isSet()).toBe(true);
  expect(service._sessionId).toBe("stream-123");
});

test("test_rejected_handshake_makes_the_service_unusable", async () => {
  const websocket = new FakeWebsocket([], {
    ack: { type: "error", message: "invalid credential" },
  });
  const service = makeService();
  patchConnect(service, websocket);
  const errors: Frame[] = [];
  service.pushFrame = async (frame: Frame) => {
    errors.push(frame);
  };

  await service._connectWebsocket();

  expect(service._websocket).toBeNull();
  expect(websocket.closed).toBe(true);
  expect(service.isUsable).toBe(false);
  expect((errors[0] as ErrorFrame).category).toBe(ErrorCategory.AUTHENTICATION);
});

test("test_endpointing_turn_emits_interims_then_the_completed_transcript", async () => {
  const service = makeService();
  service._websocket = new FakeWebsocket([
    JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }),
    JSON.stringify({ type: "transcript", transcript: "what is the", final: false }),
    JSON.stringify({ type: "transcript", transcript: "what is the capital", final: false }),
    JSON.stringify({ type: "speechEnd", turnId: 1, audioProcessedMs: 900 }),
    JSON.stringify({
      type: "speechComplete",
      turnId: 1,
      transcript: "What is the capital?",
      audioProcessedMs: 900,
    }),
  ]);
  const frames: Frame[] = [];
  service.pushFrame = async (f: Frame) => {
    frames.push(f);
  };
  service.emitSttUsageMetrics = async () => {};

  await service._receiveMessages();

  expect(frames.map((frame) => frame.constructor)).toEqual([
    InterimTranscriptionFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
  ]);
  const last = frames.at(-1) as TranscriptionFrame;
  expect(last.text).toBe("What is the capital?");
  expect(last.finalized).toBeTruthy();
  expect(last.language).toBe(Language.EN);
});

test("test_final_transcript_is_interim_until_the_turn_completes", async () => {
  const service = makeService();
  service._websocket = new FakeWebsocket([
    JSON.stringify({ type: "transcript", transcript: "Berlin.", final: true }),
  ]);
  const frames: Frame[] = [];
  service.pushFrame = async (f: Frame) => {
    frames.push(f);
  };

  await service._receiveMessages();

  expect(frames.map((frame) => frame.constructor)).toEqual([InterimTranscriptionFrame]);
});

test("test_final_transcript_ends_the_turn_in_push_to_talk", async () => {
  const service = makeService(16000, {
    settings: new MetaSTTService.Settings({ mode: "PUSH_TO_TALK" }),
  });
  service._websocket = new FakeWebsocket([
    JSON.stringify({ type: "transcript", transcript: "Berlin.", final: true }),
  ]);
  const frames: Frame[] = [];
  service.pushFrame = async (f: Frame) => {
    frames.push(f);
  };
  service.emitSttUsageMetrics = async () => {};

  await service._receiveMessages();

  expect(frames.map((frame) => frame.constructor)).toEqual([TranscriptionFrame]);
});

test("test_usage_is_reported_before_the_transcription_frame", async () => {
  const service = makeService();
  service._websocket = new FakeWebsocket([
    JSON.stringify({ type: "speechComplete", turnId: 1, transcript: "Berlin." }),
  ]);
  const events: string[] = [];
  service.pushFrame = async (f: Frame) => {
    events.push(f.constructor.name);
  };
  service.emitSttUsageMetrics = async () => {
    events.push("usage");
  };

  await service._receiveMessages();

  expect(events).toEqual(["usage", "TranscriptionFrame"]);
});

test("test_error_event_is_reported", async () => {
  const service = makeService();
  service._websocket = new FakeWebsocket([
    JSON.stringify({ type: "error", message: "backend failure", sessionId: "stream-123" }),
  ]);
  const errors: string[] = [];
  service.pushError = async (errorMsg: string) => {
    errors.push(errorMsg);
  };

  await service._receiveMessages();

  expect(errors[0]).toContain("backend failure");
});

test("test_settings_change_reconnects", async () => {
  const service = makeService();
  let reconnects = 0;
  service._requestReconnect = async () => {
    reconnects++;
  };

  await service._updateSettings(new MetaSTTService.Settings({ keywords: ["Pipecat"] }));

  expect(service._settings.keywords).toEqual(["Pipecat"]);
  expect(reconnects).toBe(1);
});

test("test_disconnect_half_closes_the_input_stream", async () => {
  const [service, websocket] = await connected();

  await service._disconnect();

  expect(JSON.parse(websocket.sent.at(-1) as string)).toEqual({ type: "endStream" });
  expect(websocket.closed).toBe(true);
});
