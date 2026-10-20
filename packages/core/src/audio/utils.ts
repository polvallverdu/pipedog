// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/utils.py

/**
 * Audio utility functions for Pipecat.
 *
 * Provides common audio processing utilities including mixing, format
 * conversion, volume calculation, and codec transformations for various audio
 * formats used in Pipecat pipelines.
 *
 * Porting notes: numpy is replaced by typed arrays; Python's `audioop`
 * (G.711 μ-law/A-law), `wave` and the `loudness` package (ITU-R BS.1770
 * integrated loudness) are reimplemented here in plain TypeScript.
 */

import type { BaseAudioResampler } from "./resamplers/base_audio_resampler.ts";
import {
  bytesToInt16,
  SOXRAudioResampler,
  type SOXRAudioResamplerOptions,
} from "./resamplers/soxr_resampler.ts";
import {
  SOXRStreamAudioResampler,
  type SOXRStreamAudioResamplerOptions,
} from "./resamplers/soxr_stream_resampler.ts";

// Normal speech usually results in many samples between ±500 to ±5000,
// depending on loudness and mic gain. So we are using a threshold that is well
// below what real speech produces.
export const SPEAKING_THRESHOLD = 20;

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Create an audio resampler instance for batch processing of complete audio
 * files.
 *
 * @param options Options passed to the resampler constructor.
 * @returns A configured SOXRAudioResampler instance.
 */
export function createFileResampler(options: SOXRAudioResamplerOptions = {}): BaseAudioResampler {
  return new SOXRAudioResampler(options);
}

/**
 * Create a stream audio resampler instance.
 *
 * @param options Options passed to the resampler constructor.
 * @returns A configured SOXRStreamAudioResampler instance.
 */
export function createStreamResampler(
  options: SOXRStreamAudioResamplerOptions = {},
): BaseAudioResampler {
  return new SOXRStreamAudioResampler(options);
}

function clipInt16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}

/**
 * Mix two audio streams together by adding their samples.
 *
 * Both audio streams are assumed to be 16-bit signed integer PCM data. If the
 * streams have different lengths, the shorter one is zero-padded to match the
 * longer stream.
 *
 * @param audio1 First audio stream as raw bytes (16-bit signed integers).
 * @param audio2 Second audio stream as raw bytes (16-bit signed integers).
 * @returns Mixed audio data as raw bytes with samples clipped to 16-bit range.
 */
export function mixAudio(audio1: Uint8Array, audio2: Uint8Array): Uint8Array {
  const data1 = bytesToInt16(audio1);
  const data2 = bytesToInt16(audio2);

  // Max length
  const maxLength = Math.max(data1.length, data2.length);

  // Mix the arrays (zero-padding the shorter one)
  const mixedAudio = new Int16Array(maxLength);
  for (let i = 0; i < maxLength; i++) {
    const a = i < data1.length ? (data1[i] as number) : 0;
    const b = i < data2.length ? (data2[i] as number) : 0;
    mixedAudio[i] = clipInt16(a + b);
  }

  return int16ToBytes(mixedAudio);
}

/**
 * Scale the volume of an audio stream by multiplying its samples.
 *
 * The audio is assumed to be 16-bit signed integer PCM data.
 *
 * @param audio Audio as raw bytes (16-bit signed integers).
 * @param factor The multiplier for every sample: 1.0 leaves the audio
 *   unchanged, 0.5 halves it.
 * @returns Scaled audio data as raw bytes with samples clipped to 16-bit range.
 */
export function scaleAudio(audio: Uint8Array, factor: number): Uint8Array {
  const data = bytesToInt16(audio);
  const out = new Int16Array(data.length);
  const f = Math.fround(factor);
  for (let i = 0; i < data.length; i++) {
    // numpy computes in float32, clips, then truncates toward zero.
    out[i] = Math.trunc(clipInt16(Math.fround((data[i] as number) * f)));
  }
  return int16ToBytes(out);
}

/**
 * Interleave left and right mono audio channels into stereo audio.
 *
 * Takes two mono audio streams and combines them into a single stereo stream
 * by interleaving the samples (L, R, L, R, ...). If the channels have
 * different lengths, both are truncated to the shorter length.
 *
 * @param leftAudio Left channel audio as raw bytes (16-bit signed integers).
 * @param rightAudio Right channel audio as raw bytes (16-bit signed integers).
 * @returns Interleaved stereo audio data as raw bytes.
 */
export function interleaveStereoAudio(leftAudio: Uint8Array, rightAudio: Uint8Array): Uint8Array {
  const left = bytesToInt16(leftAudio);
  const right = bytesToInt16(rightAudio);

  const minLength = Math.min(left.length, right.length);

  const stereo = new Int16Array(minLength * 2);
  for (let i = 0; i < minLength; i++) {
    stereo[2 * i] = left[i] as number;
    stereo[2 * i + 1] = right[i] as number;
  }

  return int16ToBytes(stereo);
}

/**
 * Wrap raw PCM audio in a WAV container.
 *
 * The PCM data is expected to be signed 16-bit little-endian samples, which
 * is what Pipecat pipelines carry (e.g. what `AudioBufferProcessor` emits
 * from its audio event handlers).
 *
 * Trailing bytes that don't complete a frame are dropped. Without this the
 * WAV header would report a frame count that excludes them while the data
 * chunk still carries them, so readers would disagree about the length and a
 * stereo stream truncated mid-frame would swap channels.
 *
 * @param pcm Raw PCM audio data (16-bit signed integers). Any typed view
 *   (e.g. an `Int16Array`) is read as its underlying bytes.
 * @param sampleRate Sample rate of the audio in Hz.
 * @param numChannels Number of interleaved channels in the PCM data.
 * @returns A complete in-memory WAV file.
 */
export function pcmToWav(
  input: Uint8Array | ArrayBufferView,
  sampleRate: number,
  numChannels = 1,
): Uint8Array {
  // Upstream: `memoryview(pcm).cast("B")`.
  let pcm =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const blockAlign = 2 * numChannels;
  const remainder = pcm.length % blockAlign;
  if (remainder) {
    pcm = pcm.subarray(0, pcm.length - remainder);
  }

  // Same layout Python's `wave` module writes: RIFF header, 16-byte PCM fmt
  // chunk, data chunk (padded to an even length).
  const dataLength = pcm.length;
  const pad = dataLength % 2;
  const out = new Uint8Array(44 + dataLength + pad);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength + pad, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  out.set(pcm, 44);
  return out;
}

/** Audio read from a WAV container by `readWav()`. @internal */
export interface WavData {
  audio: Uint8Array;
  sampleRate: number;
  numChannels: number;
  sampleWidth: number;
}

/**
 * Read the PCM frames out of a WAV file (Python's `wave.open(...).readframes()`).
 *
 * @internal
 */
export function readWav(data: Uint8Array): WavData {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("file does not start with RIFF id");
  }
  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let sampleWidth = 0;
  let audio: Uint8Array | null = null;
  while (offset + 8 <= data.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      sampleWidth = Math.ceil(view.getUint16(body + 14, true) / 8);
    } else if (id === "data") {
      audio = data.slice(body, Math.min(body + size, data.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!audio || !sampleRate) {
    throw new Error("fmt chunk and/or data chunk missing");
  }
  return { audio, sampleRate, numChannels, sampleWidth };
}

/**
 * Normalize a value to the range [0, 1] and clamp it to bounds.
 *
 * @param value The value to normalize.
 * @param minValue The minimum value of the input range.
 * @param maxValue The maximum value of the input range.
 * @returns Normalized value clamped to the range [0, 1].
 */
export function normalizeValue(value: number, minValue: number, maxValue: number): number {
  const normalized = (value - minValue) / (maxValue - minValue);
  const normalizedClamped = Math.max(0, Math.min(1, normalized));
  return normalizedClamped;
}

//
// ITU-R BS.1770 integrated loudness (replaces the `loudness` package).
//

type Biquad = { b: [number, number, number]; a: [number, number, number] };

// K-weighting filter design for an arbitrary sample rate (the same analog
// prototype parameters used by libebur128 and pyloudnorm).
function kWeightingFilters(rate: number): [Biquad, Biquad] {
  // Stage 1: high shelf.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b: [
      (Vh + (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - Vh)) / a0,
      (Vh - (Vb * K) / Q + K * K) / a0,
    ],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  // Stage 2: high pass (RLB).
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highPass: Biquad = {
    b: [1, -2, 1],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  return [shelf, highPass];
}

function applyBiquad(input: Float64Array, { b, a }: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] as number;
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

function integratedLoudness(samples: Float64Array, rate: number): number {
  const blockSize = 0.4;
  const blockLength = Math.round(blockSize * rate);
  if (samples.length < blockLength) {
    throw new Error("Audio must have length greater than the block size.");
  }
  const [shelf, highPass] = kWeightingFilters(rate);
  const filtered = applyBiquad(applyBiquad(samples, shelf), highPass);

  // 400 ms gating blocks with 75% overlap.
  const step = blockSize * 0.25;
  const numBlocks = Math.round((samples.length / rate - blockSize) / step) + 1;
  const z: number[] = [];
  for (let j = 0; j < numBlocks; j++) {
    const lower = Math.trunc(blockSize * (j * 0.25) * rate);
    const upper = Math.min(Math.trunc(blockSize * (j * 0.25 + 1) * rate), filtered.length);
    let sum = 0;
    for (let i = lower; i < upper; i++) {
      const v = filtered[i] as number;
      sum += v * v;
    }
    z.push(sum / (blockSize * rate));
  }
  const blockLoudness = (zj: number) => -0.691 + 10 * Math.log10(zj);

  // Absolute gate.
  const gammaA = -70.0;
  const aboveAbs = z.filter((zj) => blockLoudness(zj) >= gammaA);
  if (aboveAbs.length === 0) return Number.NEGATIVE_INFINITY;
  const meanAbs = aboveAbs.reduce((s, v) => s + v, 0) / aboveAbs.length;

  // Relative gate.
  const gammaR = blockLoudness(meanAbs) - 10.0;
  const aboveRel = z.filter((zj) => blockLoudness(zj) > gammaR && blockLoudness(zj) > gammaA);
  if (aboveRel.length === 0) return Number.NEGATIVE_INFINITY;
  const meanRel = aboveRel.reduce((s, v) => s + v, 0) / aboveRel.length;
  return -0.691 + 10 * Math.log10(meanRel);
}

/**
 * Calculate the loudness level of audio data using ITU-R BS.1770.
 *
 * @param audio Audio data as raw bytes (16-bit signed integers). Must hold at
 *   least 400ms of audio, the length of a BS.1770 gating block.
 * @param sampleRate Sample rate of the audio in Hz.
 * @returns Normalized loudness value between 0 (quiet) and 1 (loud).
 * @throws Error if the audio is shorter than a gating block.
 */
export function calculateAudioVolume(audio: Uint8Array, sampleRate: number): number {
  const audioNp = bytesToInt16(audio);
  const audioFloat = new Float64Array(audioNp.length);
  for (let i = 0; i < audioNp.length; i++) {
    audioFloat[i] = Math.fround((audioNp[i] as number) / 32768.0);
  }

  let level = integratedLoudness(audioFloat, sampleRate);

  // Loudness goes from -110 to -10 LUFS (more or less), where -110 is quiet
  // and -10 is loud. Audio below the BS.1770 absolute gate measures as -inf,
  // which normalizes to 0.
  level = normalizeValue(level, -110, -10);

  return level;
}

/**
 * Apply exponential smoothing to a value.
 *
 * Exponential smoothing is used to reduce noise in time-series data by giving
 * more weight to recent values while still considering historical data.
 *
 * @param value The new value to incorporate.
 * @param prevValue The previous smoothed value.
 * @param factor Smoothing factor between 0 and 1. Higher values give more
 *   weight to the new value.
 * @returns The exponentially smoothed value.
 */
export function expSmoothing(value: number, prevValue: number, factor: number): number {
  return prevValue + factor * (value - prevValue);
}

//
// G.711 codecs (replaces Python's `audioop`; same algorithms as CPython).
//

const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const BIAS = 0x84;
const CLIP = 32635;

function search(value: number, table: number[]): number {
  for (let i = 0; i < table.length; i++) {
    if (value <= (table[i] as number)) return i;
  }
  return table.length;
}

function linear14ToUlaw(pcmVal: number): number {
  let mask: number;
  if (pcmVal < 0) {
    pcmVal = -pcmVal;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (pcmVal > CLIP) pcmVal = CLIP;
  pcmVal += BIAS >> 2;
  const seg = search(pcmVal, SEG_UEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  const uval = (seg << 4) | ((pcmVal >> (seg + 1)) & 0xf);
  return (uval ^ mask) & 0xff;
}

function ulawToLinear16(uVal: number): number {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0xf) << 3) + BIAS;
  t <<= (uVal & 0x70) >> 4;
  return uVal & 0x80 ? BIAS - t : t - BIAS;
}

function linear13ToAlaw(pcmVal: number): number {
  let mask: number;
  if (pcmVal >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcmVal = -pcmVal - 1;
  }
  const seg = search(pcmVal, SEG_AEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  let aval = seg << 4;
  if (seg < 2) aval |= (pcmVal >> 1) & 0xf;
  else aval |= (pcmVal >> seg) & 0xf;
  return (aval ^ mask) & 0xff;
}

function alawToLinear16(aVal: number): number {
  aVal ^= 0x55;
  let t = (aVal & 0xf) << 4;
  const seg = (aVal & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
  }
  return aVal & 0x80 ? t : -t;
}

function ulaw2lin(ulaw: Uint8Array): Uint8Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = ulawToLinear16(ulaw[i] as number);
  return int16ToBytes(out);
}

function lin2ulaw(pcm: Uint8Array): Uint8Array {
  const samples = bytesToInt16(pcm);
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linear14ToUlaw((samples[i] as number) >> 2);
  return out;
}

function alaw2lin(alaw: Uint8Array): Uint8Array {
  const out = new Int16Array(alaw.length);
  for (let i = 0; i < alaw.length; i++) out[i] = alawToLinear16(alaw[i] as number);
  return int16ToBytes(out);
}

function lin2alaw(pcm: Uint8Array): Uint8Array {
  const samples = bytesToInt16(pcm);
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linear13ToAlaw((samples[i] as number) >> 3);
  return out;
}

/**
 * Convert μ-law encoded audio to PCM and optionally resample.
 *
 * @param ulawBytes μ-law encoded audio data as raw bytes.
 * @param inRate Original sample rate of the μ-law audio in Hz.
 * @param outRate Desired output sample rate in Hz.
 * @param resampler Audio resampler instance for rate conversion.
 * @returns PCM audio data as raw bytes at the specified output rate.
 */
export async function ulawToPcm(
  ulawBytes: Uint8Array,
  inRate: number,
  outRate: number,
  resampler: BaseAudioResampler,
): Promise<Uint8Array> {
  // Convert μ-law to PCM
  const inPcmBytes = ulaw2lin(ulawBytes);

  // Resample
  const outPcmBytes = await resampler.resample(inPcmBytes, inRate, outRate);

  return outPcmBytes;
}

/**
 * Convert PCM audio to μ-law encoding and optionally resample.
 *
 * @param pcmBytes PCM audio data as raw bytes (16-bit signed integers).
 * @param inRate Original sample rate of the PCM audio in Hz.
 * @param outRate Desired output sample rate in Hz.
 * @param resampler Audio resampler instance for rate conversion.
 * @returns μ-law encoded audio data as raw bytes at the specified output rate.
 */
export async function pcmToUlaw(
  pcmBytes: Uint8Array,
  inRate: number,
  outRate: number,
  resampler: BaseAudioResampler,
): Promise<Uint8Array> {
  // Resample
  const inPcmBytes = await resampler.resample(pcmBytes, inRate, outRate);

  // Convert PCM to μ-law
  const outUlawBytes = lin2ulaw(inPcmBytes);

  return outUlawBytes;
}

/**
 * Convert A-law encoded audio to PCM and optionally resample.
 *
 * @param alawBytes A-law encoded audio data as raw bytes.
 * @param inRate Original sample rate of the A-law audio in Hz.
 * @param outRate Desired output sample rate in Hz.
 * @param resampler Audio resampler instance for rate conversion.
 * @returns PCM audio data as raw bytes at the specified output rate.
 */
export async function alawToPcm(
  alawBytes: Uint8Array,
  inRate: number,
  outRate: number,
  resampler: BaseAudioResampler,
): Promise<Uint8Array> {
  // Convert a-law to PCM
  const inPcmBytes = alaw2lin(alawBytes);

  // Resample
  const outPcmBytes = await resampler.resample(inPcmBytes, inRate, outRate);

  return outPcmBytes;
}

/**
 * Convert PCM audio to A-law encoding and optionally resample.
 *
 * @param pcmBytes PCM audio data as raw bytes (16-bit signed integers).
 * @param inRate Original sample rate of the PCM audio in Hz.
 * @param outRate Desired output sample rate in Hz.
 * @param resampler Audio resampler instance for rate conversion.
 * @returns A-law encoded audio data as raw bytes at the specified output rate.
 */
export async function pcmToAlaw(
  pcmBytes: Uint8Array,
  inRate: number,
  outRate: number,
  resampler: BaseAudioResampler,
): Promise<Uint8Array> {
  // Resample
  const inPcmBytes = await resampler.resample(pcmBytes, inRate, outRate);

  // Convert PCM to A-law
  const outAlawBytes = lin2alaw(inPcmBytes);

  return outAlawBytes;
}

/**
 * Determine if an audio sample contains silence by checking amplitude levels.
 *
 * Analyzes raw PCM audio data to detect silence by comparing the maximum
 * absolute amplitude against a predefined threshold. The audio is expected to
 * be clean speech or complete silence without background noise.
 *
 * Normal speech typically produces amplitude values between ±500 to ±5000,
 * depending on factors like loudness and microphone gain. The threshold
 * (SPEAKING_THRESHOLD) is set well below typical speech levels to reliably
 * detect silence vs. speech.
 *
 * @param pcmBytes Raw PCM audio data as bytes (16-bit signed integers).
 * @returns True if the audio sample is considered silence (below threshold),
 *   false otherwise.
 */
export function isSilence(pcmBytes: Uint8Array): boolean {
  // Read raw audio bytes as int16 samples
  const audioData = bytesToInt16(pcmBytes);
  if (audioData.length === 0) {
    // numpy's max() of an empty array raises.
    throw new Error("zero-size array to reduction operation maximum which has no identity");
  }

  // Check the maximum absolute amplitude in the frame
  let maxValue = 0;
  for (let i = 0; i < audioData.length; i++) {
    const v = Math.abs(audioData[i] as number);
    if (v > maxValue) maxValue = v;
  }

  // If max value is lower than SPEAKING_THRESHOLD, consider it as silence
  return maxValue <= SPEAKING_THRESHOLD;
}

export interface DetectSpeechOnsetOptions {
  /** Analysis window length in milliseconds. */
  frameMs?: number;
  /** Step between windows in milliseconds (the onset resolution). */
  hopMs?: number;
  /**
   * Energy gate in dBFS; windows quieter than this are silence. Sits above
   * typical TTS noise-floor padding and below voiced onset.
   */
  thresholdDb?: number;
  /** Minimum duration the energy must stay above the gate for an onset to count. */
  minVoicedMs?: number;
}

/** Python's round(): half to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Detect the first sample of sustained audible speech in PCM audio.
 *
 * Measures short-time RMS energy: the signal is downmixed to mono, scanned
 * with a `frameMs` window hopping every `hopMs`, and each window's RMS is
 * computed with its mean removed (a DC offset carries no energy). Onset is the
 * start of the first run of windows whose RMS stays above `thresholdDb` for at
 * least `minVoicedMs`.
 *
 * Working on energy rather than per-sample amplitude rejects noise-floor blips
 * (a lone loud sample averages out over the window), and the minimum-duration
 * requirement rejects brief transients. `hopMs` sets the onset resolution.
 *
 * Operates on a growing buffer as audio streams in: returns null until enough
 * audio has arrived to confirm an onset, at which point the caller stops
 * feeding it.
 *
 * @param pcmBytes Raw PCM audio data (16-bit signed integers).
 * @param sampleRate Sample rate of the audio in Hz.
 * @param numChannels Number of interleaved audio channels (downmixed to mono).
 * @returns The per-channel sample index of speech onset, or null if no
 *   sustained onset is present yet.
 */
export function detectSpeechOnset(
  pcmBytes: Uint8Array,
  sampleRate: number,
  numChannels = 1,
  options: DetectSpeechOnsetOptions = {},
): number | null {
  const frameMs = options.frameMs ?? 10.0;
  const hopMs = options.hopMs ?? 1.0;
  const thresholdDb = options.thresholdDb ?? -40.0;
  const minVoicedMs = options.minVoicedMs ?? 50.0;

  if (sampleRate <= 0) {
    return null;
  }

  // A trailing partial sample can't be read as int16; ignore it.
  const samples = bytesToInt16(pcmBytes.subarray(0, pcmBytes.length & ~1));
  if (samples.length === 0) {
    return null;
  }

  // Downmix to a mono signal normalized to [-1, 1], keeping the sign so that
  // mean-removed RMS measures energy correctly.
  let mono: Float32Array;
  if (numChannels > 1) {
    const usable = samples.length - (samples.length % numChannels);
    mono = new Float32Array(usable / numChannels);
    for (let i = 0; i < mono.length; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) sum += samples[i * numChannels + c] as number;
      mono[i] = sum / numChannels;
    }
  } else {
    mono = Float32Array.from(samples);
  }
  for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] as number) / 32768.0;

  const n = mono.length;
  const frame = Math.max(1, pyRound((sampleRate * frameMs) / 1000));
  const hop = Math.max(1, pyRound((sampleRate * hopMs) / 1000));
  if (n < frame) {
    // Not enough audio for even one window; wait for more.
    return null;
  }

  const gate = 10.0 ** (thresholdDb / 20.0); // normalized RMS gate (-40 dBFS = 0.01)

  // Edge-pad so each window stays centered on its hop position and a constant
  // start isn't read as a step (which would carry energy).
  const pad = Math.floor(frame / 2);
  const padded = new Float32Array(n + 2 * pad);
  padded.fill(mono[0] as number, 0, pad);
  padded.set(mono, pad);
  padded.fill(mono[n - 1] as number, pad + n);
  const numWindows = padded.length - frame + 1;

  const active: boolean[] = [];
  for (let start = 0; start < numWindows; start += hop) {
    let mean = 0;
    for (let i = 0; i < frame; i++) mean += padded[start + i] as number;
    mean /= frame;
    let sq = 0;
    for (let i = 0; i < frame; i++) {
      const d = (padded[start + i] as number) - mean;
      sq += d * d;
    }
    active.push(Math.sqrt(sq / frame) > gate);
  }

  if (!active.some((a) => a)) {
    return null;
  }

  // Onset is the start of the first run of active windows lasting at least
  // minVoicedMs. A window spreads a lone sample across ~frameMs, so
  // minVoicedMs must exceed frameMs to tell a real onset from a blip.
  const minWindows = Math.max(1, pyRound(minVoicedMs / hopMs));
  let run = 0;
  for (let i = 0; i < active.length; i++) {
    if (active[i]) {
      run += 1;
      if (run >= minWindows) {
        return (i - minWindows + 1) * hop;
      }
    } else {
      run = 0;
    }
  }

  return null;
}
