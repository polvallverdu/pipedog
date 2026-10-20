// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_server_transport.py

/**
 * Behavioral tests for the single-client WebSocket server transport.
 *
 * The contract under test: output written before an EndFrame (e.g. a farewell
 * spoken by the TTS via Flows' `end_conversation` action) must reach the client
 * before the server closes the shared connection — and the server must still be
 * torn down once the session ends.
 *
 * These drive a real transport over a real WebSocket connection and assert on
 * what the client observes (bytes received, connection closed, server no longer
 * listening), not on the transport's internal teardown bookkeeping.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTask, sleep, type Task, waitFor } from "@pipedog/asyncio";
import { EndFrame, type Frame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { FrameSerializer, type SerializedData } from "@pipedog/core/serializers/base_serializer";
import { WorkerRunner } from "@pipedog/core/workers/runner";

import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "../src/server.ts";
import { ConnectionClosed, type WebsocketConnection, websocketConnect } from "../src/socket.ts";

const SAMPLE_RATE = 16000;

function repeatBytes(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function startsWith(a: Uint8Array, prefix: Uint8Array): boolean {
  return a.length >= prefix.length && bytesEqual(a.subarray(0, prefix.length), prefix);
}

// 0.2s of recognizable audio @ 16kHz mono s16 (multiple of the 20ms chunk size).
const GOODBYE_AUDIO = repeatBytes([0x01, 0x02, 0x03, 0x04], 1600);

const END_MARKER = new TextEncoder().encode("__END__");

function _freePort(): number {
  const server = Bun.serve({ hostname: "localhost", port: 0, fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

/** Serialize audio frames as their raw bytes and EndFrame as a marker. */
class _RawAudioSerializer extends FrameSerializer {
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (frame instanceof OutputAudioRawFrame) {
      return frame.audio;
    }
    if (frame instanceof EndFrame) {
      return END_MARKER;
    }
    return null;
  }

  async deserialize(_data: SerializedData): Promise<Frame | null> {
    return null;
  }
}

function _params(): SingleClientWebsocketServerParams {
  return new SingleClientWebsocketServerParams({
    serializer: new _RawAudioSerializer(),
    audioOutEnabled: true,
  });
}

// unittest's addCleanup / addAsyncCleanup: run in reverse order after each test.
let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  const pending = cleanups.reverse();
  cleanups = [];
  for (const cleanup of pending) {
    await cleanup();
  }
});

/** Base with helpers to run a transport and connect a client to it. */
const WebsocketServerTransportTest = {
  /** Run `processors` on a worker, returning it and its run task. */
  async _serve(
    _transport: SingleClientWebsocketServerTransport,
    processors: FrameProcessor[],
  ): Promise<[PipelineWorker, Task<void>]> {
    const worker = new PipelineWorker(new Pipeline(processors), {
      cancelOnIdleTimeout: false,
      params: new PipelineParams({ audioOutSampleRate: SAMPLE_RATE }),
    });
    const runner = new WorkerRunner({ handleSigint: false });
    await runner.addWorkers(worker);
    const runTask = createTask(() => runner.run());
    cleanups.push(() => runner.cancel());
    cleanups.push(() => runTask.cancel());
    return [worker, runTask];
  },

  /** Connect a client, retrying until the server is listening. */
  async _connect(port: number): Promise<WebsocketConnection> {
    for (let i = 0; i < 50; i++) {
      try {
        return await websocketConnect(`ws://localhost:${port}`);
      } catch (e) {
        if (!(e instanceof ConnectionClosed)) throw e;
        await sleep(0.1);
      }
    }
    throw new Error(`could not connect to ws://localhost:${port}`);
  },

  /** Assert nothing accepts connections on `port` (server torn down). */
  async _assertNotListening(port: number): Promise<void> {
    // `OSError` from `websockets.connect` is a failed handshake here.
    await expect(websocketConnect(`ws://localhost:${port}`)).rejects.toThrow(ConnectionClosed);
  },
};

const { _serve, _connect, _assertNotListening } = WebsocketServerTransportTest;

/** Output queued before an EndFrame must reach the client before close. */
describe("TestGoodbyeFlushedBeforeClose", () => {
  test("test_output_queued_before_endframe_reaches_client_before_close", async () => {
    // The farewell scenario: audio (the goodbye) queued before the EndFrame,
    // exactly what Flows' end_conversation action produces. The input sees the
    // EndFrame first, so a premature teardown there would cut the goodbye off.
    const port = _freePort();
    const transport = new SingleClientWebsocketServerTransport(_params(), {
      host: "localhost",
      port,
    });
    const [worker, runTask] = await _serve(transport, [transport.input(), transport.output()]);
    const client = await _connect(port);

    const received: Uint8Array[] = [];

    async function readUntilClosed(): Promise<void> {
      try {
        for await (const message of client) {
          if (message instanceof Uint8Array) {
            received.push(message);
          }
        }
      } catch (e) {
        if (!(e instanceof ConnectionClosed)) throw e;
      }
    }

    const readerTask = createTask(() => readUntilClosed());

    // Let on_client_connected propagate to the output transport.
    await sleep(0.2);

    await worker.queueFrames([
      new OutputAudioRawFrame({ audio: GOODBYE_AUDIO, sampleRate: SAMPLE_RATE, numChannels: 1 }),
      new EndFrame(),
    ]);

    // The session ends and, once the goodbye has been delivered, the server
    // closes the connection — so both the worker and the reader finish.
    await waitFor(() => runTask, 10);
    await waitFor(() => readerTask, 5);
    await client.close();

    // The output may pad trailing silence after the goodbye, so assert the
    // whole goodbye arrived, intact and first (a premature close would leave
    // a truncated prefix).
    const audioReceived = concatBytes(received.filter((m) => !bytesEqual(m, END_MARKER)));
    expect(
      startsWith(audioReceived, GOODBYE_AUDIO),
      `goodbye not delivered in full before close (received ${audioReceived.length} bytes)`,
    ).toBe(true);
  });
});

/** The server is drained once the session ends (it must not leak). */
describe("TestServerTornDownAfterSession", () => {
  test("test_server_stops_listening_after_pipeline_ends", async () => {
    const port = _freePort();
    const transport = new SingleClientWebsocketServerTransport(_params(), {
      host: "localhost",
      port,
    });
    const [worker, runTask] = await _serve(transport, [transport.input(), transport.output()]);
    const client = await _connect(port);

    await sleep(0.2);
    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => runTask, 10);
    await client.close();

    await _assertNotListening(port);
  });

  test("test_server_torn_down_without_output_transport", async () => {
    // With no output transport, the input is the only holder of the shared
    // server, so its EndFrame alone drives the teardown — no separate backstop
    // needed.
    const port = _freePort();
    const transport = new SingleClientWebsocketServerTransport(_params(), {
      host: "localhost",
      port,
    });
    const [worker, runTask] = await _serve(transport, [transport.input()]);
    const client = await _connect(port);

    await sleep(0.2);
    await worker.queueFrames([new EndFrame()]);
    await waitFor(() => runTask, 10);
    await client.close();

    await _assertNotListening(port);
  });
});

/** Emits one coalesced payload every third frame, buffering the two before it. */
class _CoalescingSerializer extends FrameSerializer {
  _seen = 0;

  /** Emit the accumulated block on every third audio frame. */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (!(frame instanceof OutputAudioRawFrame)) {
      return null;
    }
    this._seen += 1;
    if (this._seen % 3) {
      return null;
    }
    return concatBytes([frame.audio, frame.audio, frame.audio]);
  }

  /** Unused; only the output transport is exercised here. */
  async deserialize(_data: SerializedData): Promise<Frame | null> {
    return null;
  }
}

/**
 * Tests for issue #5592.
 *
 * A serializer that buffers audio across calls emits no payload on most of
 * them. Those frames have still been written, so pacing has to follow the
 * frames taken rather than the payloads that go out, and the frames have to
 * keep reaching downstream consumers.
 */
describe("TestWriteAudioFramePacesWrittenFrames", () => {
  function _makeOutput(serializer: FrameSerializer) {
    const params = new SingleClientWebsocketServerParams({ serializer, audioOutEnabled: true });
    const output = new SingleClientWebsocketServerTransport(params).output();
    const o = output as any;
    o._websocket = { send: mock(async () => {}), close: mock(async () => {}) };
    o._sampleRate = SAMPLE_RATE;
    o._writeAudioSleep = mock(async () => {});
    return o;
  }

  function _audioFrame(): OutputAudioRawFrame {
    return new OutputAudioRawFrame({
      audio: new Uint8Array(320),
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
    });
  }

  test("test_every_frame_is_paced_when_payloads_are_coalesced", async () => {
    // Pacing follows the frames taken, not the payloads that go out.
    const output = _makeOutput(new _CoalescingSerializer());

    const written: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      written.push(await output.writeAudioFrame(_audioFrame()));
    }

    expect(written).toEqual(Array(9).fill(true));
    expect(output._writeAudioSleep).toHaveBeenCalledTimes(9);
    expect(output._websocket.send).toHaveBeenCalledTimes(3);
  });
});
