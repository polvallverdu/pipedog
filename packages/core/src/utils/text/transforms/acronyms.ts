// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/acronyms.py

/** Normalize acronyms so TTS pronounces each letter individually. */

import type { TextType } from "../../../frames/frames.ts";

// Two or more consecutive uppercase letters not immediately followed by a lowercase
// letter (to avoid splitting CamelCase words like "iPhone" or "McDonalds").
// Python's `\b` is Unicode-aware; the lookarounds rebuild it with Unicode `\w`
// (letters, digits and underscore).
const ACRONYM_RE = /(?<![\p{L}\p{N}_])[A-Z]{2,}(?![a-z])(?![\p{L}\p{N}_])/gu;

/**
 * Insert spaces between letters of uppercase acronyms.
 *
 * This transformer is alphanumeric-preserving: the same letters are kept,
 * only spaces are added between them, so the `WordCompletionTracker`
 * requires no segment-map overhead.
 *
 * @param text Input text possibly containing acronyms like API or HTTP.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with acronyms letter-spaced (e.g. `"API"` → `"A P I"`).
 *
 * @example
 * ```ts
 * const result = await normalizeAcronyms("Use the API or HTTP endpoint", "*");
 * // "Use the A P I or H T T P endpoint"
 * ```
 */
export async function normalizeAcronyms(
  text: string,
  _textType: string | TextType,
): Promise<string> {
  return text.replace(ACRONYM_RE, (match) => [...match].join(" "));
}
