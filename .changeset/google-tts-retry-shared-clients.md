---
"@pipedog/google": minor
---

`GeminiTTSService` takes an opt-in `retryOnBlocked`: a sentence Google blocks for its usage
guidelines is requested again, a sentence cut off midway starts over (optionally with a lead-in via
`restartText`), and an optional `fallback` gets one last attempt; `isGeminiTTSBlockedError` and
`GeminiTTSBlockedError` are exported (#91). `GoogleSTTService`, `GoogleTTSService`,
`GoogleHttpTTSService` and the Cloud backend of `GeminiTTSService` take `sharedClient`, one gRPC
client per endpoint and credentials in the process (`getSharedGoogleCloudTTSClient`), and
`prewarm()`, which connects the channel and fetches a token at start-up and fails soft (#93).
`GoogleSTTService.setLanguageCodes()` reconnects with new codes when the bot starts speaking, or
after the user's turn (#89). The TTS audio-cache key now covers `voiceCloningKey` and the Gemini
backend, and the docs show how to pre-synthesize fixed lines with `warmAudioCache()` (#92).
