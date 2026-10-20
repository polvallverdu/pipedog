// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_daily_transport_service.py

import { describe, expect, test } from "bun:test";

describe("TestDailyTransport", () => {
  // Skipped upstream: @unittest.skip("FIXME: This test is failing").
  // Upstream it imports `pipecat.transports.daily_transport` (a module path that no
  // longer exists; DailyTransport now lives in transports/daily/transport.py, ported
  // to @pipecat-ts/transport-daily) and calls `on_first_other_participant_joined`,
  // which is no longer a DailyTransport method/event. The import is dynamic so this
  // file loads without the unported transport-daily package.
  test.skip("test_event_handler", async () => {
    // @pipecat-ts/transport-daily is not ported yet.
    const modulePath = "../../transport-daily/src/transport.ts";
    const { DailyTransport } = (await import(modulePath)) as any;

    const transport = new DailyTransport("mock.daily.co/mock", "token", "bot");

    let wasCalled = false;

    transport.eventHandler(
      "on_first_other_participant_joined",
      (_transport: unknown, _participant: unknown) => {
        wasCalled = true;
      },
    );

    transport.onFirstOtherParticipantJoined({ id: "user-id" });

    expect(wasCalled).toBe(true);
  });

  // Upstream also contains `test_event_handler_async` and
  // `test_run_with_camera_and_mic`, but only as commented-out string literals
  // (dead code referencing the removed `pipecat.services.daily_transport_service`),
  // so there is nothing to port.
});
