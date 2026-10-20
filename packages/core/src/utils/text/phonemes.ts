// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/text/phonemes.py

/**
 * Shared pronunciation parsing and normalization utilities for TTS services.
 *
 * A pronunciation reaches a TTS service as an IPA string. Services each want their
 * own markup for it, but they all start from the same steps: tidy the notation,
 * split it into phones, and find which vowel each stress mark belongs to. Those
 * steps live here, so a service's formatter only has to render the result.
 *
 * Normalization is notation-only. It unifies ways of writing the same symbol
 * (`ʧ` and `tʃ`, `g` and `ɡ`, `'` and `ˈ`) and never changes which sound
 * is written, so it is safe for any language.
 */

export const PRIMARY_STRESS = "ˈ";
export const SECONDARY_STRESS = "ˌ";
export const STRESS_MARKS = [PRIMARY_STRESS, SECONDARY_STRESS] as const;

export const TIE_BAR = "͡";

// Ligatures and ASCII look-alikes of IPA symbols. "tʃ" and "dʒ" are always read
// as one phone, so they are written untied; other affricates keep the tie bar
// that tells them apart from a cluster.
const _IPA_NOTATION: readonly [string, string][] = [
  ["͜", TIE_BAR], // tie bar below
  ["ʧ", "tʃ"],
  ["ʤ", "dʒ"],
  [`t${TIE_BAR}ʃ`, "tʃ"],
  [`d${TIE_BAR}ʒ`, "dʒ"],
  ["ʦ", `t${TIE_BAR}s`],
  ["ʣ", `d${TIE_BAR}z`],
  ["g", "ɡ"],
  ["'", PRIMARY_STRESS],
  [":", "ː"],
  [".", ""], // syllable break
];

// Sequences read as a single phone even without a tie bar: affricates written
// this way in nearly every dictionary, and the English diphthongs. Anything else
// ("ts" in "cats" against Italian "pizza") is one phone only when tied.
const _IPA_MULTI = ["tʃ", "dʒ", "aɪ", "aʊ", "ɔɪ", "oʊ", "eɪ"].map((m) => Array.from(m));

const _IPA_VOWELS: ReadonlySet<string> = new Set(Array.from("aeiouyæɑɒɔəɚɛɜɝɪʊʌɐᵻɨʉɯɤøœɶɵɘɞ"));

// Characters that belong to the phone before them rather than starting a new one.
const _IPA_MODIFIERS: ReadonlySet<string> = new Set(Array.from("ːˑ"));

const _NONSPACING_MARK_RE = /^\p{Mn}$/u;

function isStressMark(char: string): boolean {
  return char === PRIMARY_STRESS || char === SECONDARY_STRESS;
}

function isModifierChar(char: string): boolean {
  return _IPA_MODIFIERS.has(char) || _NONSPACING_MARK_RE.test(char);
}

/** Whether the code points `chars` start with `prefix` (code points) at `index`. */
function startsWithAt(chars: readonly string[], prefix: readonly string[], index: number): boolean {
  if (index + prefix.length > chars.length) return false;
  return prefix.every((c, k) => chars[index + k] === c);
}

/**
 * Unify the notation of an IPA string without changing what it says.
 *
 * Strips surrounding `/…/` or `[…]`, composes Unicode, replaces ligatures and
 * ASCII look-alikes with their IPA symbols, writes `tʃ` and `dʒ` untied and
 * other affricates tied (`ʦ` becomes `t͡s`), drops syllable breaks, and
 * collapses whitespace.
 *
 * @param ipa An IPA transcription.
 * @returns The same transcription in canonical notation.
 *
 * @example
 * normalizeIpa("/ˈʧɪ.kən/"); // "ˈtʃɪkən"
 */
export function normalizeIpa(ipa: string): string {
  ipa = ipa.trim().normalize("NFC");
  const chars = Array.from(ipa);
  if (chars.length >= 2) {
    const pair = `${chars[0]}${chars[chars.length - 1]}`;
    if (pair === "//" || pair === "[]") {
      ipa = chars.slice(1, -1).join("");
    }
  }
  for (const [old, replacement] of _IPA_NOTATION) {
    ipa = ipa.replaceAll(old, replacement);
  }
  return ipa
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Split one IPA word into phones, in written order.
 *
 * Stress marks are returned as tokens of their own, where they were written.
 * Tied sequences (`t͡s`), `tʃ`, `dʒ` and the English diphthongs are one
 * phone each, returned without the tie bar; length marks and combining
 * diacritics stay with the phone they modify.
 *
 * @param ipa An IPA transcription of a single word.
 * @returns The phones and stress marks of the word.
 *
 * @example
 * ipaPhones("mɛtˈfɔɹmɪn"); // ["m", "ɛ", "t", "ˈ", "f", "ɔ", "ɹ", "m", "ɪ", "n"]
 */
export function ipaPhones(ipa: string): string[] {
  const chars = Array.from(normalizeIpa(ipa).replaceAll(" ", ""));
  const phones: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const char = chars[i] as string;
    if (isStressMark(char)) {
      phones.push(char);
      i += 1;
      continue;
    }
    let phone: string;
    if (chars[i + 1] === TIE_BAR && i + 2 < chars.length) {
      phone = char + chars[i + 2];
      i += 3;
    } else {
      const multi = _IPA_MULTI.find((m) => startsWithAt(chars, m, i));
      phone = multi ? multi.join("") : char;
      i += multi ? multi.length : 1;
    }
    while (i < chars.length && isModifierChar(chars[i] as string)) {
      phone += chars[i];
      i += 1;
    }
    const last = phones[phones.length - 1];
    if (last !== undefined && !isStressMark(last) && _isModifierOnly(phone)) {
      phones[phones.length - 1] = last + phone;
    } else {
      phones.push(phone);
    }
  }
  return phones;
}

/** Whether an IPA phone (as returned by `ipaPhones`) is a vowel. */
export function isIpaVowel(phone: string): boolean {
  const first = Array.from(phone)[0];
  return first !== undefined && _IPA_VOWELS.has(first);
}

/**
 * Move each stress mark from where it was written to just before its vowel.
 *
 * Transcriptions usually put stress at the start of the syllable
 * (`mɛtˈfɔɹmɪn`); some services want it on the vowel itself
 * (`mɛtfˈɔɹmɪn`). A stress mark with no vowel after it is dropped.
 *
 * @param phones Phones and stress marks, as returned by `ipaPhones`.
 * @returns The same phones with every stress mark directly before a vowel.
 */
export function stressBeforeVowels(phones: readonly string[]): string[] {
  const result: string[] = [];
  let pending: string | null = null;
  for (const phone of phones) {
    if (isStressMark(phone)) {
      pending = phone;
      continue;
    }
    if (pending && isIpaVowel(phone)) {
      result.push(pending);
      pending = null;
    }
    result.push(phone);
  }
  return result;
}

function _isModifierOnly(phone: string): boolean {
  return Array.from(phone).every(isModifierChar);
}
