// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/alnum_utils.py

/**
 * Shared alphanumeric utilities for text normalization and cursor advancement.
 *
 * Positions and counts are UTF-16 code units, as JavaScript string indices
 * are (upstream counts code points). Every count produced here (`alnumOnly`
 * lengths) and every count consumed (`advanceByAlnums`, `advanceByChars`)
 * uses the same unit, so they stay in step; they only differ from upstream
 * for characters outside the Basic Multilingual Plane.
 */

import { stripCompleteMarkup } from "./markup_utils.ts";

//
// Python `str` predicates, for one character (code point).
//

const ALNUM_RE = /^[\p{L}\p{N}]$/u;
const ALPHA_RE = /^\p{L}$/u;
const PUNCT_RE = /^\p{P}$/u;
// Python's `str.isspace()` set (differs from JS `\s` on \x1c-\x1f, \x85 and \ufeff).
// The \x1c-\x1f separators are checked by code in `isSpace`.
const SPACE_RE = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

/** Python's `ch.isalnum()` for a single character. */
export function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM_RE.test(ch);
}

/** Python's `ch.isalpha()` for a single character. */
export function isAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ALPHA_RE.test(ch);
}

/** Python's `ch.isspace()` for a single character. */
export function isSpace(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (ch.length === 1 && code >= 0x1c && code <= 0x1f) || SPACE_RE.test(ch);
}

/** Python's `unicodedata.category(ch).startswith("P")` for a single character. */
export function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && PUNCT_RE.test(ch);
}

/** The character (code point) at code unit offset `pos` of `text`. */
export function charAt(text: string, pos: number): string {
  const cp = text.codePointAt(pos);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * Remove punctuation only at the very end of `text`.
 *
 * @param text Input text to trim.
 * @returns `text` with any trailing run of Unicode punctuation characters removed.
 */
export function stripTrailingPunctuation(text: string): string {
  return text.replace(/\p{P}+$/u, "");
}

/**
 * Typographic punctuation variants mapped to their ASCII equivalents.
 *
 * LLMs emit the typographic forms and TTS services may report the ASCII ones
 * in word-timestamp events (or the reverse). Every entry is a single
 * character mapped to a single character, which is what lets
 * `foldForMatching` keep its 1:1 length contract.
 */
const TYPOGRAPHIC_FOLD: Readonly<Record<string, string>> = {
  "‘": "'", // ‘ LEFT SINGLE QUOTATION MARK
  "’": "'", // ’ RIGHT SINGLE QUOTATION MARK
  ʼ: "'", // ʼ MODIFIER LETTER APOSTROPHE
  "“": '"', // “ LEFT DOUBLE QUOTATION MARK
  "”": '"', // ” RIGHT DOUBLE QUOTATION MARK
  "–": "-", // – EN DASH
  "—": "-", // — EM DASH
};

const TYPOGRAPHIC_FOLD_RE = /[\u2018\u2019\u02bc\u201c\u201d\u2013\u2014]/g;

/**
 * Replace typographic punctuation variants with their ASCII equivalents.
 *
 * @param text Input text to fold.
 * @returns `text` with typographic quotes and dashes replaced by ASCII; same
 *   length as `text`.
 */
export function foldTypography(text: string): string {
  return text.replace(TYPOGRAPHIC_FOLD_RE, (ch) => TYPOGRAPHIC_FOLD[ch] ?? ch);
}

/**
 * Lowercase `char`, reduced to its base letter if it carries a combining accent.
 *
 * NFD decomposes an accented character into a base letter plus a combining
 * mark (e.g. `é` -> `e` + `◌́`, category `Mn`); dropping the mark keeps only
 * the base letter. Always returns exactly one character of the same length,
 * so callers can rely on a 1:1 length mapping with the input.
 */
function foldAccentedChar(char: string): string {
  const nfd = [...char.normalize("NFD")];
  let folded: string;
  if (nfd.length >= 2 && /^\p{Mn}$/u.test(nfd[1] as string)) {
    folded = (nfd[0] as string).toLowerCase();
  } else {
    folded = char.toLowerCase();
  }
  // A few lowercase mappings change length (they do in Python too); keep the
  // 1:1 length contract by leaving such a character as it is.
  return folded.length === char.length ? folded : char;
}

/**
 * Fold away surface variation between two spellings of the same text, 1:1.
 *
 * Unlike `alnumOnly`, this never removes or merges characters -- punctuation,
 * spaces, and markup are passed through unchanged, and each output character
 * corresponds to exactly the same-index input character. A raw offset
 * computed against the folded text therefore applies unchanged to the
 * original, so callers can use it as a drop-in transform before a
 * position-based literal comparison, without the risk of a fully-normalized
 * (whitespace/punctuation-stripped) comparison matching across a boundary
 * that wasn't already a candidate in the untransformed comparison.
 *
 * Folds case, accents, and typographic punctuation (`’` -> `'`,
 * `–` -> `-`) -- the variations a TTS service may introduce between the
 * text it was sent and the words it reports back. Deliberately narrow: each
 * folded character is listed in `TYPOGRAPHIC_FOLD`, rather than applying a
 * blanket Unicode compatibility normalization, which would silently fold
 * thousands of characters (CJK compatibility ideographs, halfwidth katakana,
 * math alphanumerics) that no service is known to substitute.
 *
 * @param text Input text to fold.
 * @returns `text` with those variations folded away; same length as `text`.
 */
export function foldForMatching(text: string): string {
  let folded = "";
  for (const ch of text) {
    folded += isAlpha(ch) ? foldAccentedChar(ch) : ch;
  }
  return foldTypography(folded);
}

/**
 * Strip XML/HTML tags then keep only lowercase alphanumeric characters.
 *
 * Accented letters (e.g. ã, é) are reduced to their base letter so TTS output
 * can be matched against LLM text even when the provider strips diacritics.
 * Non-Latin scripts (CJK, Hangul) are kept as-is — each original character
 * contributes exactly one char to the result, keeping normalized length in
 * sync with raw alnum counts used by `advanceByAlnums`.
 *
 * @param text Input text to reduce.
 * @returns Lowercase alphanumeric-only string with tags stripped.
 */
export function alnumOnly(text: string): string {
  text = stripCompleteMarkup(text);
  let result = "";
  for (const char of text) {
    // Ignore punctuation, spaces, emojis, etc.
    // Keep only letters and numbers.
    if (!isAlnum(char)) {
      continue;
    }
    if (isAlpha(char)) {
      // Letters, including CJK and Hangul: fold accents, a no-op for scripts
      // that have none.
      result += foldAccentedChar(char);
    } else {
      // Digits and other alnum-but-not-alphabetic characters: no case or
      // accent to fold, so keep as-is (lowercase conversion is a no-op).
      const lower = char.toLowerCase();
      result += lower.length === char.length ? lower : char;
    }
  }
  return result;
}

/**
 * Return true if `text` holds anything alphanumeric once markup is stripped.
 *
 * The predicate form of `alnumOnly`, for the question the callers actually
 * ask: is there anything left to speak here? A tag's letters do not count --
 * `"<break/>"` is empty by this measure.
 */
export function hasAlnum(text: string): boolean {
  return alnumOnly(text).length > 0;
}

/**
 * Return the position in `text` after advancing past `n` characters.
 *
 * XML/HTML tags (`<...>`) are crossed without counting against the budget, so
 * the span returned includes any tag met on the way. Everything else counts,
 * punctuation and spaces included.
 *
 * This keeps a cursor in step with one walking the same content written
 * without the tags: both move over the same characters, so neither reaches
 * past what the other has. Where the budget is a count of letters and digits
 * instead, use `advanceByAlnums`.
 *
 * @param text The source text to scan.
 * @param startPos Starting position in `text`.
 * @param n Number of characters (code units) to consume.
 * @returns New position in `text` after consuming `n` characters.
 */
export function advanceByChars(text: string, startPos: number, n: number): number {
  let pos = startPos;
  let count = 0;
  while (pos < text.length && count < n) {
    if (text[pos] === "<") {
      const end = text.indexOf(">", pos);
      pos = end !== -1 ? end + 1 : pos + 1;
    } else {
      const len = charAt(text, pos).length;
      count += len;
      pos += len;
    }
  }
  return pos;
}

/**
 * Return the position in `text` after advancing past `n` alphanumeric chars.
 *
 * Moves through the text one character at a time, counting only alphanumeric
 * characters. XML/HTML tags (`<...>`) are skipped entirely — their content is
 * not counted against the budget, so the returned span includes the full tag.
 * Other non-alphanumeric characters (spaces, punctuation) are also passed over
 * without decrementing the budget.
 *
 * After the `n` alnum chars are consumed, advances further past any
 * immediately following punctuation (e.g. the `,` in `"questions,"` or the `.`
 * in `"done."`), stopping before the next space, alnum char, or XML tag.
 *
 * @param text The source text to scan.
 * @param startPos Starting position in `text`.
 * @param n Number of alphanumeric characters (code units) to consume.
 * @returns New position in `text` after consuming `n` alnum chars and
 *   trailing punctuation.
 */
export function advanceByAlnums(text: string, startPos: number, n: number): number {
  let pos = startPos;
  let count = 0;
  while (pos < text.length && count < n) {
    if (text[pos] === "<") {
      const end = text.indexOf(">", pos);
      pos = end !== -1 ? end + 1 : pos + 1;
    } else {
      const ch = charAt(text, pos);
      if (isAlnum(ch)) {
        count += ch.length;
      }
      pos += ch.length;
    }
  }

  while (pos < text.length) {
    if (text[pos] === "<") {
      break;
    }
    const ch = charAt(text, pos);
    if (isAlnum(ch) || isSpace(ch)) {
      break;
    }
    pos += ch.length;
  }

  return pos;
}
