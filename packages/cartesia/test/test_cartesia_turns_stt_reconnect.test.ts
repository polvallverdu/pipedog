// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_cartesia_turns_stt_reconnect.py

/**
 * Connection handling of Cartesia Turns STT against a local fake Ink-2 server.
 *
 * The service runs in a test pipeline fed with real-time 20 ms audio frames. The
 * fake server can reject handshakes, drop a connection, reject the connection's
 * settings, or never confirm one with `connected`.
 */

import { afterEach, expect, test } from "bun:test";
import { monotonic, sleep, waitFor } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  InputAudioRawFrame,
  MetricsFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ErrorCategory } from "@pipedog/core/utils/errors";
import type { ServerWebSocket } from "bun";

import { CartesiaTurnsSTTService } from "../src/turns/stt.ts";

const FRAME_SECONDS = 0.02;

// Python's CloseCode.POLICY_VIOLATION.
const POLICY_VIOLATION = 1008;

// Test access to protected members, as the Python test does.
type Internals = {
  _reconnectBackoffMinWait: number;
  _reconnectBackoffMaxWait: number;
  _quickFailureTracker: { minStableDuration: number };
};

type _Socket = ServerWebSocket<{ index: number; closed: boolean; turnOpen: boolean }>;

interface _FakeInk2Options {
  rejectedHandshakes?: number;
  rejectAfter?: number | null;
  dropFirstAfter?: number | null;
  dropMidTurn?: boolean;
  resumeTurn?: boolean;
  openTurnAfter?: number | null;
  unconfirmed?: number | null;
  rejectSettings?: boolean;
}

class _FakeInk2 {
  rejectedHandshakes: number;
  rejectAfter: number | null;
  dropFirstAfter: number | null;
  // Open a turn on the first connection just before dropping it.
  dropMidTurn: boolean;
  // Continue that turn on the second connection: the rest of what the user says.
  resumeTurn: boolean;
  // Open a turn on the first connection after this many audio chunks; the
  // server ends it when the service sends close.
  openTurnAfter: number | null;
  // How many connections, from the first, never get connected; null for all.
  unconfirmed: number | null;
  // Reject every connection's settings after the handshake.
  rejectSettings: boolean;
  handshakes = 0;
  audioPerConnection: number[] = [];
  // Python's handler reads one message at a time; Bun delivers them as
  // callbacks, so each connection's messages are chained.
  #chains = new Map<number, Promise<void>>();

  constructor(options: _FakeInk2Options = {}) {
    this.rejectedHandshakes = options.rejectedHandshakes ?? 0;
    this.rejectAfter = options.rejectAfter ?? null;
    this.dropFirstAfter = options.dropFirstAfter ?? null;
    this.dropMidTurn = options.dropMidTurn ?? false;
    this.resumeTurn = options.resumeTurn ?? false;
    this.openTurnAfter = options.openTurnAfter ?? null;
    this.unconfirmed = options.unconfirmed === undefined ? 0 : options.unconfirmed;
    this.rejectSettings = options.rejectSettings ?? false;
  }

  /** Returns a rejection response, or null to accept the handshake. */
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

  open(websocket: _Socket): void {
    const index = this.audioPerConnection.length;
    this.audioPerConnection.push(0);
    websocket.data.index = index;
    this.#chains.set(index, Promise.resolve());
    if (this.rejectSettings) {
      const error = {
        type: "error",
        error_code: "model_not_found",
        message: "Could not resolve model.",
        status_code: 400,
      };
      websocket.send(JSON.stringify(error));
      websocket.data.closed = true;
      websocket.close(POLICY_VIOLATION, "Invalid model");
      return;
    }
    if (this.unconfirmed === null || index < this.unconfirmed) {
      return;
    }
    websocket.send(JSON.stringify({ type: "connected", request_id: "test" }));
  }

  message(websocket: _Socket, message: string | Uint8Array): void {
    const index = websocket.data.index;
    const chain = this.#chains.get(index) ?? Promise.resolve();
    this.#chains.set(
      index,
      chain.then(() => this.#handle(websocket, message)),
    );
  }

  async #handle(websocket: _Socket, message: string | Uint8Array): Promise<void> {
    if (websocket.data.closed) {
      return;
    }
    const index = websocket.data.index;
    if (typeof message === "string") {
      if (JSON.parse(message).type === "close") {
        if (websocket.data.turnOpen) {
          this._send(websocket, "turn.end", "hello there");
        }
        websocket.data.closed = true;
        websocket.close();
      }
      return;
    }
    this.audioPerConnection[index] = (this.audioPerConnection[index] as number) + 1;
    const count = this.audioPerConnection[index];
    if (index === 0 && count === this.openTurnAfter) {
      this._send(websocket, "turn.start", "hello");
      this._send(websocket, "turn.update", "hello there");
      websocket.data.turnOpen = true;
    }
    if (index === 1 && this.resumeTurn && count === 3) {
      this._send(websocket, "turn.start", "how are you");
      this._send(websocket, "turn.end", "how are you");
    }
    if (index === 0 && count === this.dropFirstAfter) {
      if (this.dropMidTurn) {
        this._send(websocket, "turn.start", "hello");
        this._send(websocket, "turn.update", "hello there");
        await sleep(0.05);
      }
      websocket.data.closed = true;
      websocket.terminate();
    }
  }

  _send(websocket: _Socket, messageType: string, transcript: string): void {
    websocket.send(JSON.stringify({ type: messageType, transcript }));
  }
}

function _audioFrames(seconds: number): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < Math.trunc(seconds / FRAME_SECONDS); i++) {
    frames.push(
      new InputAudioRawFrame({ audio: new Uint8Array(2 * 320), sampleRate: 16000, numChannels: 1 }),
    );
    frames.push(new SleepFrame({ sleep: FRAME_SECONDS }));
  }
  return frames;
}

type _Service = CartesiaTurnsSTTService & Internals;

async function _run(
  server: _FakeInk2,
  seconds: number,
  configure?: (service: _Service) => void,
): Promise<[_Service, Frame[], Frame[]]> {
  const s = Bun.serve<{ index: number; closed: boolean; turnOpen: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const rejection = server.processRequest();
      if (rejection) {
        return rejection;
      }
      if (srv.upgrade(request, { data: { index: -1, closed: false, turnOpen: false } })) {
        return undefined;
      }
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      open: (ws) => server.open(ws),
      message: (ws, message) => server.message(ws, message as string | Uint8Array),
    },
  });
  try {
    const service = new CartesiaTurnsSTTService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${s.port}`,
    }) as unknown as _Service;
    if (configure) {
      configure(service);
    }
    const [down, up] = await runTest(service, {
      framesToSend: _audioFrames(seconds),
      pipelineParams: new PipelineParams({ enableUsageMetrics: true }),
    });
    // Give a connection still being served time to record what it received.
    await sleep(0.1);
    return [service, down, up];
  } finally {
    s.stop(true);
  }
}

/** The transcriptions pushed and the positions of proposed turn stops. */
function _turnEnds(down: Frame[]): [[string, boolean][], number[]] {
  const transcripts: [string, boolean][] = down
    .filter((f) => f instanceof TranscriptionFrame)
    .map((f) => [f.text, f.finalized]);
  const stops: number[] = [];
  down.forEach((f, i) => {
    if (f instanceof ProposedUserStoppedSpeakingFrame) {
      stops.push(i);
    }
  });
  return [transcripts, stops];
}

// Python's monkeypatch.setattr(CartesiaTurnsSTTService, "_CONNECTION_TIMEOUT", ...).
const ORIGINAL_CONNECTION_TIMEOUT = CartesiaTurnsSTTService._CONNECTION_TIMEOUT;
afterEach(() => {
  CartesiaTurnsSTTService._CONNECTION_TIMEOUT = ORIGINAL_CONNECTION_TIMEOUT;
});

test("test_a_failed_first_connect_is_retried_in_the_background", async () => {
  const server = new _FakeInk2({ rejectedHandshakes: 1 });

  const [service] = await _run(server, 0.5);

  expect(server.handshakes).toBe(2);
  expect(server.audioPerConnection[0]).toBeGreaterThan(0);
  expect(service.isUsable).toBe(true);
});

test("test_a_dropped_connection_is_replaced_by_one_new_connection", async () => {
  const server = new _FakeInk2({ dropFirstAfter: 10 });

  await _run(server, 1.0);

  expect(server.audioPerConnection.length).toBe(2);
  expect(server.audioPerConnection[1]).toBeGreaterThan(0);
});

test("test_a_turn_cut_short_by_a_drop_ends_with_its_transcript_so_far", async () => {
  const server = new _FakeInk2({ dropFirstAfter: 10, dropMidTurn: true });

  const [, down] = await _run(server, 1.0);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([["hello there", false]]);
  expect(stops.length).toBe(1);
  const firstTranscript = down.findIndex((f) => f instanceof TranscriptionFrame);
  expect(firstTranscript).toBeGreaterThanOrEqual(0);
  expect(firstTranscript).toBeLessThan(stops[0] as number);
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
  const server = new _FakeInk2({ dropFirstAfter: 10, dropMidTurn: true, resumeTurn: true });

  const [, down] = await _run(server, 1.0);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([
    ["hello there", false],
    ["how are you", true],
  ]);
  expect(stops.length).toBe(2);
});

test("test_a_turn_ends_when_reconnecting_gives_up", async () => {
  const fastBackoff = (service: _Service) => {
    service._reconnectBackoffMinWait = 0.01;
    service._reconnectBackoffMaxWait = 0.01;
  };

  const server = new _FakeInk2({ dropFirstAfter: 10, dropMidTurn: true, rejectAfter: 1 });

  const [service, down] = await _run(server, 1.0, fastBackoff);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([["hello there", false]]);
  expect(stops.length).toBe(1);
  expect(service.isUsable).toBe(false);
});

test("test_stopping_mid_turn_lets_the_server_end_the_turn", async () => {
  const server = new _FakeInk2({ openTurnAfter: 5 });

  const [, down] = await _run(server, 0.4);

  const [transcripts, stops] = _turnEnds(down);
  expect(transcripts).toEqual([["hello there", true]]);
  expect(stops.length).toBe(1);
});

test("test_an_unconfirmed_connection_is_retried", async () => {
  CartesiaTurnsSTTService._CONNECTION_TIMEOUT = 0.1;
  const server = new _FakeInk2({ unconfirmed: 1 });

  const [service] = await _run(server, 0.5);

  expect(server.handshakes).toBe(2);
  expect(server.audioPerConnection[1]).toBeGreaterThan(0);
  expect(service.isUsable).toBe(true);
});

test("test_connections_that_never_confirm_are_given_up_after_three", async () => {
  CartesiaTurnsSTTService._CONNECTION_TIMEOUT = 0.1;
  const server = new _FakeInk2({ unconfirmed: null });

  const stableBeforeTimeout = (service: _Service) => {
    // As in production, the wait for connected outlasts the time after
    // which a connection counts as stable rather than a quick failure.
    service._quickFailureTracker.minStableDuration = 0.05;
  };

  const [service] = await _run(server, 1.0, stableBeforeTimeout);

  expect(server.handshakes).toBe(3);
  expect(service.isUsable).toBe(false);
});

test("test_rejected_settings_are_not_retried", async () => {
  const server = new _FakeInk2({ rejectSettings: true });

  const [service, , up] = await _run(server, 0.5);

  expect(server.handshakes).toBe(1);
  expect(service.isUsable).toBe(false);
  const errors = up.filter((f) => f instanceof ErrorFrame);
  expect(errors.map((e) => e.category)).toEqual([ErrorCategory.INVALID_REQUEST]);
  expect((errors[0] as ErrorFrame).error).toContain("model_not_found");
});

test("test_audio_keeps_flowing_while_the_provider_is_down", async () => {
  // The connection drops and every reconnect is rejected. Reconnecting
  // happens in the background, so frames pass through the service on time
  // while each attempt fails and backs off.
  const longBackoff = (service: _Service) => {
    service._reconnectBackoffMinWait = 30;
    service._reconnectBackoffMaxWait = 30;
  };

  const server = new _FakeInk2({ dropFirstAfter: 5, rejectAfter: 1 });

  const start = monotonic();
  const [, down] = await waitFor(() => _run(server, 0.5, longBackoff), 10);

  expect(monotonic() - start).toBeLessThan(3);
  expect(down.filter((f) => f instanceof InputAudioRawFrame).length).toBe(25);
});

test("test_stopping_does_not_reconnect", async () => {
  const server = new _FakeInk2();

  await _run(server, 0.3);
  await sleep(0.3);

  expect(server.handshakes).toBe(1);
});
