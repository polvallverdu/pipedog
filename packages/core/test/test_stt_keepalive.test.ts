// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_stt_keepalive.py

/** Tests for the STTService keepalive. */

import { expect, test } from "bun:test";

import { sleep, timeout } from "@pipecat-ts/asyncio";

import type { Frame } from "../src/frames/frames.ts";
import { STTService, type STTServiceOptions } from "../src/services/stt_service.ts";
import { ConnectionClosedError } from "../src/services/websocket_service.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

const KEEPALIVE_INTERVAL = 0.01;

/** Minimal STT service that records its keepalives. */
class KeepaliveSTTService extends STTService {
  keepalives = 0;
  failuresLeft = 0;

  constructor(options: STTServiceOptions = {}) {
    super({
      keepaliveTimeout: KEEPALIVE_INTERVAL,
      keepaliveInterval: KEEPALIVE_INTERVAL,
      ...options,
    });
  }

  async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    yield null;
  }

  protected override async _sendKeepalive(_silence: Uint8Array): Promise<void> {
    if (this.failuresLeft) {
      this.failuresLeft -= 1;
      throw new ConnectionClosedError(null, "");
    }
    this.keepalives += 1;
  }
}

/** Access to the protected members the upstream test touches directly. */
type KeepaliveInternals = {
  _taskManager: TaskManager | null;
  _sampleRate: number;
  _keepaliveTask: { done(): boolean } | null;
  _createKeepaliveTask(): void;
  _cancelKeepaliveTask(): Promise<void>;
};

test("test_keepalive_survives_failed_send", async () => {
  // A failed send is logged and later keepalives still go out.
  const service = new KeepaliveSTTService();
  const internals = service as unknown as KeepaliveInternals;
  internals._taskManager = new TaskManager();
  internals._sampleRate = 16000;
  service.failuresLeft = 2;
  internals._createKeepaliveTask();
  try {
    await timeout(1, async () => {
      while (service.keepalives < 2) {
        await sleep(KEEPALIVE_INTERVAL);
      }
    });
    expect(service.failuresLeft).toBe(0);
    expect(internals._keepaliveTask!.done()).toBe(false);
  } finally {
    await internals._cancelKeepaliveTask();
  }
});
