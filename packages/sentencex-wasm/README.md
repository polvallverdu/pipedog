# @pipedog/sentencex-wasm

Sentence segmentation for pipedog with [sentencex](https://github.com/wikimedia/sentencex)
(Wikimedia, MIT), compiled to WebAssembly. Upstream Pipecat splits sentences with
`sentencex==1.0.32` (`pipecat/utils/string.py`). This package runs the same Rust core, so
pipedog gets the same sentence boundaries as upstream on every runtime.

- The `sentencex` npm package is a native Node addon with per-platform binaries. It cannot run
  on Deno or Cloudflare Workers. This package can.
- The Rust crate is [`sentencex` 0.1.32](https://crates.io/crates/sentencex/0.1.32) from
  crates.io, pinned with `=0.1.32`. It is the same release as the Python and npm `1.0.32`: git
  tag `v1.0.32`, commit `268ff94` (the crate's `.cargo_vcs_info.json`). Its `src/` is
  byte-identical to the tag. Nothing is vendored or patched. `rust/Cargo.lock` pins `regex`,
  `regex-automata`, `regex-syntax`, `aho-corasick`, `memchr` and `rustc-hash` to the versions in
  sentencex's own `Cargo.lock` at that tag.
- No wasm-bindgen and no generated JS glue. The module has **zero imports** and a small C ABI
  (`rust/src/lib.rs`). `src/engine.ts` wraps the `WebAssembly.Instance` exports by hand.
- `wasm/sentencex.wasm` is a committed build artifact of **1,054,520 bytes** (353 KB gzipped).
  It is built with cargo `opt-level = "z"`, LTO, `panic = "abort"`, then `wasm-opt -Oz`.
  Most of the size comes from the `regex` crate, which sentencex depends on with default
  features: about 350 KB of regex engine code and its Unicode tables. The language rules
  themselves (abbreviation lists etc.) are a smaller part.
- The API is **synchronous**, including the first call. Verified on Bun, Node 24, Deno 2 and
  workerd (Cloudflare Workers).
- Output is identical to the native `sentencex@1.0.32` addon on more than 67,000
  (language, text) inputs (`test/parity.test.ts`).

## Usage

```ts
import { getSentenceBoundaries, segment } from "@pipedog/sentencex-wasm";

segment("en", "Dr. Smith arrived at 5 p.m. He was late.");
// ["Dr. Smith arrived at 5 p.m. ", "He was late."]

getSentenceBoundaries("en", "Hi 👋. Bye.");
// [
//   { start_index: 0, end_index: 7, text: "Hi 👋. ", boundary_symbol: ".", is_paragraph_break: false },
//   { start_index: 7, end_index: 11, text: "Bye.", boundary_symbol: ".", is_paragraph_break: false },
// ]
```

- `segment(language, text): string[]` returns the same result as sentencex's `segment`.
  Joining the result gives back `text`, including whitespace and `"\n\n"` paragraph spans.
- `getSentenceBoundaries(language, text): SentenceBoundary[]` returns the same shape as the npm
  package's `get_sentence_boundaries` typings (`start_index`, `end_index`, `text`,
  `boundary_symbol`, `is_paragraph_break`). `get_sentence_boundaries` is exported as an alias.
- **Indices are JavaScript string (UTF-16) indices**, so
  `text.slice(b.start_index, b.end_index) === b.text`. sentencex itself returns Unicode scalar
  (code point) indices. The npm and Python packages pass those through unchanged, so they do not
  match JS string positions after an emoji or any other astral character. The conversion
  happens in Rust (`Utf16Cursor`). The parity test converts the native indices the same way
  before it compares them.
- `language` is a code such as `"en"`, `"de"` or `"ja"`. Codes that sentencex does not know go
  through its fallback map and end at English, just as in the native package. Upstream
  normalizes codes first (`resolve_sentence_tokenizer_language`: lowercase, strip the region).
  That is core's job, not this package's.
- Lone surrogates: sentencex sees them as U+FFFD, as the native addon does, and the boundaries
  are the same. The returned strings are slices of your input, so the original code units are
  kept.
- `initSentencex(source?)` compiles and instantiates now instead of on the first call.
  `source` is a `WebAssembly.Module` or wasm bytes (bytes do not work on workerd), and it
  replaces the bundled module. `getSentencex()` returns the shared `SentencexEngine`.
  `new SentencexEngine(module)` creates a separate instance.
- Cost: the first call takes about 10 to 12 ms (compiling the module and sentencex's regexes
  for English). Later calls take about 7 to 10 µs for a short sentence (Bun, Node, Deno on
  Apple Silicon). The first call for another language compiles that language's regexes, about
  1.5 ms.

## Loading on each runtime

`package.json` `"exports"["."]` uses export conditions:

| condition | entry | how the module gets loaded |
|---|---|---|
| `workerd` | `src/workerd.ts` | `import wasm from "../wasm/sentencex.wasm"` gives a compiled `WebAssembly.Module` (wrangler's default `.wasm` rule). It is instantiated synchronously, with `new WebAssembly.Instance(module, {})`, when the entry module loads. workerd refuses to compile WASM from bytes. |
| `default` | `src/index.ts` | The bytes are embedded as base64 in the generated `src/wasm_bytes.ts`. On the first call they are decoded (`Uint8Array.fromBase64` when available, else `atob`) and compiled with `new WebAssembly.Module(bytes)`, then `new WebAssembly.Instance`. There is no file access and no `fetch`, so it works the same in bundles. |

Synchronous compilation of a module this size works on Bun, Node 24 and Deno 2; the compat
harness checks all three. Browsers can refuse to compile large modules synchronously on the
main thread. For a browser, first run `initSentencex(await WebAssembly.compile(bytes))` with the
bytes of `./sentencex.wasm`. Browsers are not tested.

The embedded base64 adds about 1.4 MB to the default entry's JavaScript. On workerd only the
`.wasm` module is bundled.

## C ABI (for reference)

| export | |
|---|---|
| `sx_alloc(len) -> ptr`, `sx_free(ptr, len)` | raw linear-memory blocks |
| `sx_segment(lang, lang_len, text, text_len) -> n` | `n` records of `[start16, end16]` at `sx_out()` |
| `sx_boundaries(lang, lang_len, text, text_len) -> n` | `n` records of `[start_index16, end_index16, text_start16, text_end16, symbol_ptr, symbol_len, is_paragraph_break]`, where `symbol_len = 0xFFFFFFFF` means no symbol |
| `sx_out() -> *u32` | records from the last call |

All values are u32. A negative count means invalid UTF-8 input. The JS side writes
`language` and `text` into one allocation with `TextEncoder.encodeInto`. It reads the records,
slices the original string, decodes the boundary symbols, and only then frees the buffer,
because symbols point into it. If the module traps (a Rust panic), the engine re-instantiates
it on the next call.

## Licensing

- Our code (`src/`, `rust/src/lib.rs`, scripts and tests) is BSD-2-Clause.
- `wasm/sentencex.wasm` and `src/wasm_bytes.ts` contain compiled sentencex (MIT, © 2025 Santhosh
  Thottingal; see [`LICENSE-sentencex`](./LICENSE-sentencex)). They also contain its
  dependencies `regex`, `regex-automata`, `regex-syntax` and `rustc-hash` (MIT OR Apache-2.0),
  `aho-corasick` and `memchr` (Unlicense OR MIT), and Rust's `std` and `dlmalloc`
  (MIT OR Apache-2.0). Each of these is available under MIT. That is why the package `license` is `BSD-2-Clause AND MIT`.

## Building and testing

```sh
rustup target add wasm32-unknown-unknown
bun run build:wasm      # cargo + wasm-opt -Oz -> wasm/sentencex.wasm and src/wasm_bytes.ts; --no-opt to skip wasm-opt
bun test                # unit tests + parity against the native sentencex@1.0.32 addon
bun scripts/extract-upstream-corpus.ts   # refresh test/fixtures/upstream-corpus.json from .upstream
bun tools/compat/run.ts --package sentencex-wasm   # from the repo root: bun, node, deno, workerd
```

The parity test needs the native `sentencex` devDependency, which has prebuilt binaries for
macOS, Linux x64/arm64 and Windows x64. Its corpus covers:

- every prefix of a hand-written corpus: abbreviations, initials, times, decimals, ellipses,
  quotes, attributed questions and exclamations, URLs, emails, lists, paragraph breaks, emoji
  and other astral characters, in en, es, fr, de, ja, zh, hi, ar, pt, pl, it and nl
- every string literal in upstream's `test_english_sentence_aggregation.py`,
  `test_sentence_tokenizer_language.py`, `test_sentencex_tokenizer.py`,
  `test_simple_text_aggregator.py` and `test_utils_string.py`, alone and joined with its
  neighbour, in 12 languages and as streaming prefixes
- a text over 10 KB, which takes sentencex's paragraph-chunking path
- a mixed sample in every language code sentencex knows, plus unknown codes
