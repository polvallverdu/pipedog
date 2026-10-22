// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/config_validator.py

/**
 * Validation and configuration building for non-interactive project creation.
 *
 * DIVERGENCE: the JSON config file keeps upstream's snake_case keys (`project_name`,
 * `stt_service`, ...), since it is input a person or an agent writes, and `--dry-run` prints the
 * same keys. Not ported, because they have no pipedog counterpart: Daily PSTN and Twilio + Daily
 * SIP (`--daily-pstn-mode`, `--twilio-daily-sip-mode`), `--deploy-to-cloud` and
 * `--enable-krisp` (Pipecat Cloud), and React clients (`--client-framework react`). New:
 * `--runtime` and `--dockerfile`. Upstream's options are still recognized, so a config file written
 * for Pipecat fails with a message that says what to change, not an unknown-key error.
 */

import { readFileSync } from "node:fs";
import { ProjectConfig, type Runtime } from "./questions.ts";
import { ServiceRegistry } from "./service_metadata.ts";

/**
 * Raised when project configuration validation fails.
 *
 * Collects all validation errors so agents see every problem at once.
 */
export class ConfigValidationError extends Error {
  override name = "ConfigValidationError";
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.errors = errors;
  }
}

/** Extract the valid value strings from a list of service definitions. */
function getValidValues(serviceList: readonly { value: string }[]): string[] {
  return serviceList.map((svc) => svc.value);
}

/** Pipecat transports with no pipedog counterpart, and why. */
const UNPORTED_TRANSPORTS: Record<string, string> = {
  daily: "Daily isn't ported to pipedog",
  daily_pstn: "Daily PSTN needs Daily, which isn't ported to pipedog",
  twilio_daily_sip: "Twilio + Daily SIP needs Daily, which isn't ported to pipedog",
};

export interface ValidateConfigOptions {
  name?: string | null;
  botType?: string | null;
  transport?: string[] | null;
  mode?: string | null;
  stt?: string | null;
  llm?: string | null;
  tts?: string | null;
  realtime?: string | null;
  video?: string | null;
  clientFramework?: string | null;
  clientServer?: string | null;
  recording?: boolean;
  transcription?: boolean;
  videoInput?: boolean;
  videoOutput?: boolean;
  observability?: boolean;
  enableEval?: boolean;
  runtime?: string | null;
  dockerfile?: boolean;
  /** Pipecat-only options, rejected with an explanation when set. */
  unsupported?: Record<string, unknown>;
}

/** What upstream's options that pipedog doesn't have are, and what to do instead. */
export const UNSUPPORTED_OPTIONS: Record<string, string> = {
  dailyPstnMode: "--daily-pstn-mode isn't available: Daily isn't ported to pipedog",
  twilioDailySipMode: "--twilio-daily-sip-mode isn't available: Daily isn't ported to pipedog",
  deployToCloud:
    "--deploy-to-cloud isn't available: Pipecat Cloud has no pipedog counterpart. Use --dockerfile to get a Dockerfile",
  enableKrisp: "--enable-krisp isn't available: Krisp isn't ported to pipedog",
};

/**
 * Validate all inputs and build a ProjectConfig.
 *
 * Collects all errors before raising, so callers see every problem at once.
 *
 * @returns A fully-populated ProjectConfig.
 * @throws ConfigValidationError If any validation fails.
 */
export function validateAndBuildConfig(options: ValidateConfigOptions = {}): ProjectConfig {
  const {
    name = null,
    transport = null,
    mode = null,
    stt = null,
    llm = null,
    tts = null,
    realtime = null,
    video = null,
    clientFramework = null,
    clientServer = null,
    recording = false,
    transcription = false,
    videoInput = false,
    videoOutput: videoOutputFlag = false,
    observability = false,
    enableEval = false,
    runtime = null,
    dockerfile = false,
  } = options;
  let botType = options.botType ?? null;
  let videoOutput = videoOutputFlag;
  const errors: string[] = [];

  // Pipecat-only options.
  for (const [key, value] of Object.entries(options.unsupported ?? {})) {
    // Falsy values are the defaults of boolean flags, and mean "not asked for".
    if (value === undefined || value === null || value === false) continue;
    errors.push(UNSUPPORTED_OPTIONS[key] ?? `${key} isn't available in pipedog`);
  }

  // --- Required fields ---
  if (!name) errors.push("--name is required");

  // --bot-type is optional in non-interactive mode: when omitted it is inferred from the
  // transports below (a forking question for the interactive wizard, but the transports already
  // determine it headless). Only validate it when given.
  if (botType && botType !== "web" && botType !== "telephony") {
    errors.push(`--bot-type must be 'web' or 'telephony', got '${botType}'`);
  }

  if (!transport || transport.length === 0) errors.push("At least one --transport is required");

  if (!mode) {
    errors.push("--mode is required (cascade or realtime)");
  } else if (mode !== "cascade" && mode !== "realtime") {
    errors.push(`--mode must be 'cascade' or 'realtime', got '${mode}'`);
  }

  if (runtime && runtime !== "bun" && runtime !== "node") {
    errors.push(`--runtime must be 'bun' or 'node', got '${runtime}'`);
  }

  // --- Transport validation ---
  const webrtcValues = getValidValues(ServiceRegistry.WEBRTC_TRANSPORTS);
  const telephonyValues = getValidValues(ServiceRegistry.TELEPHONY_TRANSPORTS);
  const validTransportValues = [...webrtcValues, ...telephonyValues];

  const resolvedTransports: string[] = [];
  for (const t of transport ?? []) {
    if (validTransportValues.includes(t)) {
      resolvedTransports.push(t);
    } else if (Object.hasOwn(UNPORTED_TRANSPORTS, t)) {
      errors.push(
        `Transport '${t}' isn't available: ${UNPORTED_TRANSPORTS[t]}. ` +
          `Valid transports: ${[...validTransportValues].sort().join(", ")}`,
      );
    } else {
      errors.push(
        `Unknown transport '${t}'. Valid transports: ${[...validTransportValues].sort().join(", ")}`,
      );
    }
  }

  // Infer bot_type from the transports when it wasn't given: telephony if any transport is a
  // telephony transport, otherwise web. (Explicit values are validated against the transports by
  // the cross-check below.)
  if (!botType && resolvedTransports.length > 0) {
    botType = resolvedTransports.some((t) => telephonyValues.includes(t)) ? "telephony" : "web";
  }

  // Cross-check transport vs bot_type
  if (botType && resolvedTransports.length > 0) {
    for (const t of resolvedTransports) {
      if (botType === "web" && telephonyValues.includes(t)) {
        errors.push(`Transport '${t}' is a telephony transport but bot-type is 'web'`);
      }
      // WebRTC transports are allowed for telephony bots (local testing)
    }
  }

  // --- Mode-specific service validation ---
  if (mode === "cascade") {
    const checks: [string, string | null, string, readonly { value: string }[]][] = [
      ["--stt", stt, "STT", ServiceRegistry.STT_SERVICES],
      ["--llm", llm, "LLM", ServiceRegistry.LLM_SERVICES],
      ["--tts", tts, "TTS", ServiceRegistry.TTS_SERVICES],
    ];
    for (const [flag, value, label, list] of checks) {
      if (!value) {
        errors.push(`${flag} is required for cascade mode`);
      } else if (!getValidValues(list).includes(value)) {
        errors.push(
          `Unknown ${label} service '${value}'. Valid: ${getValidValues(list).join(", ")}`,
        );
      }
    }
    if (realtime) errors.push("--realtime should not be specified in cascade mode");
  } else if (mode === "realtime") {
    if (!realtime) {
      errors.push("--realtime is required for realtime mode");
    } else if (!getValidValues(ServiceRegistry.REALTIME_SERVICES).includes(realtime)) {
      errors.push(
        `Unknown realtime service '${realtime}'. ` +
          `Valid: ${getValidValues(ServiceRegistry.REALTIME_SERVICES).join(", ")}`,
      );
    }
    if (stt) errors.push("--stt should not be specified in realtime mode");
    if (llm) errors.push("--llm should not be specified in realtime mode");
    if (tts) errors.push("--tts should not be specified in realtime mode");
  }

  // --- Video service validation ---
  if (video) {
    if (!getValidValues(ServiceRegistry.VIDEO_SERVICES).includes(video)) {
      errors.push(
        `Unknown video service '${video}'. ` +
          `Valid: ${getValidValues(ServiceRegistry.VIDEO_SERVICES).join(", ")}`,
      );
    }
    if (botType === "telephony") errors.push("Video services are only available for web bots");
  }

  // --- Client validation ---
  let generateClient = false;
  let resolvedClientFramework: string | null = clientFramework;
  let resolvedClientServer: string | null = clientServer;

  if (clientFramework) {
    if (!["react", "vanilla", "none"].includes(clientFramework)) {
      errors.push(`--client-framework must be 'vanilla' or 'none', got '${clientFramework}'`);
    }
    if (botType === "telephony") errors.push("--client-framework is only available for web bots");
    if (clientFramework === "react") {
      errors.push(
        "--client-framework react isn't available yet. Use 'vanilla' for a Vite client, " +
          "or 'none': the runner serves a built-in React client at /client",
      );
    } else if (clientFramework === "vanilla") {
      generateClient = true;
      resolvedClientServer = "vite";
      if (clientServer && clientServer !== "vite") {
        errors.push(`--client-server must be 'vite', got '${clientServer}'`);
      }
    } else if (clientFramework === "none") {
      resolvedClientFramework = null;
    }
  }

  if (clientServer && !clientFramework) errors.push("--client-server requires --client-framework");

  // --- Cross-field constraints ---
  if (videoInput && botType === "telephony")
    errors.push("--video-input is only available for web bots");
  if (videoOutput && botType === "telephony") {
    errors.push("--video-output is only available for web bots");
  }

  // Bail out with all errors
  if (errors.length > 0) throw new ConfigValidationError(errors);

  // --- Apply defaults ---

  // Force video output on if a video service is selected
  if (video) videoOutput = true;

  return new ProjectConfig({
    projectName: name as string,
    botType: botType as "web" | "telephony",
    transports: resolvedTransports,
    mode: mode as string,
    sttService: mode === "cascade" ? stt : null,
    llmService: mode === "cascade" ? llm : null,
    ttsService: mode === "cascade" ? tts : null,
    realtimeService: mode === "realtime" ? realtime : null,
    videoService: video,
    generateClient,
    clientFramework: resolvedClientFramework,
    clientServer: resolvedClientServer,
    videoInput,
    videoOutput,
    recording,
    transcription,
    enableObservability: observability,
    enableEval,
    runtime: (runtime ?? "bun") as Runtime,
    dockerfile,
  });
}

/**
 * Load a JSON config file and return it as an object.
 *
 * @throws Error (ENOENT) If the file does not exist.
 * @throws SyntaxError If the file is not valid JSON.
 */
export function loadConfigFromFile(path: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SyntaxError(`${path}: a config file must hold a JSON object`);
  }
  return data as Record<string, unknown>;
}

/** Serialize a ProjectConfig to a pretty-printed JSON string (upstream's snake_case keys). */
export function configToJson(config: ProjectConfig): string {
  const data = {
    project_name: config.projectName,
    bot_type: config.botType,
    transports: config.transports,
    mode: config.mode,
    stt_service: config.sttService,
    llm_service: config.llmService,
    tts_service: config.ttsService,
    realtime_service: config.realtimeService,
    video_service: config.videoService,
    generate_client: config.generateClient,
    client_framework: config.clientFramework,
    client_server: config.clientServer,
    video_input: config.videoInput,
    video_output: config.videoOutput,
    recording: config.recording,
    transcription: config.transcription,
    enable_observability: config.enableObservability,
    enable_eval: config.enableEval,
    runtime: config.runtime,
    dockerfile: config.dockerfile,
  };
  return JSON.stringify(data, null, 2);
}
