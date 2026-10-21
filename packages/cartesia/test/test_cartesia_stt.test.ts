// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_cartesia_stt.py

import { afterEach, expect, mock, test } from "bun:test";

import type { ErrorFrame, Frame } from "@pipedog/core/frames/frames";
import * as websocketServiceModule from "@pipedog/core/services/websocket_service";
import {
  State,
  type WebsocketClientConnection,
  type WebsocketConnectOptions,
} from "@pipedog/core/services/websocket_service";
import { ErrorCategory } from "@pipedog/core/utils/errors";

import { CartesiaSTTService, type CartesiaSTTServiceOptions } from "../src/stt.ts";

// Snapshot before any test mocks the module: mock.module also changes the namespace object.
const originalWebsocketServiceModule = { ...websocketServiceModule };

// monkeypatch.setattr("pipecat.services.websocket_service.websocket_connect", ...)
function setWebsocketConnect(
  fake: (uri: string, options?: WebsocketConnectOptions) => Promise<unknown>,
): void {
  mock.module("@pipedog/core/services/websocket_service", () => ({
    ...originalWebsocketServiceModule,
    websocketConnect: fake,
  }));
}

afterEach(() => {
  mock.module("@pipedog/core/services/websocket_service", () => originalWebsocketServiceModule);
});

class _FakeWebsocket {
  state: State;
  send: ReturnType<typeof mock>;

  constructor(options: { state?: State; sendSideEffect?: Error | null } = {}) {
    this.state = options.state ?? State.OPEN;
    const sideEffect = options.sendSideEffect ?? null;
    this.send = mock(async (..._args: unknown[]) => {
      if (sideEffect) throw sideEffect;
    });
  }
}

/**
 * Stands in for `websockets.exceptions.InvalidStatus`, the exception
 * `websockets` raises when a handshake is rejected: it carries the HTTP
 * response with its status code.
 */
class InvalidStatus extends Error {
  response: { status_code: number };

  constructor(response: { status_code: number }) {
    super(`server rejected WebSocket connection: HTTP ${response.status_code}`);
    this.name = "InvalidStatus";
    this.response = response;
  }
}

/** Build the exception `websockets` raises when a handshake is rejected. */
function _websocketRejection(statusCode: number): InvalidStatus {
  return new InvalidStatus({ status_code: statusCode });
}

// Test access to protected members, as the Python tests do.
type Internals = {
  _websocket: WebsocketClientConnection | null;
  _sampleRate: number;
  _settings: InstanceType<typeof CartesiaSTTService.Settings>;
  _requestReconnect: () => Promise<void>;
  _updateSettings: (delta: unknown) => Promise<Record<string, unknown>>;
  _connectWebsocket: () => Promise<void>;
  pushFrame: (frame: Frame, ...args: unknown[]) => Promise<void>;
};

function internals(service: CartesiaSTTService): Internals {
  return service as unknown as Internals;
}

test("test_cartesia_connect_failure_clears_stale_websocket", async () => {
  setWebsocketConnect(async () => {
    throw new Error("connection failed");
  });

  const service = new CartesiaSTTService({ apiKey: "test-key", sampleRate: 16000 });
  internals(service)._websocket = new _FakeWebsocket({
    state: State.CLOSED,
  }) as unknown as WebsocketClientConnection;

  await internals(service)._connectWebsocket();

  expect(internals(service)._websocket).toBeNull();
});

/** Stub out the websocket connect and capture the URL it's called with. */
function _captureConnectUrl(): { url?: string; headers?: Record<string, string> } {
  const captured: { url?: string; headers?: Record<string, string> } = {};

  setWebsocketConnect(async (url, options = {}) => {
    captured.url = url;
    captured.headers = options.additionalHeaders;
    return new _FakeWebsocket();
  });
  return captured;
}

function _connectedService(options: Partial<CartesiaSTTServiceOptions> = {}): CartesiaSTTService {
  const service = new CartesiaSTTService({ apiKey: "test-key", sampleRate: 16000, ...options });
  // sample_rate is normally set from StartFrame, which these tests skip.
  internals(service)._sampleRate = 16000;
  return service;
}

/** `urllib.parse.parse_qs`: query parameter name -> list of values. */
function parseQs(query: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const values = result[key] ?? [];
    values.push(value);
    result[key] = values;
  }
  return result;
}

test("test_cartesia_connect_websocket_url_includes_keyterm", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({ model: "ink-2", keyterm: ["Cartesia", "Ink 2"] }),
  });

  await internals(service)._connectWebsocket();

  const parsed = new URL(captured.url!);
  const query = parseQs(parsed.search);
  expect(parsed.protocol).toEqual("wss:");
  expect(parsed.host).toEqual("api.cartesia.ai");
  expect(parsed.pathname).toEqual("/stt/websocket");
  expect(query.model).toEqual(["ink-2"]);
  expect(query.sample_rate).toEqual(["16000"]);
  expect(query.keyterm).toEqual(["Cartesia", "Ink 2"]);
  expect(captured.headers!["X-API-Key"]).toEqual("test-key");
});

test("test_cartesia_connect_websocket_url_encodes_keyterm_spaces_as_percent_20", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({ model: "ink-2", keyterm: ["Ink 2"] }),
  });

  await internals(service)._connectWebsocket();

  expect(captured.url).toContain("keyterm=Ink%202");
});

test("test_cartesia_connect_websocket_url_includes_keyterm_for_ink_preview", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({ model: "ink-preview", keyterm: ["Cartesia"] }),
  });

  await internals(service)._connectWebsocket();

  const query = parseQs(new URL(captured.url!).search);
  expect(query.model).toEqual(["ink-preview"]);
  expect(query.keyterm).toEqual(["Cartesia"]);
});

test("test_cartesia_connect_websocket_url_omits_keyterm_when_not_set", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService();

  await internals(service)._connectWebsocket();

  const query = parseQs(new URL(captured.url!).search);
  expect("keyterm" in query).toBe(false);
});

test("test_cartesia_connect_websocket_url_omits_keyterm_for_non_ink_2_model", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({ keyterm: ["Cartesia"] }),
  });

  await internals(service)._connectWebsocket();

  const query = parseQs(new URL(captured.url!).search);
  expect(query.model).toEqual(["ink-whisper"]);
  expect("keyterm" in query).toBe(false);
});

test("test_cartesia_connect_websocket_url_clamps_keyterms_to_limits", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({
      model: "ink-2",
      keyterm: Array.from({ length: 150 }, (_, i) => `term${i}`),
    }),
  });

  await internals(service)._connectWebsocket();

  const query = parseQs(new URL(captured.url!).search);
  expect(query.keyterm).toEqual(Array.from({ length: 100 }, (_, i) => `term${i}`));
});

test("test_cartesia_connect_websocket_url_clamps_keyterms_to_character_budget", async () => {
  const captured = _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({
      model: "ink-2",
      keyterm: ["a".repeat(700), "b".repeat(700), "c"],
    }),
  });

  await internals(service)._connectWebsocket();

  const query = parseQs(new URL(captured.url!).search);
  expect(query.keyterm).toEqual(["a".repeat(700)]);
});

test("test_cartesia_update_keyterm_reconnects", async () => {
  _captureConnectUrl();

  const service = _connectedService({
    settings: new CartesiaSTTService.Settings({ model: "ink-2", keyterm: ["Cartesia"] }),
  });
  const reconnect = mock(async () => {});
  internals(service)._requestReconnect = reconnect;

  await internals(service)._updateSettings(new CartesiaSTTService.Settings({ keyterm: ["Ink 2"] }));

  expect(internals(service)._settings.keyterm).toEqual(["Ink 2"]);
  expect(reconnect).toHaveBeenCalledTimes(1);
});

test("test_cartesia_run_stt_logs_send_failure_without_clearing_websocket", async () => {
  const service = new CartesiaSTTService({ apiKey: "test-key", sampleRate: 16000 });
  const websocket = new _FakeWebsocket({
    sendSideEffect: new Error("websocket closed"),
  }) as unknown as WebsocketClientConnection;
  internals(service)._websocket = websocket;

  for await (const _ of service.runStt(new Uint8Array(160))) {
    // drain
  }

  expect(internals(service)._websocket).toBe(websocket);
});

test("test_cartesia_rejected_api_key_makes_the_service_unusable", async () => {
  setWebsocketConnect(async () => {
    throw _websocketRejection(401);
  });

  const service = new CartesiaSTTService({ apiKey: "wrong-key", sampleRate: 16000 });

  await internals(service)._connectWebsocket();

  expect(service.isUsable).toBe(false);
});

test("test_cartesia_server_error_leaves_the_service_usable", async () => {
  setWebsocketConnect(async () => {
    throw _websocketRejection(503);
  });

  const service = new CartesiaSTTService({ apiKey: "test-key", sampleRate: 16000 });

  await internals(service)._connectWebsocket();

  expect(service.isUsable).toBe(true);
});

test("test_cartesia_classifies_the_rejection", async () => {
  setWebsocketConnect(async () => {
    throw _websocketRejection(401);
  });

  const service = new CartesiaSTTService({ apiKey: "wrong-key", sampleRate: 16000 });

  const errors: Frame[] = [];
  internals(service).pushFrame = mock(async (frame: Frame, ..._a: unknown[]) => {
    errors.push(frame);
  });

  await internals(service)._connectWebsocket();

  expect((errors[0] as ErrorFrame).category).toBe(ErrorCategory.AUTHENTICATION);
});
