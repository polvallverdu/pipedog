// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/prompts/questions.py

/**
 * Interactive prompts and question flow for project configuration.
 *
 * DIVERGENCE: upstream asks with `questionary` and redraws each answered question with a check
 * mark (`replace_question_with_answer`, ANSI cursor codes). `@clack/prompts` keeps the answers
 * on screen by itself, so that helper is gone. The questions go through a `Prompter`, so tests
 * (and callers) can script the answers. Not asked or offered, because pipedog has no
 * counterpart: Daily and the Daily PSTN and Twilio + Daily SIP flows, the React clients,
 * Pipecat Cloud deployment and Krisp. New: the runtime (Bun or Node) and a Dockerfile.
 */

import * as clack from "@clack/prompts";
import { type BotType, type ServiceDefinition, ServiceRegistry } from "./service_metadata.ts";

/** Raised when the user cancels a prompt (upstream raises `KeyboardInterrupt`). */
export class ProjectCancelledError extends Error {
  override name = "ProjectCancelledError";
  constructor(message = "Project creation cancelled") {
    super(message);
  }
}

/** What the generated project runs on. */
export type Runtime = "bun" | "node";

export interface ProjectConfigOptions {
  projectName: string;
  botType: BotType;
  transports?: string[];
  mode?: string;
  sttService?: string | null;
  llmService?: string | null;
  ttsService?: string | null;
  realtimeService?: string | null;
  videoService?: string | null;
  generateClient?: boolean;
  clientFramework?: string | null;
  clientServer?: string | null;
  videoInput?: boolean;
  videoOutput?: boolean;
  recording?: boolean;
  transcription?: boolean;
  enableObservability?: boolean;
  enableEval?: boolean;
  runtime?: Runtime;
  dockerfile?: boolean;
}

/**
 * Configuration for a pipedog project.
 *
 * Upstream's Daily PSTN and Twilio + Daily SIP modes, `deploy_to_cloud` and `enable_krisp` have
 * no counterpart; `runtime` and `dockerfile` are new.
 */
export class ProjectConfig {
  // Basic info
  projectName: string;
  /** `"web"` or `"telephony"`. */
  botType: BotType;
  // Transport
  transports: string[];
  /** Pipeline mode: `"cascade"` or `"realtime"`. */
  mode: string;
  // Services (cascade mode)
  sttService: string | null;
  llmService: string | null;
  ttsService: string | null;
  // Realtime service
  realtimeService: string | null;
  /** Video avatar service (web bots). */
  videoService: string | null;
  // Client (web bots)
  generateClient: boolean;
  /** `"vanilla"`. */
  clientFramework: string | null;
  /** `"vite"`. */
  clientServer: string | null;
  // Features
  videoInput: boolean;
  videoOutput: boolean;
  recording: boolean;
  transcription: boolean;
  /** OpenTelemetry tracing (`@pipedog/tracing`), upstream's Whisker observer. */
  enableObservability: boolean;
  /** Adds an "eval" entry to the transport params so `pipedog eval` can drive the bot. */
  enableEval: boolean;
  /** The runtime the project's scripts use. */
  runtime: Runtime;
  /** Write a Dockerfile. */
  dockerfile: boolean;

  constructor(options: ProjectConfigOptions) {
    this.projectName = options.projectName;
    this.botType = options.botType;
    this.transports = options.transports ?? [];
    this.mode = options.mode ?? "cascade";
    this.sttService = options.sttService ?? null;
    this.llmService = options.llmService ?? null;
    this.ttsService = options.ttsService ?? null;
    this.realtimeService = options.realtimeService ?? null;
    this.videoService = options.videoService ?? null;
    this.generateClient = options.generateClient ?? false;
    this.clientFramework = options.clientFramework ?? null;
    this.clientServer = options.clientServer ?? null;
    this.videoInput = options.videoInput ?? false;
    this.videoOutput = options.videoOutput ?? false;
    this.recording = options.recording ?? false;
    this.transcription = options.transcription ?? false;
    this.enableObservability = options.enableObservability ?? false;
    this.enableEval = options.enableEval ?? false;
    this.runtime = options.runtime ?? "bun";
    this.dockerfile = options.dockerfile ?? false;
  }
}

/** A choice in a `Prompter` question. */
export interface Choice<T extends string = string> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * The questions the wizard asks. Each returns `null` when the user cancels (Ctrl-C), which the
 * flow turns into `ProjectCancelledError`.
 */
export interface Prompter {
  /** A line of text. */
  text(
    message: string,
    options?: { initialValue?: string; validate?: (v: string) => string | undefined },
  ): Promise<string | null>;
  /** One choice; `search` adds type-to-filter (for the long service lists). */
  select<T extends string>(
    message: string,
    choices: Choice<T>[],
    options?: { search?: boolean },
  ): Promise<T | null>;
  confirm(message: string, initialValue?: boolean): Promise<boolean | null>;
  /** Informational output (not a question). */
  info(message: string): void;
}

/** The terminal prompts, with `@clack/prompts`. */
export class ClackPrompter implements Prompter {
  async text(
    message: string,
    options: { initialValue?: string; validate?: (v: string) => string | undefined } = {},
  ): Promise<string | null> {
    // The suggested value is shown dimmed and accepted with Enter; typing replaces it.
    const suggestion = options.initialValue;
    const answer = await clack.text({
      message,
      ...(suggestion ? { placeholder: suggestion, defaultValue: suggestion } : {}),
      validate: (value) => options.validate?.(value || suggestion || ""),
    });
    return clack.isCancel(answer) ? null : answer;
  }

  async select<T extends string>(
    message: string,
    choices: Choice<T>[],
    options: { search?: boolean } = {},
  ): Promise<T | null> {
    const opts = choices.map((c) => ({
      value: c.value,
      label: c.label,
      ...(c.hint ? { hint: c.hint } : {}),
    })) as { value: T; label: string; hint?: string }[];
    const answer = options.search
      ? await clack.autocomplete<T>({ message, options: opts as never, maxItems: 10 })
      : await clack.select<T>({ message, options: opts as never });
    return clack.isCancel(answer) ? null : (answer as T);
  }

  async confirm(message: string, initialValue = false): Promise<boolean | null> {
    const answer = await clack.confirm({ message, initialValue });
    return clack.isCancel(answer) ? null : answer;
  }

  info(message: string): void {
    clack.log.info(message);
  }
}

function ensure<T>(value: T | null): T {
  if (value === null || value === undefined || (value as unknown) === "") {
    throw new ProjectCancelledError();
  }
  return value;
}

const toChoices = (services: readonly ServiceDefinition[]): Choice[] =>
  services.map((s) => ({
    label: s.label,
    value: s.value,
    ...(s.note ? { hint: s.note } : {}),
  }));

export interface AskProjectQuestionsOptions {
  /** The default for the project name prompt (e.g. the basename of the target directory). */
  defaultName?: string | null;
  /** The prompts to ask with (default: `@clack/prompts`). */
  prompter?: Prompter;
}

/**
 * Ask the user for the project configuration through interactive prompts.
 *
 * @returns The user's selections.
 * @throws ProjectCancelledError If the user cancels a prompt.
 */
export async function askProjectQuestions(
  options: AskProjectQuestionsOptions = {},
): Promise<ProjectConfig> {
  const p = options.prompter ?? new ClackPrompter();

  // Question 1: Project name
  const projectName = ensure(
    await p.text("Project name:", {
      initialValue: options.defaultName ?? "",
      validate: (text) => (text.length > 0 ? undefined : "Project name cannot be empty"),
    }),
  );

  // Question 2: Bot type
  const botType = ensure(
    await p.select<BotType>("Bot type:", [
      { label: "Web/Mobile", value: "web" },
      { label: "Telephony", value: "telephony" },
    ]),
  );

  // Question 2b: Client (web/mobile only). The runner serves a prebuilt client at /client.
  let generateClient = false;
  let clientFramework: string | null = null;
  let clientServer: string | null = null;
  if (botType === "web") {
    const framework = ensure(
      await p.select("Client:", [
        {
          label: "None (use the runner's built-in client)",
          value: "none",
          hint: "served at /client",
        },
        { label: "Vanilla JS (Vite)", value: "vanilla" },
      ]),
    );
    if (framework === "vanilla") {
      generateClient = true;
      clientFramework = "vanilla";
      clientServer = "vite"; // Vanilla JS always uses Vite
    }
  }

  // Question 3: Primary transport
  const transportOptions =
    botType === "web" ? ServiceRegistry.WEBRTC_TRANSPORTS : ServiceRegistry.TELEPHONY_TRANSPORTS;
  const transportChoices = toChoices(transportOptions);
  const primaryTransport = ensure(await p.select("Transport:", transportChoices));
  const transports = [primaryTransport];

  // Question 3b: Additional transport (for local testing)
  if (botType === "web") {
    const addBackup = await p.confirm("Add another transport for local testing?", false);
    if (addBackup) {
      const backupChoices = transportChoices.filter((c) => c.value !== primaryTransport);
      if (backupChoices.length > 0) {
        const backup = await p.select("Additional transport:", backupChoices);
        if (backup) transports.push(backup);
      }
    }
  } else if (primaryTransport !== "smallwebrtc") {
    // Telephony bots: offer WebRTC, so the bot can be tried from a browser without a phone.
    const addWebrtc = await p.confirm("Add a WebRTC transport for local testing?", false);
    if (addWebrtc) transports.push("smallwebrtc");
  }

  // Question 4: Pipeline mode
  const mode = ensure(
    await p.select("Pipeline architecture:", [
      { label: "Cascade (STT → LLM → TTS)", value: "cascade" },
      { label: "Realtime (speech-to-speech)", value: "realtime" },
    ]),
  );

  const config = new ProjectConfig({
    projectName,
    botType,
    transports,
    mode,
    generateClient,
    clientFramework,
    clientServer,
  });

  // Conditional questions based on mode
  if (mode === "cascade") {
    config.sttService = ensure(
      await p.select("Speech-to-Text:", toChoices(ServiceRegistry.STT_SERVICES), { search: true }),
    );
    config.llmService = ensure(
      await p.select("Language model:", toChoices(ServiceRegistry.LLM_SERVICES), { search: true }),
    );
    config.ttsService = ensure(
      await p.select("Text-to-Speech:", toChoices(ServiceRegistry.TTS_SERVICES), { search: true }),
    );
  } else {
    config.realtimeService = ensure(
      await p.select("Realtime service:", toChoices(ServiceRegistry.REALTIME_SERVICES), {
        search: true,
      }),
    );
  }

  // Question 5: Runtime
  config.runtime = ensure(
    await p.select<Runtime>("Runtime:", [
      { label: "Bun", value: "bun", hint: "recommended" },
      { label: "Node.js (22.18 or later)", value: "node" },
    ]),
  );

  // Question 6: Feature customization gate
  p.info(
    [
      "Default feature settings:",
      "  • Audio recording: No",
      "  • Transcription logging: No",
      ...(mode === "cascade" ? ["  • Smart turn-taking: Yes (recommended)"] : []),
      ...(botType === "web"
        ? ["  • Video avatar service: No", "  • Video input: No", "  • Video output: No"]
        : []),
      "  • Observability (OpenTelemetry tracing): No",
    ].join("\n"),
  );
  const customize = await p.confirm("Customize feature settings?", false);
  if (customize) {
    config.recording = Boolean(await p.confirm("Audio recording?", false));
    config.transcription = Boolean(await p.confirm("Transcription logging?", false));

    if (botType === "web") {
      const useVideoService = await p.confirm("Use video avatar service?", false);
      if (useVideoService) {
        config.videoService = await p.select(
          "Video avatar service:",
          toChoices(ServiceRegistry.VIDEO_SERVICES),
        );
      }
      config.videoInput = Boolean(await p.confirm("Video input?", false));
      // A video service requires video output, which is enabled automatically.
      config.videoOutput = config.videoService
        ? true
        : Boolean(await p.confirm("Video output?", false));
    }
    config.enableObservability = Boolean(await p.confirm("Enable observability?", false));
  }

  // Question 7: Dockerfile
  config.dockerfile = Boolean(await p.confirm("Generate a Dockerfile?", false));

  // Question 8: Eval transport (behavioral evals). Off by default: it adds an inert "eval" entry
  // to the transport params that is only used when the eval harness connects.
  config.enableEval = Boolean(await p.confirm("Enable evals?", false));

  return config;
}
