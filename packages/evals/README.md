# @pipedog/evals

Pipecat's evals (`pipecat.evals`) for pipedog: test a running bot end to end. The harness
connects to the bot as an RTVI client and plays the user's side of a conversation, in text or
synthesized speech. It checks what the bot does against a YAML scenario.

- **Scripted scenarios** (`script.ts`): the user's turns and the events expected after each one.
  Checks cover text, function calls, markers, images and latency budgets, and can ask an LLM
  judge.
- **Simulations** (`simulation.ts`, `persona.ts`): an LLM persona with a goal talks to the bot,
  and a judge scores the conversation (`simulation_judge.ts`).
- **The judge** (`judge.ts`): any `BaseClassifier` or OpenAI-compatible LLM. An explainer LLM
  gives reasons for a `no`.
- **Services** (`services.ts`, `tts.ts`): the judge, the user's voice (cached on disk) and the
  bot-speech transcriber, built from the scenario's `factory:` entries.
- **Sessions** (`session.ts`): `EvalSession.fromScenario(scenario, botUrl).run()`. The client
  (`client.ts`, `client_transport.ts`) connects to the runner's `/ws`.
- **Suites** (`suite.ts`): a manifest of bots and scenarios. The suite spawns each bot, then runs
  the scenarios concurrently, each in its own process (`_session_subprocess.ts`), with repeats.
- **The `pipedog-eval` CLI** (`cli.ts`): `run`, `judge` and `suite`, the port of `pipecat eval`.
- **The bot side**: the eval serializer and transport (`serializer.ts`, `fastapi_transport.ts`).
  `@pipedog/runner`'s `createTransport()` builds them when a harness connects.

```sh
bun add -d @pipedog/evals
bunx pipedog-eval run scenarios/capital.yaml --bot-url ws://localhost:7860/ws
```

## Example

```yaml
# scenarios/capital.yaml
name: capital
judge:
  eval:
    factory: ./my_evals.ts.llm # an export of my_evals.ts that returns an LLM service
scenarios:
  - name: capital_question
    turns:
      - expect:
          - event: response
            eval: "the bot greets the user"
      - user: "What is the capital of Germany?"
        expect:
          - event: response
            text_contains: Berlin
```

```ts
import { EvalScenarioFile, EvalSession } from "@pipedog/evals";

const file = await EvalScenarioFile.load("scenarios/capital.yaml");
const session = await EvalSession.fromScenario(file.get("capital/capital_question"), "ws://localhost:7860/ws");
const result = await session.run();
console.log(result.passed);
```

The guide: https://polvallverdu.github.io/pipedog/docs/evals/

## Runtimes

Every module imports on Bun, Node, Deno and Workers. Running the harness, the suite and the CLI
needs Bun or Node: they use `node:net`, `node:fs` and `node:child_process`, imported lazily where
they are used.

## Differences from upstream

- **Audio defaults.** Upstream's keyless local audio services aren't ported: Kokoro for the user's
  voice, and Moonshine or local Whisper for the transcriber. Audio scenarios name a `factory:`
  for both, e.g. OpenAI's TTS and STT from `@pipedog/openai`.
- **Audio files.** `audio:` recordings are read by a built-in WAV reader; other formats need a
  decoder (`setUserAudioDecoder`).
- **Images.** The bot's eval serializer decodes the harness's PNG images itself; other formats need
  an `imageDecoder`.
- **Factories.** A `factory:` is `<module>.<export>` (a path, a package or a `file:` URL), loaded
  with `import()`. Because of that, the service builders, `EvalJudge.fromConfig()`,
  `EvalScenarioFile.load()` and `EvalSession.fromScenario()` are async.
- **The CLI.** The `pipedog-eval` bin replaces `python -m pipecat.evals` and `pipecat eval`. A
  plain-ANSI table replaces rich's live dashboard. A small built-in loader reads `.env`.
- **Not ported (deprecated upstream).** The `EvalTransport` server, `pipecat.evals.harness`, flat
  scenario files, `trigger_disconnect`, `stop_bot`, `service: openai` and `service: cartesia`.
