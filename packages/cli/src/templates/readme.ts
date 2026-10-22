// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/templates/README.md.jinja2

/**
 * The generated project's `README.md`.
 *
 * DIVERGENCE: upstream's README has blocks for Daily PSTN and Twilio + Daily SIP, Pipecat Cloud,
 * Whisker and the Context Hub, and shows `uv` commands. Here the phone setup uses the runner's
 * own webhook (`POST /`, which answers with the provider's XML, so no TwiML Bin is needed), the
 * observability block describes OpenTelemetry tracing, and the coding-agent block points at
 * `@pipedog/mcp` and the docs' llms.txt.
 */

import type { ProjectConfig } from "../questions.ts";
import { ServiceRegistry } from "../service_metadata.ts";
import { requiredEnv } from "./server_bot.ts";

export const DOCS_URL = "https://polvallverdu.github.io/pipedog";

function label(value: string | null, list: readonly { value: string; label: string }[]): string {
  return value ? (list.find((s) => s.value === value)?.label ?? value) : "";
}

/** The commands that install and run the project, for its runtime. */
export function commands(config: ProjectConfig): {
  install: string;
  run: string;
  exec: string;
  clientInstall: string;
  clientDev: string;
} {
  const bun = config.runtime === "bun";
  return {
    install: bun ? "bun install" : "npm install",
    run: bun ? "bun bot.ts" : "node bot.ts",
    exec: bun ? "bunx" : "npx",
    clientInstall: bun ? "bun install" : "npm install",
    clientDev: bun ? "bun run dev" : "npm run dev",
  };
}

function telephonySetup(config: ProjectConfig): string[] {
  const { run } = commands(config);
  const out: string[] = [];
  const has = (t: string) => config.transports.includes(t);
  out.push("### Phone calls", "");
  out.push(
    "A phone provider reaches the bot over a public URL. Expose the local runner with a tunnel:",
    "",
    "```bash",
    "ngrok http 7860",
    "```",
    "",
    "Then start the bot for your provider, with the tunnel's host name as `--proxy`:",
    "",
    "```bash",
  );
  for (const [provider, name] of [
    ["twilio", "Twilio"],
    ["telnyx", "Telnyx"],
    ["plivo", "Plivo"],
    ["exotel", "Exotel"],
  ] as const) {
    if (has(provider)) out.push(`${run} -t ${provider} --proxy your-url.ngrok.io   # ${name}`);
  }
  out.push("```", "");
  out.push(
    "The runner answers the provider's webhook (`POST /`) with the XML that connects the call to",
    "`wss://your-url.ngrok.io/ws`, so no TwiML or TeXML Bin is needed.",
    "",
  );
  if (has("twilio")) {
    out.push(
      "#### Twilio",
      "",
      "1. In the [Twilio Console](https://console.twilio.com), open **Phone Numbers** → **Manage** → **Active Numbers** and click your number.",
      "2. Under **Voice Configuration**, set **A call comes in** to **Webhook**, method **POST**, URL `https://your-url.ngrok.io/`.",
      "3. Save, and call the number.",
      "",
      "Set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env` so the bot can hang up the call when it ends.",
      "",
    );
  }
  if (has("telnyx")) {
    out.push(
      "#### Telnyx",
      "",
      "1. In the [Telnyx Portal](https://portal.telnyx.com/), [buy a number](https://portal.telnyx.com/#/numbers/buy-numbers) if you don't have one.",
      "2. Create a [TeXML application](https://portal.telnyx.com/#/call-control/texml) with the **Voice Method** `POST` and the webhook URL `https://your-url.ngrok.io/`.",
      "3. Assign the application to your number under [Manage Numbers](https://portal.telnyx.com/#/numbers/my-numbers), and call it.",
      "",
      "Set `TELNYX_API_KEY` in `.env` so the bot can hang up the call when it ends.",
      "",
    );
  }
  if (has("plivo")) {
    out.push(
      "#### Plivo",
      "",
      "Create a Plivo application whose **Answer URL** is `https://your-url.ngrok.io/` (method `POST`), and attach it to your number.",
      "Set `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN` in `.env` so the bot can hang up the call when it ends.",
      "",
    );
  }
  if (has("exotel")) {
    out.push(
      "#### Exotel",
      "",
      "In an Exotel flow, add a **Voicebot** applet that streams to `wss://your-url.ngrok.io/ws`. `POST /` returns that URL.",
      "",
    );
  }
  return out;
}

/** Render the generated `README.md`. */
export function renderReadme(config: ProjectConfig): string {
  const { install, run, exec, clientInstall, clientDev } = commands(config);
  const allTransports = [
    ...ServiceRegistry.WEBRTC_TRANSPORTS,
    ...ServiceRegistry.TELEPHONY_TRANSPORTS,
  ];
  const transportLabels = config.transports.map((t) => label(t, allTransports));
  const hasTelephony = config.transports.some((t) =>
    ServiceRegistry.TELEPHONY_TRANSPORTS.some((d) => d.value === t),
  );
  const out: string[] = [];

  out.push(`# ${config.projectName}`, "");
  out.push(
    `A [pipedog](${DOCS_URL}) voice agent built with ${config.mode === "cascade" ? "a cascade pipeline (STT → LLM → TTS)" : "a realtime speech-to-speech pipeline"}.`,
    "",
  );

  out.push("## Configuration", "");
  out.push(`- **Bot type**: ${config.botType === "web" ? "Web" : "Telephony"}`);
  out.push(`- **Transport(s)**: ${transportLabels.join(", ")}`);
  out.push(`- **Runtime**: ${config.runtime === "bun" ? "Bun" : "Node.js (22.18 or later)"}`);
  if (config.mode === "cascade") {
    out.push("- **Pipeline**: Cascade");
    out.push(`  - **STT**: ${label(config.sttService, ServiceRegistry.STT_SERVICES)}`);
    out.push(`  - **LLM**: ${label(config.llmService, ServiceRegistry.LLM_SERVICES)}`);
    out.push(`  - **TTS**: ${label(config.ttsService, ServiceRegistry.TTS_SERVICES)}`);
  } else {
    out.push("- **Pipeline**: Realtime");
    out.push(
      `  - **Service**: ${label(config.realtimeService, ServiceRegistry.REALTIME_SERVICES)}`,
    );
  }
  const features: string[] = [];
  if (config.videoService) {
    features.push(`Video avatar (${label(config.videoService, ServiceRegistry.VIDEO_SERVICES)})`);
  }
  if (config.videoInput) features.push("Video input");
  if (config.videoOutput) features.push("Video output");
  if (config.recording) features.push("Audio recording");
  if (config.transcription) features.push("Transcription");
  if (config.enableObservability) features.push("Observability (OpenTelemetry tracing)");
  if (features.length > 0) {
    out.push("- **Features**:");
    for (const f of features) out.push(`  - ${f}`);
  }
  const notes = config.transports
    .concat(
      [
        config.sttService,
        config.llmService,
        config.ttsService,
        config.realtimeService,
        config.videoService,
      ].filter((v): v is string => Boolean(v)),
    )
    .map((value) =>
      [
        ...allTransports,
        ...ServiceRegistry.STT_SERVICES,
        ...ServiceRegistry.LLM_SERVICES,
        ...ServiceRegistry.TTS_SERVICES,
        ...ServiceRegistry.REALTIME_SERVICES,
        ...ServiceRegistry.VIDEO_SERVICES,
      ].find((s) => s.value === value),
    )
    .filter((s) => s?.note)
    .map((s) => `- ${s?.label}: ${s?.note}`);
  if (notes.length > 0) {
    out.push("", "> **Runtime notes**", ...notes.map((n) => `> ${n}`));
  }
  out.push("");

  out.push("## Setup", "");
  if (hasTelephony) {
    out.push(...telephonySetup(config));
  }

  out.push("### Server", "");
  out.push(
    "1. **Navigate to the server directory**:",
    "",
    "   ```bash",
    "   cd server",
    "   ```",
    "",
  );
  out.push("2. **Install dependencies**:", "", "   ```bash", `   ${install}`, "   ```", "");
  out.push(
    "3. **Configure environment variables**:",
    "",
    "   ```bash",
    "   cp .env.example .env",
    "   # Edit .env and add your API keys",
    "   ```",
    "",
  );
  const required = requiredEnv(config);
  if (required.length > 0) {
    out.push(`   Required: ${required.map((n) => `\`${n}\``).join(", ")}.`, "");
  }
  out.push("4. **Run the bot**:", "", "   ```bash", `   ${run}`, "   ```", "");
  out.push(
    "   The runner serves every transport; the caller selects which one (a web client picks its",
    "   transport when it connects, and a telephony provider connects to `/ws`).",
    "",
  );
  if (config.botType === "web") {
    out.push(
      "   Open <http://localhost:7860> for the runner's built-in client, click **Connect** and talk to the bot.",
      "",
    );
  }
  if (config.runtime === "bun") {
    out.push("   Prefer Node.js? `node bot.ts` works too (22.18 or later).", "");
  } else {
    out.push("   Prefer Bun? `bun bot.ts` runs the same file.", "");
  }
  out.push(
    "5. **Check the types** (optional):",
    "",
    "   ```bash",
    "   npm run typecheck",
    "   ```",
    "",
  );

  if (config.enableEval) {
    out.push("## Testing with evals", "");
    out.push(
      "This project includes behavioral evals: scripted conversations that drive the bot headless, with no live call.",
    );
    if (config.mode === "cascade") {
      out.push(
        "A starter scenario lives in `server/evals/`; edit it as your bot takes shape and copy it to add more.",
        "",
        "From `server/`, run the bot, then drive the scenario from a second terminal (the bot stays up across runs):",
        "",
        "```bash",
        run,
        "# In another terminal:",
        `${exec} pipedog eval run evals/starter_text.yaml -v`,
        "```",
        "",
        "`eval:` criteria are scored by a judge LLM, a local Ollama by default (`ollama pull gemma4:12b`).",
        `See the [evals guide](${DOCS_URL}/docs/evals) for the scenario format and for judging with another model.`,
        "",
      );
    } else {
      out.push(
        "A realtime bot has no separate text step, so it is tested with audio scenarios, which need a speech",
        "factory for the user's voice and the bot's transcript.",
        `See the [evals guide](${DOCS_URL}/docs/evals) to write one.`,
        "",
      );
    }
  }

  if (config.generateClient) {
    out.push("### Client", "");
    out.push(
      "1. **Navigate to the client directory**:",
      "",
      "   ```bash",
      "   cd client",
      "   ```",
      "",
    );
    out.push("2. **Install dependencies**:", "", "   ```bash", `   ${clientInstall}`, "   ```", "");
    out.push(
      "3. **Configure environment variables** (optional; it defaults to `http://localhost:7860/start`):",
      "",
      "   ```bash",
      "   cp env.example .env.local",
      "   ```",
      "",
      "   > **Note:** Environment variables in Vite are bundled into the client and exposed in the browser.",
      "",
    );
    out.push(
      "4. **Run the development server**:",
      "",
      "   ```bash",
      `   ${clientDev}`,
      "   ```",
      "",
    );
    out.push("5. **Open the browser**: <http://localhost:5173>", "");
  }

  out.push("## Project structure", "", "```", `${config.projectName}/`);
  out.push("├── server/                # Bot server");
  out.push("│   ├── bot.ts             # The bot: services, pipeline and event handlers");
  if (config.enableEval && config.mode === "cascade") {
    out.push("│   ├── evals/             # Behavioral eval scenarios");
  }
  out.push("│   ├── package.json       # Dependencies and scripts");
  out.push("│   ├── tsconfig.json      # Type-check settings");
  out.push("│   ├── .env.example       # Environment variables template");
  out.push("│   ├── .env               # Your API keys (not committed)");
  if (config.dockerfile) out.push("│   ├── Dockerfile         # Container image");
  if (config.generateClient) {
    out.push("├── client/                # Vanilla JS client (Vite)");
    out.push("│   ├── src/               # Client source code");
    out.push("│   └── package.json       # Client dependencies");
  }
  out.push("├── AGENTS.md              # Guide for coding agents");
  out.push("├── CLAUDE.md              # Imports AGENTS.md for Claude Code");
  out.push("├── .gitignore");
  out.push("└── README.md              # This file", "```", "");

  if (config.dockerfile) {
    out.push("## Docker", "");
    out.push(
      "The Dockerfile in `server/` builds an image that runs the bot on the runner:",
      "",
      "```bash",
      "cd server",
      `docker build -t ${config.projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")} .`,
      `docker run --env-file .env -p 7860:7860 ${config.projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
      "```",
      "",
      "The runner is a development server: serve a production bot behind your own HTTPS, and see",
      `[Deployment](${DOCS_URL}/docs/deployment) for servers, Vercel and Cloudflare Workers.`,
      "",
    );
  }

  if (config.enableObservability) {
    out.push("## Observability", "");
    out.push(
      "The bot is instrumented with OpenTelemetry (`@pipedog/tracing`): each conversation is traced, with its turns",
      "and the speech-to-text, LLM and text-to-speech calls in them. Tracing is off until you point it at an",
      "OTLP/HTTP endpoint:",
      "",
      "```bash",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces",
      "```",
      "",
      `Any OTLP backend works (Jaeger, Langfuse, Honeycomb). See [Metrics and tracing](${DOCS_URL}/docs/concepts/metrics-and-tracing).`,
      "",
    );
  }

  out.push("## Building with an AI coding agent", "");
  out.push(
    "Extending this bot with Claude Code, Cursor, Codex or another coding assistant? `AGENTS.md` (and `CLAUDE.md`, which imports it)",
    "tell the agent how pipedog projects work. For current, accurate API knowledge instead of stale training data, give it the docs:",
    "",
    `- [llms.txt](${DOCS_URL}/llms.txt): the index of every docs page, as Markdown.`,
    "- The docs MCP server, `@pipedog/mcp`, which runs locally and bundles the docs of your pipedog version:",
    "",
    "```bash",
    "claude mcp add pipedog --scope project -- npx -y @pipedog/mcp   # Claude Code",
    `${exec} pipedog init . --mcp                                       # Claude Code, Cursor and VS Code`,
    "```",
    "",
  );

  out.push("## Learn more", "");
  out.push(`- [pipedog documentation](${DOCS_URL}/docs)`);
  out.push("- [pipedog on GitHub](https://github.com/polvallverdu/pipedog)");
  out.push(
    "- [Pipecat documentation](https://docs.pipecat.ai/) (pipedog is a port of Pipecat, so its concepts carry over)",
    "",
  );

  return out.join("\n");
}
