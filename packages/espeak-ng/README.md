# @pipedog/espeak-ng

[eSpeak NG](https://github.com/espeak-ng/espeak-ng) phonemization for pipedog's local TTS models
([Kokoro](../kokoro), [Piper](../piper)). eSpeak NG runs as WebAssembly from
[`@echogarden/espeak-ng-emscripten`](https://www.npmjs.com/package/@echogarden/espeak-ng-emscripten),
an optional peer dependency loaded on first use (one instance per process).

Two front ends reproduce what the Python TTS stacks do with espeak-ng, so the same text gives the
same phonemes:

| API | Reproduces | Used by |
|---|---|---|
| `phonemize(text, language, options)` | Python [`phonemizer`](https://github.com/bootphon/phonemizer) 3.4's espeak backend (punctuation preservation, stress, separators, language-switch flags) | kokoro-onnx, `@pipedog/kokoro` |
| `EspeakNG.textToPhonemesWithTerminator(text)` | `espeak_TextToPhonemesWithTerminator` as Piper's `espeakbridge` calls it: per-clause IPA plus the punctuation that ended the clause and whether it ended a sentence | piper-tts, `@pipedog/piper` |

```ts
import { getEspeakNG, phonemize } from "@pipedog/espeak-ng";

await phonemize("Hello world!", "en-us", { preservePunctuation: true, withStress: true });
// "həlˈoʊ wˈɜːld! "

const espeak = await getEspeakNG();
espeak.setVoice("en-us");
espeak.textToPhonemesWithTerminator("Hello, world.");
// [{ phonemes: "həlˈoʊ", punctuation: ",", endOfSentence: false, ... },
//  { phonemes: "wˈɜːld", punctuation: ".", endOfSentence: true, ... }]
```

## Install

```sh
bun add @pipedog/espeak-ng @echogarden/espeak-ng-emscripten
```

`@echogarden/espeak-ng-emscripten` is ~25 MB (the WebAssembly build plus all of espeak-ng's voice
data, 24 MB, loaded into memory on first use).

## API

- `getEspeakNG()`: the shared instance (loaded once per process). `loadEspeakNG({ factory? })` loads
  a separate one, optionally from an already imported module factory.
- `EspeakNG`
  - `voices`: every voice with its languages and priorities.
  - `voiceForLanguage(code)`: the voice for a language code the way `phonemizer` resolves it (the
    first voice whose main language is the code: `en-us` → `gmw/en-US`, `fr-fr` → `roa/fr`,
    `cmn` → `sit/cmn`; bare `fr` and `zh` have none). `supportedLanguages()` lists the codes.
  - `setVoice(name, { by })`: by name or voice file (`espeak_SetVoiceByName`; falls back to the
    voice listing that language with the best priority), or `by: "language"`.
  - `textToPhonemes(text, { ipa, phonemeSeparator })`: `espeak_TextToPhonemes`, one string per clause.
  - `textToPhonemesWithTerminator(text)`: see above.
- `phonemize()` / `phonemizeWith(espeak, ...)`: options `preservePunctuation`, `withStress`,
  `punctuationMarks`, `separator: { phone, word }`, `strip`, `preserveEmptyLines`,
  `languageSwitch: "keep-flags" | "remove-flags"`.
- `splitClauses(text)`: espeak-ng's clause boundaries (see below), with the `CLAUSE_*` constants.

## Runtimes

| | Bun | Node | Deno | Workers |
|---|---|---|---|---|
| everything | ✅ | ✅ | ✅ | ❌ (the voice data is read from the filesystem, and is too large for a Worker) |

## How close to the Python libraries?

`test/python_reference.test.ts` compares against outputs produced by the exact versions upstream
Pipecat locks (kokoro-onnx 0.6.1 with phonemizer 3.4.0 and espeakng-loader 0.2.4; piper-tts 1.8.0)
on English, French, Spanish, Mandarin, Portuguese, Italian, Hindi and Japanese text:

- `phonemize()`: identical to phonemizer for every case (including its quirks, such as cutting
  `$3.50.` at the first dot).
- `textToPhonemesWithTerminator()`: clause boundaries, punctuation and sentence ends identical to
  Piper's for every case. The phonemes are identical except for three voices (`en-gb-x-rp`,
  `pt-br`, `it`) where piper-tts bundles a newer espeak-ng whose rules differ slightly.

The WebAssembly build only exposes `espeak_TextToPhonemes`, not the `...WithTerminator` variant, so
`splitClauses()` finds the clause ends itself, following espeak-ng's `ReadClause()` for plain text
(punctuation followed by a space, bracket or end of text; full-width CJK marks; `?!` runs;
abbreviations before a lower-case word; paragraphs), and each clause is phonemized on its own. Not
modelled: SSML and a few language-specific rules (Hungarian ordinals, Armenian in-word
punctuation). A clause espeak-ng splits further (very long ones) has its parts joined with a space.

## License

BSD 2-Clause. eSpeak NG and `@echogarden/espeak-ng-emscripten` are **GPL-3.0**: distributing an
application that includes them may subject it to the GPL's terms. Upstream is in the same position:
kokoro-onnx (via espeakng-loader) and piper-tts both ship espeak-ng.
