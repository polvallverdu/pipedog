---
"@pipedog/xai": minor
"@pipedog/grok": minor
---

xAI Grok Voice Agent speech-to-speech.

- `@pipedog/xai`: `GrokRealtimeLLMService` (`@pipedog/xai/realtime/llm`) with its events
  (`@pipedog/xai/realtime/events`) and `GrokRealtimeLLMAdapter`: server VAD or locally driven
  turns, function calling and xAI's built-in tools, transcripts, audio truncation on interruption,
  `forceMessage()`, DTMF and MCP events.
- `@pipedog/grok`: the deprecated `@pipedog/grok/realtime/*` aliases, and
  `@pipedog/grok/grok_realtime_adapter`.

Runs on Bun, Node, Deno and Cloudflare Workers.
