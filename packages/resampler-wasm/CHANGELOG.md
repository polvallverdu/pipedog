# @pipedog/resampler-wasm

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- [#4](https://github.com/polvallverdu/pipedog/pull/4) [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `SOXRAudioResampler` and `SOXRStreamAudioResampler` now resample instead of throwing "not ported yet" when the rates differ. This also fixes `createFileResampler()`, `createStreamResampler()`, the μ-law/A-law helpers at other rates, `loadDtmfAudio()` at rates other than 8 kHz, `LocalSmartTurnAnalyzerV3` at rates other than 16 kHz, and output transports and TTS services whose rates differ. The resampling goes through a small engine interface in `@pipedog/core/audio/resamplers/engine`:
  
  - The default engine is `@pipedog/resampler-wasm`, which core now depends on. It loads lazily on first use, and on Cloudflare Workers it loads through the package's `workerd` export condition.
  - If WebAssembly cannot be loaded, core logs one warning and falls back to a pure-TypeScript windowed-sinc engine with soxr-like presets (`createSincResamplerEngine()`).
  - `setResamplerEngine(engine)` lets apps inject their own engine, for example a native soxr binding. `getResamplerEngine()` resolves to the engine in use.
  
  The quality presets (VHQ by default, then HQ, MQ, LQ and QQ), clearing after inactivity, `flush()` and `reset()` behave as before. Equal rates still return the input unchanged.
  
  `@pipedog/resampler-wasm`: `initResampler()` falls back to an embedded copy of the module (`src/wasm_bytes.ts`) when the `.wasm` file next to the package cannot be read, for example after bundling.
  
  `@pipedog/resampler-wasm`: the quality presets now follow libsoxr's quality table. The stopband starts at the Nyquist frequency of the lower rate. MQ, HQ and VHQ are flat to about 0.91 of it and differ mainly in attenuation: about 111, 138 and at least 157 dB. LQ (about 112 dB) and QQ (about 75 dB) have earlier roll-offs. The filter is stretched when downsampling, so it no longer leaks aliases at large ratios: a 5 kHz tone resampled from 48 kHz to 8 kHz is now 87 to 163 dB down, depending on the preset. Processing is now done in f64. Output samples, filter delays (about 8.5 ms at VHQ) and `qualityInfo()` values change; the output lengths do not.

## 0.1.0

No changes in this release.
