---
"@pipedog/google": minor
---

Google speech services: `GoogleSTTService` gets `finalizeOnVadStop` (half-close the request stream on `VADUserStoppedSpeakingFrame`, so the final transcript arrives in about 0.6 s instead of Google's ~1.5 s endpointing, merged into one finalized `TranscriptionFrame`) and accepts `GoogleSTTSettings.languageCodes` again (e.g. `["auto"]` for Chirp's language detection; transcripts carry the detected language). `GoogleTTSService` and `GeminiTTSService` accept an injected `client` (share one Cloud TTS client across calls) and `bufferOnlyStartup` (buffer only the start of each utterance), and `GeminiTTSSettings` gets `speakingRate`. A gRPC CANCELLED error (an interrupted or cancelled call) now ends a Google Cloud stream quietly instead of being reported as an error.
