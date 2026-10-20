// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_silero_vad.py

/**
 * Tests for the Silero VAD analyzer and its ONNX model wrapper.
 *
 * PORTING NOTES:
 * - Runs on the default `@pipedog/onnx` backend (onnxruntime-node here).
 * - numpy's `default_rng(0)` is replaced by a seeded mulberry32 + Box-Muller
 *   generator: same distributions, different draws.
 * - `soundfile` → a minimal PCM16 WAV reader; `soxr.resample` → core's
 *   `soxrResample` (default resampler engine), at soxr's default `HQ`.
 * - `patch("time.time", ...)` is not needed: the analyzer never reads the
 *   clock (upstream patches it for code that does, so the audio drives time).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getResamplerEngine } from "@pipedog/core/audio/resamplers/engine";
import { soxrResample } from "@pipedog/core/audio/resamplers/soxr_resampler";
import { VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { type SileroModel, type SileroOnnxModel, SileroVADAnalyzer } from "../src/silero.ts";

const SAMPLE_RATE = 16000;
// 8 kHz is phone bandwidth.
const PHONE_SAMPLE_RATE = 8000;
// 20 ms, the frame size transports deliver.
const FRAME_SECS = 0.02;
// Synthesized (Kokoro) speech with every pause removed, so a VAD listening to
// it should never report the speaker stopping.
const SPEECH_PATH = join(import.meta.dir, "assets", "continuous_speech_16k.wav");

const LONG = 300_000;

/** Access to the members the upstream tests reach into. */
interface AnalyzerInternals {
  _model: SileroModel;
}

// ---------------------------------------------------------------------------
// numpy / soundfile stand-ins

/** A seeded generator with numpy-like `normal` and `choice`. */
class Rng {
  #state: number;
  #spare: number | null = null;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  uniform(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  #standardNormal(): number {
    if (this.#spare !== null) {
      const s = this.#spare;
      this.#spare = null;
      return s;
    }
    const u1 = Math.max(this.uniform(), Number.MIN_VALUE);
    const u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.#spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  normal(mean: number, std: number, n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = mean + std * this.#standardNormal();
    return out;
  }

  choice<T>(xs: readonly T[]): T {
    return xs[Math.min(xs.length - 1, Math.floor(this.uniform() * xs.length))] as T;
  }
}

/** Read a mono PCM16 WAV file. */
function readWav(path: string): { samples: Int16Array; sampleRate: number } {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      const data = bytes.slice(offset + 8, offset + 8 + size);
      return { samples: new Int16Array(data.buffer, 0, data.length >> 1), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

function concat(...parts: Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function scale(x: Float64Array, k: number): Float64Array {
  return x.map((v) => v * k);
}

function add(a: Float64Array, b: Float64Array): Float64Array {
  expect(a.length).toEqual(b.length);
  return a.map((v, i) => v + (b[i] as number));
}

function tile(x: Float64Array, reps: number): Float64Array {
  return concat(...Array.from({ length: reps }, () => x));
}

function rms(x: Float64Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** In-place radix-2 complex FFT (`n` a power of two). */
function fftPow2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Complex DFT of any length (Bluestein), unnormalized; `inverse` flips the sign only. */
function dft(re: Float64Array, im: Float64Array, inverse: boolean): [Float64Array, Float64Array] {
  const n = re.length;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const sign = inverse ? 1 : -1;
  const cr = new Float64Array(n);
  const ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = (sign * Math.PI * ((k * k) % (2 * n))) / n;
    cr[k] = Math.cos(ang);
    ci[k] = Math.sin(ang);
  }
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = (re[k] as number) * (cr[k] as number) - (im[k] as number) * (ci[k] as number);
    ai[k] = (re[k] as number) * (ci[k] as number) + (im[k] as number) * (cr[k] as number);
  }
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  br[0] = cr[0] as number;
  bi[0] = -(ci[0] as number);
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = cr[k] as number;
    bi[k] = bi[m - k] = -(ci[k] as number);
  }
  fftPow2(ar, ai, false);
  fftPow2(br, bi, false);
  for (let k = 0; k < m; k++) {
    const r = (ar[k] as number) * (br[k] as number) - (ai[k] as number) * (bi[k] as number);
    ai[k] = (ar[k] as number) * (bi[k] as number) + (ai[k] as number) * (br[k] as number);
    ar[k] = r;
  }
  fftPow2(ar, ai, true);
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const xr = (ar[k] as number) / m;
    const xi = (ai[k] as number) / m;
    outRe[k] = xr * (cr[k] as number) - xi * (ci[k] as number);
    outIm[k] = xr * (ci[k] as number) + xi * (cr[k] as number);
  }
  return [outRe, outIm];
}

// ---------------------------------------------------------------------------

describe("TestSileroVAD", () => {
  let analyzer: SileroVADAnalyzer;
  let model: SileroOnnxModel;

  beforeAll(async () => {
    // Loading the ONNX model once is enough; it's reused across tests.
    analyzer = new SileroVADAnalyzer({ sampleRate: 16000 });
    analyzer.setSampleRate(16000);
    model = (analyzer as unknown as AnalyzerInternals)._model as SileroOnnxModel;
    await analyzer.ready();
  });

  test("test_too_many_dimensions_raises_value_error", async () => {
    // A >2-D input must raise a descriptive error. (Upstream: the message
    // previously called `x.dim()`, a PyTorch method, on a NumPy array.)
    const badInput = { data: new Float32Array(512), dims: [1, 1, 512] };
    const error = await model.call(badInput, 16000).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    // The dimension count should be interpolated into the message.
    expect(error!.message).toContain("3");
  });

  test("test_voice_confidence_silence", async () => {
    // voiceConfidence converts a raw int16 buffer and returns a valid score.
    const silence = new Uint8Array(new Int16Array(512).buffer);
    const confidence = await analyzer.voiceConfidence(silence);
    expect(confidence).toBeGreaterThanOrEqual(0.0);
    expect(confidence).toBeLessThanOrEqual(1.0);
    // Silence should not be confidently classified as speech.
    expect(confidence).toBeLessThan(0.5);
  });

  test("test_voice_confidence_conversion_matches_expected", async () => {
    // The int16->float32 conversion feeds the model the expected values.
    const samples = Int16Array.from([0, 16384, -32768, 32767]);
    const buffer = new Uint8Array(samples.buffer);

    const captured: { audio?: Float32Array } = {};
    const internals = analyzer as unknown as AnalyzerInternals;
    const originalModel = internals._model;

    internals._model = {
      async call(audioFloat32, sampleRate) {
        captured.audio = audioFloat32 as Float32Array;
        // Pad to a valid frame so the underlying model doesn't complain.
        const padded = new Float32Array(512);
        return originalModel.call(padded, sampleRate);
      },
      resetStates: (batchSize) => originalModel.resetStates(batchSize),
    };
    try {
      await analyzer.voiceConfidence(buffer);
    } finally {
      internals._model = originalModel;
    }

    const expected = Float32Array.from(samples, (s) => s / 32768.0);
    expect(captured.audio).toEqual(expected);
  });
});

describe("TestSileroVADLongStreams", () => {
  // Silero VAD over long streams, where the model's recurrent state persists.
  //
  // Test audio is built at 16 kHz. Tests that run at 8 kHz downsample it
  // first, which leaves it with phone bandwidth.

  let speech: Float64Array;
  let rng: Rng;
  let sampleRate: number;
  let analyzer: SileroVADAnalyzer;
  let position: number;
  let resetPositions: number[];

  beforeAll(async () => {
    const wav = readWav(SPEECH_PATH);
    expect(wav.sampleRate).toEqual(SAMPLE_RATE);
    speech = Float64Array.from(wav.samples);
    await getResamplerEngine();
  });

  beforeEach(() => {
    rng = new Rng(0);
    startStream(SAMPLE_RATE);
  });

  /** Start a fresh analyzer, like a new audio stream. */
  function startStream(rate: number): void {
    sampleRate = rate;
    analyzer = new SileroVADAnalyzer({ sampleRate: rate });
    analyzer.setSampleRate(rate);
    position = 0.0;
    resetPositions = [];

    // Record where in the audio the analyzer resets the model. The model
    // also calls resetStates(batchSize) itself to initialize its state;
    // those calls carry an argument and aren't the analyzer's resets.
    const model = (analyzer as unknown as AnalyzerInternals)._model;
    const resetStates = model.resetStates.bind(model);
    model.resetStates = (...args: [number?]) => {
      if (args.length === 0) resetPositions.push(position);
      resetStates(...args);
    };
  }

  function noise(seconds: number, std: number): Float64Array {
    return rng.normal(0, std, Math.trunc(seconds * SAMPLE_RATE));
  }

  /** Noise weighted toward low frequencies, like room and line noise. */
  function pinkNoise(seconds: number, targetRms: number): Float64Array {
    const samples = Math.trunc(seconds * SAMPLE_RATE);
    const white = rng.normal(0, 1, samples);
    const [re, im] = dft(white, new Float64Array(samples), false);
    // rfftfreq, with frequencies[0] = frequencies[1]; negative-frequency bins
    // mirror the positive ones, so the inverse transform stays real.
    for (let k = 0; k < samples; k++) {
      const bin = Math.max(1, Math.min(k, samples - k));
      const w = 1 / Math.sqrt((bin * SAMPLE_RATE) / samples);
      re[k] = (re[k] as number) * w;
      im[k] = (im[k] as number) * w;
    }
    const [pr] = dft(re, im, true);
    const pink = pr.map((v) => v / samples);
    return scale(pink, targetRms / rms(pink));
  }

  /** Synthesized music: plucked notes over a sustained chord. */
  function music(seconds: number): Float64Array {
    const samples = Math.trunc(seconds * SAMPLE_RATE);
    const notes = new Float64Array(samples);
    const noteSamples = Math.trunc(0.25 * SAMPLE_RATE);
    for (let start = 0; start < samples; start += noteSamples) {
      const len = Math.min(noteSamples, samples - start);
      const frequency = rng.choice([261.6, 293.7, 329.6, 392.0, 440.0, 523.3]);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        let harmonics = 0;
        for (let h = 1; h < 6; h++) harmonics += Math.sin(2 * Math.PI * frequency * h * t) / h;
        notes[start + i] = harmonics * Math.exp(-6 * t);
      }
    }
    const out = new Float64Array(samples);
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      let chord = 0;
      for (const f of [130.8, 164.8, 196.0]) chord += Math.sin(2 * Math.PI * f * t);
      out[i] = (notes[i] as number) + 0.3 * chord;
      peak = Math.max(peak, Math.abs(out[i] as number));
    }
    return scale(out, 6000 / peak);
  }

  /** Share of frames from `start` seconds on that the VAD reports as speech. */
  function speakingShare(states: VADState[], start: number): number {
    const after = states.slice(Math.trunc(start / FRAME_SECS));
    return after.filter((s) => s === VADState.SPEAKING).length / after.length;
  }

  /**
   * Feed audio to the analyzer in transport-sized frames.
   *
   * @param audio Audio at 16 kHz, resampled to the stream's sample rate.
   * @returns The VAD state after each frame.
   */
  async function analyze(audio16k: Float64Array): Promise<VADState[]> {
    let audio: Float64Array | Float32Array = audio16k;
    if (sampleRate !== SAMPLE_RATE) {
      audio = soxrResample(Float32Array.from(audio16k), SAMPLE_RATE, sampleRate, "HQ");
    }
    // np.clip(...).astype(np.int16) truncates toward zero.
    const pcm = Int16Array.from(audio, (v) => Math.trunc(Math.min(32767, Math.max(-32768, v))));
    const frameSamples = Math.trunc(FRAME_SECS * sampleRate);
    const states: VADState[] = [];
    for (let start = 0; start < pcm.length - frameSamples + 1; start += frameSamples) {
      position = start / sampleRate;
      const frame = new Uint8Array(pcm.slice(start, start + frameSamples).buffer);
      states.push(await analyzer.analyzeAudio(frame));
    }
    return states;
  }

  test(
    "test_detects_speech_after_minutes_of_background_sound",
    async () => {
      // Quiet speech is still detected after minutes of room tone or noise.
      //
      // A model whose state drifts during non-speech loses confidence in the
      // speech that follows, which shows first on quiet speech.
      const quietSpeech = scale(speech, 0.15);
      for (const rate of [SAMPLE_RATE, PHONE_SAMPLE_RATE]) {
        const backgrounds: Record<string, (seconds: number) => Float64Array> = {
          "room tone": (seconds) => noise(seconds, 60),
          "pink noise": (seconds) => pinkNoise(seconds, 200),
        };
        for (const [name, background] of Object.entries(backgrounds)) {
          // subTest(sample_rate=rate, background=name)
          startStream(rate);
          const leadIn = background(120);
          const speechWithBg = add(quietSpeech, background(quietSpeech.length / SAMPLE_RATE));

          const states = await analyze(concat(leadIn, speechWithBg));

          const speaking = speakingShare(states, leadIn.length / SAMPLE_RATE);
          expect(
            speaking,
            `VAD missed speech after 2 minutes of ${name} at ${rate} Hz: ${Math.round(speaking * 100)}%`,
          ).toBeGreaterThan(0.8);
        }
      }
    },
    LONG,
  );

  test(
    "test_detects_speech_after_music",
    async () => {
      // Quiet speech is still detected shortly after a minute of music.
      //
      // Music leaves the model unable to detect the speech that follows until
      // its state is reset. Runs on phone audio, where music most often
      // reaches the inbound track (hold music on outbound calls) and
      // suppresses speech most.
      startStream(PHONE_SAMPLE_RATE);
      const leadIn = concat(music(60), noise(2.5, 60));

      const states = await analyze(concat(leadIn, scale(speech, 0.15)));

      const speaking = speakingShare(states, leadIn.length / SAMPLE_RATE);
      expect(
        speaking,
        `VAD missed speech after music: ${Math.round(speaking * 100)}%`,
      ).toBeGreaterThan(0.8);
    },
    LONG,
  );

  test(
    "test_sustained_speech_has_no_false_stops",
    async () => {
      // Minutes of uninterrupted speech over background noise never end early.
      //
      // Runs at 16 kHz only: on this looped synthesized voice in white noise,
      // the 8 kHz model occasionally reports a stop.
      const looped = tile(speech, 30); // ~3 minutes
      const signalRms = rms(looped);
      const noisy = add(looped, rng.normal(0, signalRms / Math.sqrt(10), looped.length)); // 10 dB SNR

      const states = await analyze(noisy);

      // states.index(VADState.SPEAKING) raises when speech is never detected.
      expect(states.indexOf(VADState.SPEAKING)).toBeGreaterThanOrEqual(0);
      const afterStart = states.slice(states.indexOf(VADState.SPEAKING));
      expect(
        afterStart.includes(VADState.QUIET),
        "VAD reported the speaker stopping during continuous speech",
      ).toBe(false);
    },
    LONG,
  );

  test(
    "test_model_is_reset_during_non_speech",
    async () => {
      // The model is reset about every two seconds while there's no speech.
      await analyze(noise(30, 300));

      expect(
        resetPositions.length >= 12 && resetPositions.length <= 15,
        `expected a reset about every 2s over 30s, got ${resetPositions.length}`,
      ).toBe(true);
      const spacing = resetPositions.slice(1).map((p, i) => p - (resetPositions[i] as number));
      expect(Math.min(...spacing)).toBeGreaterThanOrEqual(2.0);
    },
    LONG,
  );

  test(
    "test_model_is_never_reset_during_speech",
    async () => {
      // A minute of uninterrupted speech gets no resets, and resets resume after it.
      const looped = tile(speech, 10); // ~1 minute
      const speechStart = 10.0;
      const speechEnd = speechStart + looped.length / SAMPLE_RATE;

      await analyze(concat(noise(speechStart, 60), looped, noise(10, 60)));

      const duringSpeech = resetPositions.filter((p) => speechStart <= p && p <= speechEnd);
      expect(duringSpeech, "model was reset during speech").toEqual([]);
      expect(resetPositions.some((p) => p > speechEnd)).toBe(true);
    },
    LONG,
  );
});
