// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_config_validator.py

// Tests for the config_validator module (non-interactive mode).
//
// DIVERGENCE: Daily isn't ported, so where upstream uses "daily" as its stand-in web transport
// this uses "smallwebrtc" (and "websocket" for the second one). Daily PSTN, Twilio + Daily SIP,
// Krisp, Pipecat Cloud and the React clients have no counterpart: their tests are skipped, and
// tests under "NEW" check that the same input is rejected with an explanation. Services that
// aren't ported (tavus_video) are replaced by ported ones (heygen_video, anthropic_llm).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigValidationError,
  configToJson,
  loadConfigFromFile,
  type ValidateConfigOptions,
  validateAndBuildConfig,
} from "../src/config_validator.ts";
import { ProjectConfig } from "../src/questions.ts";

/** The errors `validateAndBuildConfig` collects for `options`. */
function errorsOf(options?: ValidateConfigOptions): string[] {
  try {
    validateAndBuildConfig(options);
  } catch (e) {
    if (e instanceof ConfigValidationError) return e.errors;
    throw e;
  }
  throw new Error("expected a ConfigValidationError");
}

const CASCADE = {
  mode: "cascade",
  stt: "deepgram_stt",
  llm: "openai_llm",
  tts: "cartesia_tts",
} as const;

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pipedog-cli-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("TestValidCascadeConfigs", () => {
  test("test_minimal_web_cascade", () => {
    const config = validateAndBuildConfig({
      name: "my-bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
    });
    expect(config).toBeInstanceOf(ProjectConfig);
    expect(config.projectName).toEqual("my-bot");
    expect(config.botType).toEqual("web");
    expect(config.transports).toEqual(["smallwebrtc"]);
    expect(config.mode).toEqual("cascade");
    expect(config.sttService).toEqual("deepgram_stt");
    expect(config.llmService).toEqual("openai_llm");
    expect(config.ttsService).toEqual("cartesia_tts");
    expect(config.realtimeService).toBeNull();
  });

  test("test_multiple_transports", () => {
    const config = validateAndBuildConfig({
      name: "my-bot",
      botType: "web",
      transport: ["websocket", "smallwebrtc"],
      ...CASCADE,
    });
    expect(config.transports).toEqual(["websocket", "smallwebrtc"]);
  });

  test("test_telephony_cascade", () => {
    const config = validateAndBuildConfig({
      name: "call-bot",
      botType: "telephony",
      transport: ["twilio"],
      ...CASCADE,
    });
    expect(config.botType).toEqual("telephony");
    expect(config.transports).toEqual(["twilio"]);
  });

  test("test_telephony_with_webrtc_backup", () => {
    // Telephony bots can add WebRTC for local testing.
    const config = validateAndBuildConfig({
      name: "call-bot",
      botType: "telephony",
      transport: ["telnyx", "smallwebrtc"],
      mode: "cascade",
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "elevenlabs_tts",
    });
    expect(config.transports).toEqual(["telnyx", "smallwebrtc"]);
  });

  test("test_bot_type_inferred_telephony", () => {
    // Omitting --bot-type infers telephony from a telephony transport.
    const config = validateAndBuildConfig({ name: "call-bot", transport: ["twilio"], ...CASCADE });
    expect(config.botType).toEqual("telephony");
  });

  test("test_bot_type_inferred_web", () => {
    // Omitting --bot-type infers web when all transports are WebRTC.
    const config = validateAndBuildConfig({
      name: "web-bot",
      transport: ["smallwebrtc"],
      ...CASCADE,
    });
    expect(config.botType).toEqual("web");
  });

  test("test_bot_type_inferred_telephony_wins_over_webrtc", () => {
    // A telephony transport wins: twilio + smallwebrtc infers telephony.
    const config = validateAndBuildConfig({
      name: "call-bot",
      transport: ["twilio", "smallwebrtc"],
      ...CASCADE,
    });
    expect(config.botType).toEqual("telephony");
  });
});

describe("TestValidRealtimeConfigs", () => {
  test("test_minimal_realtime", () => {
    const config = validateAndBuildConfig({
      name: "rt-bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "realtime",
      realtime: "openai_realtime",
    });
    expect(config.mode).toEqual("realtime");
    expect(config.realtimeService).toEqual("openai_realtime");
    expect(config.sttService).toBeNull();
    expect(config.llmService).toBeNull();
    expect(config.ttsService).toBeNull();
  });
});

describe("TestDefaults", () => {
  // DIVERGENCE: there is no Pipecat Cloud, so no deploy_to_cloud default. The Dockerfile that
  // takes its place is off by default.
  test.skip("test_deploy_to_cloud_default_true", () => {});

  test("test_dockerfile_default_false", () => {
    const config = validateAndBuildConfig({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
    });
    expect(config.dockerfile).toBe(false);
    expect(config.runtime).toEqual("bun");
  });

  test("test_video_output_forced_on_with_video_service", () => {
    const config = validateAndBuildConfig({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
      video: "heygen_video",
    });
    expect(config.videoOutput).toBe(true);
  });
});

describe("TestTransportResolution", () => {
  // Daily PSTN and Twilio + Daily SIP need Daily, which isn't ported.
  test.skip("test_daily_pstn_dialin", () => {});
  test.skip("test_daily_pstn_dialout", () => {});
  test.skip("test_twilio_daily_sip_dialin", () => {});
  test.skip("test_twilio_daily_sip_dialout", () => {});

  test("NEW: the Daily transports are rejected, and why", () => {
    for (const transport of ["daily", "daily_pstn", "twilio_daily_sip"]) {
      const errors = errorsOf({ name: "bot", transport: [transport], ...CASCADE });
      expect(errors.some((e) => e.includes(`'${transport}'`) && e.includes("Daily"))).toBe(true);
    }
  });
});

describe("TestMissingFields", () => {
  test("test_missing_all_required", () => {
    const errors = errorsOf();
    expect(errors.some((e) => e.includes("--name"))).toBe(true);
    expect(errors.some((e) => e.includes("--transport"))).toBe(true);
    expect(errors.some((e) => e.includes("--mode"))).toBe(true);
    // --bot-type is no longer required: it's inferred from the transports.
    expect(errors.some((e) => e.includes("--bot-type is required"))).toBe(false);
  });

  test("test_missing_cascade_services", () => {
    const errors = errorsOf({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "cascade",
    });
    expect(errors.some((e) => e.includes("--stt"))).toBe(true);
    expect(errors.some((e) => e.includes("--llm"))).toBe(true);
    expect(errors.some((e) => e.includes("--tts"))).toBe(true);
  });

  test("test_missing_realtime_service", () => {
    const errors = errorsOf({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "realtime",
    });
    expect(errors.some((e) => e.includes("--realtime"))).toBe(true);
  });

  test.skip("test_missing_daily_pstn_mode", () => {});
  test.skip("test_missing_twilio_daily_sip_mode", () => {});
});

describe("TestInvalidValues", () => {
  const base = { name: "bot", botType: "web", transport: ["smallwebrtc"], ...CASCADE };

  test("test_invalid_bot_type", () => {
    expect(errorsOf({ ...base, botType: "mobile" }).some((e) => e.includes("bot-type"))).toBe(true);
  });

  test("test_invalid_mode", () => {
    expect(errorsOf({ ...base, mode: "hybrid" }).some((e) => e.includes("mode"))).toBe(true);
  });

  test("test_invalid_transport", () => {
    expect(
      errorsOf({ ...base, transport: ["nonexistent"] }).some((e) =>
        e.includes("Unknown transport"),
      ),
    ).toBe(true);
  });

  test("test_invalid_stt_service", () => {
    expect(errorsOf({ ...base, stt: "invalid_stt" }).some((e) => e.includes("Unknown STT"))).toBe(
      true,
    );
  });

  test("test_invalid_llm_service", () => {
    expect(errorsOf({ ...base, llm: "invalid_llm" }).some((e) => e.includes("Unknown LLM"))).toBe(
      true,
    );
  });

  test("test_invalid_tts_service", () => {
    expect(errorsOf({ ...base, tts: "invalid_tts" }).some((e) => e.includes("Unknown TTS"))).toBe(
      true,
    );
  });

  test("test_invalid_realtime_service", () => {
    const errors = errorsOf({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "realtime",
      realtime: "invalid_realtime",
    });
    expect(errors.some((e) => e.includes("Unknown realtime"))).toBe(true);
  });

  test("test_invalid_video_service", () => {
    expect(
      errorsOf({ ...base, video: "invalid_video" }).some((e) => e.includes("Unknown video")),
    ).toBe(true);
  });

  test("NEW: a service that isn't ported isn't offered", () => {
    // Pipecat's values for services pipedog hasn't ported are unknown here, and the message lists
    // what is valid.
    const errors = errorsOf({ ...base, stt: "gradium_stt" });
    expect(errors[0]).toContain("Unknown STT service 'gradium_stt'");
    expect(errors[0]).toContain("deepgram_stt");
  });
});

describe("TestCrossFieldConstraints", () => {
  const base = { name: "bot", ...CASCADE };

  test("test_video_only_for_web", () => {
    const errors = errorsOf({
      ...base,
      botType: "telephony",
      transport: ["twilio"],
      video: "heygen_video",
    });
    expect(errors.some((e) => e.toLowerCase().includes("web bots"))).toBe(true);
  });

  // Krisp (and the Pipecat Cloud deployment it requires) isn't available: see the NEW test below.
  test.skip("test_krisp_requires_cloud", () => {});

  test("NEW: Pipecat Cloud and Krisp flags are rejected, and why", () => {
    const errors = errorsOf({
      ...base,
      botType: "web",
      transport: ["smallwebrtc"],
      unsupported: { deployToCloud: true, enableKrisp: true, dailyPstnMode: "dial-in" },
    });
    expect(errors.some((e) => e.includes("--deploy-to-cloud") && e.includes("--dockerfile"))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes("--enable-krisp"))).toBe(true);
    expect(errors.some((e) => e.includes("--daily-pstn-mode"))).toBe(true);
  });

  test("NEW: unsupported flags left at their defaults are not errors", () => {
    const config = validateAndBuildConfig({
      ...base,
      botType: "web",
      transport: ["smallwebrtc"],
      unsupported: { deployToCloud: false, enableKrisp: false, dailyPstnMode: undefined },
    });
    expect(config.projectName).toEqual("bot");
  });

  test("test_video_input_only_for_web", () => {
    const errors = errorsOf({
      ...base,
      botType: "telephony",
      transport: ["twilio"],
      videoInput: true,
    });
    expect(
      errors.some(
        (e) => e.toLowerCase().includes("video-input") || e.toLowerCase().includes("video input"),
      ),
    ).toBe(true);
  });

  test("test_telephony_transport_for_web_rejected", () => {
    const errors = errorsOf({ ...base, botType: "web", transport: ["twilio"] });
    expect(errors.some((e) => e.toLowerCase().includes("telephony transport"))).toBe(true);
  });

  test("test_cascade_rejects_realtime_flag", () => {
    const errors = errorsOf({
      ...base,
      botType: "web",
      transport: ["smallwebrtc"],
      realtime: "openai_realtime",
    });
    expect(
      errors.some(
        (e) => e.toLowerCase().includes("realtime") && e.toLowerCase().includes("cascade"),
      ),
    ).toBe(true);
  });

  test("test_realtime_rejects_stt_flag", () => {
    const errors = errorsOf({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "realtime",
      realtime: "openai_realtime",
      stt: "deepgram_stt",
    });
    expect(
      errors.some((e) => e.toLowerCase().includes("stt") && e.toLowerCase().includes("realtime")),
    ).toBe(true);
  });

  test("test_client_framework_only_for_web", () => {
    const errors = errorsOf({
      ...base,
      botType: "telephony",
      transport: ["twilio"],
      clientFramework: "vanilla",
    });
    expect(
      errors.some(
        (e) => e.toLowerCase().includes("client-framework") || e.toLowerCase().includes("web bots"),
      ),
    ).toBe(true);
  });

  test("test_client_server_requires_framework", () => {
    const errors = errorsOf({
      ...base,
      botType: "web",
      transport: ["smallwebrtc"],
      clientServer: "vite",
    });
    expect(
      errors.some(
        (e) =>
          e.toLowerCase().includes("client-server") && e.toLowerCase().includes("client-framework"),
      ),
    ).toBe(true);
  });

  test("test_multiple_errors_collected", () => {
    // All errors should be collected, not just the first.
    const errors = errorsOf({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      mode: "cascade",
      // Missing all three cascade services
    });
    expect(errors.length).toEqual(3); // stt, llm, tts
  });

  test("NEW: the runtime is bun or node", () => {
    const errors = errorsOf({ ...base, transport: ["smallwebrtc"], runtime: "deno" });
    expect(errors.some((e) => e.includes("--runtime"))).toBe(true);
  });
});

describe("TestClientConfig", () => {
  const base = { name: "bot", botType: "web", transport: ["smallwebrtc"], ...CASCADE };

  // React clients (Vite and Next.js) aren't ported; the runner serves one at /client.
  test.skip("test_react_vite_client", () => {});
  test.skip("test_react_nextjs_client", () => {});

  test("NEW: the React client is rejected, and the alternatives named", () => {
    const errors = errorsOf({ ...base, clientFramework: "react", clientServer: "vite" });
    expect(
      errors.some((e) => e.includes("react") && e.includes("vanilla") && e.includes("/client")),
    ).toBe(true);
  });

  test("test_vanilla_client", () => {
    const config = validateAndBuildConfig({ ...base, clientFramework: "vanilla" });
    expect(config.generateClient).toBe(true);
    expect(config.clientFramework).toEqual("vanilla");
    expect(config.clientServer).toEqual("vite");
  });

  test("test_no_client", () => {
    const config = validateAndBuildConfig({ ...base, clientFramework: "none" });
    expect(config.generateClient).toBe(false);
    expect(config.clientFramework).toBeNull();
  });
});

describe("TestConfigFile", () => {
  test("test_load_config_file", () => {
    const path = tmpFile(
      "config.json",
      JSON.stringify({
        project_name: "file-bot",
        bot_type: "web",
        transports: ["smallwebrtc"],
        mode: "cascade",
        stt_service: "deepgram_stt",
        llm_service: "openai_llm",
        tts_service: "cartesia_tts",
      }),
    );
    const loaded = loadConfigFromFile(path);
    expect(loaded.project_name).toEqual("file-bot");
    expect(loaded.bot_type).toEqual("web");
  });

  test("test_load_nonexistent_file", () => {
    expect(() => loadConfigFromFile(join(tmpdir(), "nonexistent-pipedog.json"))).toThrow(/ENOENT/);
  });

  test("test_load_invalid_json", () => {
    expect(() => loadConfigFromFile(tmpFile("bad.json", "not json"))).toThrow(SyntaxError);
  });
});

/**
 * Simulate the merging logic from resolveScaffoldConfig: map config dict keys to
 * validateAndBuildConfig options, exactly as the CLI does after loading JSON.
 */
function parseConfigDict(fileData: Record<string, any>): ProjectConfig {
  return validateAndBuildConfig({
    name: fileData.name || fileData.project_name,
    botType: fileData.bot_type,
    transport: fileData.transports || fileData.transport,
    mode: fileData.mode,
    stt: fileData.stt || fileData.stt_service,
    llm: fileData.llm || fileData.llm_service,
    tts: fileData.tts || fileData.tts_service,
    realtime: fileData.realtime || fileData.realtime_service,
    video: fileData.video || fileData.video_service,
    clientFramework: fileData.client_framework,
    clientServer: fileData.client_server,
    recording: fileData.recording ?? false,
    transcription: fileData.transcription ?? false,
    videoInput: fileData.video_input ?? false,
    videoOutput: fileData.video_output ?? false,
    observability: fileData.observability ?? fileData.enable_observability ?? false,
  });
}

describe("TestConfigDictParsing", () => {
  test("test_cascade_with_service_suffix_keys", () => {
    // Config files use *_service keys (matching ProjectConfig field names).
    const config = parseConfigDict({
      project_name: "file-bot",
      bot_type: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      stt_service: "deepgram_stt",
      llm_service: "openai_llm",
      tts_service: "cartesia_tts",
    });
    expect(config.projectName).toEqual("file-bot");
    expect(config.sttService).toEqual("deepgram_stt");
    expect(config.llmService).toEqual("openai_llm");
    expect(config.ttsService).toEqual("cartesia_tts");
  });

  test("test_cascade_with_short_keys", () => {
    // Config files can also use short keys (stt, llm, tts).
    const config = parseConfigDict({
      project_name: "short-bot",
      bot_type: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      stt: "deepgram_stt",
      llm: "anthropic_llm",
      tts: "elevenlabs_tts",
    });
    expect(config.sttService).toEqual("deepgram_stt");
    expect(config.llmService).toEqual("anthropic_llm");
    expect(config.ttsService).toEqual("elevenlabs_tts");
  });

  test("test_realtime_config", () => {
    const config = parseConfigDict({
      project_name: "rt-bot",
      bot_type: "web",
      transports: ["smallwebrtc"],
      mode: "realtime",
      realtime_service: "openai_realtime",
    });
    expect(config.mode).toEqual("realtime");
    expect(config.realtimeService).toEqual("openai_realtime");
    expect(config.sttService).toBeNull();
  });

  test.skip("test_telephony_with_daily_pstn", () => {});

  test("test_full_featured_config", () => {
    const config = parseConfigDict({
      project_name: "full-bot",
      bot_type: "web",
      transports: ["websocket", "smallwebrtc"],
      mode: "cascade",
      stt_service: "deepgram_stt",
      llm_service: "openai_llm",
      tts_service: "cartesia_tts",
      client_framework: "vanilla",
      recording: true,
      transcription: true,
      video_input: true,
      video_output: true,
      enable_observability: true,
    });
    expect(config.transports).toEqual(["websocket", "smallwebrtc"]);
    expect(config.generateClient).toBe(true);
    expect(config.clientFramework).toEqual("vanilla");
    expect(config.clientServer).toEqual("vite");
    expect(config.recording).toBe(true);
    expect(config.transcription).toBe(true);
    expect(config.videoInput).toBe(true);
    expect(config.enableObservability).toBe(true);
  });

  test("test_invalid_config_dict_reports_errors", () => {
    let errors: string[] = [];
    try {
      parseConfigDict({
        project_name: "bad-bot",
        bot_type: "web",
        transports: ["smallwebrtc"],
        mode: "cascade",
        // missing stt, llm, tts
      });
    } catch (e) {
      errors = (e as ConfigValidationError).errors;
    }
    expect(errors.length).toEqual(3);
  });

  test("test_name_key_alias", () => {
    // Both 'name' and 'project_name' should work.
    const config = parseConfigDict({
      name: "alias-bot",
      bot_type: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      stt: "deepgram_stt",
      llm: "openai_llm",
      tts: "cartesia_tts",
    });
    expect(config.projectName).toEqual("alias-bot");
  });
});

describe("TestConfigToJson", () => {
  test("test_json_roundtrip", () => {
    const config = validateAndBuildConfig({
      name: "json-bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
    });
    const data = JSON.parse(configToJson(config));
    expect(data.project_name).toEqual("json-bot");
    expect(data.bot_type).toEqual("web");
    expect(data.transports).toEqual(["smallwebrtc"]);
    expect(data.mode).toEqual("cascade");
    expect(data.stt_service).toEqual("deepgram_stt");
    expect(data.llm_service).toEqual("openai_llm");
    expect(data.tts_service).toEqual("cartesia_tts");
    expect(data.runtime).toEqual("bun");
    expect(data.dockerfile).toBe(false);
  });

  test("test_json_includes_all_fields", () => {
    const config = validateAndBuildConfig({
      name: "full-bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
      recording: true,
      transcription: true,
      videoInput: true,
      videoOutput: true,
      observability: true,
    });
    const data = JSON.parse(configToJson(config));
    expect(data.recording).toBe(true);
    expect(data.transcription).toBe(true);
    expect(data.video_input).toBe(true);
    expect(data.video_output).toBe(true);
    expect(data.enable_observability).toBe(true);
  });

  test("NEW: the JSON of a config validates to the same config", () => {
    const config = validateAndBuildConfig({
      name: "round-trip",
      transport: ["twilio", "smallwebrtc"],
      ...CASCADE,
      runtime: "node",
      dockerfile: true,
      enableEval: true,
    });
    const again = parseConfigDict({ ...JSON.parse(configToJson(config)), runtime: undefined });
    expect(again.transports).toEqual(config.transports);
    expect(again.botType).toEqual("telephony");
  });
});

describe("TestFeatureFlags", () => {
  test("test_all_features_enabled", () => {
    const config = validateAndBuildConfig({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
      recording: true,
      transcription: true,
      videoInput: true,
      videoOutput: true,
      observability: true,
      enableEval: true,
      dockerfile: true,
      runtime: "node",
    });
    expect(config.recording).toBe(true);
    expect(config.transcription).toBe(true);
    expect(config.videoInput).toBe(true);
    expect(config.videoOutput).toBe(true);
    expect(config.enableObservability).toBe(true);
    expect(config.enableEval).toBe(true);
    expect(config.dockerfile).toBe(true);
    expect(config.runtime).toEqual("node");
  });

  test("test_all_features_disabled", () => {
    const config = validateAndBuildConfig({
      name: "bot",
      botType: "web",
      transport: ["smallwebrtc"],
      ...CASCADE,
      recording: false,
      transcription: false,
      videoInput: false,
      videoOutput: false,
      observability: false,
      dockerfile: false,
    });
    expect(config.recording).toBe(false);
    expect(config.transcription).toBe(false);
    expect(config.videoInput).toBe(false);
    expect(config.videoOutput).toBe(false);
    expect(config.enableObservability).toBe(false);
    expect(config.dockerfile).toBe(false);
  });
});
