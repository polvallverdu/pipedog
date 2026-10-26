---
"@pipedog/audio-ducking": minor
---

New package `@pipedog/audio-ducking` (pipedog only): `AudioDuckingFilter` lowers the bot's voice while the user talks over it. It is an output audio filter (`audioOutFilter`), so the gain applies as audio leaves the transport, with any transport or serializer; its `observer` ducks on `VADUserStartedSpeakingFrame` and restores on `VADUserStoppedSpeakingFrame`, `InterruptionFrame` and `BotStoppedSpeakingFrame`, ramping over a chunk to avoid clicks.
