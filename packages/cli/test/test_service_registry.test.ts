// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_service_registry.py

// Tests for service registry integrity and completeness.
//
// DIVERGENCE: the registry lists npm packages, not PyPI extras, so the tests of
// `extract_package_extra` are tests of `extractPackagesForServices`; Daily isn't ported, so
// "daily" is "smallwebrtc"; the Daily PSTN and SIP branches of `get_imports_for_services`, the
// SageMaker services and Whisker have no counterpart (skipped). Tests under "NEW" keep the
// registry from going stale: the offered services are compared with `apps/docs/data/providers.ts`
// (what is ported) and with the workspace packages (what they export).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compatibleLlm,
  longTail,
  ported,
  type Section,
  unportedVariants,
  upcoming,
} from "../../../apps/docs/data/providers.ts";
import { COMPATIBLE_LLMS, compatibleLlmModelEnv } from "../src/_configs.ts";
import { IMPORTS } from "../src/_imports.ts";
import { mergeImports, packagesOfImports, ServiceLoader } from "../src/service_loader.ts";
import { NOT_OFFERED, ServiceDefinition, ServiceRegistry } from "../src/service_metadata.ts";

const ALL_SERVICES = [
  ...ServiceRegistry.STT_SERVICES,
  ...ServiceRegistry.LLM_SERVICES,
  ...ServiceRegistry.TTS_SERVICES,
  ...ServiceRegistry.REALTIME_SERVICES,
  ...ServiceRegistry.VIDEO_SERVICES,
];

describe("TestServiceRegistryIntegrity", () => {
  test("test_no_duplicate_service_values", () => {
    const all = [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
      ...ALL_SERVICES,
    ];
    const values = all.map((s) => s.value);
    const duplicates = values.filter((v, i) => values.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  test("test_package_extras_are_extractable", () => {
    // Upstream checks that PyPI extras can be taken from a package string. Here every service
    // names an npm package, and the packages a bot needs come from its imports.
    for (const service of ALL_SERVICES) {
      expect(service.pkg.startsWith("@pipedog/")).toBe(true);
      const packages = packagesOfImports(ServiceLoader.getServiceImport(service.value));
      expect(packages.has(service.pkg)).toBe(true);
    }
  });
});

describe("TestServiceLoader", () => {
  test("test_client_package_requires_a_version", () => {
    // A client package and its version range must be declared together.
    expect(
      () =>
        new ServiceDefinition({
          value: "x",
          label: "X",
          pkg: "@pipedog/x",
          clientPackage: "@pipecat-ai/x-transport",
        }),
    ).toThrow(/go together/);
    expect(
      () =>
        new ServiceDefinition({
          value: "x",
          label: "X",
          pkg: "@pipedog/x",
          clientPackageVersion: "^1.0.0",
        }),
    ).toThrow(/go together/);
  });

  test("test_get_service_by_value", () => {
    const service = ServiceLoader.getServiceByValue(ServiceRegistry.STT_SERVICES, "deepgram_stt");
    expect(service).not.toBeNull();
    expect(service?.value).toEqual("deepgram_stt");
    expect(service?.label).toEqual("Deepgram");
  });

  test("test_get_service_by_value_not_found", () => {
    expect(
      ServiceLoader.getServiceByValue(ServiceRegistry.STT_SERVICES, "nonexistent_service"),
    ).toBeNull();
  });

  test("test_get_service_config", () => {
    const config = ServiceLoader.getServiceConfig("deepgram_stt");
    expect(config).not.toBeNull();
    expect(config).toContain("DeepgramSTTService");
    expect(config).toContain("DEEPGRAM_API_KEY");
  });

  // NVIDIA and its SageMaker services aren't ported.
  test.skip("test_nvidia_sagemaker_configs_use_aws_region", () => {});

  test("test_get_service_import", () => {
    const imports = ServiceLoader.getServiceImport("deepgram_stt");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.some((imp) => imp.includes("DeepgramSTTService"))).toBe(true);
  });

  test("test_websocket_is_web_transport", () => {
    // WebSocket is a web (WebRTC list) transport, not telephony.
    const web = ServiceLoader.getTransportOptions("web");
    expect(web.some((t) => t.value === "websocket")).toBe(true);
    const telephony = ServiceLoader.getTransportOptions("telephony");
    expect(telephony.every((t) => t.value !== "websocket")).toBe(true);

    const transport = ServiceLoader.getServiceByValue(
      ServiceRegistry.WEBRTC_TRANSPORTS,
      "websocket",
    );
    expect(transport).not.toBeNull();
    expect(transport?.pkg).toEqual("@pipedog/transport-websocket");
  });

  test("test_websocket_transport_imports", () => {
    // WebSocket transport imports the params + Protobuf serializer. Bots build the transport
    // with createTransport(), so only the params class (and the serializer the factory sets) are
    // imported, not the transport class or the runner-args type.
    const joined = ServiceLoader.getServiceImport("websocket").join("\n");
    expect(joined).toContain("FastAPIWebsocketParams");
    expect(joined).toContain("ProtobufFrameSerializer");
  });

  for (const service of ALL_SERVICES) {
    test(`test_every_service_package_is_extractable[${service.value}]`, () => {
      // Every service names the package it comes from, and its bot imports it.
      expect(service.pkg.startsWith("@pipedog/")).toBe(true);
      const packages = ServiceLoader.extractPackagesForServices({
        transports: ["smallwebrtc"],
        ...(ServiceRegistry.STT_SERVICES.includes(service) ? { stt: service.value } : {}),
        ...(ServiceRegistry.LLM_SERVICES.includes(service) ? { llm: service.value } : {}),
        ...(ServiceRegistry.TTS_SERVICES.includes(service) ? { tts: service.value } : {}),
        ...(ServiceRegistry.REALTIME_SERVICES.includes(service) ? { realtime: service.value } : {}),
        ...(ServiceRegistry.VIDEO_SERVICES.includes(service) ? { video: service.value } : {}),
      });
      expect(packages.has(service.pkg)).toBe(true);
    });
  }

  test("test_extract_extras_for_cascade", () => {
    const packages = ServiceLoader.extractPackagesForServices({
      transports: ["smallwebrtc"],
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "cartesia_tts",
    });
    // Always: the runner and the local turn models.
    for (const name of [
      "@pipedog/runner",
      "@pipedog/core",
      "@pipedog/audio-silero",
      "@pipedog/audio-smart-turn",
      "onnxruntime-node",
    ]) {
      expect(packages.has(name)).toBe(true);
    }
    // The services' packages.
    for (const name of ["@pipedog/deepgram", "@pipedog/openai", "@pipedog/cartesia"]) {
      expect(packages.get(name)).toEqual("pipedog");
    }
    // A web transport over SmallWebRTC needs no WebSocket server.
    expect(packages.has("ws")).toBe(false);
  });

  test("test_extract_extras_for_realtime", () => {
    const packages = ServiceLoader.extractPackagesForServices({
      transports: ["smallwebrtc"],
      realtime: "openai_realtime",
    });
    expect(packages.has("@pipedog/runner")).toBe(true);
    expect(packages.has("@pipedog/audio-silero")).toBe(true);
    expect(packages.has("@pipedog/openai")).toBe(true);
  });

  test("test_extract_extras_with_video_service", () => {
    const packages = ServiceLoader.extractPackagesForServices({
      transports: ["smallwebrtc"],
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "cartesia_tts",
      video: "heygen_video",
    });
    expect(packages.has("@pipedog/heygen")).toBe(true);
    expect(packages.has("@pipedog/runner")).toBe(true);
    expect(packages.has("@pipedog/deepgram")).toBe(true);
    expect(packages.has("@pipedog/openai")).toBe(true);
    expect(packages.has("@pipedog/cartesia")).toBe(true);
  });

  // PyPI extras ("pipecat-ai[deepgram,sagemaker]") have no counterpart.
  test.skip("test_extract_multi_extra_package", () => {});
  test.skip("test_extract_single_extra_package", () => {});
  test.skip("test_extract_no_extra_package", () => {});
  test.skip("test_extract_extras_for_sagemaker_service", () => {});

  test("NEW: the transports' packages, and the third-party ones they need", () => {
    const websocket = ServiceLoader.extractPackagesForServices({
      transports: ["websocket"],
      realtime: "openai_realtime",
    });
    expect(websocket.has("@pipedog/transport-websocket")).toBe(true);
    expect(websocket.has("@pipedog/serializer-protobuf")).toBe(true);
    expect(websocket.has("ws")).toBe(true);
    const livekit = ServiceLoader.extractPackagesForServices({
      transports: ["livekit"],
      realtime: "openai_realtime",
    });
    expect(livekit.has("@pipedog/transport-livekit")).toBe(true);
    expect(livekit.has("@livekit/rtc-node")).toBe(true);
    const twilio = ServiceLoader.extractPackagesForServices({
      transports: ["twilio"],
      realtime: "openai_realtime",
    });
    expect(twilio.has("@pipedog/transport-websocket")).toBe(true);
    expect(twilio.has("ws")).toBe(true);
    const evals = ServiceLoader.extractPackagesForServices(
      { transports: ["smallwebrtc"], realtime: "openai_realtime" },
      { eval: true, observability: true },
    );
    expect(evals.has("@pipedog/evals")).toBe(true);
    expect(evals.has("@pipedog/tracing")).toBe(true);
    expect(evals.has("@opentelemetry/api")).toBe(true);
  });

  test("test_validate_service_exists", () => {
    expect(ServiceLoader.validateServiceExists("deepgram_stt")).toBe(true);
    expect(ServiceLoader.validateServiceExists("smallwebrtc")).toBe(true);
    expect(ServiceLoader.validateServiceExists("nonexistent")).toBe(false);
  });

  test("test_observability_feature_imports_exist", () => {
    // Observability is OpenTelemetry tracing here, not Whisker.
    expect("observability" in ServiceRegistry.FEATURE_IMPORTS).toBe(true);
    const imports = ServiceRegistry.FEATURE_IMPORTS.observability as readonly string[];
    expect(imports.some((imp) => imp.includes("setupTracing"))).toBe(true);
  });

  test("test_get_imports_with_observability", () => {
    const services = {
      transports: ["smallwebrtc"],
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "cartesia_tts",
    };
    const imports = ServiceLoader.getImportsForServices(services, { observability: true }, "web");
    const text = imports.join("\n");
    expect(text).toContain("setupTracing");
    expect(text).toContain("@pipedog/tracing");
  });

  test("test_get_imports_with_video_service", () => {
    const services = {
      transports: ["smallwebrtc"],
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "cartesia_tts",
      video: "heygen_video",
    };
    const text = ServiceLoader.getImportsForServices(
      services,
      { observability: false },
      "web",
    ).join("\n");
    expect(text).toContain("HeyGenVideoService");
    expect(text).toContain("@pipedog/heygen/video");
  });

  test("test_video_services_have_correct_metadata", () => {
    for (const video of ServiceRegistry.VIDEO_SERVICES) {
      expect(video.className).not.toBeNull();
      expect(video.className?.length).toBeGreaterThan(0);
      // The API key (or its equivalent) is read from the environment.
      expect(ServiceLoader.getEnvVars(video).length).toBeGreaterThan(0);
    }
  });
});

describe("TestTransportImportBranching", () => {
  // Upstream branches on Daily PSTN dial-out and Twilio + Daily SIP, which keep a hand-built
  // transport: skipped. The common paths are checked here.
  const BASE = { stt: "deepgram_stt", llm: "openai_llm", tts: "cartesia_tts" };
  const importsOf = (transport: string) =>
    ServiceLoader.getImportsForServices({ transports: [transport], ...BASE }, {}, "web").join("\n");

  test.skip("test_create_transport_import_branch", () => {});
  test.skip("test_llm_run_frame_import_branch", () => {});

  test("NEW: every transport builds through createTransport and kicks off the LLM", () => {
    for (const transport of [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
    ].map((t) => t.value)) {
      const text = importsOf(transport);
      expect(text).toContain("createTransport");
      expect(text).toContain("LLMRunFrame");
    }
  });

  test("NEW: imports are merged by module and sorted", () => {
    const lines = mergeImports([
      'import { b } from "pkg-b";',
      'import { z } from "pkg-a";',
      'import { a } from "pkg-a";',
      'import type { T } from "pkg-a";',
      'import { fs } from "node:fs";',
    ]);
    expect(lines).toEqual([
      'import { fs } from "node:fs";',
      'import { a, z } from "pkg-a";',
      'import type { T } from "pkg-a";',
      'import { b } from "pkg-b";',
    ]);
  });
});

describe("TestEnvExampleCoverage", () => {
  // Every env var a generated service config reads must be declared with the service, where
  // .env.example (and the generated bot's startup check) read it from. The e2e test generates
  // each service and checks the .env.example it writes.
  for (const service of ALL_SERVICES) {
    test(`test_config_env_vars_are_in_env_example[${service.value}]`, () => {
      const config = ServiceLoader.getServiceConfig(service.value) as string;
      const read = new Set([...config.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
      const declared = new Set(ServiceLoader.getEnvVars(service).map((e) => e.name));
      expect([...read].filter((name) => !declared.has(name as string))).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// NEW: the registry is checked against what pipedog has, so it can't go stale.
// ---------------------------------------------------------------------------------------------

const PACKAGES_DIR = resolve(import.meta.dir, "../..");

/** The source file of an import specifier (`@pipedog/openai/llm`), from the package's exports map. */
function sourceOf(specifier: string): string | null {
  const [, name, ...rest] = specifier.split("/") as [string, string, ...string[]];
  const dir = join(PACKAGES_DIR, name);
  if (!existsSync(join(dir, "package.json"))) return null;
  const exportsMap = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports ?? {};
  const sub = rest.length === 0 ? "." : `./${rest.join("/")}`;
  let target: unknown = exportsMap[sub];
  if (target === undefined && exportsMap["./*"] !== undefined) {
    target = (exportsMap["./*"] as string).replace("*", rest.join("/"));
  }
  if (typeof target === "object" && target !== null) {
    target = (target as Record<string, string>).default ?? Object.values(target)[0];
  }
  if (typeof target !== "string") return null;
  const file = join(dir, target);
  return existsSync(file) ? file : null;
}

/** Whether `file` exports `name`, directly or through an `export *` / `export { }` of another file. */
function exportsName(file: string, name: string, depth = 0): boolean {
  const text = readFileSync(file, "utf8");
  if (
    new RegExp(
      `export\\s+(abstract\\s+|async\\s+)?(class|const|let|function|interface|type|enum)\\s+${name}\\b`,
    ).test(text)
  ) {
    return true;
  }
  if (new RegExp(`export\\s+(type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text)) return true;
  if (depth < 3) {
    for (const m of text.matchAll(/export\s+\*\s+from\s+"(\.[^"]+)"/g)) {
      const next = resolve(file, "..", m[1] as string);
      if (existsSync(next) && exportsName(next, name, depth + 1)) return true;
    }
  }
  return false;
}

describe("NEW: the registry agrees with the workspace packages", () => {
  const packageNames = new Set(
    readdirSync(PACKAGES_DIR)
      .filter((d) => existsSync(join(PACKAGES_DIR, d, "package.json")))
      .map(
        (d) =>
          JSON.parse(readFileSync(join(PACKAGES_DIR, d, "package.json"), "utf8")).name as string,
      ),
  );

  test("every service's package exists, and so does every module and class it imports", () => {
    const problems: string[] = [];
    const all = [
      ...ServiceRegistry.WEBRTC_TRANSPORTS,
      ...ServiceRegistry.TELEPHONY_TRANSPORTS,
      ...ALL_SERVICES,
    ];
    for (const service of all) {
      if (!packageNames.has(service.pkg))
        problems.push(`${service.value}: no package ${service.pkg}`);
      for (const line of ServiceLoader.getServiceImport(service.value)) {
        const m = /^import (?:type )?\{ (.+) \} from "(.+)";$/.exec(line);
        if (!m) {
          problems.push(`${service.value}: cannot read '${line}'`);
          continue;
        }
        const file = sourceOf(m[2] as string);
        if (!file) {
          problems.push(`${service.value}: no module ${m[2]}`);
          continue;
        }
        for (const name of (m[1] as string).split(",").map((n) => n.trim())) {
          if (!exportsName(file, name))
            problems.push(`${service.value}: ${m[2]} doesn't export ${name}`);
        }
      }
      for (const cls of service.className ?? []) {
        if (!ServiceLoader.getServiceImport(service.value).join("\n").includes(cls)) {
          problems.push(`${service.value}: className ${cls} isn't imported`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the feature imports exist too", () => {
    const problems: string[] = [];
    for (const [feature, lines] of Object.entries(ServiceRegistry.FEATURE_IMPORTS)) {
      for (const line of lines) {
        const m = /^import (?:type )?\{ (.+) \} from "(.+)";$/.exec(line);
        if (!m || (m[2] as string).startsWith("node:")) continue;
        const file = sourceOf(m[2] as string);
        if (!file) {
          problems.push(`${feature}: no module ${m[2]}`);
          continue;
        }
        for (const name of (m[1] as string).split(",").map((n) => n.trim())) {
          if (!exportsName(file, name)) problems.push(`${feature}: ${m[2]} doesn't export ${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the OpenAI-compatible LLMs match apps/docs/data/providers.ts", () => {
    expect(COMPATIBLE_LLMS.map((l) => l.cls).sort()).toEqual(
      compatibleLlm.map((l) => l.cls).sort(),
    );
    for (const llm of COMPATIBLE_LLMS) {
      const docs = compatibleLlm.find((l) => l.cls === llm.cls);
      expect(docs).toBeDefined();
      expect(llm.pkg).toEqual(docs?.pkg as string);
      expect(llm.env).toEqual(docs?.env as string | null);
      expect(llm.model).toEqual(docs?.model as string);
      expect(compatibleLlmModelEnv(llm)).toMatch(/^[A-Z0-9]+_MODEL$/);
    }
  });

  test("every dependency range of a generated project resolves to a workspace package", () => {
    for (const service of ALL_SERVICES) {
      const text = ServiceLoader.getServiceImport(service.value).join("\n");
      for (const pkg of packagesOfImports(text.split("\n")))
        expect(packageNames.has(pkg)).toBe(true);
    }
  });
});

describe("NEW: the registry agrees with the docs' list of ported services", () => {
  const sections: Section[] = ["llm", "stt", "tts", "s2s", "video"];
  const portedClasses = new Map<string, Section>();
  for (const section of sections) {
    for (const page of ported[section])
      for (const cls of page.classes) portedClasses.set(cls, section);
  }
  const offeredClasses = new Set(ALL_SERVICES.flatMap((s) => s.className ?? []));

  test("every ported service is offered, or is explained in NOT_OFFERED", () => {
    const missing = [...portedClasses.keys()].filter(
      (cls) => !offeredClasses.has(cls) && !(cls in NOT_OFFERED),
    );
    expect(missing).toEqual([]);
  });

  test("NOT_OFFERED lists only ported classes that aren't offered", () => {
    for (const cls of Object.keys(NOT_OFFERED)) {
      expect(portedClasses.has(cls)).toBe(true);
      expect(offeredClasses.has(cls)).toBe(false);
    }
  });

  test("only ported services are offered", () => {
    const notPorted = [...offeredClasses].filter((cls) => !portedClasses.has(cls));
    expect(notPorted).toEqual([]);
  });

  test("a service the docs list as not ported isn't offered", () => {
    const unported = new Set([
      ...upcoming.flatMap((p) => p.classes),
      ...longTail.flatMap((p) => p.classes),
      ...unportedVariants.flatMap((p) => p.classes),
    ]);
    expect([...offeredClasses].filter((cls) => unported.has(cls))).toEqual([]);
  });

  test("each service is offered in the list of its kind", () => {
    const kind = (list: readonly ServiceDefinition[]) =>
      new Set(list.flatMap((s) => s.className ?? []));
    const expected: [readonly ServiceDefinition[], Section[]][] = [
      [ServiceRegistry.STT_SERVICES, ["stt"]],
      [ServiceRegistry.TTS_SERVICES, ["tts"]],
      [ServiceRegistry.LLM_SERVICES, ["llm"]],
      [ServiceRegistry.REALTIME_SERVICES, ["s2s"]],
      [ServiceRegistry.VIDEO_SERVICES, ["video"]],
    ];
    for (const [list, kinds] of expected) {
      for (const cls of kind(list)) expect(kinds).toContain(portedClasses.get(cls) as Section);
    }
  });

  test("the transports are ported ones", () => {
    const transports = new Set(ported.transports.flatMap((p) => p.pkg));
    for (const t of ServiceRegistry.WEBRTC_TRANSPORTS) expect(transports.has(t.pkg)).toBe(true);
    const serializers = new Set(ported.serializers.flatMap((p) => p.pkg));
    for (const t of ServiceRegistry.TELEPHONY_TRANSPORTS) expect(serializers.has(t.pkg)).toBe(true);
  });
});

describe("NEW: IMPORTS covers every service", () => {
  test("no service lacks an import or a config", () => {
    expect(ServiceLoader.getMissingServices()).toEqual({ missingConfigs: [], missingImports: [] });
  });

  test("IMPORTS has no entry for a service that isn't registered", () => {
    const registered = new Set(
      [
        ...ServiceRegistry.WEBRTC_TRANSPORTS,
        ...ServiceRegistry.TELEPHONY_TRANSPORTS,
        ...ALL_SERVICES,
      ].map((s) => s.value),
    );
    expect(Object.keys(IMPORTS).filter((v) => !registered.has(v))).toEqual([]);
    expect(Object.keys(ServiceRegistry.SERVICE_CONFIGS).filter((v) => !registered.has(v))).toEqual(
      [],
    );
  });
});
