// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gladia_stt.py

/**
 * Tests for the Gladia STT service.
 *
 * Porting notes:
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported
 *   locally.
 * - `AsyncMock` → assigning an instance property that records its calls.
 * - The fake websocket's iterator ends after its scripted messages, like the
 *   upstream async generator.
 * - Also holds the Gladia case of `test_failed_connect_starts_the_receive_loop`
 *   (tests/test_websocket_stt_connect_failure.py), because core cannot import
 *   provider packages.
 */

import { describe, expect, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  CancelFrame,
  EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { State } from "@pipedog/core/services/websocket_service";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { GladiaSTTService } from "../src/stt.ts";

type Dict = Record<string, any>;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager,
  });
}

class FakeWebsocket {
  state: State;
  sent: Dict[] = [];
  closed = false;
  #incoming: Dict[];

  constructor(options: { state?: State; incoming?: Dict[] } = {}) {
    this.state = options.state ?? State.OPEN;
    this.#incoming = options.incoming ?? [];
  }

  async send(payload: string): Promise<void> {
    this.sent.push(JSON.parse(payload));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = State.CLOSED;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
    for (const message of this.#incoming) {
      yield JSON.stringify(message);
    }
  }
}

/** Build a service holding an open fake socket, without touching the network. */
function connectedService(incoming?: Dict[]): [GladiaSTTService, FakeWebsocket] {
  const service = new GladiaSTTService({ apiKey: "test-key" });
  (service as any)._setup = frameProcessorSetup(new TaskManager());
  const websocket = new FakeWebsocket({ incoming });
  (service as any)._websocket = websocket;
  service._connectionActive = true;
  return [service, websocket];
}

function messageTypes(websocket: FakeWebsocket): string[] {
  return websocket.sent.map((message) => message.type);
}

test("test_stop_sends_stop_recording_while_the_socket_is_open", async () => {
  const [service, websocket] = connectedService();

  await service.stop(new EndFrame());

  expect(messageTypes(websocket)).toEqual(["stop_recording"]);
  expect(websocket.closed).toBe(true);
});

test("test_stop_disconnects_once", async () => {
  const [service] = connectedService();
  const original = service._disconnectWebsocket.bind(service);
  let calls = 0;
  service._disconnectWebsocket = async () => {
    calls += 1;
    await original();
  };

  await service.stop(new EndFrame());

  expect(calls).toBe(1);
});

test("test_cancel_does_not_send_stop_recording", async () => {
  const [service, websocket] = connectedService();

  await service.cancel(new CancelFrame());

  expect(messageTypes(websocket)).toEqual([]);
  expect(websocket.closed).toBe(true);
});

test("test_audio_chunk_not_acknowledged_reports_error", async () => {
  // A rejected audio_chunk carries an `error` and no `acknowledged: true`.
  // The rejection is reported upstream as an error.
  const [service] = connectedService([
    {
      type: "audio_chunk",
      acknowledged: false,
      error: { message: "quota exceeded" },
      data: null,
    },
  ]);
  const errors: string[] = [];
  (service as any).pushError = async (message: string) => {
    errors.push(message);
  };

  await service._receiveMessages();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("quota exceeded");
});

test("test_translation_addon_error_reports_error_instead_of_crashing", async () => {
  // A failed translation addon call arrives with `error` set and `data: null`.
  // The failure is reported upstream as an error and the receive loop keeps
  // running, so the connection is not torn down.
  const [service] = connectedService([
    { type: "translation", error: { message: "translation addon failed" }, data: null },
  ]);
  const errors: string[] = [];
  const pushed: Frame[] = [];
  (service as any).pushError = async (message: string) => {
    errors.push(message);
  };
  (service as any).pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };

  await service._receiveMessages();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("translation addon failed");
  expect(pushed).toHaveLength(0);
});

test("test_translation_without_error_still_pushes_translation_frame", async () => {
  // A translation with `error: null` pushes a `TranslationFrame`.
  const [service] = connectedService([
    {
      type: "translation",
      error: null,
      data: {
        original_language: "en",
        translated_utterance: { language: "fr", text: "Bonjour" },
      },
    },
  ]);
  let errorCount = 0;
  const pushed: Frame[] = [];
  (service as any).pushError = async () => {
    errorCount += 1;
  };
  (service as any).pushFrame = async (frame: Frame) => {
    pushed.push(frame);
  };

  await service._receiveMessages();

  expect(errorCount).toBe(0);
  expect(pushed).toHaveLength(1);
  expect((pushed[0] as any).text).toBe("Bonjour");
});

// Tests below are not in upstream's test_gladia_stt.py: they pin the wire
// format built from Gladia's API docs and upstream's code.
describe("TestGladiaWireFormat", () => {
  test("test_audio_chunk_is_base64_json", async () => {
    const [service, websocket] = connectedService();

    await service._sendAudio(new Uint8Array([1, 2, 3]));

    expect(websocket.sent).toEqual([{ type: "audio_chunk", data: { chunk: "AQID" } }]);
  });

  test("test_transcripts_become_frames", async () => {
    const [service] = connectedService([
      {
        type: "transcript",
        data: { is_final: false, utterance: { text: "hel", language: "en" } },
      },
      {
        type: "transcript",
        data: { is_final: true, utterance: { text: "hello", language: "en" } },
      },
    ]);
    const pushed: Frame[] = [];
    (service as any).pushFrame = async (frame: Frame) => {
      pushed.push(frame);
    };
    (service as any).emitSttUsageMetrics = async () => {};

    await service._receiveMessages();

    expect(pushed[0]).toBeInstanceOf(InterimTranscriptionFrame);
    expect(pushed[1]).toBeInstanceOf(TranscriptionFrame);
    expect((pushed[1] as TranscriptionFrame).text).toBe("hello");
  });

  test("test_session_init_request", async () => {
    const calls: [string, RequestInit][] = [];
    const service = new GladiaSTTService({
      apiKey: "test-key",
      region: "us-west",
      sampleRate: 16000,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return new Response(JSON.stringify({ id: "abc", url: "wss://example.invalid/x" }), {
          status: 201,
        });
      }) as unknown as typeof fetch,
    });
    (service as any)._websocketConnect = async () => new FakeWebsocket();
    (service as any).createTask = () => null;
    await service.setup(frameProcessorSetup(new TaskManager(), { audioInSampleRate: 16000 }));

    expect(calls).toHaveLength(1);
    const [callUrl, callInit] = calls[0] as [string, RequestInit];
    expect(callUrl).toBe("https://api.gladia.io/v2/live?region=us-west");
    expect((callInit.headers as Dict)["X-Gladia-Key"]).toBe("test-key");
    const body = JSON.parse(callInit.body as string);
    expect(body).toMatchObject({
      encoding: "wav/pcm",
      bit_depth: 16,
      sample_rate: 16000,
      channels: 1,
      model: "solaria-1",
      maximum_duration_without_endpointing: 5,
    });
    expect(body.custom_metadata.pipecat).toBeString();
    expect(service._sessionUrl).toBe("wss://example.invalid/x");
  });
});

// Gladia case of test_websocket_stt_connect_failure.py::test_failed_connect_starts_the_receive_loop.
test("test_failed_connect_starts_the_receive_loop[gladia.stt-GladiaSTTService]", async () => {
  // The receive loop is what retries, so it starts even without a websocket.
  const service = new GladiaSTTService({ apiKey: "test-key" });
  service._sessionUrl = "wss://example.invalid"; // Gladia opens its session over HTTP first.
  const started: (string | undefined)[] = [];

  // DIVERGENCE: upstream records the coroutine's `__name__`; a closure has none,
  // so the receive task is identified by the name it is created with.
  (service as any).createTask = (_fn: unknown, name?: string) => {
    started.push(name);
    return null;
  };
  (service as any).pushError = async () => {};
  (service as any)._websocketConnect = async () => {
    throw new Error("Connection refused");
  };

  await service._connect();

  expect((service as any)._websocket).toBeNull();
  expect(started).toContain("_receive_task_handler");
});
