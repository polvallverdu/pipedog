---
"@pipedog/cloudflare": patch
---

`WorkersAIAuraTTSService` keeps its session open. Workers AI closes an idle Aura WebSocket after
about 3.5 s (code 1011) and has no `KeepAlive`, so the session dropped between replies and during
tool calls, and text sent while it reconnected could be lost. The service now sends an empty `Speak`
after 2 s without a message.
