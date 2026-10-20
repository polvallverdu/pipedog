// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/strip_markdown.py

/** Strip Markdown formatting symbols before TTS synthesis. */

import type { TextType } from "../../../frames/frames.ts";

// Translation notes for the patterns below:
// - Python's `.` matches anything but `\n` (JS's also skips `\r`, U+2028 and
//   U+2029), so it is written `[^\n]`.
// - Python's `re.MULTILINE` `^` / `$` only break lines at `\n` (JS's `m` flag
//   also breaks at `\r`, U+2028 and U+2029), so they are written
//   `(?<![^\n])` / `(?![^\n])`.
// - Python's `\b` is Unicode-aware; next to `_` (a word character) it becomes a
//   lookaround on Unicode `\w` (letters, digits and underscore).
const W = "[\\p{L}\\p{N}_]";
const keepGroup = (_match: string, inner: string): string => inner;

/**
 * Remove Markdown formatting symbols that have no spoken equivalent.
 *
 * Strips bold/italic markers, backtick code spans, fenced code blocks, ATX
 * headers, and blockquote markers. Does not modify link or image syntax since
 * those may carry meaningful text (the link label is preserved verbatim).
 *
 * This transformer is alphanumeric-preserving: the normalized alnum sequence of
 * the output is identical to the input, so the `WordCompletionTracker`
 * requires no segment-map overhead.
 *
 * @param text Input text, potentially containing Markdown formatting.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with Markdown formatting symbols removed.
 *
 * @example
 * ```ts
 * const result = await stripMarkdown("**Hello** and _world_", "*");
 * // "Hello and world"
 * ```
 */
export async function stripMarkdown(text: string, _textType: string | TextType): Promise<string> {
  // Fenced code blocks (``` or ~~~)
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/~~~[\s\S]*?~~~/g, "");
  // Inline code
  text = text.replace(/`([^`]+)`/g, keepGroup);
  // Bold+italic ***text*** or ___text___
  text = text.replace(/\*{3}([^\n]+?)\*{3}/g, keepGroup);
  text = text.replace(/_{3}([^\n]+?)_{3}/g, keepGroup);
  // Bold **text** or __text__
  text = text.replace(/\*{2}([^\n]+?)\*{2}/g, keepGroup);
  text = text.replace(/_{2}([^\n]+?)_{2}/g, keepGroup);
  // Italic *text* or _text_
  text = text.replace(/\*([^\n]+?)\*/g, keepGroup);
  text = text.replace(new RegExp(`(?<!${W})_([^\\n]+?)_(?!${W})`, "gu"), keepGroup);
  // ATX headers (# ## ### etc.)
  text = text.replace(/(?<![^\n])#{1,6}\s+/g, "");
  // Blockquotes
  text = text.replace(/(?<![^\n])>\s?/g, "");
  // Horizontal rules
  text = text.replace(/(?<![^\n])\s*[-*_]{3,}\s*(?![^\n])/g, "");
  return text;
}
