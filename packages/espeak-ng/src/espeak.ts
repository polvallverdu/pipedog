// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * eSpeak NG compiled to WebAssembly (`@echogarden/espeak-ng-emscripten`).
 *
 * The Emscripten build is an optional peer dependency (GPL-3.0, about 25 MB
 * with its voice data), imported on first use through a computed specifier so
 * bundlers leave it alone and importing this module costs nothing. One module
 * instance is shared by the whole process: espeak-ng keeps global state, and
 * its data takes ~24 MB of WebAssembly memory.
 *
 * espeak-ng is not reentrant, but every call here is synchronous, so in JS no
 * two phonemizations can interleave (no lock needed, unlike the Python
 * wrappers, which lock around their threads).
 */

import { isEndOfSentence, splitClauses, type TextClause, terminatorPunctuation } from "./clause.ts";

// Held in a variable so bundlers leave the import alone (optional peer).
const ESPEAK_NG_EMSCRIPTEN = "@echogarden/espeak-ng-emscripten";

/** The part of the Emscripten module we use. */
interface EmscriptenModule {
  eSpeakNGWorker: new () => EmscriptenWorker;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _free(ptr: number): void;
}

interface EmscriptenVoice {
  ptr: number;
  get_name(): string;
  get_identifier(): string;
  get_gender(): number;
  get_age(): number;
}

interface EmscriptenWorker {
  set_voice(name: string): number;
  text_to_phonemes(text: string, useIpa: number): { ptr: number };
  get_voices(index: number): EmscriptenVoice;
}

/** A factory returning the initialized Emscripten module (the package's default export). */
export type EspeakModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

/** One language a voice speaks, with espeak-ng's priority (lower is preferred). */
export interface EspeakVoiceLanguage {
  priority: number;
  language: string;
}

/** An espeak-ng voice. */
export interface EspeakVoice {
  /** Display name, e.g. `English (America)`. */
  name: string;
  /** Voice file relative to the data directory, e.g. `gmw/en-US`. */
  identifier: string;
  /** Languages, most specific first, e.g. `en-us` then `en`. */
  languages: EspeakVoiceLanguage[];
  gender: number;
  age: number;
}

/** A clause's phonemes and the punctuation that ended it. */
export interface ClausePhonemes {
  /** IPA phonemes of the clause, words separated by spaces. */
  phonemes: string;
  /** The ending punctuation as Piper writes it (`.`, `?`, `!`, `,`, `:`, `;`) or `""`. */
  punctuation: string;
  /** espeak-ng's clause value (`CLAUSE_*` from `clause.ts`). */
  terminator: number;
  /** Whether the clause ends a sentence. */
  endOfSentence: boolean;
}

export interface TextToPhonemesOptions {
  /** IPA (default) or espeak's ASCII phoneme mnemonics. */
  ipa?: boolean;
  /**
   * Separator between the phonemes of a word (default `""`). espeak writes
   * `_`; it is replaced by this.
   */
  phonemeSeparator?: string;
}

const decoder = new TextDecoder();

/**
 * eSpeak NG: voices and text-to-phoneme conversion.
 *
 * Create one with `getEspeakNG()` (shared) or `loadEspeakNG()`.
 */
export class EspeakNG {
  readonly #module: EmscriptenModule;
  readonly #worker: EmscriptenWorker;
  #voices: EspeakVoice[] | null = null;
  #currentVoice: string | null = null;

  /** Wrap an initialized `@echogarden/espeak-ng-emscripten` module. */
  constructor(module: unknown) {
    this.#module = module as EmscriptenModule;
    this.#worker = new this.#module.eSpeakNGWorker();
  }

  #cString(ptr: number): string {
    const heap = this.#module.HEAPU8;
    let end = ptr;
    while (heap[end] !== 0) end++;
    return decoder.decode(heap.subarray(ptr, end));
  }

  /** Every voice in the data, in espeak-ng's order (`espeak_ListVoices`). */
  get voices(): readonly EspeakVoice[] {
    if (this.#voices) return this.#voices;
    const voices: EspeakVoice[] = [];
    const heap8 = this.#module.HEAPU8;
    for (let i = 0; ; i++) {
      const v = this.#worker.get_voices(i);
      if (!v || v.ptr === 0) break;
      // espeak_VOICE is { name, languages, identifier, ... }; `languages` is a
      // run of <priority byte><language>\0 entries ending with a zero byte.
      let p = this.#module.HEAPU32[(v.ptr + 4) >> 2] as number;
      const languages: EspeakVoiceLanguage[] = [];
      while (p && heap8[p] !== 0) {
        const priority = heap8[p] as number;
        let end = p + 1;
        while (heap8[end] !== 0) end++;
        languages.push({ priority, language: decoder.decode(heap8.subarray(p + 1, end)) });
        p = end + 1;
      }
      voices.push({
        name: v.get_name(),
        identifier: v.get_identifier(),
        languages,
        gender: v.get_gender(),
        age: v.get_age(),
      });
    }
    this.#voices = voices;
    return voices;
  }

  /**
   * The voice for a language code, as Python's `phonemizer` picks it: the
   * first voice whose main (first) language is `language`, skipping mbrola
   * voices. So `en-us` is `gmw/en-US`, `fr-fr` is `roa/fr` and `cmn` is
   * `sit/cmn`, while bare `fr` has no voice.
   */
  voiceForLanguage(language: string): EspeakVoice | null {
    const code = language.toLowerCase();
    for (const voice of this.voices) {
      if (voice.identifier.replace(/\\/g, "/").startsWith("mb/")) continue;
      if (voice.languages[0]?.language === code) return voice;
    }
    return null;
  }

  /** The language codes `voiceForLanguage()` accepts (`phonemizer`'s supported languages). */
  supportedLanguages(): string[] {
    const out = new Set<string>();
    for (const voice of this.voices) {
      const first = voice.languages[0]?.language;
      if (first) out.add(first);
    }
    return [...out];
  }

  /**
   * Select a voice (`espeak_SetVoiceByName`).
   *
   * @param voice A voice name or file (`en-us`, `gmw/en-US`, `fr`), or with
   *   `by: "language"` a language code resolved like `voiceForLanguage()`.
   * @param options.by `name` (default) tries the name first and falls back to
   *   the language lists; `language` resolves the language code only.
   * @throws If no such voice exists.
   */
  setVoice(voice: string, options: { by?: "name" | "language" } = {}): void {
    const key = `${options.by ?? "name"}:${voice}`;
    if (this.#currentVoice === key) return;
    if (options.by === "language") {
      const found = this.voiceForLanguage(voice);
      if (!found) throw new Error(`language "${voice}" is not supported by the espeak backend`);
      if (this.#worker.set_voice(found.identifier) !== 0) {
        throw new Error(`failed to load voice "${voice}"`);
      }
    } else if (this.#worker.set_voice(voice) !== 0) {
      // Not a voice name or file; take the best voice listing it as a language.
      const code = voice.toLowerCase();
      let best: { identifier: string; priority: number } | null = null;
      for (const v of this.voices) {
        if (v.identifier.startsWith("mb/")) continue;
        for (const l of v.languages) {
          if (l.language === code && (!best || l.priority < best.priority)) {
            best = { identifier: v.identifier, priority: l.priority };
          }
        }
      }
      if (!best || this.#worker.set_voice(best.identifier) !== 0) {
        this.#currentVoice = null;
        throw new Error(`Failed to set voice: ${voice}`);
      }
    }
    this.#currentVoice = key;
  }

  /**
   * Phonemes of `text` for the current voice, one string per clause, as
   * `espeak_TextToPhonemes()` returns them (punctuation is dropped; words are
   * separated by spaces; language switches appear as `(en)` flags).
   */
  textToPhonemes(text: string, options: TextToPhonemesOptions = {}): string[] {
    const raw = this.#rawTextToPhonemes(text, options.ipa ?? true);
    const sep = options.phonemeSeparator ?? "";
    return raw.map((clause) => (sep === "_" ? clause : clause.replaceAll("_", sep)));
  }

  /**
   * `espeak_TextToPhonemes()` with espeak's `_` phoneme separator, split into
   * clauses. Empty clauses are dropped.
   */
  #rawTextToPhonemes(text: string, ipa: boolean): string[] {
    const result = this.#worker.text_to_phonemes(text, ipa ? 1 : 0);
    const ptr = result.ptr;
    let s: string;
    try {
      s = this.#cString(ptr);
    } finally {
      // The glue returns a heap copy of the result.
      this.#module._free(ptr);
    }
    // The glue joins the clauses with " | ".
    return s.split(" | ").filter((clause) => clause.length > 0);
  }

  /**
   * Phonemes of `text` per clause, with the punctuation that ended each one:
   * what Piper gets from `espeak_TextToPhonemesWithTerminator()` (IPA, no
   * phoneme separator).
   *
   * The WebAssembly build has no terminator API, so the clauses are found by
   * `splitClauses()` and each is phonemized on its own. If espeak splits a
   * clause further (very long clauses), its parts are joined with a space.
   */
  textToPhonemesWithTerminator(text: string): ClausePhonemes[] {
    return splitClauses(text).map((clause: TextClause) => {
      const phonemes = this.#rawTextToPhonemes(clause.text, true)
        .map((part) => part.replaceAll("_", ""))
        .join(" ");
      return {
        phonemes,
        punctuation: terminatorPunctuation(clause.terminator),
        terminator: clause.terminator,
        endOfSentence: isEndOfSentence(clause.terminator),
      };
    });
  }
}

export interface LoadEspeakNGOptions {
  /**
   * The `@echogarden/espeak-ng-emscripten` module factory (its default
   * export), if already imported; else it is imported.
   */
  factory?: EspeakModuleFactory;
}

/** Import `@echogarden/espeak-ng-emscripten`, or throw a helpful error if it is not installed. */
export async function importEspeakNGFactory(): Promise<EspeakModuleFactory> {
  try {
    const mod = (await import(ESPEAK_NG_EMSCRIPTEN)) as { default: EspeakModuleFactory };
    return mod.default;
  } catch (e) {
    throw new Error(
      `@echogarden/espeak-ng-emscripten is not installed (${e instanceof Error ? e.message : String(e)}); ` +
        "add it with `bun add @echogarden/espeak-ng-emscripten` / `npm i @echogarden/espeak-ng-emscripten` " +
        "(GPL-3.0, eSpeak NG compiled to WebAssembly)",
    );
  }
}

/** Load a new eSpeak NG instance (a separate WebAssembly module and ~24 MB of data). */
export async function loadEspeakNG(options: LoadEspeakNGOptions = {}): Promise<EspeakNG> {
  const factory = options.factory ?? (await importEspeakNGFactory());
  return new EspeakNG(await factory());
}

let shared: Promise<EspeakNG> | null = null;

/**
 * The process-wide eSpeak NG instance, loaded on first use. A failed load is
 * not cached, so the next call retries.
 */
export function getEspeakNG(): Promise<EspeakNG> {
  if (!shared) {
    const loading = loadEspeakNG();
    shared = loading;
    loading.catch(() => {
      if (shared === loading) shared = null;
    });
  }
  return shared;
}
