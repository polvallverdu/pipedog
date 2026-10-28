---
"@pipedog/google": minor
---

`GeminiSTTService` connects through Vertex AI with `vertexai: true` and `location` (plus optional
`projectId`, `credentials` or `credentialsPath`, else ADC), sending transcription languages as
`languageCodes` as Vertex requires; its client is created on first connect, so subclasses can read
their own options in `_createClient()` (#88). `reportDetectedLanguage: false` puts the configured
language on transcripts instead of the model's detected one, and `setLanguageCodes(codes | () =>
codes)` switches languages mid-session, reconnecting when the bot next starts speaking, never
mid-utterance (#89). The Live session now opens in the background, so the `StartFrame` no longer
waits for it and early audio is buffered; `awaitConnectionOnStart: true` keeps the old behaviour
(#90).
