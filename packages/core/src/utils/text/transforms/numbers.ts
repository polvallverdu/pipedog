// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/numbers.py

/** Expand numeric expressions into spoken form for TTS. */

import { num2words } from "num2words-ts";
import type { TextType } from "../../../frames/frames.ts";
import { toAsciiDigits } from "../unicode_digits.ts";

// Matches integers and decimals, with optional thousand separators.
// Python's `\b` (next to a digit here) is Unicode-aware; the lookarounds
// rebuild it with Unicode `\w` (letters, digits and underscore).
// `\p{Nd}` is Python's Unicode `\d`; toAsciiDigits() lets BigInt/Number parse what int()/float() accept.
const NUMBER_RE =
  /(?<![\p{L}\p{N}_])(\p{Nd}{1,3}(?:,\p{Nd}{3})*|\p{Nd}+)(?:\.(\p{Nd}+))?(?![\p{L}\p{N}_])/gu;

/**
 * Return a transform that expands numbers to their spoken form.
 *
 * When `digitCutoff` is set, numbers above it are read digit-by-digit
 * (e.g. `"2026"` → `"2 0 2 6"`). Numbers at or below the cutoff are
 * expanded as quantities (e.g. `"42"` → `"forty two"`). Pass `null`
 * to expand all numbers as words regardless of magnitude.
 *
 * Decimals are read as the whole part followed by their fractional digits, one at a
 * time, so every written digit is spoken (`"1.0"` → `"one point zero"`).
 *
 * @param digitCutoff Numbers larger than this value are read digit-by-digit.
 *   `null` disables the cutoff so every number is expanded as a word.
 * @returns An async transform callable compatible with `textTransforms`.
 *
 * @example
 * ```ts
 * const transform = expandNumbers(2025);
 * const result = await transform("Room 42 has 1234 seats and opens in 2026", "*");
 * // "Room forty two has one thousand two hundred thirty four seats and opens in 2 0 2 6"
 * ```
 */
export function expandNumbers(
  digitCutoff: number | bigint | null = 2025,
): (text: string, textType: string | TextType) => Promise<string> {
  const numToWords = (wholeMatch: string, fracStr: string | undefined): string => {
    const wholeStr = wholeMatch.replaceAll(",", "");
    const whole = BigInt(toAsciiDigits(wholeStr));

    if (digitCutoff !== null && whole > digitCutoff) {
      let result = [...wholeStr].join(" ");
      if (fracStr) {
        result += ` point ${[...fracStr].join(" ")}`;
      }
      return result;
    }

    if (fracStr) {
      // Reading the fraction one digit at a time keeps trailing zeros audible,
      // which also keeps a decimal agreeing with the plural unit expandUnits
      // picks for it ("1.0 kilometers").
      return `${num2words(whole, { lang: "en" })} point ${[...fracStr]
        .map((digit) => num2words(Number(toAsciiDigits(digit)), { lang: "en" }))
        .join(" ")}`;
    }

    return num2words(whole, { lang: "en" });
  };

  return async (text: string, _textType: string | TextType): Promise<string> =>
    text.replace(NUMBER_RE, (_match, whole: string, frac: string | undefined) =>
      numToWords(whole, frac),
    );
}
