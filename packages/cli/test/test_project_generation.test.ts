// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_project_generation.py

// Integration tests for project generation with different configurations.
//
// DIVERGENCE: the generated project is TypeScript, so "valid Python syntax" is "transpiles with
// Bun", `pyproject.toml` is `package.json`, and Ruff's formatting check is Biome's, with this
// repository's configuration. Daily isn't ported ("smallwebrtc" and "websocket" stand in), nor are
// Daily PSTN, Twilio + Daily SIP, Krisp, Pipecat Cloud, Tavus and Simli (their tests are skipped),
// and AssemblyAI is replaced by Azure. The bot is type-checked against the real packages in
// `e2e.test.ts`, which is the check upstream gets from importing the Python.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileExistsError, ProjectGenerator } from "../src/project.ts";
import { ProjectConfig, type ProjectConfigOptions } from "../src/questions.ts";
import { ServiceLoader } from "../src/service_loader.ts";
import { ServiceRegistry } from "../src/service_metadata.ts";
import { read, tmpDir } from "./helpers.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Validate that a TypeScript file has valid syntax. */
function validateSyntax(code: string): { ok: boolean; error?: string } {
  try {
    new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Format `code` as Biome (with this repository's configuration) does; the repository root is the cwd. */
function biomeFormat(code: string, file: string): string {
  const out = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${file}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(code),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0) throw new Error(`biome failed: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

/** Assert the generated TypeScript under `server` is already formatted (JSON is written as npm does). */
function assertServerFormatted(server: string): void {
  const code = read(server, "bot.ts");
  const formatted = biomeFormat(code, "bot.ts");
  expect(formatted === code, `bot.ts is not formatted:\n${firstDifference(code, formatted)}`).toBe(
    true,
  );
}

/** The first line where `a` and `b` differ, for the message of a failed format check. */
function firstDifference(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const i = x.findIndex((line, n) => line !== y[n]);
  return i < 0 ? "" : `line ${i + 1}:\n  have: ${x[i]}\n  want: ${y[i]}`;
}

type Cfg = ProjectConfigOptions & { name: string };

// Test configurations for different transport types
const TEST_CONFIGS: Cfg[] = [
  // WebRTC Transports - Cascade
  {
    name: "smallwebrtc-cascade",
    projectName: "smallwebrtc-cascade",
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
  },
  {
    name: "websocket-cascade",
    projectName: "websocket-cascade",
    botType: "web",
    transports: ["websocket"],
    mode: "cascade",
    sttService: "azure_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
  },
  {
    name: "livekit-cascade",
    projectName: "livekit-cascade",
    botType: "web",
    transports: ["livekit"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "anthropic_llm",
    ttsService: "elevenlabs_tts",
  },
  // Telephony Transports - Cascade
  ...["twilio", "telnyx", "plivo", "exotel"].map(
    (t): Cfg => ({
      name: `${t}-cascade`,
      projectName: `${t}-cascade`,
      botType: "telephony",
      transports: [t],
      mode: "cascade",
      sttService: "deepgram_stt",
      llmService: "openai_llm",
      ttsService: "cartesia_tts",
    }),
  ),
  // Realtime Pipelines
  {
    name: "smallwebrtc-realtime-openai",
    projectName: "smallwebrtc-realtime-openai",
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "realtime",
    realtimeService: "openai_realtime",
  },
  {
    name: "smallwebrtc-realtime",
    projectName: "smallwebrtc-realtime",
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "realtime",
    realtimeService: "gemini_live_realtime",
  },
  // Mixed Transports (Telephony + WebRTC)
  {
    name: "twilio-webrtc-mixed",
    projectName: "twilio-webrtc-mixed",
    botType: "telephony",
    transports: ["twilio", "smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
  },
  // With features
  {
    name: "smallwebrtc-with-features",
    projectName: "smallwebrtc-with-features",
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
    videoInput: true,
    videoOutput: true,
    recording: true,
    transcription: true,
    enableObservability: true,
    enableEval: true,
    dockerfile: true,
  },
  {
    name: "node-runtime-with-client",
    projectName: "node-runtime-with-client",
    botType: "web",
    transports: ["websocket", "smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
    runtime: "node",
    dockerfile: true,
    generateClient: true,
    clientFramework: "vanilla",
    clientServer: "vite",
  },
  // With a video service
  {
    name: "smallwebrtc-with-video-service",
    projectName: "smallwebrtc-with-video-service",
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_llm",
    ttsService: "cartesia_tts",
    videoService: "heygen_video",
    videoOutput: true,
  },
];

async function generate(
  config: ProjectConfig,
  outputDir: string,
  inPlace = false,
): Promise<string> {
  return await new ProjectGenerator(config, { out: () => {}, version: "1.2.3" }).generate(
    outputDir,
    {
      nonInteractive: true,
      inPlace,
    },
  );
}

describe("test_project_generation", () => {
  for (const data of TEST_CONFIGS) {
    test(`test_project_generation[${data.name}]`, async () => {
      // Test that projects generate successfully with different configurations.
      const outputDir = tmpDir();
      const config = new ProjectConfig(data);
      const projectPath = await generate(config, outputDir);
      expect(projectPath).toEqual(join(outputDir, config.projectName));

      // Verify core files exist (in monorepo structure)
      for (const file of [
        "server/bot.ts",
        "server/package.json",
        "server/tsconfig.json",
        "server/.env.example",
        ".gitignore",
        "README.md",
      ]) {
        expect(existsSync(join(projectPath, file)), `${file} should exist`).toBe(true);
      }

      // Verify the Dockerfile
      expect(existsSync(join(projectPath, "server", "Dockerfile"))).toBe(config.dockerfile);
      // ... and that there is nothing of Pipecat Cloud's
      expect(existsSync(join(projectPath, "server", "pcc-deploy.toml"))).toBe(false);

      // Validate TypeScript syntax
      const server = join(projectPath, "server");
      const bot = read(server, "bot.ts");
      const syntax = validateSyntax(bot);
      expect(syntax.ok, `bot.ts has syntax errors: ${syntax.error}`).toBe(true);

      // Generated code must be formatted (the Biome counterpart of the Ruff check).
      assertServerFormatted(server);

      // Verify bot.ts structure
      expect(bot).toContain("async function runBot");
      expect(bot).toContain("export async function bot");
      expect(bot).toContain("main({ bot })");

      // Verify the selected services' actual classes appear in the generated bot, rather than a
      // weak substring like "stt". The expected class names come from the registry, so this
      // stays correct as services are added or renamed.
      const assertServiceClassReferenced = (value: string, lists: ServiceDefinitionList[]) => {
        for (const list of lists) {
          const svc = ServiceLoader.getServiceByValue(list, value);
          if (svc) {
            const primary = svc.className?.[0] as string;
            expect(bot, `${value} should reference ${primary} in bot.ts`).toContain(primary);
            return;
          }
        }
        throw new Error(`Service ${value} not found in registry`);
      };
      if (config.mode === "cascade") {
        if (config.sttService)
          assertServiceClassReferenced(config.sttService, [ServiceRegistry.STT_SERVICES]);
        if (config.llmService)
          assertServiceClassReferenced(config.llmService, [ServiceRegistry.LLM_SERVICES]);
        if (config.ttsService)
          assertServiceClassReferenced(config.ttsService, [ServiceRegistry.TTS_SERVICES]);
      } else if (config.realtimeService) {
        assertServiceClassReferenced(config.realtimeService, [ServiceRegistry.REALTIME_SERVICES]);
      }

      // Verify transport-specific code
      for (const transport of config.transports) {
        if (transport === "smallwebrtc") {
          expect(bot.includes("TransportParams") || bot.toLowerCase().includes("webrtc")).toBe(
            true,
          );
        } else if (["twilio", "telnyx", "plivo", "exotel"].includes(transport)) {
          expect(bot, `${transport} should use FastAPIWebsocketParams`).toContain(
            "FastAPIWebsocketParams",
          );
        }
      }

      // Validate package.json structure
      const pkg = JSON.parse(read(server, "package.json"));
      expect(pkg.name).toEqual(config.projectName);
      expect(Object.keys(pkg.dependencies).length).toBeGreaterThan(0);
      // The @pipedog packages are at the release the CLI belongs to, and there is a runner.
      expect(pkg.dependencies["@pipedog/runner"]).toEqual("^1.2.3");
      expect(pkg.dependencies["@pipedog/core"]).toEqual("^1.2.3");
      for (const [name, range] of Object.entries<string>(pkg.dependencies)) {
        if (name.startsWith("@pipedog/")) expect(range).toEqual("^1.2.3");
      }

      // Every @pipedog package the bot imports is a dependency.
      const imported = new Set(
        [...bot.matchAll(/from "(@pipedog\/[a-z-]+)[/"]/g)].map((m) => m[1]),
      );
      for (const name of imported) {
        expect(
          name in pkg.dependencies || name in pkg.devDependencies,
          `${name} is imported but not a dependency`,
        ).toBe(true);
      }

      // Verify the runtime
      if (config.runtime === "node") {
        expect(pkg.scripts.start).toEqual("node bot.ts");
        expect(pkg.devDependencies["@types/node"]).toBeDefined();
        expect(JSON.parse(read(server, "tsconfig.json")).compilerOptions.types).toEqual(["node"]);
      } else {
        expect(pkg.scripts.start).toEqual("bun bot.ts");
        expect(pkg.devDependencies["@types/bun"]).toBeDefined();
        expect(JSON.parse(read(server, "tsconfig.json")).compilerOptions.types).toEqual(["bun"]);
      }

      // Verify transport extras
      if (config.transports.includes("websocket") || config.botType === "telephony") {
        expect(pkg.dependencies["@pipedog/transport-websocket"]).toBeDefined();
        expect(pkg.dependencies.ws).toBeDefined();
      }
      if (config.transports.includes("livekit")) {
        expect(pkg.dependencies["@pipedog/transport-livekit"]).toBeDefined();
        expect(pkg.dependencies["@livekit/rtc-node"]).toBeDefined();
      }

      // Verify observability dependencies
      if (config.enableObservability) {
        expect(pkg.dependencies["@pipedog/tracing"]).toBeDefined();
        expect(pkg.dependencies["@opentelemetry/api"]).toBeDefined();
        // Verify observability imports in bot.ts
        expect(bot).toContain("setupTracing");
        expect(bot).toContain(
          'import { OTLPTraceExporter, setupTracing } from "@pipedog/tracing";',
        );
        expect(bot).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      } else {
        expect(bot).not.toContain("setupTracing");
      }

      // Verify video service dependencies and imports
      if (config.videoService) {
        if (config.videoService === "heygen_video") {
          expect(bot).toContain("HeyGenVideoService");
          expect(bot).toContain("LiveAvatarNewSessionRequest");
          expect(bot).toContain("ServiceType");
          expect(pkg.dependencies["@pipedog/heygen"]).toBeDefined();
        }
        // Video service should be initialized in bot.ts
        expect(bot.toLowerCase()).toContain("video");
      }

      // Features
      expect(bot.includes("AudioBufferProcessor")).toBe(config.recording);
      expect(bot.includes("UserTurnStoppedMessage")).toBe(config.transcription);
      expect(bot.includes("EvalTransportParams")).toBe(config.enableEval);
      expect(pkg.dependencies["@pipedog/evals"] !== undefined).toBe(config.enableEval);
      expect(pkg.devDependencies["@pipedog/cli"] !== undefined).toBe(config.enableEval);

      // The client
      expect(existsSync(join(projectPath, "client", "package.json"))).toBe(config.generateClient);
    });
  }
});

type ServiceDefinitionList = readonly (typeof ServiceRegistry.STT_SERVICES)[number][];

describe("test_project_generation: names, places and refusals", () => {
  const web = (name: string) =>
    new ProjectConfig({
      projectName: name,
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      sttService: "deepgram_stt",
      llmService: "openai_llm",
      ttsService: "cartesia_tts",
    });

  test("test_project_name_conflict", async () => {
    // Project generation refuses to overwrite a project folder when not interactive.
    const outputDir = tmpDir();
    const config = web("test-project");
    const projectPath = await generate(config, outputDir);
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(projectPath, "server", "bot.ts"))).toBe(true);
    await expect(generate(web("test-project"), outputDir)).rejects.toThrow(FileExistsError);
  });

  test("NEW: interactively, a name conflict asks for another name", async () => {
    const outputDir = tmpDir();
    await generate(web("taken"), outputDir);
    const asked: string[] = [];
    const prompter = {
      text: async (message: string) => {
        asked.push(message);
        return asked.length === 1 ? "taken" : "free"; // still taken, then free
      },
      select: async () => null,
      confirm: async () => null,
      info: () => {},
    };
    const generator = new ProjectGenerator(web("taken"), { out: () => {}, prompter });
    const path = await generator.generate(outputDir);
    expect(path).toEqual(join(outputDir, "free"));
    expect(asked.length).toEqual(2);
    expect(generator.config.projectName).toEqual("free");
  });

  test("test_generate_in_place_no_subfolder", async () => {
    // inPlace writes contents directly into outputDir (no <name> subfolder).
    const outputDir = tmpDir();
    const projectPath = await generate(web("my-inplace-bot"), outputDir, true);
    expect(projectPath).toEqual(outputDir);
    expect(existsSync(join(outputDir, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(outputDir, "README.md"))).toBe(true);
    // The contents are NOT nested under the project name.
    expect(existsSync(join(outputDir, "my-inplace-bot"))).toBe(false);
  });

  test("test_generate_in_place_preserves_existing_neutral_files", async () => {
    // A pre-existing CLAUDE.md (the agent-loop case) is left untouched.
    const outputDir = tmpDir();
    writeFileSync(join(outputDir, "CLAUDE.md"), "# guidance");
    await generate(web("my-inplace-bot"), outputDir, true);
    expect(read(outputDir, "CLAUDE.md")).toEqual("# guidance");
    expect(existsSync(join(outputDir, "server", "bot.ts"))).toBe(true);
  });

  test("test_generate_in_place_aborts_if_project_exists", async () => {
    // inPlace refuses to clobber an existing project (server/ present).
    const outputDir = tmpDir();
    mkdirSync(join(outputDir, "server"));
    await expect(generate(web("my-inplace-bot"), outputDir, true)).rejects.toThrow(FileExistsError);
  });

  // Upstream's regressions for Windows locale encodings and for Ruff not being on PATH have no
  // counterpart: files are written as UTF-8, and nothing is formatted by an external tool.
  test.skip("test_generation_uses_utf8_on_windows_locale", () => {});
  test.skip("test_generated_python_formatted_without_ruff_on_path", () => {});
  test.skip("test_format_warns_when_ruff_cannot_run", () => {});

  test("NEW: files are UTF-8, arrows included", async () => {
    const projectPath = await generate(web("arrows"), tmpDir());
    expect(read(projectPath, "README.md")).toContain("STT → LLM → TTS");
  });

  test("NEW: an npm-unfriendly project name becomes a valid package name", async () => {
    const projectPath = await generate(web("My Voice Bot!"), tmpDir());
    expect(JSON.parse(read(projectPath, "server", "package.json")).name).toEqual("my-voice-bot");
    expect(read(projectPath, "server", "bot.ts")).toContain(
      "// My Voice Bot! - pipedog voice agent",
    );
  });
});

/** Generate a bot and return its bot.ts. */
async function genBot(
  name: string,
  options: Partial<ProjectConfigOptions> & Pick<ProjectConfigOptions, "botType">,
): Promise<string> {
  const outputDir = tmpDir();
  const cascade = options.mode !== "realtime";
  const config = new ProjectConfig({
    projectName: name,
    mode: "cascade",
    ...(cascade
      ? { sttService: "deepgram_stt", llmService: "openai_llm", ttsService: "cartesia_tts" }
      : { realtimeService: "openai_realtime" }),
    transports: options.botType === "web" ? ["smallwebrtc"] : ["twilio"],
    ...options,
  });
  const path = await generate(config, outputDir);
  // Also asserts the generated server is formatted, so every bot variant is guarded.
  assertServerFormatted(join(path, "server"));
  return read(path, "server", "bot.ts");
}

describe("test_project_generation: the bot", () => {
  test("test_collapsed_transport_construction", async () => {
    // Standard cascade bots build transports via createTransport (no per-transport switch).
    const bot = await genBot("collapsed", { botType: "web" });
    // Unified path: a transportParams object + createTransport, with no hand-parsed handshake.
    expect(bot).toContain("const transportParams = {");
    expect(bot).toContain("await createTransport(runnerArgs, transportParams)");
    expect(bot).not.toContain("parseTelephonyWebsocket");
    // createTransport is imported.
    expect(bot).toContain('import { createTransport } from "@pipedog/runner/utils";');
    expect(validateSyntax(bot).ok).toBe(true);
  });

  test("test_eval_transport_opt_in", async () => {
    // `enableEval` adds an inert `eval` transport entry; it's absent otherwise.
    const without = await genBot("eval-off", { botType: "web", enableEval: false });
    expect(without).not.toContain("eval: () =>");
    expect(without).not.toContain("EvalTransportParams");

    // Opted in: the eval entry and its import are generated, and the bot is valid.
    const withEval = await genBot("eval-on", { botType: "web", enableEval: true });
    expect(withEval).toMatch(/eval: \(\) =>\s+new EvalTransportParams\(\{/);
    expect(withEval).toContain('import { EvalTransportParams } from "@pipedog/evals/transport";');
    expect(validateSyntax(withEval).ok).toBe(true);
  });

  test("test_eval_starter_scenarios", async () => {
    // `enableEval` scaffolds a runnable starter scenario, plus the dependencies to run it.
    const gen = async (name: string, config: Partial<ProjectConfigOptions>) => {
      const cascade = config.mode !== "realtime";
      const path = await generate(
        new ProjectConfig({
          projectName: name,
          botType: "web",
          transports: ["smallwebrtc"],
          ...(cascade
            ? { sttService: "deepgram_stt", llmService: "openai_llm", ttsService: "cartesia_tts" }
            : { realtimeService: "openai_realtime" }),
          ...config,
        }),
        tmpDir(),
      );
      return join(path, "server");
    };

    // Off by default: no evals directory, no eval dependencies.
    let server = await gen("starters-off", { enableEval: false });
    expect(existsSync(join(server, "evals"))).toBe(false);
    expect(JSON.parse(read(server, "package.json")).dependencies["@pipedog/evals"]).toBeUndefined();

    // Cascade: the starter is generated, and is a scripted scenario of two turns.
    server = await gen("starters-cascade", { enableEval: true });
    const text = read(server, "evals", "starter_text.yaml");
    expect(text).toContain("name: starter_text");
    expect(text).toContain("scenarios:");
    expect(text).toContain("turns:");
    expect(text).toContain("event: response");
    expect(text).toContain("pipedog eval run evals/starter_text.yaml");
    // The audio starter needs a speech factory: not generated.
    expect(existsSync(join(server, "evals", "starter_audio.yaml"))).toBe(false);

    // The project carries what the harness needs.
    const pkg = JSON.parse(read(server, "package.json"));
    expect(pkg.dependencies["@pipedog/evals"]).toBeDefined();
    expect(pkg.devDependencies["@pipedog/cli"]).toBeDefined();
    expect(pkg.scripts.eval).toEqual("pipedog eval");

    // The README documents the eval loop.
    expect(read(server, "..", "README.md")).toContain("evals/starter_text.yaml");

    // Realtime: no separate text LLM step, so no starter scenario.
    server = await gen("starters-realtime", { enableEval: true, mode: "realtime" });
    expect(existsSync(join(server, "evals", "starter_text.yaml"))).toBe(false);
    expect(read(server, "..", "README.md")).toContain("audio scenarios");
  });

  test("test_twilio_active_personalization_uses_call_info", async () => {
    // Upstream's Twilio bot looks the call up through Twilio's REST API. Here the telephony bot
    // logs the caller's number from the parsed handshake (`runnerArgs.callData`).
    const bot = await genBot("twilio-bot", { botType: "telephony", transports: ["twilio"] });
    expect(bot).toContain("runnerArgs instanceof WebSocketRunnerArguments");
    expect(bot).toContain("runnerArgs.callData?.fromNumber");
    expect(bot).toContain("TelephonyCallEndedError");
    // A phone bot runs the pipeline at 8 kHz.
    expect(bot).toContain("audioInSampleRate: 8000");
    // ...and does not wait for the RTVI client_ready event: it speaks first on connect.
    expect(bot).not.toContain("worker.rtvi");
    expect(bot).toContain("Start by concisely introducing yourself.");
  });

  test("NEW: a web bot greets on RTVI's client_ready, a phone bot on connect", async () => {
    const web = await genBot("web-greet", { botType: "web" });
    expect(web).toContain('worker.rtvi.eventHandler("on_client_ready"');
    const phone = await genBot("phone-greet", { botType: "telephony" });
    expect(phone).not.toContain("on_client_ready");
  });

  // Daily PSTN / SIP dial-in and dial-out, their bespoke flows and local fallbacks.
  test.skip("test_daily_pstn_dialin_uses_create_transport", () => {});
  test.skip("test_dialout_and_sip_keep_bespoke_but_standard_run_bot", () => {});
  test.skip("test_bespoke_scenarios_local_fallback", () => {});
  test.skip("test_dialout_local_run_skips_dialout_machinery", () => {});
  test.skip("test_sip_dialin_local_run_skips_call_forwarding", () => {});
  test.skip("test_bespoke_eval_only_fallback", () => {});
  test.skip("test_bespoke_daily_local_transport", () => {});
  test.skip("test_bespoke_local_fallback_realtime", () => {});

  test("test_run_bot_signature_uniform_across_modes", async () => {
    // Every generated bot (web, telephony, realtime) shares one runBot signature.
    const sig =
      "async function runBot(transport: BaseTransport, runnerArgs: RunnerArguments): Promise<void> {";
    expect(await genBot("webrb", { botType: "web" })).toContain(sig);
    expect(await genBot("phonerb", { botType: "telephony" })).toContain(sig);
    expect(await genBot("rtrb", { botType: "web", mode: "realtime" })).toContain(sig);
  });

  test("test_websocket_transport_generation", async () => {
    // The websocket transport builds via createTransport with the FastAPI websocket params and a
    // Protobuf serializer, on the unified collapsed path.
    const bot = await genBot("ws", { botType: "web", transports: ["websocket"] });
    // Imports: params class + serializer + createTransport (not the transport class).
    expect(bot).toContain(
      'import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";',
    );
    expect(bot).toContain(
      'import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";',
    );
    expect(bot).toContain('import { createTransport } from "@pipedog/runner/utils";');
    // Collapsed path: a transportParams object keyed by "websocket" + createTransport.
    expect(bot).toContain("const transportParams = {");
    expect(bot).toMatch(/websocket: \(\) =>\s+new FastAPIWebsocketParams\(\{/);
    expect(bot).toContain("serializer: new ProtobufFrameSerializer()");
    expect(bot).toContain("await createTransport(runnerArgs, transportParams)");
    expect(validateSyntax(bot).ok).toBe(true);
  });

  test("test_video_input_captures_sources", async () => {
    // Video input on SmallWebRTC lists the camera in videoInSources, so the transport captures
    // it when the client connects. The screen share is listed commented out, for the developer
    // to enable.
    const bot = await genBot("video-in", {
      botType: "web",
      transports: ["smallwebrtc", "websocket"],
      videoInput: true,
    });
    expect(bot.split("const transportParams = {")[0]).toContain("VideoInSourceParams");
    expect(bot.split("videoInSources: {").length - 1).toEqual(1);
    expect(bot.split("camera: new VideoInSourceParams({ framerate: 1 }),").length - 1).toEqual(1);
    expect(
      bot.split("// screenVideo: new VideoInSourceParams({ framerate: 1 }),").length - 1,
    ).toEqual(1);
    expect(validateSyntax(bot).ok).toBe(true);
  });

  test("test_video_input_without_video_transport", async () => {
    // A websocket-only bot has no video sources to list, so it doesn't import VideoInSourceParams.
    const bot = await genBot("video-in-ws", {
      botType: "web",
      transports: ["websocket"],
      videoInput: true,
    });
    expect(bot).not.toContain("VideoInSourceParams");
    expect(bot).not.toContain("videoInSources");
  });

  test("test_env_example_lists_selected_service_keys", async () => {
    // server/.env.example documents the env vars for exactly the selected services.
    const outputDir = tmpDir();
    const path = await generate(
      new ProjectConfig({
        projectName: "wsenv",
        botType: "web",
        transports: ["websocket"],
        mode: "cascade",
        sttService: "deepgram_stt",
        llmService: "openai_llm",
        ttsService: "cartesia_tts",
      }),
      outputDir,
    );
    const envExample = read(path, "server", ".env.example");
    // Header + the API keys for the chosen STT/LLM/TTS providers.
    expect(envExample).toContain("Environment Variables");
    expect(envExample).toContain("DEEPGRAM_API_KEY=");
    expect(envExample).toContain("OPENAI_API_KEY=");
    expect(envExample).toContain("CARTESIA_API_KEY=");
    // No env vars for providers we didn't pick.
    expect(envExample).not.toContain("ELEVENLABS_API_KEY");
    expect(envExample).not.toContain("ANTHROPIC_API_KEY");
  });

  test("NEW: the bot refuses to start without the keys its services need, and says which", async () => {
    const bot = await genBot("keys", { botType: "web" });
    expect(bot).toContain(
      'const REQUIRED_ENV = ["DEEPGRAM_API_KEY", "OPENAI_API_KEY", "CARTESIA_API_KEY"];',
    );
    expect(bot).toContain("Missing environment variables:");
    // A bot whose services need no key (Ollama) has no check.
    const local = await genBot("local", {
      botType: "web",
      llmService: "ollama_llm",
      sttService: "openai_stt",
      ttsService: "openai_tts",
    });
    expect(local).toContain('const REQUIRED_ENV = ["OPENAI_API_KEY"];');
    const none = await genBot("none", { botType: "web", sttService: "gemini_stt" });
    expect(none).toContain("GOOGLE_API_KEY");
  });

  test("NEW: .env.example marks required keys and comments out optional ones", async () => {
    const outputDir = tmpDir();
    const path = await generate(
      new ProjectConfig({
        projectName: "env",
        botType: "web",
        transports: ["livekit"],
        mode: "cascade",
        sttService: "deepgram_stt",
        llmService: "openai_llm",
        ttsService: "elevenlabs_tts",
      }),
      outputDir,
    );
    const env = read(path, "server", ".env.example");
    expect(env).toContain("\nLIVEKIT_URL=\n");
    expect(env).toContain("# LIVEKIT_ROOM_NAME=");
    expect(env).toContain("\nELEVENLABS_VOICE_ID=\n");
    expect(env).toContain("# OPENAI_MODEL=gpt-4.1");
    // One key serves STT, LLM and TTS: listed once.
    const openai = new ProjectConfig({
      projectName: "o",
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      sttService: "openai_stt",
      llmService: "openai_llm",
      ttsService: "openai_tts",
    });
    const p2 = await generate(openai, tmpDir());
    expect(read(p2, "server", ".env.example").split("OPENAI_API_KEY=").length - 1).toEqual(1);
  });

  test("NEW: the bot starts as the program's entry on Bun, Deno and Node", async () => {
    const bot = await genBot("entry", { botType: "web" });
    // import.meta.main (Bun, Deno, Node 24.2+), else a comparison of the entry script's URL.
    expect(bot).toContain('typeof meta.main === "boolean"');
    expect(bot).toContain("pathToFileURL(resolve(entry)).href");
    expect(bot).toContain("await main({ bot });");
  });

  test("NEW: recording writes a WAV file, transcription logs the turns", async () => {
    const bot = await genBot("features", { botType: "web", recording: true, transcription: true });
    expect(bot).toContain("autoStartRecording: true");
    expect(bot).toContain('"on_audio_data"');
    expect(bot).toContain("header.setUint32(4, 36 + audio.length, true);");
    expect(bot).toContain('"on_user_turn_stopped"');
    expect(bot).toContain('"on_assistant_turn_stopped"');
  });
});

describe("test_project_generation: the client and the other files", () => {
  const config = (extra: Partial<ProjectConfigOptions> = {}) =>
    new ProjectConfig({
      projectName: "with-client",
      botType: "web",
      transports: ["smallwebrtc", "websocket"],
      mode: "cascade",
      sttService: "deepgram_stt",
      llmService: "openai_llm",
      ttsService: "cartesia_tts",
      generateClient: true,
      clientFramework: "vanilla",
      clientServer: "vite",
      ...extra,
    });

  test("NEW: the README tells how to run it on the chosen runtime", async () => {
    const bun = read(await generate(config(), tmpDir()), "README.md");
    expect(bun).toContain("bun install");
    expect(bun).toContain("bun bot.ts");
    expect(bun).toContain("https://polvallverdu.github.io/pipedog/llms.txt");
    expect(bun).toContain("npx -y @pipedog/mcp");
    const node = read(await generate(config({ runtime: "node" }), tmpDir()), "README.md");
    expect(node).toContain("npm install");
    expect(node).toContain("node bot.ts");
    expect(node).not.toContain("bun install");
  });

  test("NEW: the telephony README explains the provider setup, with the runner's webhook", async () => {
    const readme = read(
      await generate(
        new ProjectConfig({
          projectName: "phone",
          botType: "telephony",
          transports: ["twilio", "telnyx"],
          mode: "cascade",
          sttService: "deepgram_stt",
          llmService: "openai_llm",
          ttsService: "cartesia_tts",
        }),
        tmpDir(),
      ),
      "README.md",
    );
    expect(readme).toContain("ngrok http 7860");
    expect(readme).toContain("bun bot.ts -t twilio --proxy");
    expect(readme).toContain("bun bot.ts -t telnyx --proxy");
    expect(readme).toContain("#### Twilio");
    expect(readme).toContain("#### Telnyx");
    // Not Pipecat Cloud's.
    expect(readme).not.toContain("api.pipecat.daily.co");
    expect(readme).not.toContain("Pipecat Cloud");
  });

  test("NEW: the Dockerfile matches the runtime", async () => {
    const bun = read(
      await generate(config({ dockerfile: true }), tmpDir()),
      "server",
      "Dockerfile",
    );
    expect(bun).toContain("FROM oven/bun");
    expect(bun).toContain('CMD ["bun", "bot.ts", "--host", "0.0.0.0"]');
    const node = read(
      await generate(config({ dockerfile: true, runtime: "node" }), tmpDir()),
      "server",
      "Dockerfile",
    );
    expect(node).toContain("FROM node:");
    expect(node).toContain('CMD ["node", "bot.ts", "--host", "0.0.0.0"]');
  });

  test("NEW: nothing Pipecat-specific is left in a generated project", async () => {
    const path = await generate(
      config({ dockerfile: true, enableEval: true, enableObservability: true }),
      tmpDir(),
    );
    for (const file of [
      "README.md",
      "server/bot.ts",
      "server/package.json",
      "server/.env.example",
      "server/Dockerfile",
      "server/evals/starter_text.yaml",
      "client/package.json",
      "client/src/config.js",
      "client/index.html",
    ]) {
      const text = read(path, file);
      expect(text, file).not.toMatch(/(?<!@)pipecat-ai/);
      expect(text, file).not.toContain("pipecat.daily.co");
      expect(text, file).not.toContain("uv run");
      expect(text, file).not.toContain("Whisker");
      expect(text, file).not.toContain("from pipecat");
    }
  });
});
