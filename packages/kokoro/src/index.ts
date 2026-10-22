// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Kokoro text-to-speech for pipedog: `KokoroTTSService` (a port of Pipecat's)
 * and the engine behind it, `Kokoro` (a reimplementation of the Python
 * `kokoro-onnx` package on `@pipedog/onnx` and `@pipedog/espeak-ng`).
 *
 * @example
 * ```ts
 * import { KokoroTTSService } from "@pipedog/kokoro";
 * const tts = new KokoroTTSService({
 *   settings: new KokoroTTSService.Settings({ voice: "af_heart" }),
 * });
 * ```
 */

export * from "./kokoro_onnx.ts";
export * from "./npz.ts";
export * from "./trim.ts";
export * from "./tts.ts";
