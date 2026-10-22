// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Clause splitting the way eSpeak NG does it.
 *
 * `espeak_TextToPhonemesWithTerminator()` (what Piper calls) reports, for each
 * clause, the punctuation that ended it and whether it ended a sentence. The
 * WebAssembly build only exposes `espeak_TextToPhonemes()`, which reports
 * neither, so this module finds the clause boundaries itself, following
 * `ReadClause()` in espeak-ng's `readclause.c` for plain text:
 *
 * - A clause ends at `.`, `?`, `!`, `,`, `:`, `;`, an ellipsis (`…` or three
 *   or more dots), an en/em dash, and their CJK, Arabic, Greek and Devanagari
 *   counterparts, when followed by whitespace, a bracket or quote, or the end
 *   of the text. Full-width CJK marks, `…`, `¿` and `¡` need no space after.
 * - A run of `?`/`!` (and punctuation right after one) counts as one mark.
 * - A `.` followed by a lower-case word on the same line is an abbreviation,
 *   not a clause end; so is a mark before any letter or digit.
 * - A blank line ends a clause (a paragraph); a mark followed by a blank line
 *   is reported as a paragraph rather than as itself.
 *
 * Not modelled: SSML, per-language options (Hungarian ordinals, languages
 * whose sentences may start in lower case) and Armenian in-word punctuation.
 * espeak still splits over-long clauses itself; the caller joins those parts.
 */

/** Pause bits (x 10 ms). */
export const CLAUSE_PAUSE = 0x00000fff;
export const CLAUSE_INTONATION_TYPE = 0x00007000;
/** The mark needs no space after it (CJK full-width punctuation, `…`). */
export const CLAUSE_OPTIONAL_SPACE_AFTER = 0x00008000;
export const CLAUSE_TYPE = 0x000f0000;
export const CLAUSE_PUNCTUATION_IN_WORD = 0x00100000;
export const CLAUSE_SPEAK_PUNCTUATION_NAME = 0x00200000;
export const CLAUSE_DOT_AFTER_LAST_WORD = 0x00400000;
export const CLAUSE_PAUSE_LONG = 0x00800000;

export const CLAUSE_INTONATION_FULL_STOP = 0x00000000;
export const CLAUSE_INTONATION_COMMA = 0x00001000;
export const CLAUSE_INTONATION_QUESTION = 0x00002000;
export const CLAUSE_INTONATION_EXCLAMATION = 0x00003000;
export const CLAUSE_INTONATION_NONE = 0x00004000;

export const CLAUSE_TYPE_NONE = 0x00000000;
export const CLAUSE_TYPE_EOF = 0x00010000;
export const CLAUSE_TYPE_VOICE_CHANGE = 0x00020000;
export const CLAUSE_TYPE_CLAUSE = 0x00040000;
export const CLAUSE_TYPE_SENTENCE = 0x00080000;

export const CLAUSE_NONE = 0 | CLAUSE_INTONATION_NONE | CLAUSE_TYPE_NONE;
export const CLAUSE_PARAGRAPH = 70 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_SENTENCE;
export const CLAUSE_EOF = 40 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_SENTENCE | CLAUSE_TYPE_EOF;
export const CLAUSE_PERIOD = 40 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_SENTENCE;
export const CLAUSE_COMMA = 20 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE;
export const CLAUSE_QUESTION = 40 | CLAUSE_INTONATION_QUESTION | CLAUSE_TYPE_SENTENCE;
export const CLAUSE_EXCLAMATION = 45 | CLAUSE_INTONATION_EXCLAMATION | CLAUSE_TYPE_SENTENCE;
export const CLAUSE_COLON = 30 | CLAUSE_INTONATION_FULL_STOP | CLAUSE_TYPE_CLAUSE;
export const CLAUSE_SEMICOLON = 30 | CLAUSE_INTONATION_COMMA | CLAUSE_TYPE_CLAUSE;

const OPT = CLAUSE_OPTIONAL_SPACE_AFTER;

/** `clause_type_from_codepoint()` for the punctuation espeak-ng ends clauses on. */
const PUNCTUATION: ReadonlyMap<string, number> = new Map([
  [".", CLAUSE_PERIOD],
  ["?", CLAUSE_QUESTION],
  ["!", CLAUSE_EXCLAMATION],
  [",", CLAUSE_COMMA],
  [":", CLAUSE_COLON],
  [";", CLAUSE_SEMICOLON],
  // Ellipsis
  ["…", CLAUSE_SEMICOLON | CLAUSE_SPEAK_PUNCTUATION_NAME | OPT],
  // En and em dash (extended dash)
  ["–", CLAUSE_SEMICOLON],
  ["—", CLAUSE_SEMICOLON],
  // Inverted question and exclamation marks
  ["¿", CLAUSE_SEMICOLON | OPT],
  ["¡", CLAUSE_SEMICOLON | OPT],
  // Greek question mark
  [";", CLAUSE_QUESTION],
  // Arabic comma, semicolon, question mark
  ["،", CLAUSE_COMMA],
  ["؛", CLAUSE_SEMICOLON],
  ["؟", CLAUSE_QUESTION],
  // Devanagari danda
  ["।", CLAUSE_PERIOD | OPT],
  // CJK and full-width forms
  ["、", CLAUSE_COMMA | OPT],
  ["。", CLAUSE_PERIOD | OPT],
  ["！", CLAUSE_EXCLAMATION | OPT],
  ["，", CLAUSE_COMMA | OPT],
  ["．", CLAUSE_PERIOD | OPT],
  ["：", CLAUSE_COLON | OPT],
  ["；", CLAUSE_SEMICOLON | OPT],
  ["？", CLAUSE_QUESTION | OPT],
  ["｡", CLAUSE_PERIOD],
]);

/** espeak-ng's `IsBracket()`: brackets and quotes. */
const BRACKETS = new Set(["(", ")", "[", "]", "{", "}", "<", ">", '"', "'", "`", "«", "»"]);
BRACKETS.add("《").add("》");
for (let c = 0x2018; c <= 0x201f; c++) BRACKETS.add(String.fromCharCode(c));

const ALNUM = /[\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const SPACE = /\s/u;

function clauseType(c: string | undefined): number {
  return c === undefined ? CLAUSE_NONE : (PUNCTUATION.get(c) ?? CLAUSE_NONE);
}

function isSpace(c: string | undefined): boolean {
  return c !== undefined && SPACE.test(c);
}

/** A clause of text and how espeak-ng would report its end. */
export interface TextClause {
  /** The clause's text, including the punctuation that ends it. */
  text: string;
  /** espeak-ng's clause value: one of the `CLAUSE_*` constants, plus flags. */
  terminator: number;
}

/**
 * Split `text` into clauses where espeak-ng's `ReadClause()` would.
 *
 * The last clause, which ends at the end of the text, is reported as
 * `CLAUSE_EOF`. Clauses that are only whitespace are dropped.
 */
export function splitClauses(text: string): TextClause[] {
  const cps = Array.from(text);
  const n = cps.length;
  const clauses: TextClause[] = [];
  let start = 0;
  let anyAlnum = false;

  const emit = (end: number, terminator: number) => {
    const piece = cps.slice(start, end + 1).join("");
    if (piece.trim()) clauses.push({ text: piece, terminator });
  };

  let i = 0;
  while (i < n) {
    const c1 = cps[i] as string;

    if (c1 === "\n") {
      // A second newline (ignoring other whitespace) is a paragraph break.
      let j = i + 1;
      let parag = 0;
      while (j < n && isSpace(cps[j])) {
        if (cps[j] === "\n") parag++;
        j++;
      }
      if (parag > 0) {
        emit(i - 1, CLAUSE_PARAGRAPH - 30 + 30 * Math.min(parag, 3));
        start = j;
        anyAlnum = false;
        i = j;
        continue;
      }
      i++;
      continue;
    }

    if (ALNUM.test(c1)) anyAlnum = true;

    let mark = c1;
    let end = i;
    if (c1 === "." && cps[i + 1] === ".") {
      // Three or more dots are an ellipsis.
      let run = 1;
      while (cps[i + run] === ".") run++;
      if (run >= 3) {
        mark = "…";
        end = i + run - 1;
      }
    }

    let punct = clauseType(mark);
    if (punct !== CLAUSE_NONE && !(punct & CLAUSE_PUNCTUATION_IN_WORD)) {
      // A run like "?!?" is decided by its first mark.
      if (punct & (CLAUSE_QUESTION | CLAUSE_EXCLAMATION)) {
        while (end + 1 < n && clauseType(cps[end + 1]) & (CLAUSE_QUESTION | CLAUSE_EXCLAMATION)) {
          end++;
        }
      }
      const c2 = cps[end + 1];
      let isEnd =
        isSpace(c2) ||
        (punct & CLAUSE_OPTIONAL_SPACE_AFTER) !== 0 ||
        (c2 !== undefined && BRACKETS.has(c2)) ||
        c2 === "?" ||
        c2 === undefined;

      if (isEnd) {
        let k = end + 1;
        let nlCount = 0;
        while (k < n && isSpace(cps[k])) {
          if (cps[k] === "\n") nlCount++;
          k++;
        }
        const cNext = cps[k];

        if (nlCount === 0) {
          if (mark === "." && cNext === "'" && cps[k + 1] === "s") {
            // An acronym with a genitive, e.g. "U.S.A.'s".
            isEnd = false;
          }
          if (mark === ".") {
            // A lower-case word next: the dot is probably an abbreviation's.
            if (cNext !== undefined && LOWER.test(cNext)) isEnd = false;
            if (!anyAlnum) isEnd = false;
          } else if (!anyAlnum) {
            isEnd = false;
          }
        }

        if (isEnd) {
          if (nlCount > 1) {
            punct =
              punct === CLAUSE_QUESTION || punct === CLAUSE_EXCLAMATION
                ? punct + 35
                : CLAUSE_PARAGRAPH;
          }
          emit(end, punct);
          start = k;
          anyAlnum = false;
          i = k;
          continue;
        }
      }
      i = end + 1;
      continue;
    }
    i++;
  }

  if (start < n) emit(n - 1, CLAUSE_EOF);
  return clauses;
}

/**
 * The punctuation Piper's `espeakbridge` writes for a clause value, or `""`.
 *
 * It compares the value without its pause and "speak the name" flags, so a
 * mark that needs no space after it (CJK) or a paragraph break gives `""`.
 */
export function terminatorPunctuation(terminator: number): string {
  const t = terminator & 0x000fffff;
  if (t === CLAUSE_PERIOD) return ".";
  if (t === CLAUSE_QUESTION) return "?";
  if (t === CLAUSE_EXCLAMATION) return "!";
  if (t === CLAUSE_COMMA) return ",";
  if (t === CLAUSE_COLON) return ":";
  if (t === CLAUSE_SEMICOLON) return ";";
  return "";
}

/** Whether a clause value ends a sentence (`CLAUSE_TYPE_SENTENCE`). */
export function isEndOfSentence(terminator: number): boolean {
  return (terminator & CLAUSE_TYPE_SENTENCE) === CLAUSE_TYPE_SENTENCE;
}
