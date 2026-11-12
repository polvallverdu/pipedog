// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * TEN VAD voice activity detection for pipedog.
 *
 * `TenVADAnalyzer` is a `VADAnalyzer` backed by
 * [TEN VAD](https://github.com/TEN-framework/ten-vad), an opt-in alternative
 * to Silero. Upstream Pipecat has no TEN VAD: this module is pipedog only.
 *
 * LICENSE: TEN VAD is distributed under Apache-2.0 *with additional
 * conditions* (among them a non-compete clause regarding Agora, and that
 * derivative works of TEN VAD stay under TEN's license). pipedog is
 * BSD-2-Clause, so this package contains none of TEN's code, JavaScript glue,
 * WebAssembly, model or data, and is not derived from them. It only calls
 * TEN's documented C/WebAssembly interface (`ten_vad_create`,
 * `ten_vad_process`, `ten_vad_destroy`), described here by our own
 * TypeScript types. You obtain TEN's prebuilt WebAssembly build yourself
 * (`lib/Web/ten_vad.js` and `lib/Web/ten_vad.wasm` in TEN's repository) and
 * pass it in at runtime; TEN's license conditions apply to your use of those
 * files. Read them before you ship.
 *
 * @example
 * ```ts
 * import { readFile } from "node:fs/promises";
 * import { loadTenVadModule, TenVADAnalyzer } from "@pipedog/audio-ten-vad";
 * // TEN's files, which you downloaded from TEN's repository.
 * import createVADModule from "./ten-vad/ten_vad.js";
 *
 * const module = loadTenVadModule({
 *   factory: createVADModule,
 *   wasmBinary: await readFile("./ten-vad/ten_vad.wasm"),
 * });
 * const vad = new TenVADAnalyzer({ module, sampleRate: 16000 });
 * ```
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { VADAnalyzer, type VADAnalyzerOptions } from "@pipedog/core/audio/vad/vad_analyzer";
import { logger } from "@pipedog/core/utils/logger";

/** The only sample rate TEN VAD accepts. */
export const TEN_VAD_SAMPLE_RATE = 16000;

/** Samples per frame TEN VAD is optimized for: 160 (10 ms) or 256 (16 ms) at 16 kHz. */
export type TenVADHopSize = 160 | 256;

/**
 * The members of TEN VAD's Emscripten module that pipedog uses.
 *
 * This describes TEN's documented WebAssembly interface (the module that
 * `lib/Web/ten_vad.js` creates); it is our own declaration, not TEN's code.
 * Pointers are byte offsets into the module's memory.
 *
 * The `HEAP*` views are replaced when the module's memory grows, so they are
 * read from the module again after every call into it, never kept.
 */
export interface TenVADModule {
  /**
   * Create a VAD instance and write its handle (a pointer) at `handlePtr`.
   *
   * @returns 0 on success, -1 on error.
   */
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  /**
   * Score one frame of `audioDataLength` (= the hop size) int16 samples at
   * `audioDataPtr`. Writes the speech probability (float32) at
   * `outProbabilityPtr` and the speech flag (int32, 0 or 1) at `outFlagPtr`.
   *
   * @returns 0 on success, -1 on error.
   */
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number;
  /**
   * Destroy the instance whose handle is stored at `handlePtr`.
   *
   * @returns 0 on success, -1 on error.
   */
  _ten_vad_destroy(handlePtr: number): number;
  /** Pointer to a NUL-terminated version string. */
  _ten_vad_get_version?(): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
}

/**
 * TEN's module factory: the default export of `lib/Web/ten_vad.js`
 * (`createVADModule`), an Emscripten `MODULARIZE` factory that takes Module
 * overrides.
 */
export type TenVADModuleFactory = (
  moduleOverrides?: Record<string, unknown>,
) => Promise<TenVADModule>;

export interface LoadTenVadModuleOptions {
  /** TEN's module factory, the default export of TEN's `ten_vad.js`. */
  factory: TenVADModuleFactory;
  /**
   * The bytes of TEN's `ten_vad.wasm` (Bun, Node, Deno, browsers). Passed to
   * Emscripten as `wasmBinary`.
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /**
   * TEN's `ten_vad.wasm` compiled ahead of time, for Cloudflare Workers (which
   * cannot compile WebAssembly from bytes: import the `.wasm` file as a
   * module). Instantiated through Emscripten's `instantiateWasm` hook.
   */
  wasmModule?: WebAssembly.Module;
  /**
   * Further Emscripten Module overrides (for example `locateFile`), merged
   * under `wasmBinary` / `instantiateWasm`.
   */
  moduleOverrides?: Record<string, unknown>;
}

/**
 * Create TEN VAD's WebAssembly module with your copy of TEN's files.
 *
 * Pass `wasmBinary` (the `.wasm` bytes) or `wasmModule` (a compiled
 * `WebAssembly.Module`, required on Cloudflare Workers), or neither to let
 * TEN's glue locate and fetch `ten_vad.wasm` itself (browsers, next to
 * `ten_vad.js`).
 *
 * @returns The module, to pass as `TenVADAnalyzer`'s `module` (the promise
 *   itself can be passed, and shared by many analyzers).
 */
export async function loadTenVadModule(options: LoadTenVadModuleOptions): Promise<TenVADModule> {
  const { factory, wasmBinary, wasmModule } = options;
  if (wasmBinary !== undefined && wasmModule !== undefined) {
    throw new Error("loadTenVadModule: pass wasmBinary or wasmModule, not both");
  }
  const overrides: Record<string, unknown> = { ...options.moduleOverrides };
  if (wasmBinary !== undefined) {
    overrides.wasmBinary = wasmBinary;
    return await factory(overrides);
  }
  if (wasmModule === undefined) return await factory(overrides);

  // Emscripten's hook for custom instantiation: it waits for
  // `successCallback`, and has no failure callback, so a failed
  // instantiation rejects the load from here.
  let fail!: (e: unknown) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  overrides.instantiateWasm = (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ) => {
    WebAssembly.instantiate(wasmModule, imports).then(
      (instance) => successCallback(instance, wasmModule),
      fail,
    );
    return {};
  };
  return await Promise.race([factory(overrides), failed]);
}

/** TEN VAD's version string, e.g. `"1.0.0"` (null when the build doesn't export it). */
export function tenVadVersion(module: TenVADModule): string | null {
  if (typeof module._ten_vad_get_version !== "function") return null;
  return module.UTF8ToString(module._ten_vad_get_version());
}

export interface TenVADAnalyzerOptions extends VADAnalyzerOptions {
  /**
   * TEN VAD's WebAssembly module, or a promise of it (see
   * `loadTenVadModule()`). One module can serve many analyzers: each creates
   * its own TEN VAD instance in it.
   */
  module: TenVADModule | Promise<TenVADModule>;
  /** Samples per frame: 256 (16 ms, the default) or 160 (10 ms). */
  hopSize?: TenVADHopSize;
  /**
   * TEN VAD's own speech-flag threshold (default 0.5). The analyzer uses
   * TEN's speech *probability* as the confidence, so whether a frame counts
   * as speech is decided by `VADParams.confidence` (and `minVolume`), as for
   * every VAD analyzer; this only sets the flag TEN computes alongside it.
   */
  threshold?: number;
}

// Layout of the analyzer's one allocation in the module's memory. Offsets are
// aligned for their types; malloc returns 8-byte aligned blocks.
const HANDLE_OFFSET = 0; // int32: TEN's instance handle (a pointer)
const PROBABILITY_OFFSET = 4; // float32: out probability
const FLAG_OFFSET = 8; // int32: out flag
const AUDIO_OFFSET = 16; // int16[hopSize]: the frame

/** The analyzer's TEN VAD instance. */
interface TenVADInstance {
  module: TenVADModule;
  /** Start of the analyzer's block in the module's memory. */
  block: number;
  /** TEN's instance handle. */
  handle: number;
}

/**
 * Voice Activity Detection analyzer using TEN VAD.
 *
 * Runs TEN VAD's WebAssembly build, which you obtain from TEN and pass in as
 * `module` (see `loadTenVadModule()`); pipedog includes none of TEN's files.
 * TEN VAD takes 16 kHz audio only (resample other rates first) and scores
 * frames of `hopSize` samples. The confidence is TEN's speech probability,
 * compared with `VADParams.confidence` like any other VAD analyzer's.
 *
 * The TEN VAD instance is created once `module` resolves; `await vad.ready()`
 * waits for it, otherwise the first `analyzeAudio` does. From then on each
 * frame is scored synchronously. `cleanup()` destroys the instance and frees
 * its memory.
 *
 * @example
 * ```ts
 * const vad = new TenVADAnalyzer({
 *   module: loadTenVadModule({ factory: createVADModule, wasmBinary }),
 *   sampleRate: 16000,
 * });
 * ```
 */
export class TenVADAnalyzer extends VADAnalyzer {
  protected _hopSize: TenVADHopSize;
  protected _threshold: number;
  /** Resolves once the TEN VAD instance exists (rejects if it cannot be created). */
  protected _instanceReady: Promise<void>;

  #instance: TenVADInstance | null = null;
  #cleanedUp = false;

  /**
   * Initialize the TEN VAD analyzer.
   *
   * @param options `module`: TEN VAD's WebAssembly module; `sampleRate`: must
   *   be 16000 if given; `hopSize`: 256 or 160 samples per frame;
   *   `threshold`: TEN's flag threshold; `params`: VAD parameters.
   */
  constructor(options: TenVADAnalyzerOptions) {
    super(options);

    this._hopSize = options.hopSize ?? 256;
    this._threshold = options.threshold ?? 0.5;
    if (!Number.isInteger(this._hopSize) || this._hopSize <= 0) {
      throw new Error(`TEN VAD hop size must be a positive integer (hop size: ${this._hopSize})`);
    }
    if (!(this._threshold >= 0 && this._threshold <= 1)) {
      throw new Error(`TEN VAD threshold must be between 0 and 1 (threshold: ${this._threshold})`);
    }
    if (this._initSampleRate) this.#checkSampleRate(this._initSampleRate);
    if (options.module == null) {
      throw new Error("TenVADAnalyzer needs `module`, TEN VAD's WebAssembly module");
    }

    logger.debug("Loading TEN VAD...");
    this._instanceReady = Promise.resolve(options.module).then((module) => {
      // Cleaned up before the module arrived: nothing to create.
      if (this.#cleanedUp) return;
      this.#instance = this.#createInstance(module);
      const version = tenVadVersion(module);
      logger.debug(`Loaded TEN VAD${version ? ` ${version}` : ""}`);
    });
    this._instanceReady.catch((e) => logger.error("Error loading TEN VAD", e));
  }

  /** Resolves once TEN VAD is loaded and its instance created (rejects if it cannot be). */
  ready(): Promise<void> {
    return this._instanceReady;
  }

  /** Samples per frame. */
  get hopSize(): TenVADHopSize {
    return this._hopSize;
  }

  /** TEN VAD's own flag threshold. */
  get threshold(): number {
    return this._threshold;
  }

  #createInstance(module: TenVADModule): TenVADInstance {
    const block = module._malloc(AUDIO_OFFSET + this._hopSize * 2);
    if (!block) throw new Error("TEN VAD: out of memory");
    try {
      const rc = module._ten_vad_create(block + HANDLE_OFFSET, this._hopSize, this._threshold);
      if (rc !== 0) {
        throw new Error(
          `ten_vad_create failed (returned ${rc}, hop size ${this._hopSize}, threshold ${this._threshold})`,
        );
      }
    } catch (e) {
      rethrowIfCancelled(e);
      module._free(block);
      throw e;
    }
    // Read the heap only now: creating the instance may have grown memory.
    const handle = module.HEAP32[(block + HANDLE_OFFSET) >> 2] as number;
    return { module, block, handle };
  }

  #checkSampleRate(sampleRate: number): void {
    if (sampleRate !== TEN_VAD_SAMPLE_RATE) {
      throw new Error(
        `TEN VAD sample rate needs to be 16000 (sample rate: ${sampleRate}); resample the audio to 16 kHz`,
      );
    }
  }

  //
  // VADAnalyzer
  //

  /**
   * Set the sample rate for audio processing.
   *
   * @param sampleRate Audio sample rate (must be 16000 Hz).
   * @throws Error If the sample rate is not 16000 Hz.
   */
  override setSampleRate(sampleRate: number): void {
    this.#checkSampleRate(this._initSampleRate || sampleRate);
    super.setSampleRate(sampleRate);
  }

  /**
   * Get the number of audio frames required for VAD analysis.
   *
   * @returns The hop size (256 or 160).
   */
  numFramesRequired(): number {
    return this._hopSize;
  }

  /**
   * Calculate voice activity confidence for the given audio buffer.
   *
   * Synchronous once TEN VAD is loaded; before that, waits for it.
   *
   * @param buffer `hopSize` 16-bit samples of 16 kHz mono audio.
   * @returns TEN's speech probability, between 0.0 and 1.0.
   * @throws Error If TEN VAD cannot be loaded or fails on the frame.
   */
  voiceConfidence(buffer: Uint8Array): number | Promise<number> {
    if (this.#instance) return this.#process(this.#instance, buffer);
    if (this.#cleanedUp) throw new Error("TenVADAnalyzer was cleaned up");
    return this._instanceReady.then(() => {
      if (!this.#instance) throw new Error("TenVADAnalyzer was cleaned up");
      return this.#process(this.#instance, buffer);
    });
  }

  #process(instance: TenVADInstance, buffer: Uint8Array): number {
    const hop = this._hopSize;
    if (buffer.length !== hop * 2) {
      throw new Error(
        `TEN VAD needs frames of ${hop} samples (${hop * 2} bytes), got ${buffer.length} bytes`,
      );
    }
    const bytes = buffer.byteOffset % 2 === 0 ? buffer : buffer.slice();
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, hop);
    const { module, block, handle } = instance;
    module.HEAP16.set(samples, (block + AUDIO_OFFSET) >> 1);
    const rc = module._ten_vad_process(
      handle,
      block + AUDIO_OFFSET,
      hop,
      block + PROBABILITY_OFFSET,
      block + FLAG_OFFSET,
    );
    if (rc !== 0) throw new Error(`ten_vad_process failed (returned ${rc})`);
    // A fresh view: processing may have grown the module's memory.
    return module.HEAPF32[(block + PROBABILITY_OFFSET) >> 2] as number;
  }

  /** Release the analyzer's resources: destroys the TEN VAD instance and frees its memory. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.#cleanedUp) return;
    this.#cleanedUp = true;
    try {
      await this._instanceReady;
    } catch (e) {
      rethrowIfCancelled(e);
      // Never loaded: nothing to release.
      return;
    }
    const instance = this.#instance;
    this.#instance = null;
    if (!instance) return;
    const { module, block } = instance;
    const rc = module._ten_vad_destroy(block + HANDLE_OFFSET);
    if (rc !== 0) logger.warning(`ten_vad_destroy failed (returned ${rc})`);
    module._free(block);
  }
}
