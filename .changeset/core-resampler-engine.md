---
"@pipedog/core": minor
"@pipedog/resampler-wasm": patch
---

`SOXRAudioResampler` and `SOXRStreamAudioResampler` now resample instead of throwing "not ported yet" when the rates differ. This also fixes `createFileResampler()`, `createStreamResampler()`, the μ-law/A-law helpers at other rates, `loadDtmfAudio()` at rates other than 8 kHz, `LocalSmartTurnAnalyzerV3` at rates other than 16 kHz, and output transports and TTS services whose rates differ. The resampling goes through a small engine interface in `@pipedog/core/audio/resamplers/engine`:

- The default engine is `@pipedog/resampler-wasm`, which core now depends on. It loads lazily on first use, and on Cloudflare Workers it loads through the package's `workerd` export condition.
- If WebAssembly cannot be loaded, core logs one warning and falls back to a pure-TypeScript windowed-sinc engine with soxr-like presets (`createSincResamplerEngine()`).
- `setResamplerEngine(engine)` lets apps inject their own engine, for example a native soxr binding. `getResamplerEngine()` resolves to the engine in use.

The quality presets (VHQ by default, then HQ, MQ, LQ and QQ), clearing after inactivity, `flush()` and `reset()` behave as before. Equal rates still return the input unchanged.

`@pipedog/resampler-wasm`: `initResampler()` falls back to an embedded copy of the module (`src/wasm_bytes.ts`) when the `.wasm` file next to the package cannot be read, for example after bundling.
