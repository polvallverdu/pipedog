// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_xai_realtime_user_audio.py

/** Tests for user-audio and interruption handling in GrokRealtimeLLMService. */

import { expect, spyOn, test } from "bun:test";

import { InputAudioRawFrame } from "@pipedog/core/frames/frames";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";

import * as events from "../src/realtime/events.ts";
import { SessionProperties, TurnDetection } from "../src/realtime/events.ts";
import { CurrentAudioResponse, GrokRealtimeLLMService } from "../src/realtime/llm.ts";

class _EventRecorder {
  events: any[] = [];

  call = async (event: unknown): Promise<void> => {
    this.events.push(event);
  };

  kinds(): string[] {
    return this.events.map((e) => (e as object).constructor.name);
  }
}

// The tests reach into the service's protected members, as upstream does.
function _makeService(options: { serverVad: boolean }): [any, _EventRecorder] {
  const turnDetection = options.serverVad ? new TurnDetection({ type: "server_vad" }) : null;
  const service: any = new GrokRealtimeLLMService({
    apiKey: "test-key",
    settings: new GrokRealtimeLLMService.Settings({
      sessionProperties: new SessionProperties({ turnDetection }),
    }),
  });
  const recorder = new _EventRecorder();
  service.sendClientEvent = recorder.call;
  service.stopAllMetrics = async () => {};
  return [service, recorder];
}

function _audioFrame(data: number[] = [0xaa, 0xbb]): InputAudioRawFrame {
  return new InputAudioRawFrame({
    audio: new Uint8Array(data),
    sampleRate: 24000,
    numChannels: 1,
  });
}

test("test_default_model_is_grok_voice_latest", () => {
  const service: any = new GrokRealtimeLLMService({ apiKey: "test-key" });
  expect(service._settings.model).toBe("grok-voice-latest");
});

test("test_user_audio_dropped_until_session_ready", async () => {
  const [service, recorder] = _makeService({ serverVad: true });
  expect(service._apiSessionReady).toBe(false);

  const debug = spyOn(logger, "debug");
  let messages: string[];
  try {
    await service._sendUserAudio(_audioFrame());
    await service._sendUserAudio(_audioFrame());
    messages = debug.mock.calls.map((c) => String(c[0]));
  } finally {
    debug.mockRestore();
  }

  expect(recorder.kinds()).toEqual([]);
  expect(service._loggedAudioDropBeforeSessionReady).toBe(true);
  const dropCalls = messages.filter((m) => m.includes("Dropping user audio"));
  expect(dropCalls).toHaveLength(1);
});

test("test_user_audio_flows_after_session_ready_without_conversation_setup", async () => {
  // Audio-only pipelines never call _createResponse; audio must still flow.
  const [service, recorder] = _makeService({ serverVad: true });
  service._apiSessionReady = true;
  expect(service._llmNeedsConversationSetup).toBe(true);

  await service._sendUserAudio(_audioFrame([0x11, 0x22]));

  expect(recorder.kinds()).toEqual(["InputAudioBufferAppendEvent"]);
  expect(recorder.events[0].audio).toBe(bytesToBase64(new Uint8Array([0x11, 0x22])));
});

test("test_server_vad_interruption_cancels_without_clearing_input", async () => {
  const [service, recorder] = _makeService({ serverVad: true });
  service._apiSessionReady = true;

  await service._sendUserAudio(_audioFrame());
  await service._handleInterruption();

  expect(recorder.kinds()).toEqual(["InputAudioBufferAppendEvent", "ResponseCancelEvent"]);
  expect(recorder.kinds()).not.toContain("InputAudioBufferClearEvent");
});

test("test_manual_turn_interruption_clears_and_cancels", async () => {
  const [service, recorder] = _makeService({ serverVad: false });

  await service._handleInterruption();

  expect(recorder.kinds()).toEqual(["InputAudioBufferClearEvent", "ResponseCancelEvent"]);
});

test("test_interruption_truncates_in_flight_audio_on_the_wire", async () => {
  const [service, recorder] = _makeService({ serverVad: true });
  service._settings.sessionProperties.audio = new events.AudioConfiguration({
    output: new events.AudioOutput({ format: new events.PCMAudioFormat({ rate: 24000 }) }),
  });
  service._currentAudioResponse = new CurrentAudioResponse({
    itemId: "item-audio",
    contentIndex: 0,
    startTimeMs: Math.trunc(Date.now()) - 500,
    totalSize: 48000, // 1s at 24kHz mono 16-bit
  });

  await service._handleInterruption();

  expect(recorder.kinds()).toContain("ResponseCancelEvent");
  expect(recorder.kinds()).toContain("ConversationItemTruncateEvent");
  const truncate = recorder.events.find(
    (e) => e instanceof events.ConversationItemTruncateEvent,
  ) as events.ConversationItemTruncateEvent;
  expect(truncate.itemId).toBe("item-audio");
  expect(truncate.contentIndex).toBe(0);
  expect(truncate.audioEndMs).toBeGreaterThan(0);
  expect(truncate.audioEndMs).toBeLessThanOrEqual(1000);
  expect(service._currentAudioResponse).toBeNull();
});

test("test_delete_conversation_item_sends_client_event", async () => {
  const [service, recorder] = _makeService({ serverVad: true });
  await service.deleteConversationItem("item-1");
  expect(recorder.kinds()).toEqual(["ConversationItemDeleteEvent"]);
  expect(recorder.events[0].itemId).toBe("item-1");
});

test("test_force_message_sends_force_message_item", async () => {
  const [service, recorder] = _makeService({ serverVad: true });
  await service.forceMessage("This call is being recorded.");
  expect(recorder.kinds()).toEqual(["ConversationItemCreateEvent"]);
  const item = recorder.events[0].item;
  expect(item.type).toBe("force_message");
  expect(item.content[0].text).toBe("This call is being recorded.");
});
