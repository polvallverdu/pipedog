// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/resamplers/soxr_resampler.py

/**
 * SoX-based audio resampler implementation.
 *
 * Provides an audio resampler that uses the SoX resampler library for very
 * high-quality audio sample rate conversion.
 *
 * When to use the SOXRAudioResampler:
 * 1. For batch processing of complete audio files
 * 2. When you have all the audio data available at once
 *
 * PORTING NOTE: libsoxr is not used. `soxr.resample()` is replaced by the
 * resampler engine from `engine.ts`: `@pipedog/resampler-wasm` (rubato
 * windowed sinc in WebAssembly) by default, a pure-TypeScript windowed-sinc
 * fallback if that cannot load, or whatever `setResamplerEngine()` installed.
 * Output lengths follow soxr's; the samples differ slightly because the
 * filters differ.
 */

import { BaseAudioResampler, type SoxrQuality } from "./base_audio_resampler.ts";
import { getLoadedResamplerEngine, getResamplerEngine } from "./engine.ts";

/**
 * Stand-in for `soxr.resample()`: resample a whole mono signal.
 *
 * Synchronous, like soxr's: it uses the engine already loaded (or injected)
 * and throws if there is none yet. `await getResamplerEngine()` first when
 * calling it outside `SOXRAudioResampler.resample()`.
 *
 * @internal
 */
export function soxrResample<T extends Int16Array | Float32Array>(
  audio: T,
  inRate: number,
  outRate: number,
  quality: SoxrQuality,
): T {
  const engine = getLoadedResamplerEngine();
  if (!engine) {
    throw new Error(
      "no resampler engine loaded yet: `await getResamplerEngine()` (audio/resamplers/engine) first",
    );
  }
  return engine.resample(audio, inRate, outRate, quality);
}

export interface SOXRAudioResamplerOptions {
  /**
   * SOXR quality preset. Higher quality means higher CPU cost. One of "VHQ"
   * (default, very high quality), "HQ", "MQ", "LQ", or "QQ" (quick, lowest
   * latency).
   */
  quality?: SoxrQuality;
}

/**
 * Audio resampler implementation using the SoX resampler library.
 *
 * Configured for very high quality (VHQ) resampling by default, providing
 * excellent audio quality at the cost of additional computational overhead.
 */
export class SOXRAudioResampler extends BaseAudioResampler {
  protected _quality: SoxrQuality;

  constructor(options: SOXRAudioResamplerOptions = {}) {
    super();
    this._quality = options.quality ?? "VHQ";
  }

  /**
   * Resample audio data using SoX resampler library.
   *
   * @param audio Input audio data as raw bytes (16-bit signed integers).
   * @param inRate Original sample rate in Hz.
   * @param outRate Target sample rate in Hz.
   * @returns Resampled audio data as raw bytes (16-bit signed integers).
   */
  async resample(audio: Uint8Array, inRate: number, outRate: number): Promise<Uint8Array> {
    if (inRate === outRate) {
      return audio;
    }
    await getResamplerEngine();
    const audioData = bytesToInt16(audio);
    const resampledAudio = soxrResample(audioData, inRate, outRate, this._quality);
    return new Uint8Array(
      resampledAudio.buffer,
      resampledAudio.byteOffset,
      resampledAudio.byteLength,
    );
  }
}

/** View (or copy, if unaligned) 16-bit PCM bytes as samples. @internal */
export function bytesToInt16(audio: Uint8Array): Int16Array {
  const length = audio.length >> 1;
  if (audio.byteOffset % 2 !== 0) {
    return new Int16Array(audio.slice(0, length * 2).buffer);
  }
  return new Int16Array(audio.buffer, audio.byteOffset, length);
}
