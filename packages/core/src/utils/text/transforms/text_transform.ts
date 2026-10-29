// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/text_transform.py

/** The text transform callable shared by TTS services and the LLM text processor. */

import type { TextType } from "../base_text_aggregator.ts";

/**
 * An async callable that rewrites text of a given type: `(text, textType) => text`.
 *
 * Where a transform is registered decides who sees the rewrite. On a TTS service it
 * reaches the synthesizer only, and the context keeps the text as the LLM wrote it. On
 * `LLMTextProcessor` it reaches everything downstream: the voice, the context and the
 * client.
 */
export type TextTransform = (text: string, textType: string | TextType) => Promise<string>;
