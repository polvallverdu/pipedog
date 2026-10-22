// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_stt_connect_failure.py

/** Tests for a websocket STT service whose connect failed. */

import { expect, test } from "bun:test";

import { monotonic, sleep, type Task } from "@pipedog/asyncio";

import { ErrorFrame, type Frame, InputAudioRawFrame } from "../src/frames/frames.ts";
import { PipelineParams } from "../src/pipeline/worker.ts";
import type { FrameProcessorSetup } from "../src/processors/frame_processor.ts";
import { STTSettings } from "../src/services/settings.ts";
import {
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "../src/services/stt_service.ts";
import { State, type WebsocketClientConnection } from "../src/services/websocket_service.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";

const SAMPLE_RATE = 16000;

/** Python's built-in `ConnectionError`. */
class ConnectionError extends Error {
  override name = "ConnectionError";
}

/** An open websocket that never receives anything. */
class Websocket {
  state: State = State.OPEN;

  async send(_message: unknown): Promise<void> {}

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.state = State.CLOSED;
  }

  // biome-ignore lint/correctness/useYield: never receives anything.
  async *[Symbol.asyncIterator](): AsyncGenerator<never, void, unknown> {
    await sleep(3600);
  }
}

interface ConnectFailingSTTServiceOptions extends WebsocketSTTServiceOptions {
  failures: number;
}

/**
 * Connects the way websocket STT services do, failing the first `failures` times.
 *
 * A failed connect reports an error and leaves no websocket, and the receive
 * loop starts either way.
 */
class ConnectFailingSTTService extends WebsocketSTTService {
  _failures: number;
  connectAttempts = 0;
  _receiveTask: Task<void> | null = null;

  constructor(options: ConnectFailingSTTServiceOptions) {
    const { failures, ...rest } = options;
    super({ settings: new STTSettings({ model: null, language: null }), ...rest });
    this._failures = failures;
    this._reconnectBackoffMinWait = 0.05;
    this._reconnectBackoffMaxWait = 0.05;
  }

  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    yield null;
  }

  override async _connect(): Promise<void> {
    await super._connect();
    await this._connectWebsocket();
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();
    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }
    await this._disconnectWebsocket();
  }

  async _connectWebsocket(): Promise<void> {
    this.connectAttempts += 1;
    if (this.connectAttempts <= this._failures) {
      this._websocket = null;
      await this.pushError("Unable to connect", { exception: new ConnectionError("HTTP 503") });
      return;
    }
    this._websocket = new Websocket() as unknown as WebsocketClientConnection;
  }

  async _disconnectWebsocket(): Promise<void> {
    this._websocket = null;
  }

  async _receiveMessages(): Promise<void> {
    if (this._websocket === null) {
      throw new ConnectionError("not connected");
    }
    for await (const _ of this._websocket) {
      // Nothing to do.
    }
  }
}

async function _run(service: ConnectFailingSTTService, seconds = 0.5): Promise<[Frame[], Frame[]]> {
  const frames: Frame[] = [];
  for (let i = 0; i < Math.trunc(seconds * 50); i++) {
    frames.push(
      new InputAudioRawFrame({
        audio: new Uint8Array(2 * 320),
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
      }),
      new SleepFrame({ sleep: 0.02 }),
    );
  }
  return await runTest(service, {
    framesToSend: frames,
    expectedUpFrames: null,
    pipelineParams: new PipelineParams({ audioInSampleRate: SAMPLE_RATE }),
  });
}

test("test_failed_connect_is_retried_like_a_drop", async () => {
  const service = new ConnectFailingSTTService({ failures: 1, sampleRate: SAMPLE_RATE });

  await _run(service);

  expect(service.connectAttempts).toBe(2);
  expect(service.isUsable).toBe(true);
});

test("test_connect_that_keeps_failing_gives_up_as_permanent", async () => {
  // Unusable once the reconnect attempts run out, so a `ServiceSwitcher` can fail over.
  const service = new ConnectFailingSTTService({ failures: 100, sampleRate: SAMPLE_RATE });

  const [, up] = await _run(service);

  expect(service.connectAttempts).toBe(4);
  expect(service.isUsable).toBe(false);
  const errors = up.filter((frame) => frame instanceof ErrorFrame) as ErrorFrame[];
  expect(errors.at(-1)?.error).toContain("failed to reconnect after 3 attempts");
});

test("test_connected_service_is_not_reconnected", async () => {
  const service = new ConnectFailingSTTService({ failures: 0, sampleRate: SAMPLE_RATE });

  await _run(service);

  expect(service.connectAttempts).toBe(1);
  expect(service.isUsable).toBe(true);
});

test("test_failed_connect_is_not_retried_without_reconnect_on_error", async () => {
  const service = new ConnectFailingSTTService({
    failures: 100,
    sampleRate: SAMPLE_RATE,
    reconnectOnError: false,
  });

  await _run(service);

  expect(service.connectAttempts).toBe(1);
});

test("test_teardown_stops_a_reconnect_waiting_on_backoff", async () => {
  const service = new ConnectFailingSTTService({ failures: 100, sampleRate: SAMPLE_RATE });
  service._reconnectBackoffMinWait = 30;
  service._reconnectBackoffMaxWait = 30;

  const start = monotonic();
  await _run(service, 0.2);

  expect(monotonic() - start).toBeLessThan(5);
  expect(service.connectAttempts).toBe(2);
});

const SERVICES: [string, string, Record<string, unknown>][] = [
  ["aws.stt", "AWSTranscribeSTTService", { region: "us-east-1" }],
  ["meta.stt", "MetaSTTService", {}],
  ["openai.stt", "OpenAIRealtimeSTTService", {}],
  ["together.stt", "TogetherSTTService", {}],
  ["xai.stt", "XAISTTService", {}],
];

// The receive loop is what retries, so it starts even without a websocket.
// Each provider lives in its own package (`@pipedog/<provider>`). assemblyai, gladia and soniox run
// their case in their own package tests; the rest are not ported yet.
for (const [module, name] of SERVICES) {
  const provider = module.split(".")[0];
  test.todo(
    `test_failed_connect_starts_the_receive_loop[${module}-${name}] (needs unported services/${module.replace(".", "/")} in @pipedog/${provider})`,
  );
}
