// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/resamplers/base_audio_resampler.py

/**
 * Base audio resampler interface for Pipecat.
 *
 * Defines the abstract base class for audio resampling implementations,
 * providing a common interface for converting audio between different sample
 * rates.
 */

/** SOXR resampling quality presets, from fastest (QQ) to highest quality (VHQ). */
export type SoxrQuality = "QQ" | "LQ" | "MQ" | "HQ" | "VHQ";

/**
 * Abstract base class for audio resampling implementations.
 *
 * Defines the interface that all audio resampling implementations must
 * follow, providing a standardized way to convert audio data between
 * different sample rates.
 */
export abstract class BaseAudioResampler {
  /**
   * Resamples the given audio data to a different sample rate.
   *
   * @param audio The audio data to be resampled, as raw bytes.
   * @param inRate The original sample rate of the audio data in Hz.
   * @param outRate The desired sample rate for the output audio in Hz.
   * @returns The resampled audio data as raw bytes.
   */
  abstract resample(audio: Uint8Array, inRate: number, outRate: number): Promise<Uint8Array>;

  /**
   * Emit any audio still held internally and reset the resampler.
   *
   * Streaming resamplers keep recently seen input in their filter, so the
   * tail of a stream is only emitted once more audio arrives. Call this at
   * the end of a continuous stream to collect that tail and start clean.
   *
   * @returns The remaining resampled audio as raw bytes, empty if the
   *   resampler holds nothing.
   */
  async flush(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }

  /**
   * Discard any audio still held internally and reset the resampler.
   *
   * Use this when a stream is abandoned rather than finished (e.g. after an
   * interruption), so its leftover tail doesn't leak into the next stream.
   */
  async reset(): Promise<void> {}
}
