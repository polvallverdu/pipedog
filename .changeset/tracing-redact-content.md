---
"@pipedog/tracing": minor
---

`setupTracing({ redactContent })` and `registerWithCore({ redactContent })` (pipedog only): spans keep timings, ids, numbers and booleans, while string attributes are dropped unless their key is allowed (by default the non-content keys pipedog writes, such as model, provider, voice, language, conversation and turn ids), events keep only `exception.type`, exceptions keep only their type and statuses only their code. So transcripts, LLM input and output, system instructions and tool definitions never reach an exporter. Allowed keys can be extended, replaced or decided by a predicate; `redactTracer`, `redactTracerProvider` and `redactSpan` apply the same rules to your own spans.
