// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `RNNoise`: a stand-in for pyrnnoise's `RNNoise` class (mono, 48 kHz), on the
 * WebAssembly engine.
 *
 * `denoiseChunk` takes any number of 16-bit samples, buffers them internally
 * and yields `[speechProbability, frame]` for every complete 480-sample frame.
 * Frames are `Float32Array`s normalized to [-1, 1], as pyrnnoise yields them.
 */

import { FRAME_SIZE, type RnnoiseDenoiseState, type RnnoiseEngine, SAMPLE_RATE } from "./engine.ts";

export interface RNNoiseOptions {
  /** RNNoise only runs at 48 kHz. */
  sampleRate?: number;
  /** The WASM engine (`await initRnnoise()`). */
  engine: RnnoiseEngine;
}

/** The part of pyrnnoise's `RNNoise` that the filter uses. */
export interface RNNoiseLike {
  denoiseChunk(samples: Int16Array, partial?: boolean): Iterable<[number, Float32Array]>;
  /** Free resources, if any. */
  destroy?(): void;
}

/** Creates the denoiser for `RNNoiseFilter.start()`; may be async. */
export type RNNoiseFactory = (options: {
  sampleRate: number;
}) => RNNoiseLike | Promise<RNNoiseLike>;

export class RNNoise implements RNNoiseLike {
  #state: RnnoiseDenoiseState;
  #pending = new Float32Array(FRAME_SIZE);
  #pendingLength = 0;
  #in = new Float32Array(FRAME_SIZE);

  constructor(options: RNNoiseOptions) {
    const sampleRate = options.sampleRate ?? SAMPLE_RATE;
    if (sampleRate !== SAMPLE_RATE) {
      throw new Error(`RNNoise requires a sample rate of ${SAMPLE_RATE} Hz, got ${sampleRate}`);
    }
    this.#state = options.engine.createState();
  }

  /**
   * Denoise `samples`, yielding one `[speechProbability, frame]` per complete frame.
   *
   * @param samples 16-bit mono samples at 48 kHz.
   * @param partial When true, a trailing incomplete frame is zero-padded and
   *   processed (flush) instead of being kept for the next call.
   */
  *denoiseChunk(samples: Int16Array, partial = false): Generator<[number, Float32Array]> {
    let offset = 0;
    while (offset < samples.length) {
      const n = Math.min(FRAME_SIZE - this.#pendingLength, samples.length - offset);
      for (let i = 0; i < n; i++)
        this.#pending[this.#pendingLength + i] = samples[offset + i] as number;
      this.#pendingLength += n;
      offset += n;
      if (this.#pendingLength === FRAME_SIZE) yield this.#processPending();
    }
    if (partial && this.#pendingLength > 0) {
      this.#pending.fill(0, this.#pendingLength);
      yield this.#processPending();
    }
  }

  #processPending(): [number, Float32Array] {
    this.#in.set(this.#pending);
    const out = new Float32Array(FRAME_SIZE);
    const vad = this.#state.processFrame(this.#in, out);
    for (let i = 0; i < FRAME_SIZE; i++) out[i] = (out[i] as number) / 32768;
    this.#pendingLength = 0;
    return [vad, out];
  }

  /** Free the WASM state. */
  destroy(): void {
    this.#state.destroy();
  }
}
