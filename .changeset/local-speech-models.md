---
"@pipedog/kokoro": minor
"@pipedog/piper": minor
"@pipedog/pocket-tts": minor
"@pipedog/moonshine": minor
"@pipedog/funasr": minor
"@pipedog/espeak-ng": minor
"@pipedog/whisper": minor
"@pipedog/onnx": minor
"@pipedog/evals": minor
---

Port Pipecat's local speech models, all running in-process on `@pipedog/onnx` (no Python, no API key):

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
