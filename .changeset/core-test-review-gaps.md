---
"@pipedog/core": minor
---

Fill four gaps in core that upstream tests exercise:

- Resampling works: `SOXRAudioResampler`, `SOXRStreamAudioResampler` and `soxrResample` run on
  `@pipedog/resampler-wasm` (now a dependency) instead of throwing, so TTS services, output
  transports and the audio buffer processor can convert sample rates. Call `await initSoxr()`
  before the synchronous `soxrResample`; the async resamplers do it themselves.
- `encodeImage()` JPEG-encodes raw `L`/`LA`/`RGB`/`RGBA`/`RGBX` pixels with a built-in baseline
  encoder (`utils/jpeg_encoder`), so raw image frames reach LLMs and classifiers.
- `utils/yaml`: `includeLoader()` / `addIncludeConstructor()` work, with a PyYAML-style
  `SafeLoader` (YAML 1.1 resolvers, per-class constructors) and `load()` on top of the `yaml`
  package. Included files are read with an injected `readFile`.
- `LocalFileStorage` saves, loads, deletes and trims files through an injected `fs`
  (`node:fs/promises` fits as is).
