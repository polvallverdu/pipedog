// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A thin wrapper over the RNNoise WebAssembly module (xiph/rnnoise 0.2, built
 * by @jitsi/rnnoise-wasm with Emscripten, no glue code needed).
 *
 * The module imports two functions (heap growth and a memory copy) and exports
 * its memory, `malloc`/`free` and the RNNoise C API under minified names.
 * `engineFromModule` instantiates a compiled `WebAssembly.Module` (so the same
 * code serves every runtime, including workerd, where the module is imported)
 * and shares one instance between all denoise states.
 */

/** RNNoise's fixed frame length: 10 ms at 48 kHz. */
export const FRAME_SIZE = 480;
/** RNNoise always runs at 48 kHz. */
export const SAMPLE_RATE = 48000;

interface Exports {
  c: WebAssembly.Memory; // memory
  d: () => void; // __wasm_call_ctors
  e: (size: number) => number; // malloc
  f: (ptr: number) => void; // free
  h: (model: number) => number; // rnnoise_create
  i: (state: number) => void; // rnnoise_destroy
  j: (state: number, out: number, input: number) => number; // rnnoise_process_frame
}

/** One RNNoise denoiser (one audio stream). Call `destroy()` to free its WASM memory. */
export class RnnoiseDenoiseState {
  #engine: RnnoiseEngine;
  #state: number;
  #input: number;
  #output: number;

  /** @internal Use `RnnoiseEngine.createState()`. */
  constructor(engine: RnnoiseEngine, x: Exports) {
    this.#engine = engine;
    this.#state = x.h(0); // the built-in model
    this.#input = x.e(FRAME_SIZE * 4);
    this.#output = x.e(FRAME_SIZE * 4);
    if (!this.#state || !this.#input || !this.#output) throw new Error("RNNoise: out of memory");
  }

  /**
   * Denoise one frame of `FRAME_SIZE` samples. Samples are floats in the 16-bit
   * PCM range (-32768..32767), not normalized.
   *
   * @returns The voice-activity probability of the frame (0..1).
   */
  processFrame(input: Float32Array, output: Float32Array): number {
    if (input.length !== FRAME_SIZE || output.length !== FRAME_SIZE) {
      throw new Error(`RNNoise frames are ${FRAME_SIZE} samples`);
    }
    if (this.#state === 0) throw new Error("RNNoise state was destroyed");
    const x = this.#engine.exports;
    // Memory may have grown (detaching old views), so build views per call.
    new Float32Array(x.c.buffer, this.#input, FRAME_SIZE).set(input);
    const vad = x.j(this.#state, this.#output, this.#input);
    output.set(new Float32Array(x.c.buffer, this.#output, FRAME_SIZE));
    return vad;
  }

  /** Free the state's WASM memory. Further use throws. */
  destroy(): void {
    if (this.#state === 0) return;
    const x = this.#engine.exports;
    x.i(this.#state);
    x.f(this.#input);
    x.f(this.#output);
    this.#state = 0;
  }
}

/** An instantiated RNNoise module. */
export class RnnoiseEngine {
  /** @internal */
  readonly exports: Exports;

  constructor(module: WebAssembly.Module) {
    let memory: WebAssembly.Memory;
    const imports = {
      a: {
        // emscripten_resize_heap(requestedSize): grow the memory to at least that size.
        a: (requestedSize: number): number => {
          try {
            const pages = Math.ceil((requestedSize - memory.buffer.byteLength) / 65536);
            if (pages > 0) memory.grow(pages);
            return 1;
          } catch {
            return 0;
          }
        },
        // emscripten_memcpy_big(dest, src, num)
        b: (dest: number, src: number, num: number): void => {
          new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
        },
      },
    };
    const instance = new WebAssembly.Instance(module, imports);
    this.exports = instance.exports as unknown as Exports;
    memory = this.exports.c;
    this.exports.d();
  }

  /** Create a denoiser for one audio stream. */
  createState(): RnnoiseDenoiseState {
    return new RnnoiseDenoiseState(this, this.exports);
  }
}

/** Instantiate the RNNoise module (a compiled `WebAssembly.Module`). */
export function engineFromModule(module: WebAssembly.Module): RnnoiseEngine {
  return new RnnoiseEngine(module);
}
