// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_base_smart_turn_buffer.py

/**
 * Tests for BaseSmartTurn's audio buffer behavior.
 *
 * The buffer holds int16 PCM views and defers the float32 conversion to
 * _processSpeechSegment so it runs once per turn instead of once per
 * appended audio frame. These tests verify:
 *
 *   1. The deferred float32 segment is bit-identical to the eager version that
 *      converted each chunk in appendAudio.
 *   2. The pre-speech trim loop still bounds buffer size when no speech ever
 *      triggers.
 */

import { describe, expect, test } from "bun:test";

import { monotonic, sleep } from "@pipecat-ts/asyncio";

import { EndOfTurnState } from "../src/audio/turn/base_turn_analyzer.ts";
import {
  BaseSmartTurn,
  SmartTurnParams,
  type SmartTurnPrediction,
} from "../src/audio/turn/smart_turn/base_smart_turn.ts";
import type { MetricsData } from "../src/metrics/metrics.ts";

// Upstream: `ort = pytest.importorskip("onnxruntime")` is only needed by real
// BaseSmartTurn subclasses; the test double below needs no model runtime.

/** Test double that records the segment audio passed into _predictEndpoint. */
class _RecordingSmartTurn extends BaseSmartTurn {
  capturedSegment: Float32Array | null = null;

  protected override async _predictEndpoint(
    audioArray: Float32Array,
  ): Promise<SmartTurnPrediction> {
    this.capturedSegment = audioArray.slice();
    return { prediction: 1, probability: 0.99 };
  }
}

/** Test-only view of the analyzer's protected state (Python reads it directly). */
interface Internals {
  _audioBuffer: [number, Int16Array][];
  _speechTriggered: boolean;
  _speechStartTime: number;
  _processSpeechSegment(
    audioBuffer: [number, Int16Array][],
  ): Promise<[EndOfTurnState, MetricsData | null]>;
}
const internals = (a: _RecordingSmartTurn): Internals => a as unknown as Internals;

/** Pack an int16 array into PCM bytes, the wire format appendAudio expects. */
function _pcmBytes(values: Int16Array): Uint8Array {
  return new Uint8Array(
    values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength),
  );
}

/** Seeded integer generator (stands in for np.random.default_rng(seed=1234)). */
function seededInt16(n: number, seed: number): Int16Array {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Int16Array(n);
  // integers(-32768, 32767): high is exclusive.
  for (let i = 0; i < n; i++) out[i] = -32768 + Math.floor(next() * 65535);
  return out;
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** `int16.astype(np.float32) / 32768.0` */
function toFloat32(values: Int16Array): Float32Array {
  return Float32Array.from(values, (v) => v / 32768.0);
}

function allClose(a: Float32Array, b: number): boolean {
  // np.allclose defaults: rtol=1e-05, atol=1e-08
  return a.every((v) => Math.abs(v - b) <= 1e-8 + 1e-5 * Math.abs(b));
}

/**
 * The deferred segment must be bit-identical to per-chunk conversion.
 *
 * For `int16 -> float32 / 32768.0` the two orderings (cast-each-then-concat vs
 * concat-then-cast) are equivalent element-wise: the cast is per-element and
 * the divide is multiplication by a float constant, so concatenation
 * distributes through both. We assert this concretely so that any future code
 * change to the conversion pipeline cannot silently shift outputs.
 */
test("test_segment_matches_eager_conversion_bit_identical", () => {
  const chunkSize = 320; // 20 ms @ 16 kHz
  const nChunks = 12;
  const chunksInt16 = Array.from({ length: nChunks }, (_, i) => seededInt16(chunkSize, 1234 + i));

  // Eager: convert each chunk to float32 in isolation, then concatenate.
  const eagerFloat32Chunks = chunksInt16.map((c) => toFloat32(c));
  const eagerSegment = concatFloat32(eagerFloat32Chunks);

  // Deferred (what _processSpeechSegment now does): concatenate int16, then cast.
  const deferredSegment = toFloat32(concatInt16(chunksInt16));

  expect(deferredSegment).toBeInstanceOf(Float32Array);
  expect(eagerSegment.length).toEqual(deferredSegment.length);
  // Bit-identical, not just close: this is a structural property of the
  // operation, not an approximation.
  expect(
    new Uint8Array(eagerSegment.buffer).every(
      (byte, i) => byte === new Uint8Array(deferredSegment.buffer)[i],
    ),
  ).toBe(true);
  expect(eagerSegment).toEqual(deferredSegment);
});

/** After appendAudio, _audioBuffer entries should be int16, not float32. */
test("test_buffer_holds_int16_views_after_append", () => {
  const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });
  analyzer.setSampleRate(16_000);
  const chunk = new Int16Array([100, -200, 300, -400]);
  analyzer.appendAudio(_pcmBytes(chunk), true);

  const audioBuffer = internals(analyzer)._audioBuffer;
  expect(audioBuffer.length).toEqual(1);
  const [, stored] = audioBuffer[0] as [number, Int16Array];
  expect(stored).toBeInstanceOf(Int16Array);
  expect(Array.from(stored)).toEqual(Array.from(chunk));
});

/** When a turn completes, _processSpeechSegment must emit float32 in [-1, 1]. */
test("test_segment_audio_is_normalized_float32", async () => {
  const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });
  analyzer.setSampleRate(16_000);

  // Feed a speech-then-silence sequence: a few speech frames, then enough
  // silence to cross stop_secs (default 3 s) so the turn closes.
  const chunkSize = 320; // 20 ms @ 16 kHz
  const speech = new Int16Array(chunkSize).fill(16_000); // constant 0.488...
  const silence = new Int16Array(chunkSize);

  // Two speech chunks (40 ms) to trigger.
  for (let i = 0; i < 2; i++) {
    analyzer.appendAudio(_pcmBytes(speech), true);
  }
  // Then ~3.1 s of silence to exceed stop_secs.
  let state: EndOfTurnState = EndOfTurnState.INCOMPLETE;
  for (let i = 0; i < 160; i++) {
    // 160 * 20 ms = 3.2 s
    state = analyzer.appendAudio(_pcmBytes(silence), false);
    if (state === EndOfTurnState.COMPLETE) {
      break;
    }
  }

  // Run the segment processor directly. We rebuild the audio buffer first by
  // re-feeding, because _clear() emptied it when stop_secs fired. Easier path:
  // drive a fresh sequence and call _processSpeechSegment directly.
  const analyzer2 = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });
  analyzer2.setSampleRate(16_000);
  internals(analyzer2)._speechTriggered = true;
  internals(analyzer2)._speechStartTime = monotonic();
  for (let i = 0; i < 4; i++) {
    analyzer2.appendAudio(_pcmBytes(speech), true);
  }

  await internals(analyzer2)._processSpeechSegment(internals(analyzer2)._audioBuffer);
  expect(analyzer2.capturedSegment).not.toBeNull();
  const segment = analyzer2.capturedSegment as Float32Array;
  expect(segment).toBeInstanceOf(Float32Array);
  expect(segment.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(1.0);
  // The constant 16000 / 32768 ≈ 0.48828125 should appear throughout.
  expect(allClose(segment, 16_000 / 32768.0)).toBe(true);
});

/** Without speech, the buffer must stay bounded by pre_speech_ms + stop_secs + max_duration_secs. */
test("test_pre_speech_buffer_trim_still_bounds_growth", async () => {
  const params = new SmartTurnParams({ preSpeechMs: 100, stopSecs: 0.2, maxDurationSecs: 0.5 });
  const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params });
  analyzer.setSampleRate(16_000);

  const chunk = new Int16Array(320);
  // Feed chunks of non-speech; all timestamps are taken via monotonic() inside
  // appendAudio, and any chunk older than 0.8 s gets popped on each call.
  for (let i = 0; i < 50; i++) {
    analyzer.appendAudio(_pcmBytes(chunk), false);
    await sleep(0.02); // advance monotonic clock past the trim window cumulatively
  }

  // max_buffer_time is 0.1 + 0.2 + 0.5 = 0.8 s; at 50 Hz that caps the buffer
  // well below 50 entries. We're conservative — anything < 50 proves the trim ran.
  expect(internals(analyzer)._audioBuffer.length).toBeLessThan(50);
});

/**
 * clear() after an externally-ended turn must kill the stale silence timer.
 *
 * Regression for the phantom end-of-turn: a turn force-ended mid-speech (e.g.
 * a max-speech cap plus a mute strategy) leaves _speechTriggered true with
 * buffered audio. Without clear(), post-unmute silence accumulates until
 * stop_secs fires a spurious COMPLETE during the bot's speech.
 */
test("test_clear_prevents_stale_stop_secs_completion", () => {
  const params = new SmartTurnParams({ stopSecs: 0.2 });
  const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params });
  analyzer.setSampleRate(16_000);

  const chunkSize = 320; // 20 ms @ 16 kHz
  const speech = new Int16Array(chunkSize).fill(16_000);
  const silence = new Int16Array(chunkSize);

  // Mid-speech state: speech triggered, no COMPLETE yet.
  for (let i = 0; i < 4; i++) {
    analyzer.appendAudio(_pcmBytes(speech), true);
  }
  expect(analyzer.speechTriggered).toBe(true);

  // The turn is ended externally: the strategy's handle_user_turn_stopped
  // callback calls clear().
  analyzer.clear();
  expect(analyzer.speechTriggered).toBe(false);

  // Ambient silence well past stop_secs (0.6 s vs 0.2 s). Without the clear,
  // this returned COMPLETE: the phantom stop.
  for (let i = 0; i < 30; i++) {
    const state = analyzer.appendAudio(_pcmBytes(silence), false);
    expect(state).toEqual(EndOfTurnState.INCOMPLETE);
  }
});

/** After clear(), the next prediction must only see post-clear audio. */
test("test_clear_drops_pre_clear_audio_from_next_segment", async () => {
  const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });
  analyzer.setSampleRate(16_000);

  const chunkSize = 320;
  const old = new Int16Array(chunkSize).fill(1_000);
  const fresh = new Int16Array(chunkSize).fill(2_000);

  // Audio from the force-ended turn.
  for (let i = 0; i < 4; i++) {
    analyzer.appendAudio(_pcmBytes(old), true);
  }
  analyzer.clear();

  // The next turn's audio, fed continuously as usual.
  for (let i = 0; i < 4; i++) {
    analyzer.appendAudio(_pcmBytes(fresh), true);
  }

  await internals(analyzer)._processSpeechSegment(internals(analyzer)._audioBuffer);
  expect(analyzer.capturedSegment).not.toBeNull();
  // Only the post-clear constant may appear in the segment.
  expect(allClose(analyzer.capturedSegment as Float32Array, 2_000 / 32768.0)).toBe(true);
});

describe("cleanup", () => {
  // DIVERGENCE: upstream runs the model on a lazily-created ThreadPoolExecutor
  // (`_executor`) that cleanup() shuts down. There are no threads in the port
  // (docs/CONVENTIONS.md, "WASM and Cloudflare Workers"), so there is no
  // `_executor` to assert on. Behavior after cleanup is still covered by
  // test_analyzing_works_again_after_cleanup.
  test.skip("test_cleanup_releases_the_model_thread", async () => {
    const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });
    await analyzer.analyzeEndOfTurn();
    await analyzer.cleanup();
  });

  /**
   * Cleaning up is not only teardown here.
   *
   * A turn strategy is cleaned up and re-applied whenever the strategies are
   * updated, which happens before the first user turn when a realtime service
   * recommends its own. Releasing the thread for good would leave smart turn
   * dead for the rest of the session.
   */
  test("test_analyzing_works_again_after_cleanup", async () => {
    const analyzer = new _RecordingSmartTurn({ sampleRate: 16_000, params: new SmartTurnParams() });

    await analyzer.analyzeEndOfTurn();
    await analyzer.cleanup();

    const [state] = await analyzer.analyzeEndOfTurn();

    expect(state).toEqual(EndOfTurnState.INCOMPLETE);
  });
});
