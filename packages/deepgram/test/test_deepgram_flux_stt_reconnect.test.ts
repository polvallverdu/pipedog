// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_deepgram_flux_stt_reconnect.py

/**
 * Connection handling of Deepgram Flux STT against a local fake Flux server.
 *
 * The service runs in a test pipeline fed with real-time 20 ms audio frames. The
 * fake server can reject handshakes, drop a connection, or never confirm one
 * with `Connected`.
 */

import { afterEach, expect, test } from "bun:test";
import { monotonic, sleep, waitFor } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  MetricsFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import type { ServerWebSocket } from "bun";

import { DeepgramFluxSTTService } from "../src/flux/stt.ts";

const FRAME_SECONDS = 0.02;

interface _FakeFluxOptions {
  rejectedHandshakes?: number;
  rejectAfter?: number | null;
  dropFirstAfter?: number | null;
  /** Open a turn on the first connection just before dropping it. */
  dropMidTurn?: boolean;
  /** Continue that turn on the second connection: the rest of what the user says. */
  resumeTurn?: boolean;
  /** How many connections, from the first, never get Connected; null for all. */
  unconfirmed?: number | null;
}

interface _ConnectionData {
  index: number;
  chain: Promise<void>;
  done: boolean;
}

class _FakeFlux {
  rejectedHandshakes: number;
  rejectAfter: number | null;
  dropFirstAfter: number | null;
  dropMidTurn: boolean;
  resumeTurn: boolean;
  unconfirmed: number | null;
  handshakes = 0;
  audioPerConnection: number[] = [];

  constructor(options: _FakeFluxOptions = {}) {
    this.rejectedHandshakes = options.rejectedHandshakes ?? 0;
    this.rejectAfter = options.rejectAfter ?? null;
    this.dropFirstAfter = options.dropFirstAfter ?? null;
    this.dropMidTurn = options.dropMidTurn ?? false;
    this.resumeTurn = options.resumeTurn ?? false;
    this.unconfirmed = options.unconfirmed === undefined ? 0 : options.unconfirmed;
  }

  /** Returns a response to refuse the handshake, or null to accept it. */
  processRequest(): Response | null {
    this.handshakes += 1;
    const rejected =
      this.handshakes <= this.rejectedHandshakes ||
      (this.rejectAfter !== null && this.handshakes > this.rejectAfter);
    if (rejected) {
      return new Response("unavailable\n", { status: 503 });
    }
    return null;
  }

  open(websocket: ServerWebSocket<_ConnectionData>): void {
    const index = this.audioPerConnection.length;
    websocket.data.index = index;
    this.audioPerConnection.push(0);
    if (this.unconfirmed === null || index < this.unconfirmed) {
      return;
    }
    websocket.send(JSON.stringify({ type: "Connected", request_id: "test" }));
  }

  /** Messages are handled one at a time, in order, as `async for` does upstream. */
  message(websocket: ServerWebSocket<_ConnectionData>, message: string | Buffer): void {
    const data = websocket.data;
    data.chain = data.chain.then(() => this.#handle(websocket, message));
  }

  async #handle(websocket: ServerWebSocket<_ConnectionData>, message: string | Buffer) {
    const data = websocket.data;
    if (data.done) return;
    if (typeof message === "string") return;
    const index = data.index;
    this.audioPerConnection[index] = (this.audioPerConnection[index] ?? 0) + 1;
    if (index === 1 && this.resumeTurn && this.audioPerConnection[1] === 3) {
      for (const event of ["StartOfTurn", "EndOfTurn"]) {
        const turnInfo = { type: "TurnInfo", event, transcript: "how are you" };
        websocket.send(JSON.stringify(turnInfo));
      }
    }
    if (index === 0 && this.audioPerConnection[0] === this.dropFirstAfter) {
      data.done = true;
      if (this.dropMidTurn) {
        for (const [event, transcript] of [
          ["StartOfTurn", "hello"],
          ["Update", "hello there"],
        ]) {
          const turnInfo = { type: "TurnInfo", event, transcript };
          websocket.send(JSON.stringify(turnInfo));
        }
        await Bun.sleep(50);
      }
      // Drops the TCP connection without a close frame (`transport.abort()`).
      websocket.terminate();
    }
  }

  close(websocket: ServerWebSocket<_ConnectionData>): void {
    websocket.data.done = true;
  }
}

function _audioFrames(seconds: number): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < Math.trunc(seconds / FRAME_SECONDS); i++) {
    frames.push(
      new InputAudioRawFrame({
        audio: new Uint8Array(2 * 320),
        sampleRate: 16000,
        numChannels: 1,
      }),
    );
    frames.push(new SleepFrame({ sleep: FRAME_SECONDS }));
  }
  return frames;
}

async function _run(
  server: _FakeFlux,
  seconds: number,
  configure?: (service: DeepgramFluxSTTService) => void,
): Promise<[DeepgramFluxSTTService, Frame[]]> {
  const s = Bun.serve<_ConnectionData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const refusal = server.processRequest();
      if (refusal) return refusal;
      if (srv.upgrade(request, { data: { index: -1, chain: Promise.resolve(), done: false } })) {
        return undefined;
      }
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      open: (ws) => server.open(ws),
      message: (ws, message) => server.message(ws, message),
      close: (ws) => server.close(ws),
    },
  });
  try {
    const service = new DeepgramFluxSTTService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${s.port}`,
    });
    if (configure) {
      configure(service);
    }
    const [down] = await runTest(service, {
      framesToSend: _audioFrames(seconds),
      pipelineParams: new PipelineParams({ enableUsageMetrics: true }),
    });
    // Give a connection still being served time to record what it received.
    await sleep(0.1);
    return [service, down];
  } finally {
    s.stop(true);
  }
}

// monkeypatch.setattr(DeepgramFluxSTTService, "_CONNECTION_TIMEOUT", ...) is undone after each test.
afterEach(() => {
  delete (DeepgramFluxSTTService as { _CONNECTION_TIMEOUT?: number })._CONNECTION_TIMEOUT;
});

function _setConnectionTimeout(value: number): void {
  Object.defineProperty(DeepgramFluxSTTService, "_CONNECTION_TIMEOUT", {
    value,
    configurable: true,
    writable: true,
  });
}

test("test_a_failed_first_connect_is_retried_in_the_background", async () => {
  const server = new _FakeFlux({ rejectedHandshakes: 1 });

  const [service] = await _run(server, 0.5);

  expect(server.handshakes).toBe(2);
  expect(server.audioPerConnection[0]).toBeGreaterThan(0);
  expect(service.isUsable).toBe(true);
});

test("test_a_dropped_connection_is_replaced_by_one_new_connection", async () => {
  const server = new _FakeFlux({ dropFirstAfter: 10 });

  await _run(server, 1.0);

  expect(server.audioPerConnection.length).toBe(2);
  expect(server.audioPerConnection[1]).toBeGreaterThan(0);
});

/** The transcriptions pushed and the positions of proposed turn stops. */
function _turnEnds(down: Frame[]): [[string, boolean][], number[]] {
  const transcripts = down
    .filter((f): f is TranscriptionFrame => f instanceof TranscriptionFrame)
    .map((f) => [f.text, f.finalized] as [string, boolean]);
  const stops: number[] = [];
  down.forEach((f, i) => {
    if (f instanceof ProposedUserStoppedSpeakingFrame) stops.push(i);
  });
  return [transcripts, stops];
}

test("test_a_turn_cut_short_by_a_drop_ends_with_its_transcript_so_far", async () => {
  const server = new _FakeFlux({ dropFirstAfter: 10, dropMidTurn: true });

  const [, down] = await _run(server, 1.0);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([["hello there", false]]);
  expect(stops.length).toBe(1);
  const firstTranscript = down.findIndex((f) => f instanceof TranscriptionFrame);
  expect(firstTranscript).toBeLessThan(stops[0]!);
  // Usage is reported ahead of the transcript, for the STT span it closes.
  expect(
    down
      .slice(0, firstTranscript)
      .some(
        (f) => f instanceof MetricsFrame && f.data.some((d) => d instanceof STTUsageMetricsData),
      ),
  ).toBe(true);
  expect(server.audioPerConnection.length).toBe(2);
});

test("test_speech_continuing_after_a_drop_becomes_a_new_turn", async () => {
  const server = new _FakeFlux({ dropFirstAfter: 10, dropMidTurn: true, resumeTurn: true });

  const [, down] = await _run(server, 1.0);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([
    ["hello there", false],
    ["how are you", true],
  ]);
  expect(stops.length).toBe(2);
});

test("test_a_turn_ends_when_reconnecting_gives_up", async () => {
  const fastBackoff = (service: DeepgramFluxSTTService) => {
    service._reconnectBackoffMinWait = 0.01;
    service._reconnectBackoffMaxWait = 0.01;
  };

  const server = new _FakeFlux({ dropFirstAfter: 10, dropMidTurn: true, rejectAfter: 1 });

  const [service, down] = await _run(server, 1.0, fastBackoff);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([["hello there", false]]);
  expect(stops.length).toBe(1);
  expect(service.isUsable).toBe(false);
});

test("test_an_unconfirmed_connection_is_retried", async () => {
  _setConnectionTimeout(0.1);
  const server = new _FakeFlux({ unconfirmed: 1 });

  const [service] = await _run(server, 0.5);

  expect(server.handshakes).toBe(2);
  expect(server.audioPerConnection[1]).toBeGreaterThan(0);
  expect(service.isUsable).toBe(true);
});

test("test_connections_that_never_confirm_are_given_up_after_three", async () => {
  _setConnectionTimeout(0.1);
  const server = new _FakeFlux({ unconfirmed: null });

  const stableBeforeTimeout = (service: DeepgramFluxSTTService) => {
    // As in production, the wait for Connected outlasts the time after
    // which a connection counts as stable rather than a quick failure.
    service._quickFailureTracker.minStableDuration = 0.05;
  };

  const [service] = await _run(server, 1.0, stableBeforeTimeout);

  expect(server.handshakes).toBe(3);
  expect(service.isUsable).toBe(false);
});

test("test_audio_keeps_flowing_while_the_provider_is_down", async () => {
  // The connection drops and every reconnect is rejected. Reconnecting
  // happens in the background, so frames pass through the service on time
  // while each attempt fails and backs off.
  const longBackoff = (service: DeepgramFluxSTTService) => {
    service._reconnectBackoffMinWait = 30;
    service._reconnectBackoffMaxWait = 30;
  };

  const server = new _FakeFlux({ dropFirstAfter: 5, rejectAfter: 1 });

  const start = monotonic();
  const [, down] = await waitFor(() => _run(server, 0.5, longBackoff), 10);

  expect(monotonic() - start).toBeLessThan(3);
  expect(down.filter((f) => f instanceof InputAudioRawFrame).length).toBe(25);
});

test("test_stopping_does_not_reconnect", async () => {
  const server = new _FakeFlux();

  await _run(server, 0.3);
  await sleep(0.3);

  expect(server.handshakes).toBe(1);
});
