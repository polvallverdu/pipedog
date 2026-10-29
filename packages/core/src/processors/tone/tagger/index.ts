// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/tone/tagger/__init__.py

/**
 * Pipecat Tone's tagger: expression tags for an LLM's plain replies.
 *
 * Part of expressive conversation (alpha). The tagger model labels each sentence of a
 * reply as it streams in: a delivery, slow spans for details, stressed words, a sound
 * before or after and, with `ExpressionGuidance.BREATHE`, a breath before it, drawn as a
 * light breath, a deep breath or an exhale. It reads the call so far and how the user
 * sounded, and runs on the CPU in about 15 milliseconds a sentence. The labels are
 * `CORE_DELIVERY`, `CORE_SOUNDS` and the kinds of breath it draws, written as tags in the
 * names the TTS service performs them by.
 *
 * **Alpha.** These types are likely to change between releases.
 */

export { PipecatToneTagger } from "./processor.ts";
