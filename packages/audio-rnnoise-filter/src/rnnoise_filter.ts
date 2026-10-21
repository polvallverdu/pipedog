// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/filters/rnnoise_filter.py

/**
 * RNNoise noise suppression audio filter for Pipecat.
 *
 * This module provides an audio filter implementation using RNNoise, a recurrent
 * neural network for audio noise reduction.
 *
 * PORTING NOTES:
 * - DIVERGENCE: upstream uses the pyrnnoise library (native). Here RNNoise runs
 *   as WebAssembly (xiph/rnnoise 0.2 as built by `@jitsi/rnnoise-wasm`, shipped in
 *   `wasm/rnnoise.wasm`), so the filter works on Bun, Node, Deno and Cloudflare
 *   Workers. The `RNNoise` class (`./rnnoise.ts`) mirrors pyrnnoise's
 *   `denoise_chunk` (internal buffering, 480-sample frames).
 * - Upstream's tests patch the module-level `RNNoise` (and, in one test, the
 *   resampler class). The options `rnnoise` (a factory) and the protected
 *   `_createResampler` take their place.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { initRnnoise } from "@pipedog/audio-rnnoise-filter/wasm";
import { BaseAudioFilter } from "@pipedog/core/audio/filters/base_audio_filter";
import type { SoxrQuality } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { SOXRStreamAudioResampler } from "@pipedog/core/audio/resamplers/soxr_stream_resampler";
import { type FilterControlFrame, FilterEnableFrame } from "@pipedog/core/frames/frames";
import { logger } from "@pipedog/core/utils/logger";
import { RNNoise, type RNNoiseFactory, type RNNoiseLike } from "./rnnoise.ts";

export interface RNNoiseFilterOptions {
  /**
   * Quality of the resampler if resampling is needed. One of "VHQ", "HQ",
   * "MQ", "LQ", "QQ". Defaults to "QQ" (Quick) for lowest latency.
   */
  resamplerQuality?: SoxrQuality;
  /**
   * Creates the RNNoise denoiser (default: the bundled WebAssembly build, loaded
   * with `initRnnoise()`). Replace it to supply your own, or a fake in tests.
   */
  rnnoise?: RNNoiseFactory | null;
}

/** The minimal resampler interface the filter needs. */
interface FilterResampler {
  resample(audio: Uint8Array, inRate: number, outRate: number): Promise<Uint8Array>;
}

const defaultFactory: RNNoiseFactory = async ({ sampleRate }) =>
  new RNNoise({ sampleRate, engine: await initRnnoise() });

/**
 * Audio filter using RNNoise for noise suppression.
 *
 * Provides real-time noise suppression for audio streams using RNNoise, a
 * recurrent neural network for audio noise reduction. The filter buffers audio
 * data to match RNNoise's required frame length (480 samples at 48kHz) and
 * processes it in chunks.
 */
export class RNNoiseFilter extends BaseAudioFilter {
  protected _filtering = true;
  protected _sampleRate = 0;
  protected _rnnoise: RNNoiseLike | null = null;
  protected _rnnoiseReady = false;
  protected _resamplerIn: FilterResampler | null = null;
  protected _resamplerOut: FilterResampler | null = null;
  protected _resamplerQuality: SoxrQuality;
  #factory: RNNoiseFactory;

  /** @param options `resamplerQuality` (default "QQ") and an optional `rnnoise` factory. */
  constructor(options: RNNoiseFilterOptions = {}) {
    super();
    this._resamplerQuality = options.resamplerQuality ?? "QQ";
    this.#factory = options.rnnoise ?? defaultFactory;
  }

  /** Create one of the two stream resamplers (a hook, as upstream's test patches the class). */
  protected _createResampler(quality: SoxrQuality): FilterResampler {
    return new SOXRStreamAudioResampler({ quality });
  }

  /**
   * Initialize the filter with the transport's sample rate.
   *
   * @param sampleRate The sample rate of the input transport in Hz.
   */
  async start(sampleRate: number): Promise<void> {
    this._sampleRate = sampleRate;

    try {
      // RNNoise always requires 48kHz.
      this._rnnoise = await this.#factory({ sampleRate: 48000 });
      this._rnnoiseReady = true;
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`Failed to initialize RNNoise: ${e instanceof Error ? e.message : String(e)}`);
      this._rnnoiseReady = false;
      return;
    }

    if (this._sampleRate !== 48000) {
      logger.info(`RNNoise filter enabling resampling: ${this._sampleRate} <-> 48000`);
      try {
        this._resamplerIn = this._createResampler(this._resamplerQuality);
        this._resamplerOut = this._createResampler(this._resamplerQuality);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(
          `Could not create the resampler: ${e instanceof Error ? e.message : String(e)}`,
        );
        this._rnnoiseReady = false;
      }
    }
  }

  /** Clean up the RNNoise engine when stopping. */
  async stop(): Promise<void> {
    this._rnnoise?.destroy?.();
    this._rnnoise = null;
    this._rnnoiseReady = false;
    this._resamplerIn = null;
    this._resamplerOut = null;
  }

  /**
   * Process control frames to enable/disable filtering.
   *
   * @param frame The control frame containing filter commands.
   */
  async processFrame(frame: FilterControlFrame): Promise<void> {
    if (frame instanceof FilterEnableFrame) {
      this._filtering = frame.enable;
    }
  }

  /**
   * Apply RNNoise noise suppression to audio data.
   *
   * Buffers incoming audio and processes it in chunks that match RNNoise's
   * required frame length (480 samples at 48kHz). Returns filtered audio data.
   *
   * @param audio Raw audio data as bytes to be filtered.
   * @returns Noise-suppressed audio data as bytes.
   */
  async filter(audio: Uint8Array): Promise<Uint8Array> {
    if (!this._rnnoiseReady || !this._filtering || this._rnnoise === null) {
      return audio;
    }

    // Resample input if needed
    let inAudio = audio;
    if (this._sampleRate !== 48000 && this._resamplerIn) {
      inAudio = await this._resamplerIn.resample(audio, this._sampleRate, 48000);
    }

    // If audio is empty, return empty bytes (no point in noise cancellation)
    if (inAudio.length === 0) {
      return new Uint8Array(0);
    }

    // Convert bytes to an int16 array (copied: the bytes may not be 2-aligned)
    const audioSamples = new Int16Array(inAudio.length >> 1);
    new Uint8Array(audioSamples.buffer).set(inAudio.subarray(0, audioSamples.length * 2));

    // Process chunk through RNNoise
    // denoiseChunk handles buffering internally and yields [speechProb, denoisedFrame]
    // denoisedFrame is float32 normalized to [-1.0, 1.0]
    const filteredFrames: Int16Array[] = [];
    for (const [, denoisedFrame] of this._rnnoise.denoiseChunk(audioSamples)) {
      const denoisedInt16 = new Int16Array(denoisedFrame.length);
      for (let i = 0; i < denoisedFrame.length; i++) {
        // (frame * 32767).astype(np.int16): truncates toward zero; clamped here
        // (numpy wraps on overflow).
        const v = Math.trunc((denoisedFrame[i] as number) * 32767);
        denoisedInt16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      filteredFrames.push(denoisedInt16);
    }

    // Combine all processed frames
    if (filteredFrames.length > 0) {
      const total = filteredFrames.reduce((n, f) => n + f.length, 0);
      const combined = new Int16Array(total);
      let offset = 0;
      for (const f of filteredFrames) {
        combined.set(f, offset);
        offset += f.length;
      }
      const filteredAudio = new Uint8Array(combined.buffer);

      // Resample output if needed
      if (this._sampleRate !== 48000 && this._resamplerOut) {
        return await this._resamplerOut.resample(filteredAudio, 48000, this._sampleRate);
      }

      return filteredAudio;
    }

    // No frames processed yet (buffering)
    return new Uint8Array(0);
  }
}
