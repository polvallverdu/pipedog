// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_stt_connect_failure.py

/**
 * The AssemblyAI case of `test_failed_connect_starts_the_receive_loop`.
 *
 * The other tests in upstream's file exercise a core test double and are
 * ported in `@pipedog/core`. This file covers the provider parametrization
 * that lives in this package.
 *
 * Porting notes:
 * - `patch("pipecat.services.websocket_service.websocket_connect", fail_connect)`
 *   becomes replacing the instance's `_websocketConnect`.
 * - Python records the started coroutine's `__name__`; here `createTask` is
 *   given the task name, `_receive_task_handler`.
 */

import { expect, test } from "bun:test";
import { AssemblyAISTTService } from "../src/stt.ts";

class ConnectionRefusedError extends Error {
  override name = "ConnectionRefusedError";
}

test("test_failed_connect_starts_the_receive_loop[assemblyai.stt-AssemblyAISTTService]", async () => {
  // The receive loop is what retries, so it starts even without a websocket.
  const service = new AssemblyAISTTService({ apiKey: "test-key" });
  const started: (string | null | undefined)[] = [];

  (service as any).createTask = (_fn: unknown, name?: string | null) => {
    started.push(name);
    return null;
  };
  (service as any).pushError = async () => {};
  (service as any)._websocketConnect = async () => {
    throw new ConnectionRefusedError("[Errno 111] Connection refused");
  };

  await (service as any)._connect();

  expect((service as any)._websocket).toBeNull();
  expect(started).toContain("_receive_task_handler");
});
