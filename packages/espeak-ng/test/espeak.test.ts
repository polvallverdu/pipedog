// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import {
  CLAUSE_COMMA,
  CLAUSE_EOF,
  CLAUSE_PARAGRAPH,
  CLAUSE_PERIOD,
  CLAUSE_QUESTION,
  getEspeakNG,
  loadEspeakNG,
  phonemize,
  splitClauses,
  terminatorPunctuation,
} from "../src/index.ts";

describe("EspeakNG", () => {
  test("one shared instance", async () => {
    expect(await getEspeakNG()).toBe(await getEspeakNG());
  });

  test("lists voices with their languages", async () => {
    const espeak = await getEspeakNG();
    const us = espeak.voices.find((v) => v.identifier === "gmw/en-US");
    expect(us?.name).toBe("English (America)");
    expect(us?.languages.map((l) => l.language)).toEqual(["en-us", "en"]);
  });

  test("resolves language codes like phonemizer", async () => {
    const espeak = await getEspeakNG();
    // Every code Kokoro's language map produces has a voice...
    const codes: Record<string, string> = {
      "en-us": "gmw/en-US",
      "en-gb": "gmw/en",
      es: "roa/es",
      "fr-fr": "roa/fr",
      "fr-be": "roa/fr-BE",
      "fr-ch": "roa/fr-CH",
      hi: "inc/hi",
      it: "roa/it",
      ja: "jpx/ja",
      pt: "roa/pt",
      "pt-br": "roa/pt-BR",
      cmn: "sit/cmn",
      yue: "sit/yue",
    };
    for (const [code, identifier] of Object.entries(codes)) {
      expect(espeak.voiceForLanguage(code)?.identifier).toBe(identifier);
    }
    // ...but bare "fr" and "zh" are not a voice's main language.
    expect(espeak.voiceForLanguage("fr")).toBeNull();
    expect(espeak.voiceForLanguage("zh")).toBeNull();
    expect(espeak.supportedLanguages()).toContain("en-us");
  });

  test("setVoice by name falls back to the language lists", async () => {
    const espeak = await getEspeakNG();
    espeak.setVoice("en-gb"); // no voice file is called en-gb
    expect(espeak.textToPhonemes("tomato").join(" ")).toContain("ɑː");
    espeak.setVoice("en-us");
    expect(espeak.textToPhonemes("tomato").join(" ")).toContain("eɪ");
    expect(() => espeak.setVoice("xx-nope")).toThrow("Failed to set voice: xx-nope");
    expect(() => espeak.setVoice("xx-nope", { by: "language" })).toThrow(
      'language "xx-nope" is not supported by the espeak backend',
    );
  });

  test("textToPhonemes returns one string per clause", async () => {
    const espeak = await getEspeakNG();
    espeak.setVoice("en-us");
    expect(espeak.textToPhonemes("Hello world. How are you?")).toEqual([
      "həlˈoʊ wˈɜːld",
      "hˈaʊ ɑːɹ juː",
    ]);
    expect(espeak.textToPhonemes("Hello", { phonemeSeparator: "_" })).toEqual(["h_ə_l_ˈoʊ"]);
  });

  test("a separate instance can be loaded", async () => {
    const other = await loadEspeakNG();
    expect(other).not.toBe(await getEspeakNG());
    other.setVoice("es");
    expect(other.textToPhonemes("hola")).toEqual(["ˈola"]);
  });
});

describe("phonemize", () => {
  test("strips stress and punctuation by default", async () => {
    expect(await phonemize("Hello, world!", "en-us")).toBe("həloʊ wɜːld ");
  });

  test("keeps them on request", async () => {
    expect(
      await phonemize("Hello, world!", "en-us", { preservePunctuation: true, withStress: true }),
    ).toBe("həlˈoʊ, wˈɜːld! ");
  });

  test("separators and strip", async () => {
    expect(
      await phonemize("Hello world", "en-us", {
        separator: { phone: "-", word: "|" },
        strip: true,
      }),
    ).toBe("h-ə-l-oʊ|w-ɜː-l-d");
  });

  test("language switch flags", async () => {
    const text = "J'aime le football.";
    expect(await phonemize(text, "fr-fr")).toContain("(en)");
    expect(await phonemize(text, "fr-fr", { languageSwitch: "remove-flags" })).not.toContain(
      "(en)",
    );
  });

  test("lines are phonemized separately", async () => {
    expect(await phonemize("one\n\ntwo", "en-us")).toBe("wʌn \ntuː ");
    expect(await phonemize("one\n\ntwo", "en-us", { preserveEmptyLines: true })).toBe(
      "wʌn \n\ntuː ",
    );
  });

  test("unsupported language", async () => {
    await expect(phonemize("bonjour", "fr")).rejects.toThrow(
      'language "fr" is not supported by the espeak backend',
    );
  });
});

describe("splitClauses", () => {
  test("ends clauses where espeak-ng does", () => {
    const clauses = splitClauses("Hello, world. How are you? Fine\n\nNew paragraph");
    expect(clauses.map((c) => c.text)).toEqual([
      "Hello,",
      "world.",
      "How are you?",
      "Fine",
      "New paragraph",
    ]);
    expect(clauses.map((c) => c.terminator)).toEqual([
      CLAUSE_COMMA,
      CLAUSE_PERIOD,
      CLAUSE_QUESTION,
      CLAUSE_PARAGRAPH,
      CLAUSE_EOF,
    ]);
    expect(clauses.map((c) => terminatorPunctuation(c.terminator))).toEqual([
      ",",
      ".",
      "?",
      "",
      "",
    ]);
  });

  test("abbreviations, decimals and ellipses", () => {
    expect(splitClauses("e.g. the dog").map((c) => c.text)).toEqual(["e.g. the dog"]);
    expect(splitClauses("It is 3.50 now").map((c) => c.text)).toEqual(["It is 3.50 now"]);
    expect(splitClauses("Mr. Smith").map((c) => c.text)).toEqual(["Mr.", "Smith"]);
    expect(splitClauses("Wait... what?!").map((c) => c.text)).toEqual(["Wait...", "what?!"]);
    expect(splitClauses("你好，世界。").map((c) => c.text)).toEqual(["你好，", "世界。"]);
  });

  test("agrees with espeak-ng's own clause splitting", async () => {
    const espeak = await getEspeakNG();
    espeak.setVoice("en-us");
    const texts = [
      "Hello world. How are you? I'm fine, thanks!",
      'He said "hello." Then he left; nobody knew why: it was late.',
      "Numbers like 3.14 and 1,000 stay whole. Do they?",
      "Wait... what?! No way—really? (Yes.) Okay.",
      "Line one\nline two\n\nNew paragraph. The U.S.A.'s flag.",
      "¿Qué tal? ¡Hola! Muy bien.",
      "你好，世界。今天天气很好！",
      "Dr. Who arrived at 5 p.m. today. Then he left.",
    ];
    for (const text of texts) {
      expect([text, splitClauses(text).length]).toEqual([text, espeak.textToPhonemes(text).length]);
    }
  });
});
