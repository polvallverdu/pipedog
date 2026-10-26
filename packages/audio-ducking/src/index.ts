// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `AudioDuckingFilter`: lowers the bot's voice while the user talks over it. An output audio
 * filter (`audioOutFilter`), so it works with any transport or serializer, plus an observer that
 * ducks it from the user's voice activity. Pure TypeScript; runs on Bun, Node, Deno and
 * Cloudflare Workers. Not in upstream Pipecat.
 *
 * @example
 * ```ts
 * import { AudioDuckingFilter } from "@pipedog/audio-ducking";
 * const ducking = new AudioDuckingFilter({ duckedGain: 0.35 });
 * // audioOutFilter: ducking in the transport params, observers: [ducking.observer] in the worker
 * ```
 */

export * from "./ducking_filter.ts";
