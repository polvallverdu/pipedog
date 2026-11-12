---
"@pipedog/audio-ten-vad": minor
---

New package `@pipedog/audio-ten-vad` (pipedog only): `TenVADAnalyzer`, a VAD analyzer backed by
[TEN VAD](https://github.com/TEN-framework/ten-vad), as an opt-in alternative to Silero. It drives
TEN VAD's prebuilt WebAssembly build through TEN's documented interface; `loadTenVadModule()`
loads it from the `.wasm` bytes, a precompiled `WebAssembly.Module` (Cloudflare Workers) or TEN's
own loader. pipedog ships none of TEN's code, WebAssembly or model: you obtain `ten_vad.js` and
`ten_vad.wasm` from TEN, and TEN's license (Apache-2.0 with additional conditions) applies to your
use of them. 16 kHz only, 160- or 256-sample frames.
