// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/pronunciations.py

/**
 * Replace words with a TTS service's pronunciation markup.
 *
 * Applications usually reach this through a service's
 * `TTSService.pronunciationTransformIpa` static method, which supplies the
 * service's own formatter.
 */

import type { TextType } from "../../../frames/frames.ts";
import { logger } from "../../logger.ts";

/** Turns `(word, ipa)` into the text to send, or null when it cannot. */
export type PronunciationFormatter = (word: string, ipa: string) => string | null;

/** Returns the text to send in place of a match. */
export type PronunciationReplacer = (match: RegExpExecArray) => string;

// Python's `PronunciationTransform` is a callable object (`__call__`). The
// interface merges a call signature into the class, and the constructor
// returns a function carrying the class prototype, so an instance is both
// callable (usable in `textTransforms`) and `instanceof PronunciationTransform`.
export interface PronunciationTransform {
  // biome-ignore lint/style/useShorthandFunctionType: an interface is needed to merge with the class.
  (text: string, textType: string | TextType): Promise<string>;
}

/**
 * A text transform that replaces words with a service's pronunciation markup.
 *
 * TTS services recognize it among their `textTransforms` and skip it while
 * they cannot read pronunciation markup (see `TTSService.supportsPronunciations`),
 * so the words are spoken as written.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: adds Python's `__call__` signature to the class.
export class PronunciationTransform {
  protected _pattern!: RegExp | null;
  protected _replace!: PronunciationReplacer;

  /**
   * Initialize the transform.
   *
   * @param pattern Matches the words to replace, or null when there are none.
   * @param replace Returns the text to send in place of a match.
   */
  constructor(pattern: RegExp | null, replace: PronunciationReplacer) {
    const call = async (text: string, textType: string | TextType): Promise<string> =>
      self.transform(text, textType);
    const self = Object.setPrototypeOf(call, new.target.prototype) as PronunciationTransform;
    self._pattern = pattern;
    self._replace = replace;
    // biome-ignore lint/correctness/noConstructorReturn: returning the callable is the point (see above).
    return self;
  }

  /**
   * Replace every matched word in `text`.
   *
   * Python's `__call__`; calling the instance runs this.
   *
   * @param text The text about to be sent to the service.
   * @param _textType The text type of the text (unused).
   * @returns The text with each matched word replaced.
   */
  transform(text: string, _textType: string | TextType): string {
    const pattern = this._pattern;
    if (!pattern) return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, (...args: unknown[]) => {
      // `replace` passes (match, ...groups, offset, input); rebuild an exec array.
      const match = [args[0] as string] as unknown as RegExpExecArray;
      return this._replace(match);
    });
  }
}

/** Python's `re.escape` for a JS (`u`-flag) regular expression. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Return a transform that replaces each word with its formatted pronunciation.
 *
 * Words match whole and case-insensitively, longest first, and never as part
 * of a longer or hyphenated word. The matched text is passed to the formatter,
 * so markup that keeps the word (such as an SSML `<phoneme>` tag) keeps it as
 * written.
 *
 * Every pronunciation is formatted once here, so one the service cannot use
 * is reported when the transform is built rather than while speaking. Those
 * words are left out and spoken as written.
 *
 * @param pronunciations Word to IPA, e.g. `{ Metformin: "mɛtˈfɔɹmɪn" }`.
 * @param formatPronunciation Turns `(word, ipa)` into the text to send, or
 *   null when it cannot.
 * @param options.serviceName Name used in the warning for unusable pronunciations.
 * @returns A transform to register with `textTransforms`.
 */
export function pronunciationTransform(
  pronunciations: Readonly<Record<string, string>>,
  formatPronunciation: PronunciationFormatter,
  options: { serviceName?: string } = {},
): PronunciationTransform {
  const serviceName = options.serviceName ?? "TTS service";
  const phonemes = new Map<string, string>();
  const unusable: string[] = [];
  for (const [rawWord, value] of Object.entries(pronunciations)) {
    const word = rawWord.trim();
    if (!word) continue;
    if (formatPronunciation(word, value) === null) {
      unusable.push(word);
    } else {
      phonemes.set(word.toLowerCase(), value);
    }
  }

  if (unusable.length > 0) {
    logger.warning(
      `${serviceName} cannot use these IPA pronunciations, so they ` +
        `will be spoken as written: ${unusable.join(", ")}`,
    );
  }

  let pattern: RegExp | null = null;
  if (phonemes.size > 0) {
    // Python's `len` counts code points, not UTF-16 units.
    const words = [...phonemes.keys()].sort((a, b) => [...b].length - [...a].length);
    // Python's Unicode `\w` is letters, digits and underscore.
    pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_-])(?:${words.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}_-])`,
      "giu",
    );
  }

  const replace = (match: RegExpExecArray): string => {
    const word = match[0];
    // Python indexes the dict directly; a case-folding mismatch would raise
    // there, here the word is kept as written.
    const ipa = phonemes.get(word.toLowerCase());
    if (ipa === undefined) return word;
    return formatPronunciation(word, ipa) || word;
  };

  return new PronunciationTransform(pattern, replace);
}
