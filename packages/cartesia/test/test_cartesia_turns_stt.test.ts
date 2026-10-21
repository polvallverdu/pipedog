// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_cartesia_turns_stt.py

import { expect, mock, test } from "bun:test";
import { EagerTranscriptionFrame, type Frame } from "@pipedog/core/frames/frames";
import {
  EagerUserTurnStrategies,
  ExternalUserTurnStrategies,
} from "@pipedog/core/turns/user_turn_strategies";
import { CartesiaTurnsSTTService, type CartesiaTurnsSTTServiceOptions } from "../src/turns/stt.ts";

// Test access to protected members, as the Python test does.
type Internals = {
  _sampleRate: number;
  _settings: InstanceType<typeof CartesiaTurnsSTTService.Settings>;
  _websocketUrl(): string;
  _requestReconnect: (...args: unknown[]) => Promise<void>;
  _updateSettings(delta: unknown): Promise<Record<string, unknown>>;
  _handleTurnEagerEnd(data: Record<string, unknown>): Promise<void>;
  pushFrame: (...args: unknown[]) => Promise<void>;
};

function _service(
  options: Partial<CartesiaTurnsSTTServiceOptions> = {},
): CartesiaTurnsSTTService & Internals {
  const service = new CartesiaTurnsSTTService({
    apiKey: "test-key",
    sampleRate: 16000,
    ...options,
  }) as unknown as CartesiaTurnsSTTService & Internals;
  // sample_rate is normally set from StartFrame, which these tests skip.
  service._sampleRate = 16000;
  return service;
}

/** Equivalent of Python's `parse_qs`: name -> list of values. */
function parseQs(url: string): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const [key, value] of new URL(url).searchParams) {
    query[key] = [...(query[key] ?? []), value];
  }
  return query;
}

test("test_cartesia_turns_websocket_url_includes_keyterm", () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({ keyterm: ["Cartesia", "Ink 2"] }),
  });

  const parsed = new URL(service._websocketUrl());
  const query = parseQs(service._websocketUrl());

  expect(parsed.protocol).toEqual("wss:");
  expect(parsed.host).toEqual("api.cartesia.ai");
  expect(parsed.pathname).toEqual("/stt/turns/websocket");
  expect(query.model).toEqual(["ink-2"]);
  expect(query.sample_rate).toEqual(["16000"]);
  expect(query.keyterm).toEqual(["Cartesia", "Ink 2"]);
});

test("test_cartesia_turns_websocket_url_encodes_keyterm_spaces_as_percent_20", () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({ keyterm: ["Ink 2"] }),
  });

  expect(service._websocketUrl()).toContain("keyterm=Ink%202");
});

test("test_cartesia_turns_websocket_url_omits_keyterm_when_not_set", () => {
  const service = _service();

  const query = parseQs(service._websocketUrl());

  expect("keyterm" in query).toBe(false);
});

test("test_cartesia_turns_websocket_url_includes_turn_detection_thresholds", () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({
      turnStartThreshold: 0.7,
      turnEagerEndThreshold: 0.5,
      turnEndThreshold: 0.4,
      turnEndTimeoutMs: 4500,
    }),
  });

  const query = parseQs(service._websocketUrl());

  expect(query.turn_start_threshold).toEqual(["0.7"]);
  expect(query.turn_eager_end_threshold).toEqual(["0.5"]);
  expect(query.turn_end_threshold).toEqual(["0.4"]);
  expect(query.turn_end_timeout_ms).toEqual(["4500"]);
});

test("test_cartesia_turns_websocket_url_omits_unset_turn_detection_thresholds", () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({ turnEndTimeoutMs: 8000 }),
  });

  const query = parseQs(service._websocketUrl());

  expect(query.turn_end_timeout_ms).toEqual(["8000"]);
  expect("turn_start_threshold" in query).toBe(false);
  expect("turn_eager_end_threshold" in query).toBe(false);
  expect("turn_end_threshold" in query).toBe(false);
});

test("test_cartesia_turns_websocket_url_clamps_keyterms_to_limits", () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({
      keyterm: Array.from({ length: 150 }, (_, i) => `term${i}`),
    }),
  });

  const query = parseQs(service._websocketUrl());

  expect(query.keyterm).toEqual(Array.from({ length: 100 }, (_, i) => `term${i}`));
});

test("test_cartesia_turns_update_keyterm_reconnects", async () => {
  const service = _service({
    settings: new CartesiaTurnsSTTService.Settings({ keyterm: ["Cartesia"] }),
  });
  const reconnect = mock(async () => {});
  service._requestReconnect = reconnect;

  await service._updateSettings(new CartesiaTurnsSTTService.Settings({ keyterm: ["Ink 2"] }));

  expect(service._settings.keyterm).toEqual(["Ink 2"]);
  expect(reconnect).toHaveBeenCalledTimes(1);
});

test("test_cartesia_turns_update_model_does_not_reconnect", async () => {
  const service = _service();
  const reconnect = mock(async () => {});
  service._requestReconnect = reconnect;

  await service._updateSettings(new CartesiaTurnsSTTService.Settings({ model: "ink-3" }));

  expect(reconnect).not.toHaveBeenCalled();
});

test("test_cartesia_turns_recommends_external_strategies_by_default", () => {
  const strategies = _service().serviceMetadataFrame().userTurnStrategies;

  expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
  expect(strategies).not.toBeInstanceOf(EagerUserTurnStrategies);
});

test("test_cartesia_turns_recommends_eager_strategies_when_asked", () => {
  const strategies = _service({ enableEagerEndOfTurn: true }).serviceMetadataFrame();

  expect(strategies.userTurnStrategies).toBeInstanceOf(EagerUserTurnStrategies);
});

test("test_cartesia_turns_reports_an_eager_end_of_turn_only_when_enabled", async () => {
  const cases: [boolean, (abstract new (...args: any[]) => Frame)[]][] = [
    [false, []],
    [true, [EagerTranscriptionFrame]],
  ];
  for (const [enabled, expected] of cases) {
    const service = _service({ enableEagerEndOfTurn: enabled });
    const pushFrame = mock(async (_frame: Frame) => {});
    service.pushFrame = pushFrame as (...args: unknown[]) => Promise<void>;

    await service._handleTurnEagerEnd({ transcript: "book a flight" });

    const pushed = pushFrame.mock.calls.map((call) => (call[0] as Frame).constructor);
    expect(pushed).toEqual(expected);
  }
});
