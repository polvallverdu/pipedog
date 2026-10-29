// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/strip_markdown.py

/**
 * Strip Markdown formatting symbols before TTS synthesis.
 *
 * Porting notes: Python's `StripMarkdown` is a callable object (`__call__`).
 * As with `VoiceFormatter`, the constructor returns a function carrying the
 * class prototype, so an instance is both callable (usable in
 * `textTransforms`) and `instanceof StripMarkdown`; the apply step is the
 * `transform()` method.
 */

import type { TextType } from "../../../frames/frames.ts";

// Stands in for an asterisk that is content rather than emphasis while the
// emphasis rules run. A private-use character, so it cannot occur in the text.
const _STAR = "";

// Translation notes for the patterns below:
// - Python's `.` matches anything but `\n` (JS's also skips `\r`, U+2028 and
//   U+2029), so it is written `[^\n]`.
// - Python's `re.MULTILINE` `^` / `$` only break lines at `\n` (JS's `m` flag
//   also breaks at `\r`, U+2028 and U+2029), so they are written
//   `(?<![^\n])` / `(?![^\n])`.
// - Python's `\b` is Unicode-aware; next to `_` (a word character) it becomes a
//   lookaround on Unicode `\w` (letters, digits and underscore).
// - Python's `\d` matches any Unicode decimal digit, so it is written `\p{Nd}`.
const W = "[\\p{L}\\p{N}_]";
const keepGroup = (_match: string, inner: string): string => inner;
const UNDERSCORE_ITALIC_RE = new RegExp(`(?<!${W})_([^\\n]+?)_(?!${W})`, "gu");

export interface StripMarkdownOptions {
  /**
   * Reduce `[label](url)` and `![alt](url)` to the label or alt text.
   * Enabled by default.
   */
  stripUrls?: boolean;
}

// The interface merges a call signature into the class (Python's `__call__`).
export interface StripMarkdown {
  // biome-ignore lint/style/useShorthandFunctionType: an interface is needed to merge with the class.
  (text: string, textType: string | TextType): Promise<string>;
}

/**
 * Transform that removes Markdown formatting symbols with no spoken equivalent.
 *
 * Strips bold/italic markers, backtick code spans, fenced code blocks, ATX
 * headers, list bullets, blockquote markers and horizontal rules. Struck-through
 * text (`~~like this~~`) is removed along with its markers, since it is text
 * the reply takes back. A link or image is reduced to its label or alt text, so
 * the URL is not read out, unless `stripUrls` is off.
 *
 * An asterisk that is content stays: one between digits (`2*3`), one escaped
 * as `\*`, or one standing alone between spaces (`Press * then #`).
 *
 * Outside of fenced code, struck-through text and link URLs, this transformer
 * is alphanumeric-preserving: the normalized alnum sequence of the output is
 * identical to the input, so the `WordCompletionTracker` requires no
 * segment-map overhead.
 *
 * `stripMarkdown` is an instance with the default options, for registering
 * directly.
 *
 * @example
 * ```ts
 * const tts = new CartesiaTTSService({
 *   textTransforms: [["*", new StripMarkdown({ stripUrls: false })]],
 * });
 * ```
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: adds Python's `__call__` signature to the class.
export class StripMarkdown {
  protected _stripUrls!: boolean;

  /**
   * Initialize the transform.
   *
   * @param options.stripUrls Reduce `[label](url)` and `![alt](url)` to the label or
   *   alt text. Enabled by default.
   */
  constructor(options: StripMarkdownOptions = {}) {
    const call = async (text: string, textType: string | TextType): Promise<string> =>
      self.transform(text, textType);
    const self = Object.setPrototypeOf(call, new.target.prototype) as StripMarkdown;
    self._stripUrls = options.stripUrls ?? true;
    // biome-ignore lint/correctness/noConstructorReturn: returning the callable is the point (see above).
    return self;
  }

  /**
   * Remove Markdown formatting symbols from the text.
   *
   * Python's `__call__`; calling the instance runs this.
   *
   * @param text Input text, potentially containing Markdown formatting.
   * @param _textType Text type of the text frame (unused).
   * @returns Text with Markdown formatting symbols removed.
   */
  async transform(text: string, _textType: string | TextType): Promise<string> {
    // Fenced code blocks (``` or ~~~)
    text = text.replace(/```[\s\S]*?```/g, "");
    text = text.replace(/~~~[\s\S]*?~~~/g, "");
    // Images and links, keeping the alt text or label
    if (this._stripUrls) {
      text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, keepGroup);
    }
    // Inline code
    text = text.replace(/`([^`]+)`/g, keepGroup);
    // Strikethrough, with the space before it so the words around it still join
    text = text.replace(/[ \t]?~~(?=\S)[^\n]+?(?<=\S)~~/g, "");
    // Horizontal rules (---, ***, * * *), before list bullets so a spaced one
    // isn't taken for an item
    text = text.replace(/(?<![^\n])[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*(?![^\n])\n?/g, "");
    // List bullets (-, +, *) at any indent, since nested items are indented
    text = text.replace(/(?<![^\n])([ \t]*)[-+*][ \t]+(?=\S)/g, keepGroup);
    // Content asterisks: escaped (\*) or between digits (2*3, 2**3)
    text = text.replace(/\\\*|(?<=\p{Nd})\*+(?=\p{Nd})/gu, (match) =>
      _STAR.repeat(match.split("*").length - 1),
    );
    // Bold+italic ***text*** or ___text___
    text = text.replace(/\*{3}([^\n]+?)\*{3}/g, keepGroup);
    text = text.replace(/_{3}([^\n]+?)_{3}/g, keepGroup);
    // Bold **text** or __text__
    text = text.replace(/\*{2}([^\n]+?)\*{2}/g, keepGroup);
    text = text.replace(/_{2}([^\n]+?)_{2}/g, keepGroup);
    // Italic *text* or _text_. The markers hug the text, so a standalone
    // asterisk ("Press * then #") is not an opener or a closer.
    text = text.replace(/\*(?=\S)([^\n]+?)(?<=\S)\*/g, keepGroup);
    text = text.replace(UNDERSCORE_ITALIC_RE, keepGroup);
    // ATX headers (# ## ### etc.)
    text = text.replace(/(?<![^\n])#{1,6}\s+/g, "");
    // Blockquotes
    text = text.replace(/(?<![^\n])>\s?/g, "");
    return text.replaceAll(_STAR, "*");
  }
}

/**
 * A `StripMarkdown` with the default options.
 *
 * @example
 * ```ts
 * const result = await stripMarkdown("**Hello** and _world_", "*");
 * // "Hello and world"
 *
 * const tts = new CartesiaTTSService({
 *   textTransforms: [["*", stripMarkdown]],
 * });
 * ```
 */
export const stripMarkdown = new StripMarkdown();
