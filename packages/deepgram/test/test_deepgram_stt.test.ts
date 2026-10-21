// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_deepgram_stt.py

/**
 * Porting notes:
 * - Upstream's `connect()` returns an async context manager; here it returns a
 *   promise of the connection, so `_failing_connect_cm(exc)` is a connect that
 *   rejects with `exc`, and `_dropping_connect_cm(exc)` resolves to a
 *   connection whose `startListening()` rejects. The TS service closes the
 *   connection itself (`connection.close()`), so fakes provide `close()`.
 * - The SDK's `ApiError(status_code=...)` is `DeepgramApiError(message, statusCode)`.
 * - `monkeypatch.setattr("...stt.exponential_backoff_time" | "...stt.time" |
 *   "...stt.asyncio.sleep", ...)` → `mock.module()` on the module the service
 *   imports the name from, restored after each test.
 * - `DeepgramSTTService.__new__(...)` → `Object.create(DeepgramSTTService.prototype)`.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported locally.
 * - Results messages are the parsed JSON objects, not SDK models.
 */

import { afterEach, expect, mock, test } from "bun:test";
import * as asyncioModule from "@pipedog/asyncio";
import {
  CancelledError,
  createTask,
  Event,
  gatherSettled,
  sleep,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  InterimTranscriptionFrame,
  MetricsFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import {
  type BaseTaskManager,
  getRunningLoop,
  TaskManager,
} from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import * as networkModule from "@pipedog/core/utils/network";
import { QuickFailureTracker } from "@pipedog/core/utils/network";
import { _deriveDeepgramUrls, DeepgramApiError, DeepgramSTTService } from "../src/stt.ts";

// Snapshots taken before any test mocks the modules: mock.module also changes the namespace object.
const originalAsyncioModule = { ...asyncioModule };
const originalNetworkModule = { ...networkModule };

afterEach(() => {
  mock.module("@pipedog/asyncio", () => originalAsyncioModule);
  mock.module("@pipedog/core/utils/network", () => originalNetworkModule);
});

// monkeypatch.setattr("pipecat.services.deepgram.stt.exponential_backoff_time", ...)
function patchExponentialBackoffTime(fake: (attempt: number) => number): void {
  mock.module("@pipedog/core/utils/network", () => ({
    ...originalNetworkModule,
    exponentialBackoffTime: fake,
  }));
}

// monkeypatch.setattr("pipecat.services.deepgram.stt.time", fake_time) / "...asyncio.sleep"
function patchAsyncio(overrides: Partial<typeof asyncioModule>): void {
  mock.module("@pipedog/asyncio", () => ({ ...originalAsyncioModule, ...overrides }));
}

/** A fake `time.monotonic` returning `values` in turn (StopIteration when exhausted). */
function fakeMonotonic(values: number[]): () => number {
  const it = values[Symbol.iterator]();
  return () => {
    const next = it.next();
    if (next.done) throw new Error("StopIteration");
    return next.value;
  };
}

/** Python's built-in `ConnectionError`. */
class ConnectionError extends Error {
  override name = "ConnectionError";
}

type AnyService = any;

/** Collect log messages emitted while the sink is installed (`logger.add(sink, format="{message}")`). */
function captureLogs(): { value: () => string; remove: () => void } {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    messages.push(record.message);
  });
  return { value: () => messages.join("\n"), remove };
}

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

/**
 * Build a DeepgramSTTService without running the constructor, wiring just
 * enough for _connectionHandler() to run: a real createTask/cancelTask pair
 * (so the keepalive task is properly started and torn down) and mocked
 * pushError/_buildConnectKwargs.
 */
function _makeBareService(): AnyService {
  const service: AnyService = Object.create(DeepgramSTTService.prototype);
  service._name = "DeepgramSTTService";
  service._connection = null;
  service._connectionSettled = new Event();
  service._quickFailureTracker = new QuickFailureTracker();
  service._buildConnectKwargs = mock(() => ({}));
  service.pushError = mock(async (..._args: unknown[]) => {});
  service.createTask = (coro: () => Promise<unknown>, _name?: string) => createTask(coro);

  service.cancelTask = async (task: Task<unknown>, _timeout?: number | null) => {
    task.cancel();
    try {
      await task;
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  };
  return service;
}

function _failingConnectCm(exc: Error): () => Promise<never> {
  return async () => {
    throw exc;
  };
}

/** A connect that completes the handshake and then loses the connection. */
function _droppingConnectCm(exc: Error): () => Promise<unknown> {
  return async () => ({
    on: mock(() => {}),
    startListening: mock(async () => {
      throw exc;
    }),
    sendKeepAlive: mock(async () => {}),
    sendCloseStream: mock(async () => {}),
    close: mock(async () => {}),
  });
}

/** `MagicMock(side_effect=[...])`: each call runs the next implementation. */
function sideEffects(impls: Array<() => Promise<unknown>>): ReturnType<typeof mock> {
  let i = 0;
  return mock((..._args: unknown[]) => {
    if (i >= impls.length) throw new Error("StopIteration");
    return impls[i++]!();
  });
}

function mockClient(connect: ReturnType<typeof mock>): AnyService {
  return { listen: { v1: { connect } } };
}

const deriveCases: Array<[string, string, string]> = [
  // Secure schemes
  ["wss://mydeepgram.com", "wss://mydeepgram.com", "https://mydeepgram.com"],
  ["https://mydeepgram.com", "wss://mydeepgram.com", "https://mydeepgram.com"],
  // Insecure schemes (air-gapped deployments)
  ["ws://mydeepgram.com", "ws://mydeepgram.com", "http://mydeepgram.com"],
  ["http://mydeepgram.com", "ws://mydeepgram.com", "http://mydeepgram.com"],
  // Bare hostname defaults to secure
  ["mydeepgram.com", "wss://mydeepgram.com", "https://mydeepgram.com"],
  // With port
  ["ws://localhost:8080", "ws://localhost:8080", "http://localhost:8080"],
  ["wss://localhost:443", "wss://localhost:443", "https://localhost:443"],
  ["localhost:8080", "wss://localhost:8080", "https://localhost:8080"],
  // With path
  ["wss://host/v1/listen", "wss://host/v1/listen", "https://host/v1/listen"],
  ["http://host/v1/listen", "ws://host/v1/listen", "http://host/v1/listen"],
];

test.each(deriveCases)(
  "test_derive_deepgram_urls[%s-%s-%s]",
  (baseUrl, expectedWs, expectedHttp) => {
    const [wsUrl, httpUrl] = _deriveDeepgramUrls(baseUrl);
    expect(wsUrl).toBe(expectedWs);
    expect(httpUrl).toBe(expectedHttp);
  },
);

test("test_derive_deepgram_urls_unknown_scheme_warns", () => {
  const sink = captureLogs();
  try {
    const [wsUrl, httpUrl] = _deriveDeepgramUrls("ftp://mydeepgram.com");
    // Falls back to secure
    expect(wsUrl).toBe("wss://mydeepgram.com");
    expect(httpUrl).toBe("https://mydeepgram.com");
    expect(sink.value()).toContain("Unrecognized scheme");
  } finally {
    sink.remove();
  }
});

test("test_run_stt_send_media_exception_clears_connection", async () => {
  // send_media() failure should log a warning and clear this._connection.
  const service: AnyService = Object.create(DeepgramSTTService.prototype);
  service._name = "DeepgramSTTService";

  const mockConnection = {
    sendMedia: mock(async (_audio: Uint8Array) => {
      throw new Error("websocket closed");
    }),
  };
  service._connection = mockConnection;

  const sink = captureLogs();
  try {
    for await (const _ of service.runStt(new Uint8Array(160))) {
      // drain
    }

    expect(service._connection).toBeNull();
    expect(sink.value()).toContain("send_media failed");
  } finally {
    sink.remove();
  }
});

test("test_run_stt_skips_send_when_connection_is_none", async () => {
  // When this._connection is null, runStt should silently skip.
  const service: AnyService = Object.create(DeepgramSTTService.prototype);
  service._connection = null;

  // Should not raise
  for await (const _ of service.runStt(new Uint8Array(160))) {
    // drain
  }

  expect(service._connection).toBeNull();
});

test("test_connection_handler_gives_up_immediately_on_4xx_api_error", async () => {
  // A 4xx ApiError (e.g. invalid API key) should stop retrying after a single
  // attempt and report the error.
  const service = _makeBareService();
  const connect = mock(_failingConnectCm(new DeepgramApiError("invalid credentials", 401)));
  service._client = mockClient(connect);

  await service._connectionHandler();

  expect(connect).toHaveBeenCalledTimes(1);
  expect(service.pushError).toHaveBeenCalledTimes(1);
});

test("test_connection_handler_gives_up_after_max_quick_failures", async () => {
  // Repeated fast failures (e.g. network errors) should stop retrying after
  // maxConsecutiveFailures in a row, with backoff between attempts.
  patchExponentialBackoffTime(() => 0);
  const service = _makeBareService();
  const maxFailures: number = service._quickFailureTracker.maxConsecutiveFailures;
  const connect = sideEffects(
    Array.from({ length: maxFailures }, () => _failingConnectCm(new ConnectionError("boom"))),
  );
  service._client = mockClient(connect);

  await service._connectionHandler();

  expect(connect).toHaveBeenCalledTimes(maxFailures);
  // One pushError per failed attempt, plus a final give-up error.
  expect(service.pushError).toHaveBeenCalledTimes(maxFailures + 1);
});

test("test_connection_handler_resets_quick_failure_count_after_stable_connection", async () => {
  // A connection that stays up longer than minStableDuration should reset the
  // quick-failure counter, so a prior near-miss doesn't count against the next
  // round of failures.
  patchExponentialBackoffTime(() => 0);
  const service = _makeBareService();
  // Simulate having already accumulated near-cap quick failures before a
  // stable connection came up.
  service._quickFailureTracker.count = service._quickFailureTracker.maxConsecutiveFailures - 1;

  // Only the attempt that connects is timed, from the handshake to the drop.
  patchAsyncio({ monotonic: fakeMonotonic([0, 10]) });

  const connect = sideEffects([
    _droppingConnectCm(new ConnectionError("stable then dropped")),
    _failingConnectCm(new ConnectionError("quick 1")),
    _failingConnectCm(new ConnectionError("quick 2")),
    _failingConnectCm(new ConnectionError("quick 3")),
  ]);
  service._client = mockClient(connect);

  await service._connectionHandler();

  // If the counter had NOT been reset after the stable connection, giving up
  // would have happened after just 1 more quick failure (2 total attempts).
  expect(connect).toHaveBeenCalledTimes(4);
});

test("test_connection_handler_gives_up_on_handshakes_that_fail_slowly", async () => {
  // A handshake that hangs before failing is a failure, however long it took.
  //
  // Timing the attempt rather than the connection reads these as healthy and
  // retries them forever.
  patchExponentialBackoffTime(() => 0);
  const service = _makeBareService();
  const maxFailures: number = service._quickFailureTracker.maxConsecutiveFailures;

  // Every attempt takes far longer than minStableDuration before failing.
  patchAsyncio({ monotonic: fakeMonotonic([0, 10, 10, 20, 20, 30, 30, 40, 40, 50]) });

  const connect = sideEffects(
    Array.from({ length: 8 }, () => _failingConnectCm(new ConnectionError("timed out"))),
  );
  service._client = mockClient(connect);

  await service._connectionHandler();

  expect(connect).toHaveBeenCalledTimes(maxFailures);
});

test("test_connect_returns_once_the_connection_is_given_up_on", async () => {
  // Connecting happens while the service is set up, so a connection that is
  // never going to come up has to finish setting up rather than hold it open.
  const service = _makeBareService();
  const connect = mock(_failingConnectCm(new DeepgramApiError("invalid credentials", 401)));
  service._client = mockClient(connect);

  await waitFor(service._connect(), 5);

  expect(service._connection).toBeNull();
});

test("test_connection_handler_backs_off_after_non_quick_failure", async () => {
  // A failure that isn't a quick failure (lasted >= minStableDuration) must
  // still back off before retrying, instead of busy-looping with no delay.
  const sleepCalls: number[] = [];

  const fakeSleep = async (duration: number): Promise<void> => {
    sleepCalls.push(duration);
    if (sleepCalls.length >= 2) {
      // Stand in for the task being cancelled, e.g. by _disconnect(), so the
      // `while (true)` loop under test terminates.
      throw new CancelledError();
    }
  };

  const service = _makeBareService();

  // Each attempt "lasts" 10s (>= minStableDuration), so is never a quick failure.
  patchAsyncio({ sleep: fakeSleep, monotonic: fakeMonotonic([0, 10, 10, 20, 20, 30]) });

  const connect = sideEffects([
    _failingConnectCm(new ConnectionError("drop 1")),
    _failingConnectCm(new ConnectionError("drop 2")),
    _failingConnectCm(new ConnectionError("drop 3")),
  ]);
  service._client = mockClient(connect);

  try {
    await service._connectionHandler();
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
  }

  expect(sleepCalls).toEqual([4, 4]); // exponentialBackoffTime's minWait, not skipped
});

function _resultsMessage(transcript: string, isFinal: boolean): Record<string, unknown> {
  return {
    type: "Results",
    channel_index: [0, 1],
    duration: 1.2,
    start: 0.0,
    is_final: isFinal,
    speech_final: isFinal,
    channel: {
      alternatives: [{ transcript, confidence: 0.99, words: [] }],
    },
    metadata: {
      request_id: "req-123",
      model_info: { name: "n", version: "v", arch: "a" },
      model_uuid: "u",
    },
  };
}

test("test_final_transcript_emits_usage_before_transcription_frame", async () => {
  const service: AnyService = new DeepgramSTTService({ apiKey: "test-key" });
  service._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: true });
  const pushedFrames: unknown[] = [];

  service.pushFrame = async (frame: unknown, _direction?: unknown) => {
    pushedFrames.push(frame);
  };

  // Simulate audio previously submitted to the service.
  service._sttUsagePendingSeconds = 1.25;

  // Interim results must not emit usage.
  await service._onMessage(_resultsMessage("hello", false));
  expect(pushedFrames.map((f) => (f as object).constructor)).toEqual([InterimTranscriptionFrame]);

  // A final transcript emits usage before the TranscriptionFrame so tracing
  // can attach it to the span the frame closes.
  await service._onMessage(_resultsMessage("hello world", true));

  const frameTypes = pushedFrames.map((f) => (f as object).constructor);
  expect(frameTypes).toEqual([InterimTranscriptionFrame, MetricsFrame, TranscriptionFrame]);

  const data = (pushedFrames[1] as MetricsFrame).data[0];
  expect(data).toBeInstanceOf(STTUsageMetricsData);
  expect((data as STTUsageMetricsData).value.audioSeconds).toBe(1.25);
  expect(service._sttUsagePendingSeconds).toBe(0.0);
});

test("test_connection_handler_does_not_reconnect_after_cancel", async () => {
  // A cancelled `_connectionHandler` must die, not loop and reconnect.
  //
  // `_connectionHandler` is a `while (true)` reconnect loop whose `finally`
  // block awaits `cancelTask(keepaliveTask)`. Pipeline teardown can cancel the
  // connection task while it is suspended in that `finally` — right after a
  // mid-call network drop, with the keepalive blocked on the dead socket — and
  // a handler that survived would reconnect to Deepgram unsupervised.
  //
  // The service is wired to a real `TaskManager` by hand so that the handler
  // runs its own `finally` against the real `cancelTask`; the fake SDK client
  // keeps the network out of it.
  const taskManager = new TaskManager({ loop: getRunningLoop() });

  const service: AnyService = new DeepgramSTTService({ apiKey: "fake-key-offline-test" });
  service.createTask = (coro: () => Promise<unknown>, name = "deepgram-test") =>
    taskManager.createTask(coro, name);
  service.cancelTask = (task: Task<unknown>, timeout?: number | null) =>
    taskManager.cancelTask(task, timeout);

  const dropEvent = new Event();
  let connectCalls = 0;

  class FakeConnection {
    #drops: boolean;

    constructor(drops: boolean) {
      this.#drops = drops;
    }

    on(..._args: unknown[]): void {}

    async startListening(): Promise<void> {
      if (this.#drops) {
        await dropEvent.wait();
        throw new ConnectionError("simulated mid-call network drop");
      }
      await new Event().wait(); // reconnected socket: idle forever
    }

    async sendCloseStream(..._args: unknown[]): Promise<void> {}

    async sendKeepAlive(..._args: unknown[]): Promise<void> {}

    async close(): Promise<void> {}
  }

  const fakeConnect = async (..._args: unknown[]) => {
    connectCalls += 1;
    return new FakeConnection(connectCalls === 1);
  };

  service._client = { listen: { v1: { connect: fakeConnect } } };

  // Keepalive whose cancellation takes a while to complete — models the real
  // keepalive blocked mid `sendKeepAlive()` on a just-dropped socket. This
  // holds the handler inside its finally's `await cancelTask(keepaliveTask)`,
  // the window where the race lands.
  const keepaliveCancelDelivered = new Event();
  const releaseKeepaliveCleanup = new Event();

  const stubbornKeepalive = async (): Promise<void> => {
    try {
      await new Event().wait();
    } catch (e) {
      if (e instanceof CancelledError) {
        keepaliveCancelDelivered.set();
        await releaseKeepaliveCleanup.wait();
      }
      throw e;
    }
  };

  service._keepaliveHandler = stubbornKeepalive;

  await service._connect(); // spawns the real _connectionHandler
  const connectionTask: Task<unknown> = service._connectionTask;
  await sleep(0.05); // handler inside startListening, keepalive parked
  expect(connectCalls).toBe(1);

  // 1. The connection drops mid-call: handler enters `catch`, then `finally`,
  //    and suspends at `await cancelTask(keepaliveTask)`.
  dropEvent.set();
  await keepaliveCancelDelivered.wait();

  // 2. Pipeline teardown cancels the connection task in that exact window.
  connectionTask.cancel();
  await sleep(0.05);

  try {
    // connection handler survived an explicit cancel: its own CancelledError
    // was swallowed inside the finally's cancelTask
    expect(connectionTask.cancelled() || connectionTask.done()).toBe(true);
    // connection handler RECONNECTED after being cancelled — orphaned-reconnect zombie
    expect(connectCalls).toBe(1);
  } finally {
    releaseKeepaliveCleanup.set();
    connectionTask.cancel();
    await gatherSettled(connectionTask);
    const remaining = [...taskManager.currentTasks()];
    for (const task of remaining) {
      task.cancel();
    }
    await gatherSettled(...remaining);
  }
});
