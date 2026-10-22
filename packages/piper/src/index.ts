// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Piper text-to-speech for pipedog: ports of Pipecat's `PiperTTSService`
 * (local Piper voices) and `PiperHttpTTSService` (a Piper HTTP server).
 *
 * The local engine (`PiperVoice`, `downloadVoice`, ...) lives in
 * `@pipedog/piper/piper_voice` and is imported lazily by `PiperTTSService`,
 * so `PiperHttpTTSService` runs on Cloudflare Workers without it.
 *
 * @example
 * ```ts
 * import { PiperTTSService } from "@pipedog/piper";
 * const tts = new PiperTTSService({
 *   settings: new PiperTTSService.Settings({ voice: "en_US-ryan-high" }),
 * });
 * ```
 */

export type {
  AudioChunk,
  PiperConfig,
  PiperVoice,
  PiperVoiceLoadOptions,
  SynthesisConfig,
} from "./piper_voice.ts";
export * from "./tts.ts";
