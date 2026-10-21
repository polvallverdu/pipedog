// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_evals_client_transport.py

/** Tests for the eval harness's client output transport. */

import { describe, expect, mock, test } from "bun:test";
import { CancelledError, createTask, sleep } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  InterruptionFrame,
  type OutputAudioRawFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";
import {
  WebsocketClientInputTransport,
  WebsocketClientOutputTransport,
  WebsocketClientParams,
  type WebsocketClientSession,
} from "@pipedog/transport-websocket/client";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import {
  _RecorderTrack,
  EvalClientInputTransport,
  EvalClientOutputTransport,
  EvalClientRecorder,
  EvalClientTransport,
  FRAME_S,
} from "../src/client_transport.ts";
import { EvalConnectionFlags, parseEvalConnect } from "../src/serializer.ts";

/** A session stand-in that reports an open connection. */
function _fakeSession(): WebsocketClientSession {
  return { isClosing: false, isConnected: true } as unknown as WebsocketClientSession;
}

const NO_TRANSPORT = null as unknown as BaseTransport;

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const isSilence = (pcm: Uint8Array): boolean => pcm.every((b) => b === 0);

/**
 * `patch.object(cls, name, new=AsyncMock())`: replace `name` on `cls`'s
 * prototype for the duration of `fn`, then restore it.
 */
async function patchPrototype<T>(
  cls: { prototype: object },
  name: string,
  replacement: (...args: never[]) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const proto = cls.prototype as Record<string, unknown>;
  const had = Object.hasOwn(proto, name);
  const original = proto[name];
  proto[name] = replacement;
  try {
    return await fn();
  } finally {
    if (had) proto[name] = original;
    else delete proto[name];
  }
}

type OutputInternals = {
  _sampleRate: number;
  _pending: Uint8Array;
  _sendTaskHandler(): Promise<void>;
  _sendFrame(frame: OutputAudioRawFrame): Promise<void>;
  pushFrame(frame: Frame, direction?: FrameDirection): Promise<void>;
};

/** The output streams queued audio at real time, silence otherwise. */
describe("TestEvalHarnessOutput", () => {
  const SR = 16000;
  const CHUNK_BYTES = Math.trunc(SR * FRAME_S) * 2; // one ~40ms frame, 16-bit mono

  const _run = async (out: OutputInternals, seconds: number) => {
    const task = createTask(() => out._sendTaskHandler());
    try {
      await sleep(seconds);
    } finally {
      task.cancel();
      await task.then(
        () => {},
        (e: unknown) => {
          if (!(e instanceof CancelledError)) throw e;
        },
      );
    }
  };

  test("test_paces_queued_audio_then_silence", async () => {
    const out = new EvalClientOutputTransport(
      NO_TRANSPORT,
      _fakeSession(),
      new WebsocketClientParams({ audioOutEnabled: true }),
    ) as unknown as OutputInternals;
    out._sampleRate = SR; // set by start(); skip the transport lifecycle

    const sent: Uint8Array[] = [];

    // capture frames instead of serializing/sending
    out._sendFrame = async (frame) => {
      sent.push(frame.audio);
    };
    // the unlinked processor has no downstream
    out.pushFrame = async () => {};

    const utterance = repeat([1, 2], Math.trunc((SR * 12) / 100)); // 120ms -> three 40ms chunks
    out._pending = concat(out._pending, utterance);

    await _run(out, 0.25);

    const speech = sent.filter((pcm) => !isSilence(pcm));
    expect(concat(...speech)).toEqual(utterance); // full utterance, in order
    expect(speech.every((pcm) => pcm.length === CHUNK_BYTES)).toBe(true);
    expect(sent).toContainEqual(new Uint8Array(CHUNK_BYTES)); // silence keeps flowing
    // Real-time pacing: ~0.25s emits ~6 frames at 40ms, not hundreds.
    expect(sent.length).toBeLessThan(Math.trunc(0.25 / FRAME_S) + 5);
  });

  test("test_interruption_drops_the_unsent_audio", async () => {
    const recorder = new EvalClientRecorder(SR);
    const out = new EvalClientOutputTransport(
      NO_TRANSPORT,
      _fakeSession(),
      new WebsocketClientParams({ audioOutEnabled: true }),
      { recorder },
    );
    const internals = out as unknown as OutputInternals;
    const audio = repeat([1, 0], SR / 10); // 100ms
    recorder.addUser(audio, SR);
    internals._pending = concat(internals._pending, audio);
    await patchPrototype(
      WebsocketClientOutputTransport,
      "processFrame",
      mock(async () => {}),
      () => out.processFrame(new InterruptionFrame(), FrameDirection.DOWNSTREAM),
    );
    expect(internals._pending.length).toEqual(0);
    expect(recorder._user._chunks).toEqual([]);
  });
});

/** A track lays its chunks out on a playout timeline; silence only for real pauses. */
describe("TestRecorderTrack", () => {
  const SR = 16000;
  const CHUNK_S = 0.04;
  const CHUNK = repeat([1, 0], Math.trunc(SR * CHUNK_S)); // 40ms of non-silent samples

  /** A track fed one CHUNK at each arrival time (seconds). */
  const _track = (arrivals: number[]): _RecorderTrack => {
    // DIVERGENCE: upstream patches the module's `time.monotonic`; the track's
    // clock is injected here.
    let now = 0;
    const track = new _RecorderTrack({ clock: () => now });
    for (const at of arrivals) {
      now = at;
      track.add(CHUNK, SR);
    }
    return track;
  };

  const _paced = (start: number, count: number, step = 0.04): number[] =>
    Array.from({ length: count }, (_, i) => start + i * step);

  const times = (chunk: Uint8Array, n: number): Uint8Array =>
    concat(...Array.from({ length: n }, () => chunk));

  /** Seconds of inserted silence: the output beyond the chunks themselves. */
  const _silenceS = async (track: _RecorderTrack): Promise<number> => {
    const out = await track.rendered(SR, track.first!);
    return (out.length - track._chunks.length * CHUNK.length) / (SR * 2);
  };

  test("test_real_time_stream_is_contiguous", async () => {
    const jitter = [0, 0.01, -0.005, 0.008, 0, -0.01, 0.012, 0];
    const arrivals = _paced(10.0, 8).map((t, i) => t + jitter[i]!);
    const out = await _track(arrivals).rendered(SR, 10.0);
    expect(out).toEqual(times(CHUNK, 8));
  });

  test("test_pause_between_turns_is_silence", async () => {
    const arrivals = [..._paced(10.0, 5), ..._paced(10.0 + 5 * 0.04 + 1.0, 5)];
    expect(Math.abs((await _silenceS(_track(arrivals))) - 1.0)).toBeLessThanOrEqual(0.001);
  });

  test("test_receiver_hiccup_is_absorbed_by_the_source_lead", async () => {
    // The bot sends at twice real time: 20 chunks (0.8s of audio) in 0.4s, then
    // a 0.3s hole on the receiving side, then the rest. The hole is shorter than
    // the lead the source has built, so nothing in the recording moves.
    const arrivals = [..._paced(10.0, 20, 0.02), ..._paced(10.7, 10, 0.02)];
    const track = _track(arrivals);
    expect(await track.rendered(SR, 10.0)).toEqual(times(CHUNK, 30));
  });

  test("test_drop_tail_spans_chunks", async () => {
    const track = _track(_paced(10.0, 3));
    track.dropTail(CHUNK.length + 100);
    const out = await track.rendered(SR, 10.0);
    expect(out).toEqual(times(CHUNK, 2).slice(0, CHUNK.length * 2 - 100));
  });

  test("test_unpaced_pause_counts_from_the_end_of_playout", async () => {
    // A fast source (the user TTS) produces a turn in a burst; its playout
    // still takes the audio's duration, and the pause runs from that end.
    const arrivals = [...Array.from({ length: 10 }, (_, i) => 10.0 + i * 0.001), 20.0];
    expect(Math.abs((await _silenceS(_track(arrivals))) - (10.0 - 10 * 0.04))).toBeLessThanOrEqual(
      0.001,
    );
  });

  test("test_lead_silence_aligns_to_the_recording_start", async () => {
    const track = _track(_paced(12.0, 2));
    const out = await track.rendered(SR, 10.0);
    expect(out).toEqual(concat(new Uint8Array(2 * SR * 2), times(CHUNK, 2)));
  });
});

/** The input buffers the bot's audio and drops what is unplayed at an interruption. */
describe("TestEvalHarnessInput", () => {
  const SR = 16000;

  test("test_bot_interrupted_drops_the_unplayed_audio", async () => {
    const recorder = new EvalClientRecorder(SR);
    const inp = new EvalClientInputTransport(
      NO_TRANSPORT,
      _fakeSession(),
      new WebsocketClientParams({ audioInEnabled: true }),
      { recorder },
    );
    // The base push_frame has no linked pipeline here; stand in for it.
    const push = mock(async (_frame: Frame, _direction?: FrameDirection) => {});
    await patchPrototype(WebsocketClientInputTransport, "pushFrame", push, async () => {
      const audio = repeat([1, 0], SR / 10); // 100ms
      await inp.pushAudioFrame(new InputAudioRawFrame({ audio, sampleRate: SR, numChannels: 1 }));
      await inp.pushAudioFrame(new InputAudioRawFrame({ audio, sampleRate: SR, numChannels: 1 }));
      expect(inp._botPcm.length).toEqual(2 * audio.length);
      expect(recorder._bot._chunks.length).toEqual(2);

      const interrupted = new InputTransportMessageFrame({
        message: { label: RTVI.MESSAGE_LABEL, type: "bot-interrupted" },
      });
      await inp.pushFrame(interrupted);

      expect(inp._botPcm.length).toEqual(0);
      expect(recorder._bot._chunks).toEqual([]); // nothing of it was played
      expect(push.mock.calls.at(-1)![0]).toBe(interrupted); // still reported
    });
  });
});

describe("TestEvalClientTransportConnect", () => {
  test("test_sends_eval_connect_before_client_ready", async () => {
    const flags = new EvalConnectionFlags({ skipTts: true });
    const transport = new EvalClientTransport("ws://localhost:7860", null, { flags });
    const sent: string[] = [];
    const internals = transport as unknown as {
      _session: { send(message: string): Promise<boolean> };
      _onConnected(websocket: WebsocketConnection | null): Promise<void>;
    };
    internals._session.send = mock(async (message: string) => {
      sent.push(message);
      return true;
    });

    await internals._onConnected(null);

    const messages = sent.map((m) => pyJsonLoads(m) as Record<string, unknown>);
    expect(parseEvalConnect(messages[0])).toEqual(flags);
    expect(messages[1]!.type).toEqual("client-ready");
  });
});
