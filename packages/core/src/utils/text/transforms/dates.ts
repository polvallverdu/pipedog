// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/transforms/dates.py

/** Expand date expressions into spoken form for TTS. */

import { num2words } from "num2words-ts";
import type { TextType } from "../../../frames/frames.ts";

// Python's `\b` (next to a digit here) is Unicode-aware; the lookarounds
// rebuild it with Unicode `\w` (letters, digits and underscore).
// ISO dates: 2023-05-10
const ISO_DATE_RE = /(?<![\p{L}\p{N}_])(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}_])/gu;
// US dates: 05/10/2023 or 05-10-2023 (not matched by ISO because ISO has 4-digit year first)
const US_DATE_RE = /(?<![\p{L}\p{N}_])(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?![\p{L}\p{N}_])/gu;

const ORDINAL_SUFFIXES: Readonly<Record<number, string>> = { 1: "st", 2: "nd", 3: "rd" };

// Indexed by month - 1. Hardcoded rather than derived from strftime("%B"), which
// renders the month in the process's LC_TIME locale and would produce a
// mixed-language result alongside the English year and ordinal suffix.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function ordinal(n: number): string {
  const key = [11, 12, 13].includes(n % 100) ? 0 : n % 10;
  const suffix = ORDINAL_SUFFIXES[key] ?? "th";
  return `${n}${suffix}`;
}

/** A validated calendar date (stand-in for Python's `datetime`). */
interface SimpleDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Build a date like Python's `datetime(year, month, day)`.
 *
 * @throws RangeError for an out-of-range year, month or day (Python's `ValueError`).
 */
function makeDate(year: number, month: number, day: number): SimpleDate {
  if (year < 1 || year > 9999) throw new RangeError(`year ${year} is out of range`);
  if (month < 1 || month > 12) throw new RangeError("month must be in 1..12");
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) throw new RangeError("day is out of range for month");
  return { year, month, day };
}

function dateToSpoken(dt: SimpleDate): string {
  const yearWords = num2words(dt.year, { lang: "en" });
  const month = MONTH_NAMES[dt.month - 1];
  const day = ordinal(dt.day);
  return `${month} ${day}, ${yearWords}`;
}

function isoReplace(match: string, year: string, month: string, day: string): string {
  try {
    return dateToSpoken(makeDate(Number(year), Number(month), Number(day)));
  } catch (e) {
    if (e instanceof RangeError) return match;
    throw e;
  }
}

function usReplace(match: string, month: string, day: string, year: string): string {
  try {
    return dateToSpoken(makeDate(Number(year), Number(month), Number(day)));
  } catch (e) {
    if (e instanceof RangeError) return match;
    throw e;
  }
}

/**
 * Expand date expressions to their spoken form.
 *
 * Handles ISO format (`YYYY-MM-DD`) and US format (`MM/DD/YYYY` or `MM-DD-YYYY`).
 *
 * @param text Input text possibly containing date expressions.
 * @param _textType Text type of the text frame (unused).
 * @returns Text with date expressions replaced by spoken equivalents.
 *
 * @example
 * ```ts
 * const result = await normalizeDates("Meeting on 2023-05-10", "*");
 * // "Meeting on May 10th, two thousand and twenty three"
 * ```
 */
export async function normalizeDates(text: string, _textType: string | TextType): Promise<string> {
  text = text.replace(ISO_DATE_RE, isoReplace);
  text = text.replace(US_DATE_RE, usReplace);
  return text;
}
