---
"@pipedog/sarvam": minor
"@pipedog/smallest": minor
"@pipedog/gradium": minor
"@pipedog/meta": minor
"@pipedog/inception": minor
---

Add `@pipedog/sarvam` (SarvamLLMService, SarvamSTTService, SarvamRealtimeSTTService, SarvamTTSService, SarvamHttpTTSService), `@pipedog/smallest` (SmallestSTTService, SmallestTTSService), `@pipedog/gradium` (GradiumSTTService, GradiumTTSService), `@pipedog/meta` (MetaSTTService) and `@pipedog/inception` (InceptionLLMService), with docs. All run on Bun, Node, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through the core `websocketConnect`, with no provider SDKs.
