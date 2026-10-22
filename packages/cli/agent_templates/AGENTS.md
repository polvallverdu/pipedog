# AGENTS.md — Building pipedog Apps

> Guidance for AI coding agents building **applications** with pipedog, the TypeScript port of Pipecat.
> This is **not** about contributing to pipedog itself — for that, see the repository's own CLAUDE.md and docs/CONVENTIONS.md.
>
> Audience: any coding agent (Claude Code, Cursor, Codex, …).
> Docs index for LLMs: https://polvallverdu.github.io/pipedog/llms.txt

---

## 0. Golden rules (non-negotiable)

1. **Scaffold first. Never hand-write boilerplate.** Start every new app from the pipedog CLI scaffold (§1) — it generates a *runnable* bot (services + pipeline already wired), not a bare skeleton. Modify what it generates; don't rebuild it or invent your own structure.
2. **Don't guess — learn, then verify.** pipedog follows Pipecat, whose APIs your training data knows in Python and probably not in TypeScript. When a capability is unfamiliar, **learn how it works first** (§3 `search_docs`) instead of jumping into code; then confirm every class, import path and option against a **live source** (§3) as you write. Confidently-wrong APIs are the #1 failure mode.
3. **Make it verifiable before you make it fancy.** pipedog ships a behavioral **eval harness** (§6): scaffold with `--eval` and check every change by running scenarios headless — no live voice call. Stand up that loop before adding features.
4. **Ask for credentials; don't invent them.** Model names, voice IDs, and API keys are provider-specific and change often. If you don't have one, stop and ask — list exactly which keys are needed.

---

## 1. Start by scaffolding

Always begin from the deterministic CLI scaffold. It gives you a known-good structure, correct dependencies and a runnable entry point.

> ⚠️ **Agents: scaffold non-interactively** — bare `pipedog init` (no scaffold flags) opens an interactive wizard that **hangs an automated run**. Pass your choices as flags (or `--config`):

```bash
# Headless: any scaffold flag (--bot-type, a service, or --config) switches off the wizard.
# Run it in the project directory you're already in; `.` scaffolds in place, the name comes from the dir.
# The service values below are EXAMPLES — map the user's actual choices, don't copy these.
bunx @pipedog/cli init . \
  --transport smallwebrtc --mode cascade \
  --stt deepgram_stt --llm openai_llm --tts cartesia_tts \
  --eval                             # eval transport + a starter scenario, for verification (§6)
#   • `npx @pipedog/cli init .` does the same on Node. Add `--runtime node` for a Node project.
#   • Don't hand-write flags from memory — discover them:
#       pipedog init --help          # available flags
#       pipedog init --list-options  # valid service/transport VALUES, as JSON
#   • --dry-run prints the resolved config as JSON; --config project.json drives it from a file.
#   • --transport is repeatable — pass each transport you want (production + a local-dev one, §2).
#   • --bot-type is inferred from --transport (telephony if any telephony transport, else web) — omit it.
```

**Choose *with* the user, not for them.** Map their requirements to the real options and confirm transport / services / mode before scaffolding — don't silently pick or guess. Mode affects testing speed — **cascade (STT→LLM→TTS)** gets the fast text-mode eval loop (§6); **realtime (speech-to-speech)** is tested with audio scenarios.

The scaffold writes this guide, registers the docs MCP server for your coding agent (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`; pass `--no-mcp` to skip), and produces:

```
mybot/
├── server/
│   ├── bot.ts            # entry point: an async `bot(runnerArgs)` function + `main({ bot })`
│   ├── evals/            # a starter eval scenario, with --eval, cascade mode (§6)
│   ├── package.json      # @pipedog/* dependencies, pinned to one release
│   ├── tsconfig.json
│   ├── .env.example      # required env vars
│   └── Dockerfile        # with --dockerfile
├── client/               # a Vite client, with --client-framework vanilla
├── AGENTS.md, CLAUDE.md  # this guide
└── README.md
```

**`bot.ts` is a runnable bot, not a blank skeleton.** For the services you chose, the scaffold emits the **constructed service objects** (keys read from env), the `transportParams`, the canonical pipeline and context aggregators, the runner wiring, and an on-connect handler that speaks the first turn. **Modify it in place** — system prompt, function-calling tools (§4), business logic, the greeting — do **not** re-declare the service constructors, rebuild the pipeline, or write your own connect handler. Nearly every ported provider is a scaffold value; hand-wire a service only if `--list-options` genuinely doesn't list it.

Every bot exports an async `bot(runnerArgs)` entry point that the dev runner (`@pipedog/runner`) calls once per session. Keep that contract.

> If the user already has an app, do **not** re-scaffold — read their existing structure and follow it.

Run the bot with `bun bot.ts` (or `node bot.ts` on Node 22.18+) from `server/`, after `bun install` and copying `.env.example` to `.env`. `npm run typecheck` type-checks it.

---

## 2. Choosing transport & services

Transport and services are scaffold inputs (the `--transport` / `--stt` / `--llm` / `--tts` flags) — map the use case to them before you scaffold, and confirm exact class names and options via §3.

**Transport — by where the bot runs:**
- **Web / mobile voice** — `smallwebrtc` (peer-to-peer WebRTC, no account; Bun, Node and Deno, not Cloudflare Workers), `websocket` (Pipecat's WebSocket client transport; also runs on Workers), or `livekit`.
- **Telephony** — `twilio`, `telnyx`, `plivo` or `exotel`: a WebSocket media stream, with the provider's serializer chosen by the runner from the handshake.
- Not available: Daily (and so Daily PSTN and Twilio + Daily SIP), which isn't ported. **Cloudflare Workers** is not a scaffold option: see https://polvallverdu.github.io/pipedog/docs/deployment/cloudflare-workers and the repository's `examples/workers-durable-voice-agent`.

**Scaffold every transport you need at once** — repeat `--transport` (e.g. `--transport twilio --transport smallwebrtc`); the scaffold wires each one's params and dependencies. They coexist in `transportParams`; `-t <name>` (`bun bot.ts -t twilio`) picks one per run. A **telephony** bot can include `smallwebrtc` for local testing: the runner serves a browser client at `http://localhost:7860` so you can talk to the bot with no phone. Also useful: **the `eval` transport (§6)** — drive the bot headless with scripted scenarios to confirm behavior, tune prompts and catch regressions.

**Services** — STT, TTS, LLM are independent choices. Confirm the exact class, model name and options via §3; do not assume. Services are configured with a `settings` object (`new OpenAILLMService.Settings({ model, systemInstruction })`).

When the user describes a use case, find the closest page or example in the docs (§3 `search_docs`) and start there.

---

## 3. Find current truth (anti-staleness)

You have live sources for current truth — never substitute your memory. Use the **highest rung of this ladder that works right now**:

1. **The `pipedog` docs MCP server** (`@pipedog/mcp`; check your tool list). It runs locally over stdio and bundles the docs and API of the pipedog release it was published with, so it works offline. Tools:
   - `list_pages(section?)` — every page's slug, title and description.
   - `search_docs(query, limit?)` — keyword search; **learn the concept first** (turn detection, context, function calling, transports…).
   - `read_page(slug)` — a page in full, e.g. `services/stt/deepgram`.
   - `get_api(symbol)` — an exported class, function or type of the `@pipedog/*` packages: its **import path**, constructor and options interface, its declaration, and the pages that document it. **Run it on any symbol you're about to type from memory.**

   MCP servers are read only at session start. If the tools aren't in your list, tell the user to restart the session (the scaffold already wrote the config), and use rungs 2–3 meanwhile. To register it by hand: `claude mcp add pipedog -- npx -y @pipedog/mcp` (Claude Code), or `pipedog init --mcp` to write the project's config files for Claude Code, Cursor and VS Code. Pin it to the project's pipedog version with `npx -y @pipedog/mcp@<version>`.
2. **llms.txt** — the machine-readable docs index at https://polvallverdu.github.io/pipedog/llms.txt (every page by section, with a link to its Markdown); the whole docs in one file at `/llms-full.txt`; any page as Markdown by adding `.md` to its URL.
3. **The installed packages** — the pinned version is on disk and cannot be stale. Read the type declarations when the docs are ambiguous: `node_modules/@pipedog/<package>/dist/**/*.d.ts` (the sources are in `src/` when installed from a checkout).
4. **Pipecat's docs** (https://docs.pipecat.ai) explain the concepts, because pipedog is a port: class names, event names and wire formats are the same. Take **signatures and import paths from pipedog, not from Pipecat**: members are camelCase, constructors take one options object, and modules are `@pipedog/<package>/<upstream module path>`.

**Rule of thumb:** if you're about to type a pipedog class name, import path or service option from memory — stop and run `get_api` / `search_docs` first.

---

## 4. Mental model (concepts, not APIs)

These concepts are stable even as signatures change — internalize them so your code flows correctly.

**Terminology (current).** Get this vocabulary right:
- **Worker** — the top-level runnable unit. A single bot is a `PipelineWorker` (it wraps your pipeline), run by a `WorkerRunner`. There is no `PipelineTask`.
- **Job / job group** — cross-worker RPC in multi-worker apps. Don't call these "agents."
- **Task** — means *only* an asyncio-style task (`createTask` from `@pipedog/asyncio`). Don't use "task" for the runnable unit.

Core concepts:

- **Everything is a Frame moving through a pipeline of FrameProcessors.** Frames flow **downstream** (input → output) or **upstream** (errors/acknowledgments). A processor receives a frame, does its work, and pushes it along — by default in the direction it came.
- **Change a running pipeline by pushing frames, not by calling methods.** pipedog is real-time and ordered: push a frame (`LLMSetToolsFrame` to swap tools, a context message plus `LLMRunFrame` to make the bot speak) so the change stays in sequence with frames already in flight; reaching into an object directly jumps the queue and causes subtle ordering bugs. Find the right frame via §3. `worker.queueFrames([...])` queues frames from outside the pipeline.
- **A worker runs the show.** Wrap your pipeline in a `PipelineWorker`, then run it with a `WorkerRunner`: `await runner.addWorkers(worker)`, then `await runner.run()`. `await runner.cancel()` ends a session early (e.g. from an `on_client_disconnected` handler). In a scaffolded app the dev runner drives all of this per session via your `bot(runnerArgs)` entry point.
- **Pipeline order matters.** The canonical **cascade** voice loop is:
  ```
  transport.input()
    → STT
    → user context aggregator
    → LLM
    → TTS
    → transport.output()
    → assistant context aggregator
  ```
  **Realtime (speech-to-speech)** is the same loop **without STT and TTS** — the S2S service does both internally:
  ```
  transport.input()
    → user context aggregator
    → LLM (realtime S2S service)
    → transport.output()
    → assistant context aggregator
  ```
  In **both**, the **assistant aggregator goes after `transport.output()`** so it records what was actually produced. Getting this order wrong is a common, subtle bug.
- **Context aggregation** accumulates conversation messages for the LLM. User and assistant aggregators are created together (`new LLMContextAggregatorPair(context, …)`; `.user()` and `.assistant()`) and bracket the response leg as shown above.
- **The LLM's output is spoken.** TTS reads exactly what the LLM writes — markdown, emojis and bullet lists come out as noise. The scaffold's system instruction already guards this: *"Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken."* When you rewrite the prompt for the use case, **carry that sentence over**.
- **Instructions live in two places — don't pour everything into one.** Durable identity and rules live in the LLM's *system instruction* (`settings.systemInstruction`). Turn- or task-specific guidance goes as a **`developer`** message in the context (`context.addMessage({ role: "developer", content })`) — the scaffold's greeting already works this way. To seed or steer a turn yourself, add to the context and queue an `LLMRunFrame`; don't rewrite the system instruction mid-conversation.
- **Function calling (tools)** — how the bot *does* things, and where most of your app code goes. A tool is an async function whose first parameter is `params` (a `FunctionCallParams`); its name and parameter names come from the function, its description and parameter types from metadata attached to it, and it reports back through `params.resultCallback` — that's what feeds the result into the conversation so the LLM can speak it:
  ```ts
  const checkStock = Object.assign(
    async function check_stock(params: FunctionCallParams, item: string) {
      await params.resultCallback({ inStock: true });
    },
    {
      description: "Check whether an item is in stock.",
      parameters: { item: { type: "string", description: 'The item to look up, e.g. "tulips".' } },
    },
  );
  const context = new LLMContext({ tools: [checkStock] });
  ```
  Tools listed on the context register with the LLM service by themselves; there is no separate registration step. Direct functions must not be minified (their parameter names are read from the source). To share backend handles or per-session state across handlers, pass `appResources` to `PipelineWorker` and read `params.appResources` (don't use globals). An explicit-schema path (`FunctionSchema` with a `handler`) exists for dynamic tool sets — confirm via §3.
- **Ending the conversation from a tool** (the "goodbye" / hang-up feature nearly every phone bot needs) — push `EndWorkerFrame` from the handler, *after* reporting the result:
  ```ts
  await params.resultCallback({ success: true });
  await params.llm.pushFrame(new EndWorkerFrame());
  ```
  Downstream (the default) is correct: queued frames flush, so the bot can finish speaking before the pipeline ends. Don't invent shutdown paths (`process.exit`, cancelling tasks).
- **A turn has two phases — start and stop — each driven by a strategy.** The defaults the scaffold wires: Silero VAD (and transcription) to detect the user *starting*; Smart Turn to detect them *stopping*. These defaults are tuned — to change turn-taking, swap or configure the strategies via §3 (`search_docs "turn strategies"`) rather than hand-tweaking timings blind.
- **Interruptions** — when the user barges in, an interruption propagates and clears in-flight work. Most apps get this for free from the turn strategy.
- **Cancellation is cooperative.** pipedog gives JavaScript asyncio's semantics through `@pipedog/asyncio`. Inside a `FrameProcessor` (or any `BaseObject`), start background work with `this.createTask(() => this.work(), "name")` so it is tracked and cancelled on shutdown; cancel with `await this.cancelTask(task)`. A broad `catch` in your own processor starts with `rethrowIfCancelled(e)`, or it swallows cancellations. Never leave a promise floating.
- **TypeScript rules.** The packages use erasable syntax only (no `enum`, `namespace` or constructor parameter properties), so Bun and Node run `.ts` directly. Constructors take **one options object**; event names (`"on_client_connected"`) and wire formats keep Pipecat's snake_case.
- **Structured conversations (Flows)** — when the conversation has distinct *stages* with different rules (intake → order → payment → confirmation), don't pile every instruction and tool into one giant system prompt. `@pipedog/flows` layers a state machine over the pipeline: each node gets its own prompt, tools and actions, with explicit transitions, as code or as a YAML/JSON `FlowConfig`. A single context plus tools is right for most bots; reach for Flows when the prompt or tool set must *change per stage*, or the process must be enforced. Confirm the APIs via §3 (`search_docs "flows"`) before writing Flows code.
- **Multi-worker (advanced)** — several concurrently running workers cooperating over a shared bus, calling each other via jobs. Reach for this only when one pipeline genuinely isn't enough. Stages *within* one conversation are Flows territory.

---

## 5. Secrets & environment

- Keep a `.env.example` listing every key the app needs; never commit real keys. The dev runner loads `.env` from the working directory.
- Before running anything, check which providers are wired and confirm the user has the corresponding keys. The generated bot refuses to start without its required variables and names the missing ones. If a key is missing, **stop and ask** — name the provider and the env var.

---

## 6. Verify your work (the eval harness)

A voice app can't be eyeballed like a web page, but you don't need a live call to test it. `@pipedog/evals` (the port of Pipecat's evals) is a **behavioral eval harness**: a **scenario** is a YAML file the harness plays against your *running bot*, end to end, as an RTVI client. Every scenario has a **kind**:

- **Scripted** — you write the user's turns out and assert what the bot does after each: `text_contains`, a `function_call` with its args, `within_ms` latency, or an `eval:` criterion for an LLM judge. Same input every run, so a failure is reproducible. The inner loop: run it constantly.
- **Simulated** — an LLM plays a caller with a persona and a goal; a judge reads the whole conversation and decides `success:` and scores `metrics:`.

and a **modality**: *text* (the default: the user's turns are sent as text and the LLM's text read back, so only the brain runs) or *audio* (synthesized speech in, transcription out, so VAD, STT and TTS run too). Audio scenarios need a `factory:` for the user's voice and the bot's transcript, because upstream's keyless local defaults (Kokoro, Moonshine) aren't ported.

**The judge.** Only `eval:` criteria, `success:` and judged `metrics:` need it; deterministic checks don't. The default is a local Ollama (`gemma4:12b`), or point `judge.eval` at another LLM through a `factory:` (`<module>.<export>`: a function that takes the block and returns an OpenAI-compatible service). If neither is available, ask the user.

> **Deep reference:** https://polvallverdu.github.io/pipedog/docs/evals — look it up via `read_page("evals")` (§3).

**Make your bot eval-able.** Scaffold with `--eval` whenever you intend to test the bot. The generated bot has the `eval` entry in `transportParams` and a **runnable starter scenario in `server/evals/starter_text.yaml`** (cascade). It passes against the fresh scaffold, so run it *first* to prove the loop, then edit it to match the bot you're building and copy it to grow the suite. For an **existing** bot, add the transport entry by hand (RTVI is on by default for `PipelineWorker`, so this is the only edit):
```ts
import { EvalTransportParams } from "@pipedog/evals/transport";

const transportParams = {
  eval: () => new EvalTransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  // ... your real transports stay as-is
};
```
**Boot it.** `bun bot.ts` starts the dev runner, which the eval harness connects to (default `ws://localhost:7860/ws`); each scenario gets a fresh bot session, and "no exceptions + pipeline assembled" is your fastest "did I wire it right" signal. Keep its stdout greppable (`bun bot.ts 2>&1 | tee /tmp/pipedog-output.txt`) so when a scenario fails you grep for the stack trace instead of re-running. The runner stays up between runs, so boot once and drive scenario after scenario from a second terminal:
```bash
bunx pipedog eval run evals/starter_text.yaml -v
```
Exit code is non-zero if any scenario fails. `pipedog eval suite` runs many at once from a manifest; `pipedog eval judge` judges saved conversations. Assert on what the bot *produced*, and prefer the modality-agnostic `response` event.

**Also run the type check** — `npm run typecheck` in `server/` — after every change: most mistakes in a generated bot are a wrong option name, and `tsc` finds them in a second.

---

## 7. Deploying

The dev runner is a **development** server. For production, host the bot behind your own HTTPS:
- **A server or container** — the scaffold's `--dockerfile` writes a Dockerfile (Bun or Node) that runs the bot with `--host 0.0.0.0`. See https://polvallverdu.github.io/pipedog/docs/deployment/servers.
- **Vercel** and **Cloudflare Workers** (WebSocket transports only; no WebRTC, and provider-side turn detection instead of local models) have their own guides under https://polvallverdu.github.io/pipedog/docs/deployment.
- pipedog has no counterpart of Pipecat Cloud (`pipecat cloud`): don't generate its deploy config or reach for that plugin.

**Before deploying, confirm the target with the user** — you can't create their accounts or set their secrets for them. Set the same environment variables as `.env` in the host's secret store.
