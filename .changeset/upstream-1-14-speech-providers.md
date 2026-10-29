---
"@pipedog/cartesia": minor
"@pipedog/elevenlabs": minor
"@pipedog/fish": minor
"@pipedog/minimax": minor
"@pipedog/deepgram": minor
"@pipedog/inworld": minor
"@pipedog/smallest": minor
"@pipedog/speechify": minor
"@pipedog/sarvam": minor
"@pipedog/google": minor
---

Speech providers brought up to pipecat main after 1.14:

- Expression adapters for expressive conversation (alpha): `CartesiaExpressionAdapter`
  (`@pipedog/cartesia/cartesia_adapter`, `CartesiaEmotion` now lives there),
  `ElevenLabsAudioTagExpressionAdapter`, Fish Audio S2 and MiniMax adapters. With
  `enableExpressiveConversation`, the TTS services perform the tags the LLM writes.
- Cartesia: `accent` setting (#6429), regional locales and CJK punctuation tokens; the turns STT
  reconnects from its receive loop and ends a turn cut short by a dropped connection with the
  transcript so far (#6242).
- ElevenLabs: audio tags reported as words, and the word clock advances on wordless alignment
  (#6297).
- Deepgram: the TTS and Flux services report the `dg-error` reason of a refused connection, and
  Flux STT waits for `Connected` through the core `_receiveUntilConfirmed`.
- Inworld TTS reconnects from its receive loop (#6300); Sarvam STT reconnects (#6342).
- Smallest: `dateFormat` and the `"redact"` content filter (#6431). Speechify: `pronunciations`
  (#6436) and `simba-3.5` as the default model. Google Vertex defaults to `gemini-3.8-flash`.
