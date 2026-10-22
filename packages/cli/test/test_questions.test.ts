// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_questions.py

// Tests for interactive prompts and question flow.
//
// DIVERGENCE: upstream builds questionary `Choice` objects from the registry; the questions here
// go through a `Prompter`, so the Choice tests check the registry's fields and the tests under
// "NEW" run the whole question flow with scripted answers. Daily isn't ported ("smallwebrtc"
// stands in); the React clients, Pipecat Cloud and Krisp have no counterpart.

import { describe, expect, test } from "bun:test";
import { askProjectQuestions, ProjectCancelledError, ProjectConfig } from "../src/questions.ts";
import { ServiceLoader } from "../src/service_loader.ts";
import { ServiceRegistry } from "../src/service_metadata.ts";
import { ScriptedPrompter } from "./helpers.ts";

const ALL_SERVICES = [
  ...ServiceRegistry.STT_SERVICES,
  ...ServiceRegistry.LLM_SERVICES,
  ...ServiceRegistry.TTS_SERVICES,
  ...ServiceRegistry.REALTIME_SERVICES,
  ...ServiceRegistry.VIDEO_SERVICES,
  ...ServiceRegistry.WEBRTC_TRANSPORTS,
  ...ServiceRegistry.TELEPHONY_TRANSPORTS,
];

describe("TestProjectConfig", () => {
  test("test_project_config_creation", () => {
    // ProjectConfig can be created with required fields.
    const config = new ProjectConfig({
      projectName: "test-bot",
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
    });
    expect(config.projectName).toEqual("test-bot");
    expect(config.botType).toEqual("web");
    expect(config.transports).toEqual(["smallwebrtc"]);
    expect(config.mode).toEqual("cascade");
  });

  test("test_project_config_defaults", () => {
    // ProjectConfig has sensible defaults.
    const config = new ProjectConfig({ projectName: "test-bot", botType: "web" });
    expect(config.transports).toEqual([]);
    expect(config.mode).toEqual("cascade");
    expect(config.sttService).toBeNull();
    expect(config.llmService).toBeNull();
    expect(config.ttsService).toBeNull();
    expect(config.realtimeService).toBeNull();
    expect(config.videoService).toBeNull();
    expect(config.videoInput).toBe(false);
    expect(config.videoOutput).toBe(false);
    expect(config.recording).toBe(false);
    expect(config.transcription).toBe(false);
    expect(config.enableObservability).toBe(false);
    expect(config.enableEval).toBe(false);
    // Client-related defaults
    expect(config.generateClient).toBe(false);
    expect(config.clientFramework).toBeNull();
    expect(config.clientServer).toBeNull();
    // pipedog's: Bun, and no Dockerfile
    expect(config.runtime).toEqual("bun");
    expect(config.dockerfile).toBe(false);
  });

  test("test_project_config_with_client", () => {
    const config = new ProjectConfig({
      projectName: "test-bot",
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      generateClient: true,
      clientFramework: "vanilla",
      clientServer: "vite",
    });
    expect(config.generateClient).toBe(true);
    expect(config.clientFramework).toEqual("vanilla");
    expect(config.clientServer).toEqual("vite");
  });

  // The Next.js client isn't ported.
  test.skip("test_project_config_nextjs_client", () => {});

  test("test_project_config_with_video_service", () => {
    const config = new ProjectConfig({
      projectName: "test-video-bot",
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      sttService: "deepgram_stt",
      llmService: "openai_llm",
      ttsService: "cartesia_tts",
      videoService: "heygen_video",
      videoOutput: true,
    });
    expect(config.videoService).toEqual("heygen_video");
    expect(config.videoOutput).toBe(true);
    expect(config.botType).toEqual("web"); // Video services only for web bots
  });
});

describe("TestServiceDefinitionChoiceCreation", () => {
  // Regression tests to ensure ServiceDefinition objects can be used to build the prompts'
  // choices: every entry has a label and a value.
  test("test_service_definitions_work_as_choices", () => {
    expect(ALL_SERVICES.length).toBeGreaterThan(0);
    for (const svc of ALL_SERVICES) {
      const choice = { label: svc.label, value: svc.value };
      expect(choice.label).toEqual(svc.label);
      expect(choice.value).toEqual(svc.value);
    }
  });

  test("test_transport_options_query", () => {
    const web = ServiceLoader.getTransportOptions("web");
    expect(web.some((svc) => svc.label.includes("SmallWebRTC"))).toBe(true);
    const telephony = ServiceLoader.getTransportOptions("telephony");
    expect(telephony.some((svc) => svc.label.includes("Twilio"))).toBe(true);
  });

  test("test_transport_fallback_access", () => {
    // Transport options can be accessed by index (for fallback logic).
    const options = ServiceLoader.getTransportOptions("web");
    expect(options.length).toBeGreaterThan(0);
    const first = options[0];
    expect(typeof first?.value).toEqual("string");
    expect(typeof first?.label).toEqual("string");
  });

  test("test_all_services_have_required_fields", () => {
    for (const service of ALL_SERVICES) {
      expect(typeof service.label).toEqual("string");
      expect(typeof service.value).toEqual("string");
      expect(service.label.length).toBeGreaterThan(0);
      expect(service.value.length).toBeGreaterThan(0);
    }
  });
});

describe("NEW: the question flow", () => {
  test("a web cascade bot, with the defaults", async () => {
    const prompter = new ScriptedPrompter([
      "my-bot", // Project name
      "web", // Bot type
      "none", // Client
      "smallwebrtc", // Transport
      false, // another transport?
      "cascade",
      "deepgram_stt",
      "openai_llm",
      "cartesia_tts",
      "bun", // Runtime
      false, // customize features?
      false, // Dockerfile
      false, // evals
    ]);
    const config = await askProjectQuestions({ prompter });
    expect(prompter.remaining).toEqual(0);
    expect(config).toMatchObject({
      projectName: "my-bot",
      botType: "web",
      transports: ["smallwebrtc"],
      mode: "cascade",
      sttService: "deepgram_stt",
      llmService: "openai_llm",
      ttsService: "cartesia_tts",
      realtimeService: null,
      generateClient: false,
      runtime: "bun",
      recording: false,
      enableEval: false,
    });
  });

  test("a web bot with the Vite client, a second transport and every feature", async () => {
    const prompter = new ScriptedPrompter([
      "default", // the directory's name
      "web",
      "vanilla",
      "websocket",
      true, // another transport?
      "smallwebrtc",
      "realtime",
      "openai_realtime",
      "node",
      true, // customize features?
      true, // recording
      true, // transcription
      true, // video avatar service?
      "heygen_video",
      true, // video input
      true, // observability
      true, // Dockerfile
      true, // evals
    ]);
    const config = await askProjectQuestions({ defaultName: "dir-name", prompter });
    expect(prompter.remaining).toEqual(0);
    expect(config).toMatchObject({
      projectName: "dir-name",
      transports: ["websocket", "smallwebrtc"],
      mode: "realtime",
      realtimeService: "openai_realtime",
      generateClient: true,
      clientFramework: "vanilla",
      clientServer: "vite",
      runtime: "node",
      recording: true,
      transcription: true,
      videoService: "heygen_video",
      videoInput: true,
      videoOutput: true, // forced on by the video service
      enableObservability: true,
      dockerfile: true,
      enableEval: true,
    });
  });

  test("a telephony bot is offered WebRTC for local testing", async () => {
    const prompter = new ScriptedPrompter([
      "call-bot",
      "telephony",
      "twilio",
      true, // WebRTC for local testing?
      "cascade",
      "deepgram_stt",
      "openai_llm",
      "cartesia_tts",
      "bun",
      false,
      false,
      false,
    ]);
    const config = await askProjectQuestions({ prompter });
    expect(config.botType).toEqual("telephony");
    expect(config.transports).toEqual(["twilio", "smallwebrtc"]);
    // No client or video questions for a phone bot.
    expect(prompter.asked).not.toContain("Client:");
    expect(prompter.asked).not.toContain("Use video avatar service?");
  });

  test("cancelling a prompt ends the wizard", async () => {
    await expect(askProjectQuestions({ prompter: new ScriptedPrompter([null]) })).rejects.toThrow(
      ProjectCancelledError,
    );
    await expect(
      askProjectQuestions({ prompter: new ScriptedPrompter(["bot", "web", null]) }),
    ).rejects.toThrow(ProjectCancelledError);
  });

  test("the choices are the registry's, with no unported service", async () => {
    const seen: Record<string, string[]> = {};
    const prompter = new ScriptedPrompter(["bot", "web", "none", "smallwebrtc", false, "cascade"]);
    const select = prompter.select.bind(prompter);
    prompter.select = async (message, choices) => {
      seen[message] = choices.map((c) => c.value);
      return select(message, choices);
    };
    // The rest of the questions have no scripted answers: the flow stops at the first one.
    await expect(askProjectQuestions({ prompter })).rejects.toThrow(/unexpected prompt/);
    expect(seen["Transport:"]).toEqual(ServiceRegistry.WEBRTC_TRANSPORTS.map((t) => t.value));
    expect(seen["Speech-to-Text:"]).toEqual(ServiceRegistry.STT_SERVICES.map((t) => t.value));
  });
});
