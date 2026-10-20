---
"@pipedog/core": minor
---

Core is fully ported (all 361 upstream modules): the text transforms that make text speakable for
TTS (numbers, currency, dates, percentages, phone numbers, units, acronyms, email, markdown,
replacements, pronunciations, `VoiceFormatter`) and the WebSocket proxy client. Numbers are spoken
with `num2words-ts`, as upstream uses `num2words`; Unicode digits (e.g. "٥٠") are recognised and
read like upstream does.
