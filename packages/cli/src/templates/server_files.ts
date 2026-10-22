// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/templates/server/env.example.jinja2

/**
 * The generated server's supporting files: `package.json` and `tsconfig.json` (upstream's
 * `pyproject.toml`), `.env.example`, the Dockerfile and the starter eval scenario.
 *
 * DIVERGENCE: `pyproject.toml` lists `pipecat-ai[extras]>=1.12.0`; `package.json` lists the
 * `@pipedog/*` packages the bot imports (found from its imports) at the release the CLI belongs
 * to, plus the third-party packages they need. Upstream's `pcc-deploy.toml` and its
 * `pipecat-base` Dockerfile are Pipecat Cloud's and are not generated; the Dockerfile here is a
 * plain Bun or Node image. `starter_audio.yaml` is not generated: audio scenarios need a speech
 * factory for the user's voice and the bot's transcript (upstream's local Kokoro and Moonshine
 * defaults aren't ported).
 */

import type { ProjectConfig } from "../questions.ts";
import { ServiceLoader } from "../service_loader.ts";
import { ServiceRegistry } from "../service_metadata.ts";
import { featuresOf, servicesOf } from "./server_bot.ts";

/** The release of `@pipedog/*` the generated project is written against (the CLI's own). */
export interface TemplateContext {
  /** The `@pipedog/*` version, e.g. `0.6.1`; dependencies are `^<version>`. */
  version: string;
}

/** An npm package name from a project name: lowercase, URL-safe, no leading dot or underscore. */
export function npmName(projectName: string): string {
  const name = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name || "pipedog-bot";
}

/** The `@pipedog/*` and third-party dependencies of the generated server. */
export function serverDependencies(
  config: ProjectConfig,
  ctx: TemplateContext,
): Record<string, string> {
  const packages = ServiceLoader.extractPackagesForServices(servicesOf(config), featuresOf(config));
  const deps: Record<string, string> = {};
  for (const [name, range] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    deps[name] = range === "pipedog" ? `^${ctx.version}` : range;
  }
  return deps;
}

/** `server/package.json`. */
export function renderPackageJson(config: ProjectConfig, ctx: TemplateContext): string {
  const bun = config.runtime === "bun";
  const run = bun ? "bun" : "node";
  const scripts: Record<string, string> = {
    start: `${run} bot.ts`,
    dev: `${run} --watch bot.ts`,
    typecheck: "tsc --noEmit",
  };
  if (config.enableEval) scripts.eval = "pipedog eval";
  const devDependencies: Record<string, string> = {
    [bun ? "@types/bun" : "@types/node"]: bun ? "^1.4.3" : "^24.19.1",
    typescript: "^7.0.2",
  };
  if (config.enableEval) devDependencies["@pipedog/cli"] = `^${ctx.version}`;
  const pkg: Record<string, unknown> = {
    name: npmName(config.projectName),
    private: true,
    version: "0.0.0",
    type: "module",
    scripts,
    dependencies: serverDependencies(config, ctx),
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  if (!bun) pkg.engines = { node: ">=22.18" };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** `server/tsconfig.json`: the type-check settings the @pipedog packages are written against. */
export function renderTsconfig(config: ProjectConfig): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      moduleDetection: "force",
      strict: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noEmit: true,
      types: [config.runtime === "bun" ? "bun" : "node"],
    },
    include: ["*.ts"],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

/** `server/.env.example`: the environment variables of the selected services, by service. */
export function renderEnvExample(config: ProjectConfig): string {
  const sections: string[] = [];
  const all = [
    ...ServiceRegistry.WEBRTC_TRANSPORTS,
    ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ...ServiceRegistry.STT_SERVICES,
    ...ServiceRegistry.LLM_SERVICES,
    ...ServiceRegistry.TTS_SERVICES,
    ...ServiceRegistry.REALTIME_SERVICES,
    ...ServiceRegistry.VIDEO_SERVICES,
  ];
  const selected: { value: string; kind: string }[] = [
    ...config.transports.map((value) => ({ value, kind: "Transport" })),
    ...(config.mode === "cascade"
      ? [
          { value: config.sttService, kind: "Speech-to-Text" },
          { value: config.llmService, kind: "LLM" },
          { value: config.ttsService, kind: "Text-to-Speech" },
        ]
      : [{ value: config.realtimeService, kind: "Realtime" }]),
    { value: config.videoService, kind: "Video" },
  ].filter((s): s is { value: string; kind: string } => Boolean(s.value));

  const seen = new Set<string>();
  for (const { value, kind } of selected) {
    const def = all.find((d) => d.value === value);
    if (!def) continue;
    const lines: string[] = [`# ${def.label} (${kind})`];
    if (def.note) lines.push(`# ${def.note}`);
    for (const env of ServiceLoader.getEnvVars(def)) {
      // One service's key can serve another (OPENAI_API_KEY for STT, LLM and TTS): list it once.
      if (seen.has(env.name)) continue;
      seen.add(env.name);
      if (env.description) lines.push(`# ${env.description}`);
      if (env.required) {
        lines.push(`${env.name}=`);
      } else {
        lines.push(`# ${env.name}=${env.default ?? ""}`);
      }
    }
    if (lines.length > 1 || def.note) sections.push(lines.join("\n"));
  }

  if (config.enableObservability) {
    sections.push(
      [
        "# Tracing (OpenTelemetry)",
        "# An OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces. Tracing is off without it.",
        "# OTEL_EXPORTER_OTLP_ENDPOINT=",
      ].join("\n"),
    );
  }
  return `# ${config.projectName} - Environment Variables\n# Copy this file to .env and fill in your API keys\n\n${sections.join("\n\n")}\n`;
}

/** `server/Dockerfile`: a plain Bun or Node image (Pipecat Cloud's base image isn't used). */
export function renderDockerfile(config: ProjectConfig): string {
  if (config.runtime === "bun") {
    return `FROM oven/bun:1

WORKDIR /app

# Install the dependencies first, so the layer is cached until they change
COPY package.json bun.lock* ./
RUN bun install --production

# Copy the application code
COPY bot.ts ./

EXPOSE 7860

# The runner listens on localhost by default; a container has to listen on every interface.
CMD ["bun", "bot.ts", "--host", "0.0.0.0"]
`;
  }
  return `FROM node:24-slim

WORKDIR /app

# Install the dependencies first, so the layer is cached until they change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the application code
COPY bot.ts ./

EXPOSE 7860

# The runner listens on localhost by default; a container has to listen on every interface.
CMD ["node", "bot.ts", "--host", "0.0.0.0"]
`;
}

/** `server/evals/starter_text.yaml`: a text-mode scenario that passes against a fresh bot. */
export function renderEvalScenario(config: ProjectConfig): string {
  const run = config.runtime === "bun" ? "bun" : "node";
  return `name: starter_text

# Starter eval scenario for ${config.projectName}, in text mode (the fast inner loop).
#
# Text mode (the default) bypasses VAD, STT and TTS: each \`user:\` turn is sent as text and the
# judge reads the LLM's text output. Use it to test the bot's *decisions* (prompt adherence,
# function calls, multi-turn context) on every edit.
#
# Run it (two terminals, both in server/):
#
#   ${run} bot.ts                                              # 1: the bot
#   ${config.runtime === "bun" ? "bunx" : "npx"} pipedog eval run evals/starter_text.yaml -v   # 2: this scenario
#
# The bot stays up across runs, so leave it running and re-run evals as you edit.
#
# \`eval:\` criteria are scored by a judge LLM, by default a local Ollama
# (\`ollama pull gemma4:12b\`). To judge with another model, point \`factory:\` at a module of yours
# that returns the LLM service (see https://polvallverdu.github.io/pipedog/docs/evals):
#
#   judge:
#     eval:
#       factory: ./my_evals.ts.llm
#       model: gpt-4.1-mini
#
# As your bot takes shape, update these turns to match it, and copy this file to add scenarios.
# Besides \`eval:\` you can assert substrings (\`text_contains:\`), latency (\`within_ms:\`), and
# tool use:
#
#   - user: "What's the weather in Paris?"
#     expect:
#       - event: function_call
#         calls:
#           - name: get_current_weather

scenarios:
  - name: starter_text
    turns:
      # The bot speaks first on connect. A turn with no \`user:\` just waits for and asserts on
      # events (here, the greeting), so we don't barge into it.
      - expect:
          - event: response
            eval: "the bot opens the conversation (a greeting, an introduction, or an offer to help)"

      - user: "What can you help me with?"
        expect:
          - event: response
            eval: "the bot answers, describing what it can do or offering to help"
`;
}
