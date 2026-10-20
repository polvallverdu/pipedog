// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/units.py

/** Expand unit abbreviations into their spoken form for TTS. */

import type { TextType } from "../../../frames/frames.ts";

/** Maps unit abbreviation to (singular, plural) spoken forms. */
const UNIT_MAP: Readonly<Record<string, readonly [string, string]>> = {
  km: ["kilometer", "kilometers"],
  m: ["meter", "meters"],
  cm: ["centimeter", "centimeters"],
  mm: ["millimeter", "millimeters"],
  mi: ["mile", "miles"],
  ft: ["foot", "feet"],
  in: ["inch", "inches"],
  yd: ["yard", "yards"],
  kg: ["kilogram", "kilograms"],
  g: ["gram", "grams"],
  mg: ["milligram", "milligrams"],
  lb: ["pound", "pounds"],
  oz: ["ounce", "ounces"],
  l: ["liter", "liters"],
  ml: ["milliliter", "milliliters"],
  mph: ["mile per hour", "miles per hour"],
  kph: ["kilometer per hour", "kilometers per hour"],
  kmh: ["kilometer per hour", "kilometers per hour"],
  gb: ["gigabyte", "gigabytes"],
  mb: ["megabyte", "megabytes"],
  kb: ["kilobyte", "kilobytes"],
  tb: ["terabyte", "terabytes"],
  hz: ["hertz", "hertz"],
  khz: ["kilohertz", "kilohertz"],
  mhz: ["megahertz", "megahertz"],
  ghz: ["gigahertz", "gigahertz"],
};

// Single-letter units that are also common English words: only expand when
// they appear immediately after a digit with no intervening space, e.g. "5m"
// but not "1 m people" (where "m" is a word) or "1 in 5" (preposition).
const AMBIGUOUS_UNITS = new Set(["in", "m", "g", "l"]);

// A stable sort, like Python's `sorted`, so equal lengths keep insertion order.
const sortedUnambiguous = Object.keys(UNIT_MAP)
  .filter((u) => !AMBIGUOUS_UNITS.has(u))
  .sort((a, b) => b.length - a.length);
const sortedAmbiguous = [...AMBIGUOUS_UNITS].sort((a, b) => b.length - a.length);

// Python's `\b` (after a unit letter here) is Unicode-aware; the lookahead
// rebuilds it with Unicode `\w` (letters, digits and underscore). The unit
// names are plain letters, so they need no escaping.
const W = "[\\p{L}\\p{N}_]";

// Unambiguous units allow optional whitespace between the number and the unit.
const UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${sortedUnambiguous.join("|")})(?!${W})`, "giu");

// Ambiguous units require the unit to follow the digit with no space.
const AMBIGUOUS_UNIT_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)(${sortedAmbiguous.join("|")})(?!${W})`,
  "giu",
);

/**
 * Expand unit abbreviations to their full spoken form.
 *
 * A quantity of exactly one takes the singular form of the unit.
 *
 * @param text Input text possibly containing unit expressions.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with unit abbreviations replaced by spoken equivalents.
 *
 * @example
 * ```ts
 * const result = await expandUnits("Run 5km at 100kph", "*");
 * // "Run 5 kilometers at 100 kilometers per hour"
 *
 * const result2 = await expandUnits("Only 1km left", "*");
 * // "Only 1 kilometer left"
 * ```
 */
export async function expandUnits(text: string, _textType: string | TextType): Promise<string> {
  const replace = (_match: string, number: string, unit: string): string => {
    // Python indexes the map directly; every match is a key once lowercased.
    const [singular, plural] = UNIT_MAP[unit.toLowerCase()]!;
    // Only a bare "1" takes the singular; a decimal such as "1.0" reads as
    // plural in speech.
    return `${number} ${number === "1" ? singular : plural}`;
  };

  text = text.replace(UNIT_RE, replace);
  return text.replace(AMBIGUOUS_UNIT_RE, replace);
}
