// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Local audio transport for pipedog: the machine's microphone and speakers, through the `sox`
 * or `ffmpeg` command-line tools. Subpaths mirror upstream (`/audio`).
 *
 * Runtimes: Node, Bun and Deno (they can spawn processes).
 */

export * from "./audio.ts";
export * from "./audio_tools.ts";
export * from "./process.ts";
