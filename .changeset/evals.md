---
"@pipedog/evals": minor
"@pipedog/runner": minor
---

Add `@pipedog/evals`, the port of `pipecat.evals`, to test a bot end to end:

- Scripted and simulated scenarios in YAML, with users simulated by an LLM persona.
- TTS for the user's audio, with a disk cache.
- A client transport that connects to the bot as an RTVI client.
- Expectation matchers and an LLM judge (any `BaseClassifier`, or a factory).
- Results, multi-bot suites from a manifest, and subprocess sessions.
- The `pipedog-eval` CLI, with `run`, `judge` and `suite`.

`@pipedog/runner` now detects an eval harness's `eval-connect` message on `/ws` and builds the
eval transport. `@pipedog/evals` is an optional peer dependency of the runner.
