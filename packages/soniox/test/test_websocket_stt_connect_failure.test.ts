// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_stt_connect_failure.py

/**
 * The Soniox case of `test_failed_connect_starts_the_receive_loop`.
 *
 * The rest of upstream's file is ported in `@pipedog/core`
 * (`packages/core/test/test_websocket_stt_connect_failure.test.ts`); the
 * parametrized case lives with each provider's package because core cannot
 * import the provider packages.
 *
 * Porting notes:
 * - Upstream patches `create_task` to record the coroutine's name; a TypeScript
 *   task is a thunk, so the test runs it far enough to see which handler it
 *   starts by recording the method the thunk calls (`_receiveTaskHandler`).
 */

import { expect, test } from "bun:test";
import { SonioxSTTService } from "../src/stt.ts";

test("test_failed_connect_starts_the_receive_loop[soniox.stt-SonioxSTTService]", async () => {
  // The receive loop is what retries, so it starts even without a websocket.
  const service = new SonioxSTTService({ apiKey: "test-key" });
  const svc = service as any;
  const started: string[] = [];

  svc.createTask = (_fn: () => unknown, _name?: string) => {
    // The thunk is `() => this._receiveTaskHandler(...)`: run it with the
    // handler swapped for a recorder instead of a real loop.
    const original = svc._receiveTaskHandler;
    svc._receiveTaskHandler = async () => {
      started.push("_receive_task_handler");
    };
    try {
      _fn();
    } finally {
      svc._receiveTaskHandler = original;
    }
    return null;
  };
  svc.pushError = async () => {};
  svc._websocketConnect = async () => {
    const error = new Error("Connection refused") as Error & { code?: number };
    error.name = "ConnectionRefusedError";
    throw error;
  };

  await svc._connect();

  expect(svc._websocket).toBeNull();
  expect(started).toContain("_receive_task_handler");
});
