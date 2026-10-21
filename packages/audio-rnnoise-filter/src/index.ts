// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * RNNoise noise suppression for pipedog: `RNNoiseFilter`, a port of upstream's
 * filter, running RNNoise as WebAssembly on Bun, Node, Deno and Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { RNNoiseFilter } from "@pipedog/audio-rnnoise-filter";
 * const audioInFilter = new RNNoiseFilter();
 * ```
 */

export { getRnnoise, initRnnoise, type RnnoiseSource } from "@pipedog/audio-rnnoise-filter/wasm";
export * from "./engine.ts";
export * from "./rnnoise.ts";
export * from "./rnnoise_filter.ts";
