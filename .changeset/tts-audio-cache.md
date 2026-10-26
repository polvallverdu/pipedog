---
"@pipedog/core": minor
---

TTS audio cache (pipedog only): `TTSService` takes an optional `audioCache` (`TTSAudioCache`, an in-memory LRU bounded by size, or any `get`/`set` store), and `warmAudioCache(text)` synthesizes fixed lines ahead of time so they play without a request to the provider. Only warmed lines are stored unless `cacheSynthesizedAudio` allows live synthesis. Works with services that yield audio from `runTts` (HTTP and streaming-RPC).
