// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gradium_stt.py

/**
 * Tests for the Gradium STT service: turn detection from the end-pointing
 * signal, flush handling, reconnects and audio chunking.
 *
 * Porting notes:
 * - `AsyncMock()` assigned to a service attribute → `mock(async () => ...)`
 *   assigned to the instance property; `assert_awaited_once_with(X)` →
 *   `toHaveBeenCalledTimes(1)` and `toHaveBeenCalledWith(X)`.
 * - `monkeypatch.setattr(gradium_stt, "TRANSCRIPT_AGGREGATION_DELAY", 0)` →
 *   setting the service's `_transcriptAggregationDelay` (an ES module export
 *   is read-only; see the DIVERGENCE note in `src/stt.ts`).
 * - `service._handle_flushed = service._transcript_aggregation_handler` needs
 *   an explicit `bind`.
 * - `asyncio` marks and `MagicMock` websockets become plain objects.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { State } from "@pipedog/core/services/websocket_service";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import {
  _gradiumPcmSampleRate,
  _TurnPhase,
  GradiumSTTService,
  type GradiumSTTServiceOptions,
} from "../src/stt.ts";

function _service(
  options: Partial<GradiumSTTServiceOptions> & { enableTurnDetection?: boolean } = {},
): any {
  const service: any = new GradiumSTTService({
    apiKey: "test-key",
    sampleRate: 16000,
    enableTurnDetection: true,
    ...options,
  });
  service.broadcastFrame = mock(async () => {});
  service.broadcastInterruption = mock(async () => {});
  service.pushFrame = mock(async () => {});
  return service;
}

function _step(inactivity: number, horizon = 3.0): Record<string, any> {
  return { type: "step", vad: [{ horizon_s: horizon, inactivity_prob: inactivity }] };
}

function _lastPushed(service: any): any {
  return service.pushFrame.mock.calls.at(-1)[0];
}

function _messages(...items: unknown[]): () => AsyncGenerator<string> {
  return async function* () {
    for (const item of items) yield JSON.stringify(item);
  };
}

test("test_gradium_recommends_external_strategies_only_with_turn_detection", () => {
  expect(_service().serviceMetadataFrame().userTurnStrategies).toBeInstanceOf(
    ExternalUserTurnStrategies,
  );
  expect(_service({ enableTurnDetection: false }).serviceMetadataFrame().userTurnStrategies).toBe(
    null,
  );
});

test("test_gradium_turn_detection_settings_are_set_only_with_turn_detection", () => {
  const on = _service()._settings;
  const off = _service({ enableTurnDetection: false })._settings;

  expect([on.eotHorizonS, on.eotThreshold, on.postFlushCooldownFrames]).toEqual([3.0, 0.5, 8]);
  expect([off.eotHorizonS, off.eotThreshold, off.postFlushCooldownFrames]).toEqual([
    null,
    null,
    null,
  ]);
});

test("test_gradium_turn_detection_settings_passed_in_win_over_the_defaults", () => {
  const settings = _service({
    settings: new GradiumSTTService.Settings({ eotThreshold: 0.7 }),
  })._settings;

  expect(settings.eotThreshold).toBe(0.7);
  expect(settings.eotHorizonS).toBe(3.0);
});

test("test_gradium_update_reconnects_only_for_connection_bound_settings", async () => {
  for (const [delta, reconnects] of [
    [new GradiumSTTService.Settings({ eotThreshold: 0.7 }), false],
    [new GradiumSTTService.Settings({ delayInFrames: 8 }), true],
  ] as const) {
    const service = _service();
    service._websocket = {};
    service._disconnect = mock(async () => {});
    service._connect = mock(async () => {});

    await service._updateSettings(delta);

    expect(service._disconnect).toHaveBeenCalledTimes(reconnects ? 1 : 0);
  }
});

test("test_gradium_supports_ttfs_only_without_turn_detection", () => {
  expect(_service().supportsTtfs).toBe(false);
  expect(_service({ enableTurnDetection: false }).supportsTtfs).toBe(true);
});

test("test_gradium_a_vad_stop_flushes_only_without_turn_detection", async () => {
  for (const [enableTurnDetection, flushes] of [
    [false, 1],
    [true, 0],
  ] as const) {
    const service = _service({ enableTurnDetection });
    service._sendFlush = mock(async () => {});

    await service.processFrame(new VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM);

    expect(service._sendFlush).toHaveBeenCalledTimes(flushes);
  }
});

test("test_gradium_turn_detection_the_signal_falling_below_the_threshold_proposes_a_turn_start", async () => {
  const service = _service();

  await service._handleStep(_step(0.9));
  await service._handleStep(_step(0.2));

  expect(service.broadcastFrame).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame).toHaveBeenCalledWith(ProposedUserStartedSpeakingFrame);
  // The strategies own the interruption; the service only proposes.
  expect(service.broadcastInterruption).not.toHaveBeenCalled();
  expect(service._turnPhase).toBe(_TurnPhase.OPEN);
});

test("test_gradium_turn_detection_a_signal_that_starts_low_opens_nothing", async () => {
  // With nothing heard yet the estimate starts low and climbs; that is not
  // speech. Only a dip after the signal has read inactive is.
  const service = _service();

  for (const inactivity of [0.1, 0.3, 0.45]) {
    await service._handleStep(_step(inactivity));
  }

  expect(service.broadcastFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).not.toBe(_TurnPhase.OPEN);
});

test("test_gradium_turn_detection_watches_the_horizon_closest_to_the_setting", async () => {
  const service = _service({ settings: new GradiumSTTService.Settings({ eotHorizonS: 1.0 }) });

  await service._handleStep({
    type: "step",
    vad: [
      { horizon_s: 1.0, inactivity_prob: 0.9 },
      { horizon_s: 3.0, inactivity_prob: 0.1 },
    ],
  });

  expect(service._turnPhase).not.toBe(_TurnPhase.OPEN);
});

test("test_gradium_turn_detection_a_step_at_the_threshold_ends_an_open_turn_with_a_flush", async () => {
  const service = _service();
  // AsyncMock returns a truthy MagicMock: the flush was sent.
  service._sendFlush = mock(async () => true);
  await service._handleStep(_step(0.9));
  await service._handleStep(_step(0.2));

  await service._handleStep(_step(0.5));

  expect(service._sendFlush).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame.mock.calls.at(-1)).toEqual([ProposedUserStoppedSpeakingFrame]);
  expect(service._turnPhase).toBe(_TurnPhase.ENDING);
});

test("test_gradium_turn_detection_the_flush_ack_starts_the_cooldown_and_holds_the_ending_phase", async () => {
  // The turn's transcript is still aggregating, so no new turn may start yet.
  const service = _service();
  service._turnPhase = _TurnPhase.ENDING;
  service._handleFlushed = mock(async () => {});
  service._getWebsocket = _messages({ type: "flushed" });

  await service._receiveMessages();

  expect(service._turnPhase).toBe(_TurnPhase.ENDING);
  expect(service._flushCooldown).toBe(8);
  expect(service._handleFlushed).toHaveBeenCalledTimes(1);
});

test("test_gradium_turn_detection_speech_continuing_through_a_flush_opens_a_turn", async () => {
  // After a flush the signal follows the audio: a user who keeps talking
  // reads low straight away, without first reading inactive.
  const service = _service({
    settings: new GradiumSTTService.Settings({ postFlushCooldownFrames: 2 }),
  });
  service._transcriptAggregationDelay = 0;
  service.emitSttUsageMetrics = mock(async () => {});
  service._traceTranscription = mock(async () => {});
  service._handleFlushed = service._transcriptAggregationHandler.bind(service);
  service._turnPhase = _TurnPhase.ENDING;
  service._accumulatedText = ["I'd like to book a"];
  service._getWebsocket = _messages({ type: "flushed" }, ...[0, 1, 2].map(() => _step(0.1)));

  await service._receiveMessages();

  expect(_lastPushed(service).text).toBe("I'd like to book a");
  expect(service.broadcastFrame).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame).toHaveBeenCalledWith(ProposedUserStartedSpeakingFrame);
  expect(service._turnPhase).toBe(_TurnPhase.OPEN);
});

test("test_gradium_turn_detection_an_empty_turn_still_arms_the_next_turn", async () => {
  const service = _service();
  service._transcriptAggregationDelay = 0;
  service._turnPhase = _TurnPhase.ENDING;

  await service._transcriptAggregationHandler();

  expect(service.pushFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).toBe(_TurnPhase.ARMED);
});

test("test_gradium_turn_detection_no_start_before_the_previous_transcript_is_pushed", async () => {
  // With no cooldown, steps after the flush ack are read at once; the turn's
  // transcript must still go out before the next start proposal.
  const service = _service({
    settings: new GradiumSTTService.Settings({ postFlushCooldownFrames: 0 }),
  });
  service._transcriptAggregationDelay = 0;
  service.emitSttUsageMetrics = mock(async () => {});
  service._traceTranscription = mock(async () => {});
  service._handleFlushed = mock(async () => {});
  service._turnPhase = _TurnPhase.ENDING;
  service._accumulatedText = ["first turn"];
  service._getWebsocket = _messages({ type: "flushed" }, _step(0.1));
  await service._receiveMessages();

  expect(service.broadcastFrame).not.toHaveBeenCalled();

  await service._transcriptAggregationHandler();
  await service._handleStep(_step(0.1));

  expect(_lastPushed(service).text).toBe("first turn");
  expect(service.broadcastFrame).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame).toHaveBeenCalledWith(ProposedUserStartedSpeakingFrame);
});

test("test_gradium_without_turn_detection_a_flush_ack_leaves_turns_alone", async () => {
  const service = _service({ enableTurnDetection: false });
  service._transcriptAggregationDelay = 0;
  service.emitSttUsageMetrics = mock(async () => {});
  service._traceTranscription = mock(async () => {});
  service._handleFlushed = service._transcriptAggregationHandler.bind(service);
  service._accumulatedText = ["hello"];
  service._getWebsocket = _messages({ type: "flushed" }, _step(0.9), _step(0.1));
  await service._receiveMessages();

  expect(_lastPushed(service).text).toBe("hello");
  expect(service.broadcastFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).toBe(_TurnPhase.IDLE);
  expect(service._flushCooldown).toBe(0);
});

test("test_gradium_turn_detection_a_failed_transcript_push_still_arms_the_next_turn", async () => {
  const service = _service();
  service._transcriptAggregationDelay = 0;
  service._turnPhase = _TurnPhase.ENDING;
  service._finalizeAccumulatedText = mock(async () => {
    throw new Error("push failed");
  });

  await expect(service._transcriptAggregationHandler()).rejects.toThrow("push failed");

  expect(service._turnPhase).toBe(_TurnPhase.ARMED);
});

test("test_gradium_turn_detection_the_transcript_finalizes_on_the_spot_when_the_flush_cannot_be_sent", async () => {
  // No socket, so no "flushed" acknowledgment is coming to finalize it.
  const service = _service();
  service.emitSttUsageMetrics = mock(async () => {});
  service._traceTranscription = mock(async () => {});
  service._turnPhase = _TurnPhase.OPEN;
  service._accumulatedText = ["so far"];

  await service._endTurn();

  expect(service._turnPhase).toBe(_TurnPhase.IDLE);
  expect(_lastPushed(service).text).toBe("so far");
  expect(service.broadcastFrame).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame).toHaveBeenCalledWith(ProposedUserStoppedSpeakingFrame);
});

test("test_gradium_turn_detection_ignores_the_signal_during_the_post_flush_cooldown", async () => {
  // The steps right after a flush can read as speech resuming; none of them
  // may open a turn, and the first one past the cooldown may.
  const service = _service({
    settings: new GradiumSTTService.Settings({ postFlushCooldownFrames: 2 }),
  });
  service._flushCooldown = 2;

  // Neither an inactive reading nor the dip after it counts while cooling down.
  await service._handleStep(_step(0.9));
  await service._handleStep(_step(0.9));
  await service._handleStep(_step(0.2));
  expect(service.broadcastFrame).not.toHaveBeenCalled();

  await service._handleStep(_step(0.9));
  await service._handleStep(_step(0.2));
  expect(service.broadcastFrame).toHaveBeenCalledTimes(1);
  expect(service.broadcastFrame).toHaveBeenCalledWith(ProposedUserStartedSpeakingFrame);
});

test("test_gradium_turn_detection_no_new_start_while_the_flush_is_unacknowledged", async () => {
  const service = _service();
  service._turnPhase = _TurnPhase.ENDING;

  await service._handleStep(_step(0.2));

  expect(service.broadcastFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).not.toBe(_TurnPhase.OPEN);
});

function _reconnectable(service: any): any {
  service.emitSttUsageMetrics = mock(async () => {});
  service._traceTranscription = mock(async () => {});
  service._disconnectWebsocket = mock(async () => {});
  service._connectWebsocket = mock(async () => {});
  service._verifyConnection = mock(async () => true);
  return service;
}

test("test_gradium_a_reconnect_pushes_the_text_so_far_and_keeps_an_open_turn_open", async () => {
  // The user may still be speaking; the new connection's signal ends the turn.
  const service = _reconnectable(_service());
  service._turnPhase = _TurnPhase.OPEN;
  service._accumulatedText = ["book a table"];
  service._flushCounter = 3;
  service._flushCooldown = 2;

  expect(await service._reconnectWebsocket(1)).toBe(true);

  const frame = _lastPushed(service);
  expect(frame).toBeInstanceOf(TranscriptionFrame);
  expect(frame.text).toBe("book a table");
  expect(service.broadcastFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).toBe(_TurnPhase.OPEN);
  expect([service._accumulatedText, service._flushCounter, service._flushCooldown]).toEqual([
    [],
    0,
    0,
  ]);
});

test("test_gradium_a_reconnect_while_ending_pushes_the_transcript_without_a_second_stop", async () => {
  const service = _reconnectable(_service());
  service._turnPhase = _TurnPhase.ENDING;
  service._accumulatedText = ["the tail"];

  await service._reconnectWebsocket(1);

  expect(_lastPushed(service).text).toBe("the tail");
  expect(service.broadcastFrame).not.toHaveBeenCalled();
  expect(service._turnPhase).toBe(_TurnPhase.IDLE);
});

test("test_gradium_a_failed_first_connect_still_starts_the_receive_loop", async () => {
  // The receive loop is what retries the connection.
  const service = _service();
  service._connectWebsocket = mock(async () => {});
  service.createTask = mock(() => ({}));

  await service._connect();

  expect(service._websocket).toBe(null);
  expect(service.createTask).toHaveBeenCalledTimes(1);
});

describe("test_gradium_pcm_input_is_sent_at_a_rate_gradium_accepts", () => {
  for (const [pipelineRate, sentRate] of [
    [8000, 8000],
    [16000, 16000],
    [24000, 24000],
    [11025, 16000],
    [22050, 24000],
    [48000, 24000],
  ] as const) {
    test(`${pipelineRate} -> ${sentRate}`, () => {
      expect(_gradiumPcmSampleRate(pipelineRate)).toBe(sentRate);
    });
  }
});

test("test_gradium_audio_at_an_unsupported_rate_is_resampled_before_chunking", async () => {
  const service = _service({ enableTurnDetection: false });
  service._sampleRate = 48000;
  service._sendSampleRate = 24000;
  service._chunkSizeBytes = Math.trunc((80 * 24000 * 2) / 1000);
  const send = mock(async () => {});
  service._websocket = { state: State.OPEN, send };

  // One second at 48 kHz is one second at 24 kHz: about 12 chunks of 80 ms.
  for await (const _ of service.runStt(new Uint8Array(2 * 48000))) {
    // drain
  }

  expect(send.mock.calls.length).toBeGreaterThanOrEqual(11);
  expect(send.mock.calls.length).toBeLessThanOrEqual(12);
});
