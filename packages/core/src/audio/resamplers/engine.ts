// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The resampling engine behind `SOXRAudioResampler` and
 * `SOXRStreamAudioResampler`.
 *
 * Upstream calls python-soxr (`soxr.resample()` and `soxr.ResampleStream`).
 * Here those calls go through a small engine interface, so the actual
 * implementation can be swapped:
 *
 * - By default the engine is `@pipedog/resampler-wasm` (rubato windowed sinc
 *   compiled to WebAssembly), loaded lazily on first use. On Cloudflare
 *   Workers the package's "workerd" export condition imports the `.wasm` as a
 *   module (workerd forbids compiling WASM from bytes); elsewhere it is
 *   fetched/read next to the package and instantiated asynchronously.
 * - If the WASM engine cannot be loaded, core logs one warning and falls back
 *   to a pure-TypeScript windowed-sinc engine (`sinc_engine.ts`).
 * - Applications can inject their own engine (for example a native libsoxr
 *   binding) with `setResamplerEngine()`.
 *
 * @example
 * ```ts
 * import { setResamplerEngine } from "@pipedog/core/audio/resamplers/engine";
 * setResamplerEngine(myNativeSoxrEngine);
 * ```
 */

import { logger } from "../../utils/logger.ts";
import type { SoxrQuality } from "./base_audio_resampler.ts";
import { createSincResamplerEngine } from "./sinc_engine.ts";

/** Options of a streaming resampler (as `soxr.ResampleStream(...)`). */
export interface ResamplerStreamOptions {
  inRate: number;
  outRate: number;
  numChannels: number;
  quality: SoxrQuality;
}

/** A stateful streaming resampler; stands in for `soxr.ResampleStream`. */
export interface ResamplerStream {
  /**
   * Resample a chunk of interleaved samples, keeping the filter history for
   * the next chunk. With `last` the audio held in the filter is appended and
   * the stream starts over.
   */
  resampleChunk<T extends Int16Array | Float32Array>(chunk: T, last?: boolean): T;
  /** Discard the filter history (`soxr.ResampleStream.clear()`). */
  clear(): void;
  /** Free any native/WASM state. Optional. */
  destroy?(): void;
}

/**
 * A resampling engine. Structurally identical to what
 * `createSoxrCompatibleEngine()` from `@pipedog/resampler-wasm` returns.
 */
export interface ResamplerEngine {
  /** Stands in for `soxr.resample(audio, in_rate, out_rate, quality=...)` (mono). */
  resample<T extends Int16Array | Float32Array>(
    audio: T,
    inRate: number,
    outRate: number,
    quality: SoxrQuality,
  ): T;
  /** Stands in for `soxr.ResampleStream(in_rate=, out_rate=, num_channels=, quality=)`. */
  createStream(options: ResamplerStreamOptions): ResamplerStream;
}

type EngineLoader = () => Promise<ResamplerEngine>;

/** Load `@pipedog/resampler-wasm` and wrap it in the soxr-shaped interface. */
async function loadWasmEngine(): Promise<ResamplerEngine> {
  const wasm = await import("@pipedog/resampler-wasm");
  return wasm.createSoxrCompatibleEngine(await wasm.initResampler());
}

let injected: ResamplerEngine | null = null;
let loaded: ResamplerEngine | null = null;
let loading: Promise<ResamplerEngine> | null = null;
let defaultLoader: EngineLoader = loadWasmEngine;

/**
 * Install the engine every SOXR resampler uses from now on (streams already
 * created keep theirs). Pass `null` to go back to the default
 * (`@pipedog/resampler-wasm`, with the pure-TypeScript fallback).
 */
export function setResamplerEngine(engine: ResamplerEngine | null): void {
  injected = engine;
}

/**
 * The engine in use, loading the default one on first call.
 *
 * Resolves to the injected engine if there is one, else the WASM engine, else
 * (after one warning) the pure-TypeScript fallback. Never rejects.
 */
export async function getResamplerEngine(): Promise<ResamplerEngine> {
  if (injected) return injected;
  if (loaded) return loaded;
  loading ??= defaultLoader().then(
    (engine) => {
      loaded = engine;
      return engine;
    },
    (e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      logger.warning(
        `Could not load the WASM resampler (@pipedog/resampler-wasm): ${reason}. ` +
          "Falling back to the pure-TypeScript windowed-sinc resampler (lower quality, slower).",
      );
      loaded = createSincResamplerEngine();
      return loaded;
    },
  );
  return injected ?? (await loading);
}

/**
 * The engine in use, without loading anything: the injected engine, else the
 * default one if it has finished loading, else `null`. Lets synchronous code
 * (e.g. `soxrResample`) use the engine once `getResamplerEngine()` resolved.
 */
export function getLoadedResamplerEngine(): ResamplerEngine | null {
  return injected ?? loaded;
}

/**
 * Replace how the default engine is loaded and forget the loaded one. For
 * tests (e.g. simulating a WASM load failure).
 *
 * @internal
 */
export function _resetResamplerEngineForTests(loader: EngineLoader = loadWasmEngine): void {
  injected = null;
  loaded = null;
  loading = null;
  defaultLoader = loader;
}
