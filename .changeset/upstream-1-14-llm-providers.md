---
"@pipedog/openai": minor
"@pipedog/aws": minor
"@pipedog/azure": minor
"@pipedog/perplexity": minor
"@pipedog/together": minor
"@pipedog/inception": minor
"@pipedog/smallest": minor
"@pipedog/evals": minor
"@pipedog/cli": minor
"@pipedog/runner": minor
"@pipedog/serializer-twilio": minor
---

LLM and other providers brought up to pipecat main after 1.14:

- ⚠️ Perplexity: `PerplexityLLMService` (Sonar chat completions) is removed, as upstream deprecates
  it; use the new `PerplexityAgentHttpLLMService` for Perplexity's Agent API, with `preset`,
  `webSearch` and `maxSteps` settings (#5985).
- New `SmallestLLMService` (Smallest's Electron models, OpenAI-compatible, #6339).
- OpenAI: Responses services report an empty completion and default `gpt-6.1-terra` to no
  reasoning (#6348, #6434); the realtime client tolerates unknown server events (#6329); image
  generation takes `moderation` (#6432).
- AWS Bedrock: reasoning is pushed as thought frames and round-trips with its signature, and Nova's
  `<thinking>` text no longer reaches TTS (#6229).
- Azure realtime authenticates through the `_authHeaders()` hook (#6329).
- Together: `reasoningEffort` (#6437). Inception defaults to `mercury-3` (#6397).
- Twilio: `apiKeySid` / `apiKeySecret` as an alternative to `authToken` for auto hang-up; the
  runner reads `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_REGION` and `TWILIO_EDGE` (#6270,
  #6293).
- Evals: `text_matches` expectations (failure kind `text_unmatched`, #5991) and the `expression`
  event (#6303); image requests with no registered image get an error answer (#6350).
- CLI: the Perplexity entry uses `PerplexityAgentHttpLLMService`.
