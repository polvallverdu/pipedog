---
"@pipedog/cloudflare": minor
"@pipedog/cli": patch
---

New package `@pipedog/cloudflare`: Cloudflare Workers AI services, over the Worker's `AI` binding or the REST API. Deepgram Flux (`WorkersAIFluxSTTService`, with turn detection), Nova-3 (`WorkersAINova3STTService`) and Whisper (`WorkersAIWhisperSTTService`) speech-to-text; Aura (`WorkersAIAuraTTSService` over a WebSocket, `WorkersAIAuraHttpTTSService`) and MeloTTS (`WorkersAIMeloTTSService`) text-to-speech; `WorkersAILLMService` on the OpenAI-compatible endpoint; and `WorkersAISmartTurnAnalyzer` for Smart Turn v2. `pipedog init` offers the Flux, Whisper, Aura and LLM services.
