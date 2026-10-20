// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/volume.py

/** Audio volume tracking over a rolling window of recent audio. */

import { calculateAudioVolume } from "./utils.ts";

// Loudness is measured over a BS.1770 gating block, which is 400ms. The audio
// chunks flowing through a pipeline are shorter than that, so they accumulate
// into a rolling window of this size.
export const VOLUME_WINDOW_SECS = 0.4;

/**
 * Tracks the volume of an audio stream over a rolling window.
 *
 * Audio is fed in chunks of any size with `update()`, which retains the most
 * recent `VOLUME_WINDOW_SECS` of it, and `volume` measures that window. Volume
 * reads 0 until the window holds enough audio for loudness to be measurable,
 * and the window is discarded if the sample rate changes.
 *
 * Measuring costs a few hundred microseconds and grows with the sample rate,
 * so it happens on read and the result is cached until more audio arrives.
 * Callers that report volume less often than they receive audio pay only for
 * the reads.
 *
 * Audio is expected to be mono; interleaved channels would be measured as if
 * they were consecutive samples.
 */
export class AudioVolumeTracker {
  protected _sampleRate = 0;
  protected _windowNumBytes = 0;
  protected _buffer: Uint8Array = new Uint8Array(0);
  // null once the window holds audio that hasn't been measured yet.
  protected _volume: number | null = 0.0;

  /**
   * The volume of the audio in the rolling window, between 0 (quiet) and 1
   * (loud). Reads 0 until the window holds a measurable amount of audio.
   */
  get volume(): number {
    if (this._volume === null) {
      this._volume = calculateAudioVolume(this._buffer, this._sampleRate);
    }
    return this._volume;
  }

  /**
   * Add audio to the rolling window.
   *
   * @param audio Audio data as raw bytes (16-bit signed integers, mono).
   * @param sampleRate Sample rate of the audio in Hz.
   */
  update(audio: Uint8Array, sampleRate: number): void {
    if (sampleRate !== this._sampleRate) {
      this._sampleRate = sampleRate;
      // Rounded up so the window is never a sample short of a gating block,
      // which loudness rejects.
      this._windowNumBytes = Math.ceil(VOLUME_WINDOW_SECS * sampleRate) * 2;
      this.reset();
    }

    const combined = new Uint8Array(this._buffer.length + audio.length);
    combined.set(this._buffer, 0);
    combined.set(audio, this._buffer.length);
    this._buffer =
      combined.length > this._windowNumBytes
        ? combined.slice(combined.length - this._windowNumBytes)
        : combined;
    if (this._buffer.length === this._windowNumBytes) {
      this._volume = null;
    }
  }

  /** Clear the rolling window and the tracked volume. */
  reset(): void {
    this._buffer = new Uint8Array(0);
    this._volume = 0.0;
  }
}
