// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: loads eSpeak NG (WebAssembly, from the
// optional peer @echogarden/espeak-ng-emscripten) and phonemizes with both
// front ends.

import { getEspeakNG, phonemize } from "@pipedog/espeak-ng";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`espeak-ng smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  const kokoro = await phonemize("Hello world!", "en-us", {
    preservePunctuation: true,
    withStress: true,
  });
  check(kokoro === "həlˈoʊ wˈɜːld! ", `phonemize: ${JSON.stringify(kokoro)}`);

  const espeak = await getEspeakNG();
  espeak.setVoice("en-us");
  const clauses = espeak.textToPhonemesWithTerminator("Hello, world. How are you?");
  check(
    JSON.stringify(clauses.map((c) => [c.phonemes, c.punctuation, c.endOfSentence])) ===
      JSON.stringify([
        ["həlˈoʊ", ",", false],
        ["wˈɜːld", ".", true],
        ["hˈaʊ ɑːɹ juː", "?", true],
      ]),
    `textToPhonemesWithTerminator: ${JSON.stringify(clauses)}`,
  );
  check(espeak.voiceForLanguage("cmn")?.identifier === "sit/cmn", "voiceForLanguage");
}
