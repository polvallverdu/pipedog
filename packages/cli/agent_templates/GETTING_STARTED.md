# Getting Started — Building pipedog Bots with a Coding Agent

**This file is for you**: how to drive your coding agent well. The other
files here (`AGENTS.md`, `CLAUDE.md`) are the agent's guide, instructing
it how to write, run, and test pipedog code.

## The docs MCP server

Your agent needs a live source of pipedog truth: its #1 failure mode is
confidently writing APIs from memory. pipedog is a TypeScript port of
Pipecat, and models know Pipecat's Python much better than its TypeScript
names and import paths. **`@pipedog/mcp`** is a local MCP server with the
pipedog docs: it lists, searches and reads the pages, and looks up the import
path, constructor and options of any exported class. It bundles the docs of
the release it was published with, so it works offline.

`pipedog init` set it up: it wrote the server's config for the coding agents
it supports, in the project:

| Agent | File |
|---|---|
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |

MCP servers load when a session starts, so open your coding session in this
directory *after* `init`. (Claude Code asks you to approve a project's
servers the first time.) For another agent, or to add it for every project:

```bash
claude mcp add pipedog -- npx -y @pipedog/mcp        # Claude Code, for you
```

and see https://polvallverdu.github.io/pipedog/docs/guides/llms for Windsurf and others.
The server needs Node.js 20 or later (`npx`). Pin it to your pipedog version
(`npx -y @pipedog/mcp@<version>`) so its docs match the packages you install.

Without MCP, point your agent at https://polvallverdu.github.io/pipedog/llms.txt:
the docs index, with a Markdown version of every page.

## Your first prompt: write a spec, not a wish

What you say first is the biggest factor in what you get back. "Build me a
phone bot" buys a long round of clarifying questions; a prompt like this
produces a working bot on the first pass. Copy it and edit:

```text
I'm building a phone assistant for my flower shop, Field & Flower, that
takes customer orders.

The bot should be able to:
  - list the available bouquets
  - check if a specific flower is in stock
  - add a flower to the order
  - get a summary of the order
  - set the delivery details
  - place the order
  - end the call

When the call starts, the bot greets the caller with exactly:
"This is Field & Flower, your local flower shop. How can I help you today?"

Services:
  - Twilio for phone calls
  - STT: Deepgram
  - LLM: OpenAI
  - TTS: Cartesia
  - Run it on Bun

This is a demo: use a mock backend for the flower data, and "place the
order" only needs to log the order.
```

Why this works:

- **The use case and channel are explicit** (phone assistant, Twilio), so the
  agent scaffolds the right transport instead of guessing.
- **Capabilities are a list.** Each line becomes a tool the bot can call;
  vague verbs become vague tools.
- **Wording that matters is quoted.** If a greeting, name, or phrase must be
  exact, say so verbatim — otherwise the LLM improvises.
- **Services are named.** Don't know yet? Say "help me choose" — the agent is
  instructed to confirm choices with you rather than silently pick.
- **Mock vs. real is declared**, so the agent builds exactly the backend you
  asked for and nothing more.

## During the session

- **Answer its option questions.** The agent confirms transport, services,
  and runtime before scaffolding — a quick answer beats a wrong guess.
- **Have your API keys ready.** It will stop and ask rather than invent them;
  the generated `.env.example` lists everything the bot needs.
- **Iterate one feature at a time** once the first version works — small asks
  keep the verification loop fast.

## Testing your bot

A voice bot can't be eyeballed, but you don't need a live call to test it. The
project can scaffold with a **headless eval harness** (`--eval`) — the agent
verifies its own work by running scripted conversations against the bot, so
after any change "run the evals" is a fair ask.

- **LLM judge (optional).** Some eval checks use an LLM judge. If you already
  have a local model (via [Ollama](https://ollama.com)) the agent uses it for
  free; otherwise it'll ask whether to download one (~a few GB) or to judge
  with another provider.
- **Talk to it yourself.** Building a phone bot? You don't need a phone — the
  agent can wire up a free, peer-to-peer browser test transport (SmallWebRTC);
  open http://localhost:7860 and have a voice conversation while you iterate
  (ask for it if you don't see it).

## Learn more

Docs, quickstart, and the full API reference: https://polvallverdu.github.io/pipedog
