---
"@pipedog/core": minor
---

`MinWordsUserTurnStartStrategy` takes two opt-in options: `startOnVadWhenBotQuiet` starts the turn
on VAD while the bot is silent instead of waiting for a transcript, and `keepBotSpeakingOnTurnStart`
keeps the bot-speaking state across turn starts. New user mute strategies:
`OpeningUserMuteStrategy` (mute until the bot's first speech ends or has played for `maxSeconds`)
and `EndingUserMuteStrategy` (mute for good once the conversation is ending).
