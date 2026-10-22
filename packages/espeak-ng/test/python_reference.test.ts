// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Compare with the Python stacks upstream uses.
 *
 * `fixtures/python_reference.json` was produced by `fixtures/python_reference.py`
 * with kokoro-onnx 0.6.1 (phonemizer 3.4.0 + espeakng-loader 0.2.4) and
 * piper-tts 1.8.0, the versions in upstream's uv.lock:
 *
 *   uv run --no-project --with kokoro-onnx==0.6.1 --with piper-tts==1.8.0 \
 *     python -I python_reference.py > python_reference.json
 */

import { describe, expect, test } from "bun:test";
import { getEspeakNG, phonemize } from "../src/index.ts";
import reference from "./fixtures/python_reference.json";

interface KokoroCase {
  lang: string;
  text: string;
  phonemize: string;
  tokenizer: string;
}
interface PiperCase {
  voice: string;
  text: string;
  clauses: [string, string, boolean][];
}

/**
 * Piper bundles its own, newer espeak-ng data; for these voices its rules
 * give slightly different phonemes than the data in the WebAssembly build.
 * Clause boundaries and punctuation still match.
 */
const PIPER_DATA_DIFFERENCES = new Set(["en-gb-x-rp", "pt-br", "it"]);

describe("phonemizer (kokoro-onnx)", () => {
  for (const c of reference.kokoro as KokoroCase[]) {
    test(`${c.lang}: ${JSON.stringify(c.text)}`, async () => {
      const got = await phonemize(c.text.trim(), c.lang, {
        preservePunctuation: true,
        withStress: true,
      });
      expect(got).toBe(c.phonemize);
    });
  }
});

describe("textToPhonemesWithTerminator (piper espeakbridge)", () => {
  for (const c of reference.piper as PiperCase[]) {
    test(`${c.voice}: ${JSON.stringify(c.text)}`, async () => {
      const espeak = await getEspeakNG();
      espeak.setVoice(c.voice);
      const got = espeak.textToPhonemesWithTerminator(c.text);
      expect(got.map((x) => [x.punctuation, x.endOfSentence])).toEqual(
        c.clauses.map(([, punctuation, end]) => [punctuation, end]),
      );
      if (!PIPER_DATA_DIFFERENCES.has(c.voice)) {
        expect(got.map((x) => x.phonemes)).toEqual(c.clauses.map(([phonemes]) => phonemes));
      }
    });
  }
});
