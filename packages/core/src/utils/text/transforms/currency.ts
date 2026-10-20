// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/currency.py

/** Expand currency amounts into spoken form for TTS. */

import { num2words } from "num2words-ts";
import type { TextType } from "../../../frames/frames.ts";

/** Maps currency symbol to (singular, plural, cents_singular, cents_plural). */
const CURRENCY_MAP: Readonly<
  Record<string, readonly [string, string, string | null, string | null]>
> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "€": ["euro", "euros", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
  "¥": ["yen", "yen", null, null],
  "₹": ["rupee", "rupees", "paisa", "paise"],
};

// Python's `\b` (after a digit here) is Unicode-aware; the lookahead rebuilds
// it with Unicode `\w` (letters, digits and underscore).
const CURRENCY_RE = /([€£¥₹$])\s*(\d{1,3}(?:,\d{3})*|\d+)(?![\p{L}\p{N}_])(?:\.(\d+))?/gu;

function amountToWords(n: bigint, singular: string, plural: string): string {
  const words = num2words(n, { lang: "en" });
  const unit = n === 1n ? singular : plural;
  return `${words} ${unit}`;
}

function currencyMatch(symbol: string, wholeMatch: string, fracStr: string | undefined): string {
  const wholeStr = wholeMatch.replaceAll(",", "");

  const currency = CURRENCY_MAP[symbol] ?? (["unit", "units", "cent", "cents"] as const);
  const [singular, plural, cSingular, cPlural] = currency;

  const whole = BigInt(wholeStr);
  let result = amountToWords(whole, singular, plural);

  if (fracStr && cSingular && cPlural) {
    const frac = BigInt(fracStr.slice(0, 2).padEnd(2, "0"));
    if (frac > 0n) {
      result += ` and ${amountToWords(frac, cSingular, cPlural)}`;
    }
  }

  return result;
}

/**
 * Expand currency amounts to their spoken form.
 *
 * @param text Input text possibly containing currency expressions.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with currency amounts replaced by spoken equivalents.
 *
 * @example
 * ```ts
 * const result = await expandCurrency("Your balance is $42.50", "*");
 * // "Your balance is forty-two dollars and fifty cents"
 * ```
 */
export async function expandCurrency(text: string, _textType: string | TextType): Promise<string> {
  return text.replace(
    CURRENCY_RE,
    (_match, symbol: string, whole: string, frac: string | undefined) =>
      currencyMatch(symbol, whole, frac),
  );
}
