// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/replacements.py

/**
 * User-defined text replacements for TTS preprocessing.
 *
 * Porting notes: patterns are JavaScript regular expressions (a `RegExp`, or a
 * string compiled with `new RegExp(pattern, "g")`), and replacement strings use
 * JavaScript's `String.prototype.replace` syntax (`$1`, `$<name>`) rather than
 * Python's (`\1`, `\g<name>`). Every match is replaced, as Python's `re.sub`
 * does, whether or not a `RegExp` carries the `g` flag.
 */

import type { TextType } from "../../../frames/frames.ts";

/** A find-and-replace rule: `(regexPattern, replacementString)`. */
export type TextReplacement = readonly [pattern: string | RegExp, replacement: string];

function compile(pattern: string | RegExp): RegExp {
  if (typeof pattern === "string") return new RegExp(pattern, "g");
  return pattern.global ? new RegExp(pattern) : new RegExp(pattern, `${pattern.flags}g`);
}

/**
 * Return a transform that applies a list of find-and-replace rules.
 *
 * Each rule is a `(pattern, replacement)` tuple. Patterns are treated as
 * regular expressions; escape special characters for literal string matching.
 *
 * Rules are applied in the order provided. Whether the resulting transform is
 * alphanumeric-preserving depends on the replacements supplied.
 *
 * Patterns are compiled at construction time so invalid regex patterns raise
 * `SyntaxError` immediately rather than during live TTS processing.
 *
 * @param replacements Ordered list of `(regexPattern, replacementString)` pairs.
 * @returns An async transform callable compatible with `textTransforms`.
 *
 * @example
 * ```ts
 * const transform = replaceText([
 *   [/\bDr\./, "Doctor"],
 *   [/\bSt\./, "Street"],
 *   [/\bvs\b/, "versus"],
 * ]);
 * const tts = new CartesiaTTSService({ textTransforms: [["*", transform]] });
 * ```
 */
export function replaceText(
  replacements: readonly TextReplacement[],
): (text: string, textType: string | TextType) => Promise<string> {
  const compiled = replacements.map(
    ([pattern, replacement]) => [compile(pattern), replacement] as const,
  );

  return async (text: string, _textType: string | TextType): Promise<string> => {
    for (const [pattern, replacement] of compiled) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
    }
    return text;
  };
}
