// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * eSpeak NG phonemization for pipedog's local TTS models (Kokoro, Piper).
 *
 * eSpeak NG runs as WebAssembly from the optional peer dependency
 * `@echogarden/espeak-ng-emscripten` (GPL-3.0), loaded on first use. Two
 * front ends reproduce what the Python TTS stacks do with espeak-ng:
 *
 * - `phonemize()`: Python `phonemizer`'s espeak backend (kokoro-onnx).
 * - `EspeakNG.textToPhonemesWithTerminator()`: per-clause phonemes with their
 *   ending punctuation, as Piper's `espeakbridge` gets them.
 *
 * @example
 * ```ts
 * import { phonemize } from "@pipedog/espeak-ng";
 * await phonemize("Hello world!", "en-us", { preservePunctuation: true, withStress: true });
 * // "həlˈoʊ wˈɜːld! "
 * ```
 */

import { getEspeakNG } from "./espeak.ts";
import { type PhonemizeOptions, phonemizeWith } from "./phonemizer.ts";

export * from "./clause.ts";
export * from "./espeak.ts";
export * from "./phonemizer.ts";

/**
 * Phonemize `text` like Python's `phonemizer.phonemize(text, language,
 * backend="espeak", ...)`, on the shared eSpeak NG instance.
 */
export async function phonemize(
  text: string,
  language: string,
  options: PhonemizeOptions = {},
): Promise<string> {
  return phonemizeWith(await getEspeakNG(), text, language, options);
}
