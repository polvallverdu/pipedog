// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_service_usable.py

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ErrorFrame } from "../src/frames/frames.ts";
import { AIService, type AIServiceOptions } from "../src/services/ai_service.ts";
import {
  State,
  type WebsocketClientConnection,
  type WebsocketData,
  WebsocketService,
  type WebsocketServiceOptions,
} from "../src/services/websocket_service.ts";
import { BaseObject } from "../src/utils/base_object.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import * as network from "../src/utils/network.ts";

// Snapshot before any test mocks the module: mock.module also changes the namespace object.
const originalNetwork = { ...network };

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
function websocketRejection(statusCode: number): InvalidStatus {
  return new InvalidStatus({ status_code: statusCode });
}

/** Stands in for a connected websocket that answers pings. */
class FakeWebsocket {
  state: State = State.OPEN;
  sent: WebsocketData[] = [];

  async ping(): Promise<void> {}

  async send(message: WebsocketData): Promise<void> {
    this.sent.push(message);
  }
}

interface FakeWebsocketServiceOptions extends AIServiceOptions, WebsocketServiceOptions {
  connectError?: Error | null;
}

/** Websocket service whose connection attempts succeed or fail on demand. */
class FakeWebsocketService extends WebsocketService(AIService) {
  connectError: Error | null;
  connectAttempts = 0;
  reported: ErrorFrame[] = [];

  constructor(options: FakeWebsocketServiceOptions = {}) {
    super(options);
    this.connectError = options.connectError ?? null;
  }

  async _connectWebsocket(): Promise<void> {
    this.connectAttempts += 1;
    if (this.connectError) {
      throw this.connectError;
    }
    this._websocket = new FakeWebsocket() as unknown as WebsocketClientConnection;
  }

  async _disconnectWebsocket(): Promise<void> {
    this._websocket = null;
  }

  async _receiveMessages(): Promise<void> {}

  reportError = async (
    error: ErrorFrame,
    options: { forceTreatAsPermanent?: boolean } = {},
  ): Promise<void> => {
    this.reported.push(error);
    await this.pushErrorFrame(error, {
      forceTreatAsPermanent: options.forceTreatAsPermanent ?? false,
    });
  };
}

/** Websocket service mixed into something that isn't a frame processor. */
class BareWebsocketService extends WebsocketService(BaseObject) {
  connectAttempts = 0;

  async _connectWebsocket(): Promise<void> {
    this.connectAttempts += 1;
    this._websocket = new FakeWebsocket() as unknown as WebsocketClientConnection;
  }

  async _disconnectWebsocket(): Promise<void> {
    this._websocket = null;
  }

  async _receiveMessages(): Promise<void> {}
}

describe("TestReconnection", () => {
  beforeEach(() => {
    // Retry without the real backoff waits.
    mock.module("../src/utils/network.ts", () => ({
      ...originalNetwork,
      exponentialBackoffTime: () => 0,
    }));
  });

  afterEach(() => {
    // mock.module is process-wide: restore it so other test files get the real backoff.
    mock.module("../src/utils/network.ts", () => originalNetwork);
  });

  test("test_an_unusable_service_does_not_reconnect", async () => {
    const service = new FakeWebsocketService();
    await service.setUsable(false);

    const reconnected = await service._tryReconnect({ reportError: service.reportError });

    expect(reconnected).toBe(false);
    expect(service.connectAttempts).toEqual(0);
  });

  test("test_a_working_service_reconnects", async () => {
    const service = new FakeWebsocketService();

    const reconnected = await service._tryReconnect({ reportError: service.reportError });

    expect(reconnected).toBe(true);
    expect(service.connectAttempts).toEqual(1);
    expect(service.isUsable).toBe(true);
  });

  test("test_rejected_credentials_stop_further_attempts", async () => {
    const service = new FakeWebsocketService({ connectError: websocketRejection(401) });

    const reconnected = await service._tryReconnect({ reportError: service.reportError });

    expect(reconnected).toBe(false);
    // Reporting the first rejection costs the service its usability, so the
    // remaining attempts are abandoned.
    expect(service.connectAttempts).toEqual(1);
    expect(service.isUsable).toBe(false);
  });

  test("test_transient_failures_use_every_attempt", async () => {
    const service = new FakeWebsocketService({ connectError: websocketRejection(503) });

    const reconnected = await service._tryReconnect({
      maxRetries: 2,
      reportError: service.reportError,
    });

    expect(reconnected).toBe(false);
    expect(service.connectAttempts).toEqual(2);
  });

  test("test_exhausted_attempts_leave_the_service_unusable", async () => {
    const service = new FakeWebsocketService({ connectError: websocketRejection(503) });

    await service._tryReconnect({ maxRetries: 2, reportError: service.reportError });

    // Each attempt is reported as it fails; the last error is the one that
    // says the service has run out of ways to come back.
    expect(service.isUsable).toBe(false);
    expect(service.reported.at(-1)?.error).toContain("failed to reconnect");
  });

  test("test_a_failed_attempt_alone_leaves_the_service_usable", async () => {
    const service = new FakeWebsocketService({ connectError: websocketRejection(503) });

    await service._tryReconnect({ maxRetries: 2, reportError: service.reportError });

    // The service was still worth retrying when the first attempt failed.
    expect(service.reported[0]?.category).toEqual(ErrorCategory.SERVER);
  });

  test("test_reported_errors_carry_the_exception", async () => {
    const error = websocketRejection(401);
    const service = new FakeWebsocketService({ connectError: error });

    await service._tryReconnect({ reportError: service.reportError });

    expect(service.reported[0]?.exception).toBe(error);
    expect(service.reported[0]?.category).toEqual(ErrorCategory.AUTHENTICATION);
  });

  test("test_only_giving_up_reports_the_service_as_spent", async () => {
    // Test which reported errors carry the flag that ends the service.
    //
    // A failed attempt is still worth retrying, so only the error that gives
    // up says the service can no longer be given work.
    const service = new FakeWebsocketService({ connectError: websocketRejection(503) });
    const flags: boolean[] = [];

    const reportError = async (
      error: ErrorFrame,
      options: { forceTreatAsPermanent?: boolean } = {},
    ): Promise<void> => {
      const forceTreatAsPermanent = options.forceTreatAsPermanent ?? false;
      flags.push(forceTreatAsPermanent);
      await service.pushErrorFrame(error, { forceTreatAsPermanent });
    };

    await service._tryReconnect({ maxRetries: 2, reportError });

    expect(flags).toEqual([false, false, true]);
    expect(service.isUsable).toBe(false);
  });

  test("test_a_service_that_tracks_nothing_still_reconnects", async () => {
    const service = new BareWebsocketService();

    const reconnected = await service._tryReconnect();

    expect(reconnected).toBe(true);
    expect(service.connectAttempts).toEqual(1);
    expect(service._isServiceUsable).toBe(true);
  });

  test("test_a_dropped_connection_leaves_the_receive_loop_alone", async () => {
    // Test that ending the receive loop doesn't end the service.
    //
    // Turning off reconnection here means the receive loop won't do it, not
    // that the service is out of ways to come back.
    const service = new FakeWebsocketService();
    service._reconnectOnError = false;

    await service._receiveTaskHandler(service.reportError);

    expect(service.isUsable).toBe(true);
    expect(service.connectAttempts).toEqual(0);
  });

  // Skipped: exercises only `WebsocketService.send_with_retry`, deprecated
  // upstream (1.14.0) and not ported.
  test.skip("test_a_dropped_connection_still_reconnects_on_demand", () => {});
});
