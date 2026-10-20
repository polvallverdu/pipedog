// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_tts_keepalive.py

/** Tests for the WebsocketTTSService keepalive. */

import { expect, test } from "bun:test";
import { sleep, type Task, timeout } from "@pipedog/asyncio";
import type { Frame } from "../src/frames/frames.ts";
import { WebsocketTTSService } from "../src/services/tts_service.ts";
import {
  ConnectionClosedError,
  State,
  type WebsocketClientConnection,
} from "../src/services/websocket_service.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const KEEPALIVE_INTERVAL = 0.01;

/** Minimal websocket TTS service that records its keepalives. */
class KeepaliveTTSService extends WebsocketTTSService {
  keepalives = 0;
  failuresLeft = 0;

  // Widen the protected keepalive API to public so the tests can drive it,
  // as the Python tests access the underscored members directly.
  declare public _keepaliveTask: Task<unknown> | null;

  override _createKeepaliveTask(interval: number): void {
    super._createKeepaliveTask(interval);
  }

  override async _cancelKeepaliveTask(): Promise<void> {
    await super._cancelKeepaliveTask();
  }

  override async *runTts(_text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    yield null;
  }

  override async _connectWebsocket(): Promise<void> {}

  override async _disconnectWebsocket(): Promise<void> {}

  override async _receiveMessages(): Promise<void> {}

  protected override async _sendKeepalive(): Promise<void> {
    if (this.failuresLeft) {
      this.failuresLeft -= 1;
      throw new ConnectionClosedError(null, "");
    }
    this.keepalives += 1;
  }
}

function _service(): KeepaliveTTSService {
  const service = new KeepaliveTTSService({ taskManager: new TaskManager() });
  // Stand-in for MagicMock(state=State.OPEN).
  service._websocket = { state: State.OPEN } as unknown as WebsocketClientConnection;
  return service;
}

function _setWebsocketState(service: KeepaliveTTSService, state: State): void {
  (service._websocket as unknown as { state: State }).state = state;
}

async function _waitForKeepalives(service: KeepaliveTTSService, count: number): Promise<void> {
  await timeout(1, async () => {
    while (service.keepalives < count) {
      await sleep(KEEPALIVE_INTERVAL);
    }
  });
}

/** Keepalives are sent every interval while the websocket is open. */
test("test_keepalive_sent_periodically", async () => {
  const service = _service();
  service._createKeepaliveTask(KEEPALIVE_INTERVAL);
  try {
    await _waitForKeepalives(service, 3);
  } finally {
    await service._cancelKeepaliveTask();
  }
  expect(service._keepaliveTask).toBeNull();
});

/** A failed send is logged and later keepalives still go out. */
test("test_keepalive_survives_failed_send", async () => {
  const service = _service();
  service.failuresLeft = 2;
  service._createKeepaliveTask(KEEPALIVE_INTERVAL);
  try {
    await _waitForKeepalives(service, 2);
    expect(service.failuresLeft).toBe(0);
    expect(service._keepaliveTask!.done()).toBe(false);
  } finally {
    await service._cancelKeepaliveTask();
  }
});

/** No keepalive is sent while the websocket is closed, and sending resumes once it reopens. */
test("test_keepalive_skipped_while_websocket_not_open", async () => {
  const service = _service();
  _setWebsocketState(service, State.CLOSED);
  service._createKeepaliveTask(KEEPALIVE_INTERVAL);
  try {
    await sleep(KEEPALIVE_INTERVAL * 5);
    expect(service.keepalives).toBe(0);
    _setWebsocketState(service, State.OPEN);
    await _waitForKeepalives(service, 1);
  } finally {
    await service._cancelKeepaliveTask();
  }
});

/** Creating the task while one is running leaves the running task in place. */
test("test_create_keepalive_task_keeps_running_task", async () => {
  const service = _service();
  service._createKeepaliveTask(KEEPALIVE_INTERVAL);
  const task = service._keepaliveTask;
  try {
    service._createKeepaliveTask(KEEPALIVE_INTERVAL);
    expect(service._keepaliveTask).toBe(task);
  } finally {
    await service._cancelKeepaliveTask();
  }
});

/** A finished keepalive task is replaced by a new one. */
test("test_create_keepalive_task_replaces_finished_task", async () => {
  const service = _service();

  async function finished(): Promise<void> {}

  service._keepaliveTask = service.createTask(() => finished(), "finished");
  await service._keepaliveTask;
  service._createKeepaliveTask(KEEPALIVE_INTERVAL);
  try {
    expect(service._keepaliveTask!.done()).toBe(false);
    await _waitForKeepalives(service, 1);
  } finally {
    await service._cancelKeepaliveTask();
  }
});
