// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/scaffold.py

/**
 * Project scaffolding for `pipedog init`.
 *
 * The scaffolder generates a runnable pipedog project (`bot.ts`, dependencies, config, optional
 * client). It has three entry points, all used by `pipedog init`:
 *
 * - `scaffoldInteractive`: the wizard, run when the developer chooses "scaffold a runnable bot
 *   now" on interactive `init`.
 * - `scaffoldQuickstart`: the canned quickstart preset (`pipedog init quickstart`).
 * - `resolveScaffoldConfig` + `generateScaffold`: flags/config-file driven, no prompts
 *   (`pipedog init . --bot-type web ...`); the path coding agents and automation use. Split so
 *   the config is validated before any files are written.
 *
 * DIVERGENCE: the quickstart preset is SmallWebRTC, Deepgram, OpenAI Responses and Cartesia
 * (upstream adds Daily and a Pipecat Cloud deployment). `typer`'s parameter sources, which tell
 * a typed flag from a default, are the `explicit` set of the parsed command line. A Pipecat
 * config file's keys with no pipedog counterpart (`deploy_to_cloud`, `enable_krisp`, the Daily
 * modes) are ignored with a warning, since Pipecat's own `--dry-run` output has them; the same
 * flags on the command line are errors.
 */

import { Exit, type Io } from "./_io.ts";
import {
  ConfigValidationError,
  configToJson,
  loadConfigFromFile,
  validateAndBuildConfig,
} from "./config_validator.ts";
import { ProjectGenerator, type ProjectGeneratorOptions } from "./project.ts";
import { askProjectQuestions, ProjectConfig, type Prompter } from "./questions.ts";
import { ServiceRegistry } from "./service_metadata.ts";

/** The scaffold flags as typed on the command line (`undefined` when not given). */
export interface ScaffoldFlags {
  name?: string;
  botType?: string;
  transport?: string[];
  mode?: string;
  stt?: string;
  llm?: string;
  tts?: string;
  realtime?: string;
  video?: string;
  clientFramework?: string;
  clientServer?: string;
  recording?: boolean;
  transcription?: boolean;
  videoInput?: boolean;
  videoOutput?: boolean;
  observability?: boolean;
  enableEval?: boolean;
  runtime?: string;
  dockerfile?: boolean;
  /** Upstream's flags with no pipedog counterpart, by option name, when they were asked for. */
  unsupported?: Record<string, unknown>;
}

/** The flag names (camelCase) a user can type, to tell a typed flag from a default. */
export const SCAFFOLD_FLAG_NAMES = [
  "name",
  "botType",
  "transport",
  "mode",
  "stt",
  "llm",
  "tts",
  "realtime",
  "video",
  "clientFramework",
  "clientServer",
  "config",
  "recording",
  "transcription",
  "videoInput",
  "videoOutput",
  "observability",
  "enableEval",
  "runtime",
  "dockerfile",
  "dailyPstnMode",
  "twilioDailySipMode",
  "deployToCloud",
  "enableKrisp",
] as const;

/** The values `--list-options` prints: what each flag accepts. */
export function listOptions(): Record<string, unknown> {
  const values = (defs: readonly { value: string }[]) => defs.map((s) => s.value);
  return {
    bot_type: ["web", "telephony"],
    transports: {
      web: values(ServiceRegistry.WEBRTC_TRANSPORTS),
      telephony: values(ServiceRegistry.TELEPHONY_TRANSPORTS),
    },
    stt: values(ServiceRegistry.STT_SERVICES),
    llm: values(ServiceRegistry.LLM_SERVICES),
    tts: values(ServiceRegistry.TTS_SERVICES),
    realtime: values(ServiceRegistry.REALTIME_SERVICES),
    video: values(ServiceRegistry.VIDEO_SERVICES),
    runtime: ["bun", "node"],
    client_framework: ["vanilla", "none"],
  };
}

/** Print the available service options as JSON (the eager `--list-options` flag). */
export function listOptionsCallback(io: Pick<Io, "out">): never {
  io.out(JSON.stringify(listOptions(), null, 2));
  throw new Exit(0);
}

export interface ScaffoldDeps {
  io: Io;
  /** The prompts the wizard asks with (default: `@clack/prompts`). */
  prompter?: Prompter;
  /** The `@pipedog/*` release the generated project depends on (default: this package's version). */
  version?: string;
  /** Further options of the project generator. */
  generator?: ProjectGeneratorOptions;
}

/**
 * Run the interactive wizard and generate a project.
 *
 * Used by `pipedog init` when the developer chooses to scaffold a runnable bot. `dest` is the
 * resolved output location: the exact target directory when `inPlace` is true, otherwise the
 * parent the `<name>` subfolder is created under (`null` = the current directory).
 */
export async function scaffoldInteractive(
  dest: string | null,
  derivedName: string | null,
  inPlace: boolean,
  deps: ScaffoldDeps,
): Promise<void> {
  const config = await askProjectQuestions({
    defaultName: derivedName,
    ...(deps.prompter ? { prompter: deps.prompter } : {}),
  });
  const generator = new ProjectGenerator(config, {
    out: deps.io.out,
    ...(deps.version ? { version: deps.version } : {}),
    ...(deps.prompter ? { prompter: deps.prompter } : {}),
    ...deps.generator,
  });
  const projectPath = await generator.generate(dest, { inPlace });
  generator.printNextSteps(projectPath, inPlace);
}

export interface ResolveScaffoldOptions {
  /** The name to use when none is given (the target directory's name). */
  derivedName: string | null;
  dryRun: boolean;
  /** A `--config` file. */
  config?: string | null;
  /** The flags typed on the command line. */
  flags: ScaffoldFlags;
  /** The names (`SCAFFOLD_FLAG_NAMES`) of the flags that were typed, as opposed to defaulted. */
  explicit: ReadonlySet<string>;
  io: Io;
}

/** The keys of a config file for each option (upstream's snake_case, then pipedog's camelCase). */
const FILE_KEYS: Record<string, string[]> = {
  name: ["name", "project_name", "projectName"],
  botType: ["bot_type", "botType"],
  transport: ["transport", "transports"],
  mode: ["mode"],
  stt: ["stt", "stt_service", "sttService"],
  llm: ["llm", "llm_service", "llmService"],
  tts: ["tts", "tts_service", "ttsService"],
  realtime: ["realtime", "realtime_service", "realtimeService"],
  video: ["video", "video_service", "videoService"],
  clientFramework: ["client_framework", "clientFramework"],
  clientServer: ["client_server", "clientServer"],
  recording: ["recording"],
  transcription: ["transcription"],
  videoInput: ["video_input", "videoInput"],
  videoOutput: ["video_output", "videoOutput"],
  observability: ["observability", "enable_observability", "enableObservability"],
  enableEval: ["enable_eval", "eval", "enableEval"],
  runtime: ["runtime"],
  dockerfile: ["dockerfile"],
};

/** Config file keys of upstream options pipedog doesn't have: ignored, with a warning. */
const IGNORED_FILE_KEYS: Record<string, string> = {
  deploy_to_cloud: "Pipecat Cloud has no pipedog counterpart (use `dockerfile`)",
  enable_krisp: "Krisp isn't ported to pipedog",
  daily_pstn_mode: "Daily isn't ported to pipedog",
  twilio_daily_sip_mode: "Daily isn't ported to pipedog",
};

/**
 * Merge flags + config file into a validated `ProjectConfig`: no file writes.
 *
 * Merges a `--config` file (if given) with the command-line flags and validates the result. An
 * explicit flag always wins; the file value applies only when the flag was omitted. Exits with
 * code 1 and a message on a validation error, and on `dryRun` prints the resolved config as JSON
 * and exits with 0, so callers can validate *before* writing anything (see `generateScaffold`).
 *
 * @throws Exit
 */
export function resolveScaffoldConfig(options: ResolveScaffoldOptions): ProjectConfig {
  const { flags, explicit, io } = options;
  const merged: Record<string, unknown> = { ...flags };

  if (options.config) {
    let fileData: Record<string, unknown>;
    try {
      fileData = loadConfigFromFile(options.config);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      io.err(`\nCould not read the config file ${options.config}: ${message}`);
      throw new Exit(1);
    }
    // An explicit flag always wins; else the first file key present; else the flag's default.
    for (const [option, keys] of Object.entries(FILE_KEYS)) {
      if (explicit.has(option)) continue;
      for (const key of keys) {
        if (key in fileData) {
          let value = fileData[key];
          if (option === "transport" && typeof value === "string") value = [value];
          merged[option] = value;
          break;
        }
      }
    }
    for (const [key, reason] of Object.entries(IGNORED_FILE_KEYS)) {
      if (fileData[key]) io.err(`Note: ignoring '${key}' in the config file: ${reason}.`);
    }
  }

  try {
    return resolveValidated(merged as ScaffoldFlags, options);
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      io.err(`\n${e.message}`);
      throw new Exit(1);
    }
    throw e;
  }
}

function resolveValidated(flags: ScaffoldFlags, options: ResolveScaffoldOptions): ProjectConfig {
  const nn = <T>(value: T | undefined): T | null => (value === undefined ? null : value);
  const config = validateAndBuildConfig({
    name: flags.name ?? options.derivedName,
    botType: nn(flags.botType),
    transport: nn(flags.transport),
    mode: nn(flags.mode),
    stt: nn(flags.stt),
    llm: nn(flags.llm),
    tts: nn(flags.tts),
    realtime: nn(flags.realtime),
    video: nn(flags.video),
    clientFramework: nn(flags.clientFramework),
    clientServer: nn(flags.clientServer),
    recording: flags.recording ?? false,
    transcription: flags.transcription ?? false,
    videoInput: flags.videoInput ?? false,
    videoOutput: flags.videoOutput ?? false,
    observability: flags.observability ?? false,
    enableEval: flags.enableEval ?? false,
    runtime: nn(flags.runtime),
    dockerfile: flags.dockerfile ?? false,
    ...(flags.unsupported ? { unsupported: flags.unsupported } : {}),
  });
  if (options.dryRun) {
    options.io.out(configToJson(config));
    throw new Exit(0);
  }
  return config;
}

/**
 * Generate a project from an already-validated config and print next steps.
 *
 * The write half of non-interactive scaffolding; pair it with `resolveScaffoldConfig`, which
 * validates first so a bad invocation fails without touching the directory.
 */
export async function generateScaffold(
  config: ProjectConfig,
  options: { dest: string | null; inPlace: boolean; deps: ScaffoldDeps },
): Promise<void> {
  const generator = new ProjectGenerator(config, {
    out: options.deps.io.out,
    ...(options.deps.version ? { version: options.deps.version } : {}),
    ...options.deps.generator,
  });
  const projectPath = await generator.generate(options.dest, {
    nonInteractive: true,
    inPlace: options.inPlace,
  });
  generator.printNextSteps(projectPath, options.inPlace);
}

/** The quickstart project's name and directory. */
export const QUICKSTART_NAME = "pipedog-quickstart";

/**
 * Generate the canned quickstart project (no questions).
 *
 * Sets up a project with SmallWebRTC, Deepgram speech-to-text, OpenAI's Responses API for the
 * LLM and Cartesia text-to-speech: the fastest way to get a voice agent running. Used by
 * `pipedog init quickstart`, which scaffolds in place into an already-initialized directory.
 */
export async function scaffoldQuickstart(options: {
  dest?: string | null;
  outputDir?: string | null;
  inPlace?: boolean;
  deps: ScaffoldDeps;
}): Promise<void> {
  const { io } = options.deps;
  const inPlace = options.inPlace ?? false;
  io.out("Let's create your pipedog project!\n");

  // Display all pre-selected defaults
  io.out(`✔ Project name: ${QUICKSTART_NAME}`);
  io.out("✔ Bot type: Web/Mobile");
  io.out("✔ Transport: SmallWebRTC");
  io.out("✔ Pipeline architecture: Cascade (STT → LLM → TTS)");
  io.out("✔ Speech-to-Text: Deepgram");
  io.out("✔ Language model: OpenAI Responses");
  io.out("✔ Text-to-Speech: Cartesia");
  io.out("✔ Runtime: Bun");

  // Build config with quickstart defaults
  const config = new ProjectConfig({
    projectName: QUICKSTART_NAME,
    botType: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    sttService: "deepgram_stt",
    llmService: "openai_responses_llm",
    ttsService: "cartesia_tts",
  });

  await generateScaffold(config, {
    dest: inPlace ? (options.dest ?? null) : (options.outputDir ?? null),
    inPlace,
    deps: options.deps,
  });
}
