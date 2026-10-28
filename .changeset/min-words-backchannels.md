---
"@pipedog/core": minor
---

`MinWordsUserTurnStartStrategy` takes two opt-in options for interruptions over the bot (#95):
`isBackchannel` keeps acknowledgements such as "yes, okay" or "mm-hm" from starting a turn
(`createBackchannelMatcher()` builds one from the per-language `BACKCHANNEL_PHRASES`), and
`requireVadWithinSeconds` counts words only if the VAD heard the user within that many seconds.
