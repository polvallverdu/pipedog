// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Backchannel detection for user turn start strategies: "mm-hm", "yes, okay",
 * "right" and the like, which acknowledge the bot rather than take the turn.
 *
 * pipedog-only (upstream Pipecat has no equivalent).
 */

import type { Language } from "../../transcriptions/language.ts";

/** Decides whether a transcript is a backchannel. */
export type BackchannelMatcher = (text: string, language: Language | null) => boolean;

/**
 * Default backchannel phrases by base language code. A transcript is a
 * backchannel when it is made only of these phrases ("yes okay", "mm-hm
 * right"). Words that usually carry a request ("no", "wait", "stop") are left
 * out on purpose.
 */
export const BACKCHANNEL_PHRASES: Readonly<Record<string, readonly string[]>> = {
  en: [
    "yes",
    "yeah",
    "yep",
    "yup",
    "ok",
    "okay",
    "right",
    "alright",
    "all right",
    "sure",
    "uh huh",
    "mhm",
    "mm",
    "mm hm",
    "mm hmm",
    "hmm",
    "hm",
    "uh",
    "um",
    "ah",
    "oh",
    "i see",
    "got it",
    "cool",
    "great",
    "fine",
    "good",
    "exactly",
    "totally",
    "true",
  ],
  es: [
    "sí",
    "si",
    "vale",
    "ok",
    "okay",
    "claro",
    "ajá",
    "aja",
    "ah",
    "eh",
    "mm",
    "mhm",
    "bueno",
    "de acuerdo",
    "entiendo",
    "ya",
    "exacto",
    "perfecto",
    "bien",
    "muy bien",
    "vale vale",
  ],
  fr: [
    "oui",
    "ouais",
    "ok",
    "d'accord",
    "dac",
    "ah",
    "euh",
    "mm",
    "mhm",
    "bien sûr",
    "je vois",
    "exactement",
    "parfait",
    "voilà",
    "bon",
    "très bien",
  ],
  de: [
    "ja",
    "jo",
    "ok",
    "okay",
    "genau",
    "klar",
    "aha",
    "ah",
    "mm",
    "mhm",
    "stimmt",
    "gut",
    "alles klar",
    "verstehe",
    "ich verstehe",
    "richtig",
    "super",
  ],
  it: [
    "sì",
    "si",
    "ok",
    "okay",
    "certo",
    "va bene",
    "ah",
    "eh",
    "mm",
    "mhm",
    "capito",
    "esatto",
    "perfetto",
    "giusto",
    "bene",
  ],
  pt: [
    "sim",
    "tá",
    "ta",
    "ok",
    "okay",
    "claro",
    "certo",
    "ah",
    "eh",
    "mm",
    "mhm",
    "entendi",
    "exato",
    "perfeito",
    "beleza",
    "tá bom",
    "ta bom",
    "uhum",
  ],
  ca: [
    "sí",
    "si",
    "vale",
    "d'acord",
    "ok",
    "okay",
    "clar",
    "ah",
    "eh",
    "mm",
    "mhm",
    "entesos",
    "exacte",
    "perfecte",
    "molt bé",
    "bé",
  ],
};

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[-‐‑–—]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Build a `BackchannelMatcher` from phrases by base language code (default
 * `BACKCHANNEL_PHRASES`). The transcript's language picks the list; with no
 * language, or one not in `phrases`, every list is tried.
 *
 * @example
 * const isBackchannel = createBackchannelMatcher({
 *   ...BACKCHANNEL_PHRASES,
 *   en: [...BACKCHANNEL_PHRASES.en, "gotcha"],
 * });
 */
export function createBackchannelMatcher(
  phrases: Readonly<Record<string, readonly string[]>> = BACKCHANNEL_PHRASES,
): BackchannelMatcher {
  const tables = new Map<string, Set<string>>();
  for (const [lang, list] of Object.entries(phrases)) {
    tables.set(lang, new Set(list.map((p) => normalize(p).join(" "))));
  }
  const all = new Set([...tables.values()].flatMap((t) => [...t]));
  const maxPhraseWords = Math.max(1, ...[...all].map((p) => p.split(" ").length));

  return (text, language) => {
    const table = (language && tables.get(language.split("-")[0] ?? "")) || all;
    const words = normalize(text);
    if (words.length === 0) return false;
    // Can words[0..n) be split into known phrases?
    const ok: boolean[] = [true];
    for (let end = 1; end <= words.length; end++) {
      ok[end] = false;
      for (let len = 1; len <= Math.min(maxPhraseWords, end); len++) {
        if (ok[end - len] && table.has(words.slice(end - len, end).join(" "))) {
          ok[end] = true;
          break;
        }
      }
    }
    return ok[words.length] === true;
  };
}
