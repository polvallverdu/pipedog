// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/string.py

/**
 * Text processing utilities for sentence boundary detection and tag parsing.
 *
 * This module provides utilities for natural language text processing including
 * sentence boundary detection, email and number pattern handling, and XML-style
 * tag parsing for structured text content.
 *
 * Sentence boundaries use sentencex's embedded language rules without external
 * data, like upstream: `@pipecat-ts/sentencex-wasm` is the same sentencex
 * release upstream pins, compiled to WebAssembly so it runs on every runtime.
 * The segmenter is pluggable with `setSentenceSegmenter()`;
 * `intlSentenceSegmenter` is a lighter `Intl.Segmenter`-based alternative.
 *
 * Offsets returned by this module are JavaScript string indices (UTF-16 code
 * units), so `text.slice(0, matchEndofsentence(text))` is the first sentence.
 */

import { segment } from "@pipecat-ts/sentencex-wasm";

/**
 * Split `text` into spans, like sentencex's `segment(language, text)`.
 *
 * The spans must concatenate back to `text`; each span is a sentence with
 * whatever whitespace the segmenter attaches to it.
 */
export type SentenceSegmenter = (language: string, text: string) => Iterable<string>;

const QUOTED_WORD_END = /(?<![\p{L}\p{N}_])(["'“‘«‹„‟「『]+)[\p{L}\p{N}_.]+\.$/u;

/**
 * Normalize a language code for sentencex's language fallback map.
 *
 * @param language Language code, optionally with a region. null, empty, and
 *   automatic language selections use English.
 * @returns A lowercase base language code. The segmenter resolves unsupported codes.
 */
export function resolveSentenceTokenizerLanguage(language: string | null | undefined): string {
  if (typeof language !== "string") {
    return "en";
  }
  const normalized = language.trim().toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
  return normalized === "" || normalized === "auto" ? "en" : normalized;
}

// Words that end in a period without ending a sentence. The default segmenter
// merges a split that follows one of them. Lowercase, without the period.
const ABBREVIATIONS = new Set([
  // English
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "mt",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "u.s",
  "u.k",
  "no",
  "vol",
  "fig",
  "inc",
  "ltd",
  "co",
  "corp",
  "gen",
  "gov",
  "sen",
  "rep",
  "rev",
  "capt",
  "col",
  "lt",
  "sgt",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  // Other European languages
  "z.b",
  "d.h",
  "bzw",
  "ca",
  "sra",
  "srta",
  "dra",
  "p",
  "pp",
  "dott",
  "sig",
  "ing",
  "avv",
  "mme",
  "mlle",
]);

function endsWithAbbreviation(span: string): boolean {
  const trimmed = span.trimEnd();
  if (!trimmed.endsWith(".")) return false;
  const match = /([\p{L}.]+)\.$/u.exec(trimmed);
  if (!match?.[1]) return false;
  const word = match[1].replace(/^\.+/, "");
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // Dotted acronyms such as "U.S.A." or "N.A.S.A." keep going.
  return /^(\p{L}\.)+\p{L}$/u.test(word);
}

/** An alternative segmenter: `Intl.Segmenter` plus abbreviation merging. */
export const intlSentenceSegmenter: SentenceSegmenter = (language, text) => {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }
  const spans: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const previous = spans[spans.length - 1];
    if (previous !== undefined && (endsWithAbbreviation(previous) || !previous.trim())) {
      spans[spans.length - 1] = previous + segment;
    } else {
      spans.push(segment);
    }
  }
  return spans;
};

/** The default segmenter: sentencex, as upstream. */
export const sentencexSegmenter: SentenceSegmenter = (language, text) => segment(language, text);

let sentenceSegmenter: SentenceSegmenter = sentencexSegmenter;
const tokenizerCache = new Map<string, (text: string) => string[]>();

/**
 * Install the sentence segmenter used for sentence boundary detection (for
 * example `intlSentenceSegmenter`). Pass `null` to restore the default,
 * sentencex.
 */
export function setSentenceSegmenter(segmenter: SentenceSegmenter | null): void {
  sentenceSegmenter = segmenter ?? sentencexSegmenter;
  tokenizerCache.clear();
}

/**
 * Return a sentence splitter that preserves source offsets before whitespace.
 *
 * Paragraph separators belong to the following sentence. Trailing whitespace
 * stays in the aggregation buffer until that sentence is emitted.
 */
function sentTokenizer(language = "en"): (text: string) => string[] {
  const cached = tokenizerCache.get(language);
  if (cached) return cached;

  const code = resolveSentenceTokenizerLanguage(language);

  const tokenize = (text: string): string[] => {
    const sentences: string[] = [];
    let pending = "";
    for (const span of sentenceSegmenter(code, text)) {
      pending += span;
      if (span.trim()) {
        const sentence = pending.trimEnd();
        sentences.push(sentence);
        pending = pending.slice(sentence.length);
      }
    }
    return sentences;
  };

  tokenizerCache.set(language, tokenize);
  return tokenize;
}

export const SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set([
  // Latin script punctuation (most European languages, Filipino, etc.)
  ".",
  "!",
  "?",
  ";",
  "…",
  // East Asian punctuation (Chinese (Traditional & Simplified), Japanese, Korean)
  "。", // Ideographic full stop
  "？", // Full-width question mark
  "！", // Full-width exclamation mark
  "；", // Full-width semicolon
  "．", // Full-width period
  "｡", // Halfwidth ideographic period
  // Indic scripts punctuation (Hindi, Sanskrit, Marathi, Nepali, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Punjabi, Oriya, Assamese)
  "।", // Devanagari danda (single vertical bar)
  "॥", // Devanagari double danda (double vertical bar)
  // Arabic script punctuation (Arabic, Persian, Urdu, Pashto)
  "؟", // Arabic question mark
  "؛", // Arabic semicolon
  "۔", // Urdu full stop
  "؏", // Arabic sign misra (classical texts)
  // Myanmar/Burmese
  "၊", // Myanmar sign little section
  "။", // Myanmar sign section
  // Khmer
  "។", // Khmer sign khan
  "៕", // Khmer sign bariyoosan
  // Lao
  "໌", // Lao cancellation mark (used as period)
  // Tibetan
  "།", // Tibetan mark intersyllabic tsheg
  "༎", // Tibetan mark delimiter tsheg bstar
  // Armenian
  "։", // Armenian full stop
  "՜", // Armenian exclamation mark
  "՞", // Armenian question mark
  // Ethiopic script (Amharic)
  "።", // Ethiopic full stop
  "፧", // Ethiopic question mark
  "፨", // Ethiopic paragraph separator
]);

// Latin punctuation that sentencex handles well — these need sentencex's disambiguation
// because "." can appear in abbreviations, decimals, etc.
const LATIN_SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?", ";", "…"]);

// Non-Latin sentence-ending punctuation that is always unambiguous and never needs
// the tokenizer's disambiguation logic. Used for punctuation outside its rules.
export const UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION: ReadonlySet<string> = new Set(
  [...SENTENCE_ENDING_PUNCTUATION].filter((p) => !LATIN_SENTENCE_ENDING_PUNCTUATION.has(p)),
);

export type StartEndTags = readonly [string, string];

/**
 * Replace occurrences of a substring within a matched section of text.
 *
 * @param text The input text in which replacements will be made.
 * @param match A regex match representing the section of text to modify.
 * @param old The substring to be replaced.
 * @param replacement The substring to replace `old` with.
 * @returns The modified text with the specified replacements made within the matched section.
 */
export function replaceMatch(
  text: string,
  match: RegExpExecArray | RegExpMatchArray,
  old: string,
  replacement: string,
): string {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const replaced = text.slice(start, end).replaceAll(old, replacement);
  return text.slice(0, start) + replaced + text.slice(end);
}

/**
 * Find the position of the end of a sentence in the provided text.
 *
 * This function uses the sentence tokenizer to detect sentence boundaries in
 * the input text, combined with punctuation verification to ensure that
 * single tokens without proper sentence endings aren't considered complete
 * sentences.
 *
 * @param text The input text in which to find the end of the sentence.
 * @param options.language Language code. Defaults to English.
 * @returns The position of the end of the sentence if found, otherwise 0.
 */
export function matchEndofsentence(
  text: string,
  options: { language?: string | null } = {},
): number {
  const language = options.language ?? null;
  text = text.trimEnd();

  if (!text) {
    return 0;
  }

  let sentences = sentTokenizer(resolveSentenceTokenizerLanguage(language))(text);

  if (sentences.length === 0) {
    return 0;
  }

  let firstSentence = sentences[0] as string;

  let tokenizerText = text;
  // With an unfinished quote such as 'She said, "Dr. S', the segmenter can
  // split after '"Dr.'. Recheck a proposed split after a quoted word ending in
  // a period, letting the segmenter decide whether that word is an
  // abbreviation.
  const quote = sentences.length > 1 ? QUOTED_WORD_END.exec(firstSentence) : null;
  if (quote) {
    // Group 1 contains only the opening quote characters. Replace them with
    // equal-width spaces so the segmenter sees the abbreviation without the
    // quote. Boundary offsets still refer to the original text, which keeps
    // its quotes.
    const start = quote.index;
    const end = start + (quote[1] as string).length;
    tokenizerText = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
    sentences = sentTokenizer(resolveSentenceTokenizerLanguage(language))(tokenizerText);
    firstSentence = sentences[0] as string;
  }

  // A single span can be an incomplete fragment; require terminal punctuation.
  if (sentences.length === 1 && firstSentence === tokenizerText) {
    if (text && SENTENCE_ENDING_PUNCTUATION.has(text[text.length - 1] as string)) {
      return text.length;
    }
    // Additional punctuation can delimit sentences outside the selected rules.
    for (let i = 0; i < text.length; i++) {
      if (UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION.has(text[i] as string)) {
        return i + 1;
      }
    }
    return 0;
  }

  if (sentences.length > 1) {
    return firstSentence.length;
  }

  return 0;
}

function countOccurrences(text: string, sub: string): number {
  if (sub === "") return text.length + 1;
  let count = 0;
  let index = text.indexOf(sub);
  while (index !== -1) {
    count++;
    index = text.indexOf(sub, index + sub.length);
  }
  return count;
}

/**
 * Parse text to identify start and end tag pairs.
 *
 * If a start tag was previously found (i.e., currentTag is valid), wait for
 * the corresponding end tag. Otherwise, wait for a start tag.
 *
 * This function returns the index in the text where parsing should continue
 * in the next call and the current or new tags.
 *
 * @param text The text to be parsed.
 * @param tags List of tuples containing start and end tags.
 * @param currentTag The currently active tags, if any.
 * @param currentTagIndex The current index in the text.
 * @returns A tuple containing null or the current tag and the index of the text.
 */
export function parseStartEndTags(
  text: string,
  tags: readonly StartEndTags[],
  currentTag: StartEndTags | null,
  currentTagIndex: number,
): [StartEndTags | null, number] {
  // If we are already inside a tag, check if the end tag is in the text.
  if (currentTag) {
    const [, endTag] = currentTag;
    if (text.slice(currentTagIndex).includes(endTag)) {
      return [null, text.length];
    }
    return [currentTag, currentTagIndex];
  }

  // Check if any start tag appears in the text
  for (const [startTag, endTag] of tags) {
    const rest = text.slice(currentTagIndex);
    const startTagCount = countOccurrences(rest, startTag);
    const endTagCount = countOccurrences(rest, endTag);
    if (startTagCount === 0 && endTagCount === 0) {
      return [null, currentTagIndex];
    } else if (startTagCount > endTagCount) {
      return [[startTag, endTag], text.length];
    } else if (startTagCount === endTagCount) {
      return [null, text.length];
    }
  }

  return [null, currentTagIndex];
}

/**
 * Find the length of the longest suffix of text that is a proper prefix of a candidate.
 *
 * Used to detect a delimiter (e.g., an XML-style start tag) that has been
 * split across two text chunks: the trailing partial delimiter can be held
 * back from output until the next chunk completes it, rather than being
 * flushed as plain text and losing the delimiter.
 *
 * @param text The text to check for a trailing partial match.
 * @param candidates Full strings to match a proper prefix of against the end of text.
 * @returns The length of the longest matching suffix, or 0 if no candidate has a
 *   proper prefix matching the end of text.
 */
export function longestTrailingPartialMatch(text: string, candidates: readonly string[]): number {
  let longest = 0;
  for (const candidate of candidates) {
    const maxLen = Math.min(text.length, candidate.length - 1);
    for (let length = maxLen; length > longest; length--) {
      if (text.slice(text.length - length) === candidate.slice(0, length)) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export interface TextPartForConcatenationOptions {
  /** The text content. */
  text: string;
  /** Whether any necessary inter-frame (leading/trailing) spaces are already included in the text. */
  includesInterPartSpaces: boolean;
}

/**
 * Class representing a part of text for concatenation with `concatenateAggregatedText`.
 *
 * - `text`: The text content.
 * - `includesInterPartSpaces`: Whether any necessary inter-frame
 *   (leading/trailing) spaces are already included in the text.
 */
export class TextPartForConcatenation {
  text: string;
  includesInterPartSpaces: boolean;

  constructor(options: TextPartForConcatenationOptions) {
    this.text = options.text;
    this.includesInterPartSpaces = options.includesInterPartSpaces;
  }

  toString(): string {
    return `${this.constructor.name}(text: [${this.text}], includes_inter_part_spaces: ${this.includesInterPartSpaces ? "True" : "False"})`;
  }
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

/**
 * Concatenate a list of text parts into a single string.
 *
 * This function joins the provided list of text parts into a single string,
 * taking into account whether or not the parts already contain spacing.
 *
 * This function is useful for aggregating text segments received from LLMs or
 * transcription services.
 *
 * @param textParts A list of text parts to concatenate.
 * @returns A single concatenated string.
 */
export function concatenateAggregatedText(textParts: readonly TextPartForConcatenation[]): string {
  let result = "";
  let lastIncludesInterPartSpaces = false;

  if (textParts.length === 0) {
    return result;
  }

  const appendPart = (part: TextPartForConcatenation) => {
    result += part.text;
    lastIncludesInterPartSpaces = part.includesInterPartSpaces;
  };

  for (const part of textParts) {
    // Part is empty.
    // Skip.
    if (!part.text) {
      continue;
    }

    // Result is as yet empty.
    // Just append.
    if (!result) {
      appendPart(part);
      continue;
    }

    if (part.includesInterPartSpaces && lastIncludesInterPartSpaces) {
      // This part is part of an ongoing run that has spaces already included.
      // Just append.
      appendPart(part);
    } else if (!part.includesInterPartSpaces && !lastIncludesInterPartSpaces) {
      // This part is part of an ongoing run that has no spaces included.
      // Add a space before appending.
      result += " ";
      appendPart(part);
    } else {
      // This part represents a transition to a new run (spaces -> no spaces, or vice versa).
      // Add a space if needed, before appending.
      if (!isSpace(result[result.length - 1]) && !isSpace(part.text[0])) {
        result += " ";
      }
      appendPart(part);
    }
  }

  // NOTE: the above logic assumes that runs of text parts with
  // includesInterPartSpaces=true are well-formed, i.e. they're not
  // actually multiple separate runs with a space-less boundary, like
  // "hello ", "world.", "goodnight ", "moon."

  // Clean up any excessive whitespace
  result = result.trim();

  return result;
}
