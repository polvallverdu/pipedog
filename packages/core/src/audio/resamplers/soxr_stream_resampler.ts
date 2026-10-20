// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/resamplers/soxr_stream_resampler.py

/**
 * SoX-based audio resampler stream implementation.
 *
 * Provides an audio resampler that uses the SoX ResampleStream library for
 * very high quality audio sample rate conversion.
 *
 * When to use the SOXRStreamAudioResampler:
 * 1. For real-time processing scenarios
 * 2. When dealing with very long audio signals
 * 3. When processing audio in chunks or streams
 * 4. When you need to reuse the same resampler configuration multiple times,
 *    as it saves initialization overhead
 *
 * PORTING NOTE: libsoxr has no edge-compatible JavaScript equivalent yet. The
 * stream management (rate checks, idle clearing, flush/reset) is ported, but
 * `SoxrResampleStream` is a stub whose constructor throws "not ported yet".
 */

import { time } from "@pipecat-ts/asyncio";
import { BaseAudioResampler, type SoxrQuality } from "./base_audio_resampler.ts";
import { bytesToInt16 } from "./soxr_resampler.ts";

const EMPTY_AUDIO = new Int16Array(0);

/**
 * Stand-in for `soxr.ResampleStream` (mono, int16).
 *
 * STUB: libsoxr is not available in JavaScript yet; constructing one throws.
 *
 * @internal
 */
export class SoxrResampleStream {
  constructor(_options: {
    inRate: number;
    outRate: number;
    numChannels: number;
    quality: SoxrQuality;
  }) {
    throw new Error("soxr stream resampling is not ported yet");
  }

  resampleChunk(_chunk: Int16Array, _last = false): Int16Array {
    throw new Error("soxr stream resampling is not ported yet");
  }

  clear(): void {
    throw new Error("soxr stream resampling is not ported yet");
  }
}

export interface SOXRStreamAudioResamplerOptions {
  /**
   * SOXR quality preset. Higher quality means higher CPU cost. One of "VHQ"
   * (default, very high quality), "HQ", "MQ", "LQ", or "QQ" (quick, lowest
   * latency).
   */
  quality?: SoxrQuality;
  /**
   * Seconds of inactivity after which the internal resampler state is
   * cleared to avoid audio artefacts from stale history. Set to `null` to
   * never clear (recommended for telephony providers that have irregular gaps
   * between chunks). Defaults to 0.2.
   */
  clearAfterSecs?: number | null;
}

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Audio resampler implementation using the SoX ResampleStream library.
 *
 * Configured for very high quality (VHQ) resampling by default, providing
 * excellent audio quality at the cost of additional computational overhead.
 * It keeps an internal history which avoids clicks at chunk boundaries.
 *
 * Notes:
 * - Only supports mono audio (1 channel).
 * - Input must be 16-bit signed PCM audio as raw bytes.
 */
export class SOXRStreamAudioResampler extends BaseAudioResampler {
  protected _quality: SoxrQuality;
  protected _clearAfterSecs: number | null;
  protected _inRate: number | null = null;
  protected _outRate: number | null = null;
  protected _lastResampleTime = 0;
  protected _soxrStream: SoxrResampleStream | null = null;

  constructor(options: SOXRStreamAudioResamplerOptions = {}) {
    super();
    this._quality = options.quality ?? "VHQ";
    this._clearAfterSecs = options.clearAfterSecs === undefined ? 0.2 : options.clearAfterSecs;
  }

  protected _initialize(inRate: number, outRate: number): void {
    this._inRate = inRate;
    this._outRate = outRate;
    this._lastResampleTime = time();
    this._soxrStream = new SoxrResampleStream({
      inRate,
      outRate,
      numChannels: 1,
      quality: this._quality,
    });
  }

  protected _maybeClearInternalState(): void {
    const currentTime = time();
    if (this._clearAfterSecs !== null) {
      if (currentTime - this._lastResampleTime > this._clearAfterSecs) {
        if (this._soxrStream) {
          this._soxrStream.clear();
        }
      }
    }
    this._lastResampleTime = currentTime;
  }

  protected _maybeInitializeSoxStream(inRate: number, outRate: number): SoxrResampleStream {
    if (this._soxrStream === null) {
      this._initialize(inRate, outRate);
    } else {
      this._maybeClearInternalState();
    }

    if (this._inRate !== inRate || this._outRate !== outRate) {
      throw new Error(
        `SOXRStreamAudioResampler cannot be reused with different sample rates: ` +
          `expected ${this._inRate}->${this._outRate}, got ${inRate}->${outRate}`,
      );
    }

    return this._soxrStream as SoxrResampleStream;
  }

  /**
   * Resample audio data using soxr.ResampleStream resampler library.
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

    const stream = this._maybeInitializeSoxStream(inRate, outRate);
    const audioData = bytesToInt16(audio);
    const resampledAudio = stream.resampleChunk(audioData);
    return int16ToBytes(resampledAudio);
  }

  /**
   * Emit the audio held in the filter and reset it for the next stream.
   *
   * @returns The remaining resampled audio as raw bytes, empty if no audio
   *   has been resampled yet.
   */
  override async flush(): Promise<Uint8Array> {
    if (!this._soxrStream) {
      return new Uint8Array(0);
    }

    const tail = this._soxrStream.resampleChunk(EMPTY_AUDIO, true);
    this._soxrStream.clear();
    this._lastResampleTime = time();
    return int16ToBytes(tail);
  }

  /** Discard the audio held in the filter and reset it for the next stream. */
  override async reset(): Promise<void> {
    if (this._soxrStream) {
      this._soxrStream.clear();
      this._lastResampleTime = time();
    }
  }
}
