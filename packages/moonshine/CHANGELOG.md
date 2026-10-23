# @pipedog/moonshine

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/audio-silero@0.9.0
  - @pipedog/onnx@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8), [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/audio-silero@0.8.0
  - @pipedog/core@0.8.0
  - @pipedog/onnx@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#62](https://github.com/polvallverdu/pipedog/pull/62) [`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Port Pipecat's local speech models, all running in-process on `@pipedog/onnx` (no Python, no API key):
  
  - `@pipedog/kokoro`: `KokoroTTSService`, with the same Kokoro-82M model and voices files as upstream's
    kokoro-onnx (audio identical for the same input).
  - `@pipedog/piper`: `PiperTTSService` (Piper ONNX voices from rhasspy/piper-voices) and
    `PiperHttpTTSService` (a Piper HTTP server over `fetch`, also on Cloudflare Workers).
  - `@pipedog/pocket-tts`: `PocketTTSService`, Kyutai's Pocket TTS on ONNX graphs checked against
    pocket-tts 2.1.0.
  - `@pipedog/moonshine`: `MoonshineSTTService`, with Moonshine's own `.ort` models (all six
    architectures, streaming ones included).
  - `@pipedog/funasr`: `FunASRSTTService`, SenseVoiceSmall with FunASR's front end and post-processing.
  - `@pipedog/whisper`: the local `WhisperSTTService` (an ONNX port of faster-whisper: beam search,
    temperature fallback, `no_speech_prob`, hotwords and initial prompt), `WhisperSTTServiceMLX` (same
    engine; there is no MLX in JS) and the `utils` probability helpers.
  - `@pipedog/espeak-ng`: eSpeak NG phonemization (WASM) shared by Kokoro and Piper.
  - `@pipedog/onnx`: int32 and bool tensors, and `modelCacheDir()` / `downloadModelFile()` for
    downloaded models.
  - `@pipedog/evals`: the keyless local audio defaults work by name again (`kokoro` for the user's
    voice, `moonshine` and `whisper` for the transcriber).
  
  Models download on first use into `~/.cache/pipedog/<name>` (or `$PIPEDOG_CACHE_DIR`).

### Patch Changes

- Updated dependencies [[`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/onnx@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/audio-silero@0.7.0
  - @pipedog/asyncio@0.7.0
