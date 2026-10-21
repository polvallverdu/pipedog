// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `SoundfileMixer`, a port of Pipecat's soundfile mixer: mixes background sound (WAV, from
 * bytes, a URL or a path) into the transport's output audio. Pure TypeScript; runs on Bun, Node,
 * Deno and Cloudflare Workers (reading a path needs a filesystem).
 *
 * @example
 * ```ts
 * import { SoundfileMixer } from "@pipedog/audio-soundfile-mixer";
 * const mixer = new SoundfileMixer({ soundFiles: { office: "./office.wav" }, defaultSound: "office" });
 * ```
 */

export * from "./soundfile_mixer.ts";
export * from "./wav.ts";
