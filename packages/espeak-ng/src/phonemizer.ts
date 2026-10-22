// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `phonemizer.phonemize(..., backend="espeak")` (Python `phonemizer` 3.4.0),
 * on the WebAssembly eSpeak NG.
 *
 * This is the phonemization kokoro-onnx (and many other TTS stacks) use:
 * punctuation is cut out of the text, the pieces are phonemized one by one,
 * then the punctuation is put back; each word's phonemes are joined with the
 * phone separator and words with the word separator. The same steps are
 * reproduced here, in the same order, so the output matches the Python
 * library's for the same espeak-ng data.
 *
 * Supported options are those of the espeak backend except `tie`, `njobs`,
 * `prepend_text`, `words_mismatch` (always "ignore") and the
 * "remove-utterance" language-switch policy.
 */

import type { EspeakNG } from "./espeak.ts";

/** Separators between phonemes and words (`phonemizer.separator.Separator`). */
export interface Separator {
  /** Between the phonemes of a word (default `""`). */
  phone?: string;
  /** Between words (default `" "`). */
  word?: string;
}

/** The punctuation marks phonemizer considers by default. */
export const DEFAULT_PUNCTUATION_MARKS = ';:,.!?¡¿—…"«»“”(){}[]';

/** Marks that are also decimal separators, kept when between two digits. */
const DECIMAL_SEPARATORS = ",.";

export interface PhonemizeOptions {
  /** Keep punctuation in the output (default `false`). */
  preservePunctuation?: boolean;
  /** Keep the stress marks `ˈ` and `ˌ` (default `false`). */
  withStress?: boolean;
  /** The punctuation marks to handle (default `DEFAULT_PUNCTUATION_MARKS`). */
  punctuationMarks?: string | RegExp;
  /** Separators (default: no phone separator, words separated by a space). */
  separator?: Separator;
  /** Drop the trailing separators of each line (default `false`). */
  strip?: boolean;
  /** Keep empty lines in the output (default `false`). */
  preserveEmptyLines?: boolean;
  /**
   * What to do with espeak's language-switch flags, e.g. `(en)` around an
   * English word in French: `keep-flags` (default) or `remove-flags`.
   */
  languageSwitch?: "keep-flags" | "remove-flags";
}

interface MarkIndex {
  index: number;
  mark: string;
  position: "B" | "E" | "I" | "A";
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}

/** The regex matching a run of punctuation marks with the spaces around it. */
function marksRegex(marks: string | RegExp): RegExp {
  if (marks instanceof RegExp) {
    return new RegExp(`((${marks.source})|\\s)+`, "gu");
  }
  const unique = [...new Set(Array.from(marks))];
  const decimals = unique.filter((m) => DECIMAL_SEPARATORS.includes(m)).join("");
  const others = unique.filter((m) => !DECIMAL_SEPARATORS.includes(m)).join("");
  const alternatives: string[] = [];
  if (others) alternatives.push(`[${escapeClass(others)}]`);
  if (decimals) {
    // A decimal separator between two digits is part of a number ("19,99").
    const escaped = escapeClass(decimals);
    alternatives.push(`(?<![0-9])[${escaped}]`);
    alternatives.push(`[${escaped}](?![0-9])`);
  }
  return new RegExp(`(\\s*(?:${alternatives.join("|")})+\\s*)+`, "gu");
}

/** Python `str.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start] as string)) start++;
  while (end > start && chars.includes(s[end - 1] as string)) end--;
  return s.slice(start, end);
}

/** `Punctuation._preserve_line`. */
function preserveLine(line: string, num: number, re: RegExp): [string[], MarkIndex[]] {
  const matches = [...line.matchAll(re)].map((m) => m[0]);
  if (matches.length === 0) return [[line], []];

  // The line is made only of punctuation marks.
  if (matches.length === 1 && matches[0] === line) {
    return [[], [{ index: num, mark: line, position: "A" }]];
  }

  const marks: MarkIndex[] = matches.map((match, i) => {
    let position: MarkIndex["position"] = "I";
    if (i === 0 && line.startsWith(match)) position = "B";
    else if (i === matches.length - 1 && line.endsWith(match)) position = "E";
    return { index: num, mark: match, position };
  });

  // Split the line into sublines, each separated by a punctuation mark.
  const preserved: string[] = [];
  let rest = line;
  for (const mark of marks) {
    const at = rest.indexOf(mark.mark);
    preserved.push(at < 0 ? rest : rest.slice(0, at));
    rest = at < 0 ? "" : rest.slice(at + mark.mark.length);
  }
  return [[...preserved, rest], marks];
}

/** `Punctuation.restore`. */
function restore(
  text: string[],
  marks: MarkIndex[],
  sep: Required<Separator>,
  strip: boolean,
): string[] {
  text = [...text];
  marks = [...marks];
  const out: string[] = [];
  let pos = 0;
  while (text.length > 0 || marks.length > 0) {
    if (marks.length === 0) {
      for (let line of text) {
        if (!strip && sep.word && !line.endsWith(sep.word)) line = line + sep.word;
        out.push(line);
      }
      text = [];
    } else if (text.length === 0) {
      // Nothing was phonemized: return the marks alone.
      out.push(
        marks
          .map((m) => m.mark)
          .join("")
          .replaceAll(" ", sep.word),
      );
      marks = [];
    } else {
      const current = marks[0] as MarkIndex;
      if (current.index === pos) {
        marks = marks.slice(1);
        const mark = current.mark.replaceAll(" ", sep.word);
        if (sep.word && (text[0] as string).endsWith(sep.word)) {
          text[0] = (text[0] as string).slice(0, -sep.word.length);
        }
        if (current.position === "B") {
          text[0] = mark + text[0];
        } else if (current.position === "E") {
          out.push(text[0] + mark + (strip || mark.endsWith(sep.word) ? "" : sep.word));
          text = text.slice(1);
          pos += 1;
        } else if (current.position === "A") {
          out.push(mark + (strip || mark.endsWith(sep.word) ? "" : sep.word));
          pos += 1;
        } else if (text.length === 1) {
          // The final part of an intermediate mark was not phonemized.
          text[0] = text[0] + mark;
        } else {
          const first = text[0] as string;
          text = text.slice(1);
          text[0] = first + mark + text[0];
        }
      } else {
        out.push(text[0] as string);
        text = text.slice(1);
        pos += 1;
      }
    }
  }
  return out;
}

const STRESS_RE = /[ˈˌ'-]+/g;
const FLAGS_RE = /\(.+?\)/g;

/** `EspeakBackend._postprocess_line`. */
function postprocessLine(
  line: string,
  sep: Required<Separator>,
  strip: boolean,
  withStress: boolean,
  languageSwitch: "keep-flags" | "remove-flags",
): string {
  line = line.trim().replaceAll("\n", " ").replaceAll("  ", " ");
  line = line.replace(/_+/g, "_");
  line = line.replaceAll("_ ", " ");
  if (languageSwitch === "remove-flags") line = line.replace(FLAGS_RE, "");
  if (!line) return "";
  let out = "";
  for (let word of line.split(" ")) {
    word = word.trim();
    if (!withStress) word = word.replace(STRESS_RE, "");
    if (!strip) word += "_";
    word = word.replaceAll("_", sep.phone);
    out += word + sep.word;
  }
  if (strip && sep.word) out = out.slice(0, -sep.word.length);
  return out;
}

/**
 * Phonemize `text` in `language` like Python's `phonemizer.phonemize()` with
 * the espeak backend.
 *
 * @param espeak The eSpeak NG instance (`await getEspeakNG()`).
 * @param text The text; lines are phonemized separately and joined with `\n`.
 * @param language An espeak language code such as `en-us`, `fr-fr` or `cmn`
 *   (see `EspeakNG.supportedLanguages()`).
 * @throws If `language` has no espeak voice.
 */
export function phonemizeWith(
  espeak: EspeakNG,
  text: string,
  language: string,
  options: PhonemizeOptions = {},
): string {
  const sep: Required<Separator> = {
    phone: options.separator?.phone ?? "",
    word: options.separator?.word ?? " ",
  };
  const strip = options.strip ?? false;
  const withStress = options.withStress ?? false;
  const languageSwitch = options.languageSwitch ?? "keep-flags";
  const re = marksRegex(options.punctuationMarks ?? DEFAULT_PUNCTUATION_MARKS);

  espeak.setVoice(language, { by: "language" });

  // _phonemize: one utterance per line, empty lines dropped.
  let lines = stripChars(text, "\n")
    .split("\n")
    .map((line) => stripChars(line, "\n"));
  const emptyLines = options.preserveEmptyLines
    ? lines.flatMap((line, n) => (line.trim() ? [] : [n]))
    : [];
  lines = lines.filter((line) => line.trim());

  let phonemized: string[] = [];
  if (lines.length > 0) {
    // _phonemize_preprocess: cut the punctuation out (to restore it later).
    let pieces: string[];
    const marks: MarkIndex[] = [];
    if (options.preservePunctuation) {
      pieces = [];
      lines.forEach((line, num) => {
        const [preserved, lineMarks] = preserveLine(line, num, re);
        pieces.push(...preserved);
        marks.push(...lineMarks);
      });
      pieces = pieces.filter((piece) => piece);
    } else {
      pieces = lines.map((line) => line.replace(re, " ").trim());
    }

    // _phonemize_aux: espeak on each piece, its clauses joined by a space.
    const out = pieces.map((piece) =>
      postprocessLine(
        espeak.textToPhonemes(piece, { phonemeSeparator: "_" }).join(" "),
        sep,
        strip,
        withStress,
        languageSwitch,
      ),
    );

    phonemized = options.preservePunctuation ? restore(out, marks, sep, strip) : out;
  }

  for (const n of emptyLines) phonemized.splice(n, 0, "");
  return phonemized.join("\n");
}
