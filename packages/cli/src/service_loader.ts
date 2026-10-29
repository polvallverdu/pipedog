// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/registry/service_loader.py

/**
 * Service loading and validation logic.
 *
 * This module handles loading services, validating configurations, and providing utilities for
 * working with the service registry.
 *
 * DIVERGENCE: upstream's `extract_extras_for_services` returns PyPI extras of `pipecat-ai`
 * (`pipecat-ai[deepgram]`). Here the services are separate npm packages, so
 * `extractPackagesForServices` returns the `@pipedog/*` packages a bot's imports need and the
 * third-party ones next to them. `getEnvVars` is new: it reads each service's environment
 * variables from its config, where upstream keeps them in a 500-line `env.example.jinja2`.
 */

import { SERVICE_CONFIGS } from "./_configs.ts";
import {
  type BotType,
  type EnvVarDefinition,
  type ServiceDefinition,
  ServiceRegistry,
  type ServiceType,
} from "./service_metadata.ts";

/** Third-party packages the generated project depends on, with the ranges it is written against. */
export const THIRD_PARTY_VERSIONS: Record<string, string> = {
  // Runs the local Silero VAD and Smart Turn models (@pipedog/onnx falls back to onnxruntime-web).
  "onnxruntime-node": "^1.30.0",
  // Node's WebSocket server (the runner's /ws routes); Bun and Deno have one built in.
  ws: "^8.22.0",
  "@livekit/rtc-node": "^1.1.0",
  "@opentelemetry/api": "^1.9.1",
};

/** Where to get the API keys, shown in `.env.example`. */
const ENV_DESCRIPTIONS: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  ASSEMBLYAI_API_KEY: "https://www.assemblyai.com/dashboard/api-keys",
  DEEPGRAM_API_KEY: "https://console.deepgram.com/",
  CARTESIA_API_KEY: "https://play.cartesia.ai/keys",
  CLOUDFLARE_ACCOUNT_ID: "https://dash.cloudflare.com/ (Workers AI > Use REST API)",
  CLOUDFLARE_API_TOKEN: "https://dash.cloudflare.com/profile/api-tokens (Workers AI permission)",
  ELEVENLABS_API_KEY: "https://elevenlabs.io/app/settings/api-keys",
  ELEVENLABS_VOICE_ID: "a voice from your ElevenLabs voice library",
  GLADIA_API_KEY: "https://app.gladia.io/",
  GOOGLE_API_KEY: "https://aistudio.google.com/apikey",
  GOOGLE_APPLICATION_CREDENTIALS: "path to a Google Cloud service account JSON file",
  GROQ_API_KEY: "https://console.groq.com/keys",
  HEYGEN_AVATAR_ID: "the LiveAvatar avatar to use",
  HEYGEN_LIVE_AVATAR_API_KEY: "https://app.liveavatar.com/",
  INWORLD_API_KEY: "https://platform.inworld.ai/",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  MISTRAL_VOICE_ID: "a voice from your Mistral account",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  SONIOX_API_KEY: "https://console.soniox.com/",
  SPEECHMATICS_API_KEY: "https://portal.speechmatics.com/",
  TOGETHER_API_KEY: "https://api.together.ai/settings/api-keys",
  ULTRAVOX_API_KEY: "https://app.ultravox.ai/",
  XAI_API_KEY: "https://console.x.ai/",
};

/** One `import { A, B } from "module";` line, taken apart. */
const IMPORT_LINE = /^import (type )?\{ (.+) \} from "(.+)";$/;

/**
 * Merge `import { A } from "m";` lines: names from one module go in one statement, statements
 * are sorted (`node:` first, then by module), and a statement over 100 characters is wrapped.
 * A line that isn't a named import is kept as is.
 */
export function mergeImports(lines: Iterable<string>): string[] {
  const modules = new Map<string, { names: Set<string>; type: boolean }>();
  const others = new Set<string>();
  for (const line of lines) {
    const match = IMPORT_LINE.exec(line);
    if (!match) {
      others.add(line);
      continue;
    }
    const type = match[1];
    const names = match[2] ?? "";
    const module = match[3] ?? "";
    const key = `${type ? "type " : ""}${module}`;
    const entry = modules.get(key) ?? { names: new Set<string>(), type: Boolean(type) };
    for (const name of names.split(",")) entry.names.add(name.trim());
    modules.set(key, entry);
  }
  const rank = (module: string) => (module.startsWith("node:") ? 0 : 1);
  const sorted = [...modules.entries()].sort(([a], [b]) => {
    const ma = a.replace(/^type /, "");
    const mb = b.replace(/^type /, "");
    return rank(ma) - rank(mb) || ma.localeCompare(mb) || a.localeCompare(b);
  });
  const out = sorted.map(([key, { names, type }]) => {
    const module = key.replace(/^type /, "");
    const list = [...names].sort((a, b) => a.localeCompare(b));
    const line = `import ${type ? "type " : ""}{ ${list.join(", ")} } from "${module}";`;
    if (line.length <= 100) return line;
    return `import ${type ? "type " : ""}{\n${list.map((n) => `  ${n},`).join("\n")}\n} from "${module}";`;
  });
  return [...out, ...[...others].sort()];
}

/** The npm package an import specifier belongs to (`@pipedog/openai/llm` -> `@pipedog/openai`). */
export function packageOfSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith(".")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

/** The npm packages the lines import (`node:` modules excluded). */
export function packagesOfImports(lines: Iterable<string>): Set<string> {
  const packages = new Set<string>();
  for (const line of lines) {
    const match = IMPORT_LINE.exec(line) ?? /^import .*from "(.+)";$/s.exec(line);
    const specifier = match?.[match.length - 1];
    const pkg = specifier ? packageOfSpecifier(specifier) : null;
    if (pkg) packages.add(pkg);
  }
  return packages;
}

/** Handles loading and validating services from the registry. */
export class ServiceLoader {
  /** Find a service definition by its value; `null` if there is none. */
  static getServiceByValue(
    serviceList: readonly ServiceDefinition[],
    value: string,
  ): ServiceDefinition | null {
    return serviceList.find((service) => service.value === value) ?? null;
  }

  /** Get all services of a type. */
  static getAllServicesByType(serviceType: ServiceType): ServiceDefinition[] {
    const typeMap: Record<ServiceType, ServiceDefinition[]> = {
      transport: [...ServiceRegistry.WEBRTC_TRANSPORTS, ...ServiceRegistry.TELEPHONY_TRANSPORTS],
      stt: ServiceRegistry.STT_SERVICES,
      llm: ServiceRegistry.LLM_SERVICES,
      tts: ServiceRegistry.TTS_SERVICES,
      realtime: ServiceRegistry.REALTIME_SERVICES,
      video: ServiceRegistry.VIDEO_SERVICES,
    };
    return typeMap[serviceType] ?? [];
  }

  /** The initialization expression for a service (`"deepgram_stt"`), or `null`. */
  static getServiceConfig(serviceValue: string): string | null {
    return Object.hasOwn(SERVICE_CONFIGS, serviceValue)
      ? (SERVICE_CONFIGS[serviceValue] as string)
      : null;
  }

  /** Import statements for a service. */
  static getServiceImport(serviceValue: string): string[] {
    return [...(ServiceRegistry.IMPORTS[serviceValue] ?? [])];
  }

  /**
   * The environment variables a service reads: its `envVars`, or those its config reads
   * (`process.env.NAME ?? ""` is required, `?? "default"` has a default, a bare read is optional).
   */
  static getEnvVars(service: ServiceDefinition): EnvVarDefinition[] {
    if (service.envVars) return service.envVars;
    const config = ServiceLoader.getServiceConfig(service.value) ?? "";
    const vars = new Map<string, EnvVarDefinition>();
    for (const match of config.matchAll(/process\.env\.([A-Z0-9_]+)(?: \?\? "([^"]*)")?/g)) {
      const name = match[1] as string;
      const fallback = match[2];
      if (vars.has(name)) continue;
      const description = ENV_DESCRIPTIONS[name];
      vars.set(name, {
        name,
        ...(description ? { description } : {}),
        required: fallback === "",
        ...(fallback ? { default: fallback } : {}),
      });
    }
    return [...vars.values()];
  }

  /**
   * The npm packages a bot needs for the selected services: `@pipedog/*` packages (from the
   * bot's imports) and third-party ones, as `name -> "pipedog" | version range`. `"pipedog"` is
   * the release the CLI belongs to.
   *
   * @param services Service type to service value(s), e.g. `{ transports: ["smallwebrtc"], stt: "deepgram_stt" }`.
   * @param features Enabled features (`recording`, `eval`, `observability`, ...).
   */
  static extractPackagesForServices(
    services: Record<string, string | string[]>,
    features: Record<string, boolean> = {},
  ): Map<string, string> {
    const packages = new Map<string, string>();
    const add = (name: string) => {
      packages.set(
        name,
        name.startsWith("@pipedog/") ? "pipedog" : (THIRD_PARTY_VERSIONS[name] ?? "latest"),
      );
    };

    // Always: the runner, core, and the local turn models.
    for (const name of [
      "@pipedog/core",
      "@pipedog/runner",
      "@pipedog/audio-silero",
      "@pipedog/audio-smart-turn",
      "onnxruntime-node",
    ]) {
      add(name);
    }

    const allTransports = [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ];
    const selected: ServiceDefinition[] = [];
    for (const transport of toList(services.transports)) {
      const def = ServiceLoader.getServiceByValue(allTransports, transport);
      if (def) selected.push(def);
    }
    for (const [type, list] of [
      ["stt", ServiceRegistry.STT_SERVICES],
      ["llm", ServiceRegistry.LLM_SERVICES],
      ["tts", ServiceRegistry.TTS_SERVICES],
      ["realtime", ServiceRegistry.REALTIME_SERVICES],
      ["video", ServiceRegistry.VIDEO_SERVICES],
    ] as const) {
      const value = toList(services[type])[0];
      const def = value ? ServiceLoader.getServiceByValue(list, value) : null;
      if (def) selected.push(def);
    }
    const lines: string[] = [];
    for (const def of selected) {
      lines.push(...ServiceLoader.getServiceImport(def.value));
      for (const dep of Object.keys(def.extraDependencies ?? {})) add(dep);
    }
    for (const feature of [
      "recording",
      "transcription",
      "observability",
      "eval",
      "video_in_sources",
    ]) {
      if (features[feature]) lines.push(...(ServiceRegistry.FEATURE_IMPORTS[feature] ?? []));
    }
    for (const pkg of packagesOfImports(lines)) add(pkg);

    const transports = toList(services.transports);
    // Node has no built-in WebSocket server; the runner's /ws routes use `ws` there.
    if (
      transports.some(
        (t) => t === "websocket" || ServiceRegistry.TELEPHONY_TRANSPORTS.some((d) => d.value === t),
      )
    ) {
      add("ws");
    }
    if (features.observability) add("@opentelemetry/api");
    // Extra dependencies a service declares keep their own ranges.
    for (const def of selected) {
      for (const [name, range] of Object.entries(def.extraDependencies ?? {}))
        packages.set(name, range);
    }
    return packages;
  }

  /** Check if a service exists in the registry. */
  static validateServiceExists(serviceValue: string): boolean {
    if (Object.hasOwn(SERVICE_CONFIGS, serviceValue)) return true;
    const allTransports = [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ];
    return ServiceLoader.getServiceByValue(allTransports, serviceValue) !== null;
  }

  /** Transport options for a bot type. */
  static getTransportOptions(botType: BotType): ServiceDefinition[] {
    if (botType === "web") return ServiceRegistry.WEBRTC_TRANSPORTS;
    if (botType === "telephony") return ServiceRegistry.TELEPHONY_TRANSPORTS;
    return [];
  }

  /**
   * All import statements for the selected services and features, merged and sorted.
   *
   * @param services Service type to service value(s).
   * @param features Enabled features.
   * @param botType Type of bot (`"web"` or `"telephony"`).
   * @param extraImports Further import lines the generated file needs, merged in.
   */
  static getImportsForServices(
    services: Record<string, string | string[]>,
    features: Record<string, boolean>,
    _botType: BotType = "web",
    extraImports: readonly string[] = [],
  ): string[] {
    const imports = new Set<string>([...ServiceRegistry.BASE_IMPORTS, ...extraImports]);

    // Always add pipeline, context, runner and vad imports.
    for (const feature of ["pipeline", "context", "runner", "vad"]) {
      for (const line of ServiceRegistry.FEATURE_IMPORTS[feature] ?? []) imports.add(line);
    }

    // Transport imports (can be several).
    for (const transport of toList(services.transports)) {
      for (const line of ServiceRegistry.IMPORTS[transport] ?? []) imports.add(line);
    }

    // Service imports.
    for (const type of ["stt", "llm", "tts", "realtime", "video"]) {
      for (const value of toList(services[type])) {
        for (const line of ServiceRegistry.IMPORTS[value] ?? []) imports.add(line);
      }
    }

    // Feature imports.
    for (const feature of [
      "recording",
      "transcription",
      "observability",
      "eval",
      "video_in_sources",
    ]) {
      if (features[feature]) {
        for (const line of ServiceRegistry.FEATURE_IMPORTS[feature] ?? []) imports.add(line);
      }
    }

    // LLMRunFrame kicks off the conversation on connect.
    for (const line of ServiceRegistry.FEATURE_IMPORTS.llm_run_frame ?? []) imports.add(line);

    return mergeImports(imports);
  }

  /** Find services that are defined but missing configs or imports. */
  static getMissingServices(): { missingConfigs: string[]; missingImports: string[] } {
    const missing = { missingConfigs: [] as string[], missingImports: [] as string[] };
    const all = [
      ...ServiceRegistry.STT_SERVICES,
      ...ServiceRegistry.LLM_SERVICES,
      ...ServiceRegistry.TTS_SERVICES,
      ...ServiceRegistry.REALTIME_SERVICES,
      ...ServiceRegistry.VIDEO_SERVICES,
    ];
    for (const service of all) {
      if (!Object.hasOwn(SERVICE_CONFIGS, service.value))
        missing.missingConfigs.push(service.value);
      if (!Object.hasOwn(ServiceRegistry.IMPORTS, service.value)) {
        missing.missingImports.push(service.value);
      }
    }
    const transports = [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ];
    for (const service of transports) {
      if (!Object.hasOwn(ServiceRegistry.IMPORTS, service.value)) {
        missing.missingImports.push(service.value);
      }
    }
    return missing;
  }
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
