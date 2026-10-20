// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ttfa_metrics.py

/** Tests for time-to-first-audio (TTFA) detection and metrics. */

import { describe, expect, test } from "bun:test";

import { time } from "@pipedog/asyncio";

import { detectSpeechOnset } from "../src/audio/utils.ts";
import type { MetricsFrame } from "../src/frames/frames.ts";
import { TTFAMetricsData } from "../src/metrics/metrics.ts";
import { FrameProcessorMetrics } from "../src/processors/metrics/frame_processor_metrics.ts";

const SAMPLE_RATE = 16000;

/** Pack int16 samples as little-endian bytes (numpy `.astype(np.int16).tobytes()`). */
function int16Bytes(samples: ArrayLike<number>): Uint8Array {
  return new Uint8Array(Int16Array.from(samples).buffer);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function _silence(seconds: number): Uint8Array {
  return int16Bytes(new Array<number>(Math.trunc(SAMPLE_RATE * seconds)).fill(0));
}

/** A sustained tone (continuous energy, unlike an isolated blip). */
function _tone(seconds: number, amplitude = 5000): Uint8Array {
  const n = Math.trunc(SAMPLE_RATE * seconds);
  const samples = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = (i * seconds) / n;
    // astype(np.int16) truncates toward zero.
    samples[i] = Math.trunc(Math.sin(2 * Math.PI * 220 * t) * amplitude);
  }
  return int16Bytes(samples);
}

/** A single sample at a realistic noise-floor amplitude. */
function _blip(amplitude = 2370): Uint8Array {
  return int16Bytes([amplitude]);
}

/** Duplicate a mono buffer into interleaved stereo (L == R). */
function _stereo(mono: Uint8Array): Uint8Array {
  const src = new Int16Array(mono.buffer, mono.byteOffset, mono.byteLength / 2);
  const out = new Int16Array(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    out[2 * i] = src[i]!;
    out[2 * i + 1] = src[i]!;
  }
  return new Uint8Array(out.buffer);
}

/** Equivalent of `pytest.approx(expected, abs=tol)`. */
function expectApprox(actual: number, expected: number, abs?: number): void {
  // pytest.approx default: rel=1e-6, abs=1e-12.
  const tol = abs ?? Math.max(1e-6 * Math.abs(expected), 1e-12);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe("TestDetectSpeechOnset", () => {
  test("test_leading_silence_then_tone", () => {
    const onset = detectSpeechOnset(concat(_silence(0.5), _tone(0.5)), SAMPLE_RATE);
    expect(onset).not.toBeNull();
    expect(Math.abs(onset! / SAMPLE_RATE - 0.5)).toBeLessThan(0.015);
  });

  test("test_tone_from_start", () => {
    const onset = detectSpeechOnset(_tone(0.2), SAMPLE_RATE);
    expect(onset).not.toBeNull();
    expect(onset! / SAMPLE_RATE).toBeLessThan(0.01);
  });

  test("test_all_silence_returns_none", () => {
    expect(detectSpeechOnset(_silence(0.3), SAMPLE_RATE)).toBeNull();
  });

  test("test_empty_returns_none", () => {
    expect(detectSpeechOnset(new Uint8Array(0), SAMPLE_RATE)).toBeNull();
  });

  test("test_too_short_to_frame_returns_none", () => {
    // Fewer samples than one analysis frame: wait for more audio.
    expect(detectSpeechOnset(_tone(0.005), SAMPLE_RATE)).toBeNull();
  });

  test("test_isolated_blip_is_rejected", () => {
    // A single noise-floor blip must not be mistaken for speech onset.
    const buf = concat(_silence(0.2), _blip(), _silence(0.2));
    expect(detectSpeechOnset(buf, SAMPLE_RATE)).toBeNull();
  });

  test("test_brief_loud_burst_is_rejected", () => {
    // A loud transient shorter than min_voiced_ms must not trigger onset.
    const burst = _tone(0.01, 8000); // 10ms < 25ms minimum voiced
    const buf = concat(_silence(0.2), burst, _silence(0.2));
    expect(detectSpeechOnset(buf, SAMPLE_RATE)).toBeNull();
  });

  test("test_blip_before_real_onset_locks_onto_speech", () => {
    // The blip at 0.1s is ignored; onset is the sustained tone at ~0.25s.
    const buf = concat(_silence(0.1), _blip(), _silence(0.15), _tone(0.3));
    const onset = detectSpeechOnset(buf, SAMPLE_RATE);
    expect(onset).not.toBeNull();
    expect(Math.abs(onset! / SAMPLE_RATE - 0.25)).toBeLessThan(0.02);
  });

  test("test_stereo", () => {
    const buf = _stereo(concat(_silence(0.1), _tone(0.3)));
    const onset = detectSpeechOnset(buf, SAMPLE_RATE, 2);
    expect(onset).not.toBeNull();
    expect(Math.abs(onset! / SAMPLE_RATE - 0.1)).toBeLessThan(0.02);
  });
});

describe("TestTTFAMetrics", () => {
  function _makeMetrics(): FrameProcessorMetrics {
    const m = new FrameProcessorMetrics();
    m.setProcessorName("TestTTS");
    return m;
  }

  /** Run a TTFB measurement of `ttfb` seconds, which arms the TTFA scan. */
  async function _measureTtfb(m: FrameProcessorMetrics, ttfb: number): Promise<void> {
    const start = time();
    await m.startTtfbMetrics({ startTime: start, reportOnlyInitialTtfb: false });
    await m.stopTtfbMetrics({ endTime: start + ttfb });
  }

  async function _process(
    m: FrameProcessorMetrics,
    audio: Uint8Array,
    numChannels = 1,
  ): Promise<MetricsFrame | null> {
    return await m.processTtfaMetrics({ audio, sampleRate: SAMPLE_RATE, numChannels });
  }

  test("test_ttfa_spans_multiple_chunks", async () => {
    const m = _makeMetrics();
    // A 0.2s TTFB measurement arms TTFA and provides its base value.
    await _measureTtfb(m, 0.2);

    // First chunk is entirely silence: buffered, no metric yet.
    expect(await _process(m, _silence(0.3))).toBeNull();

    // Second chunk completes the leading silence (0.4s total) then tone.
    const frame = await _process(m, concat(_silence(0.1), _tone(0.3)));
    expect(frame).not.toBeNull();
    const data = frame!.data[0] as TTFAMetricsData;
    expect(data).toBeInstanceOf(TTFAMetricsData);
    // 0.2s TTFB + 0.4s leading silence, carried as a breakdown.
    expectApprox(data.ttfa, 0.6, 0.02);
    expectApprox(data.ttfb, 0.2, 1e-3);
    expectApprox(data.leadingSilence, 0.4, 0.02);
    expectApprox(data.ttfa, data.ttfb + data.leadingSilence);
  });

  test("test_ttfa_reported_once_per_response", async () => {
    const m = _makeMetrics();
    await _measureTtfb(m, 0.1);

    const first = await _process(m, _tone(0.2));
    expect(first).not.toBeNull();
    // Subsequent audio in the same response does not re-report.
    expect(await _process(m, _tone(0.2))).toBeNull();
  });

  test("test_no_metric_without_ttfb", async () => {
    const m = _makeMetrics();
    // TTFB never measured, so the scan is never armed: processing is a no-op.
    expect(await _process(m, _tone(0.2))).toBeNull();
  });

  test("test_all_silence_response_emits_nothing", async () => {
    const m = _makeMetrics();
    await _measureTtfb(m, 0.1);
    expect(await _process(m, _silence(0.5))).toBeNull();
  });

  test("test_ttfa_rearmed_each_response", async () => {
    const m = _makeMetrics();

    // First response: 0.1s TTFB, no leading silence.
    await _measureTtfb(m, 0.1);
    const first = await _process(m, _tone(0.2));
    expect(first).not.toBeNull();
    expectApprox((first!.data[0] as TTFAMetricsData).ttfa, 0.1, 0.02);

    // Second response re-arms via a fresh TTFB stop; buffer/silence reset.
    await _measureTtfb(m, 0.3);
    const second = await _process(m, concat(_silence(0.2), _tone(0.2)));
    expect(second).not.toBeNull();
    expectApprox((second!.data[0] as TTFAMetricsData).ttfa, 0.5, 0.02);
  });
});
