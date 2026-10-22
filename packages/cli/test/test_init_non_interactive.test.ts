// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_init_non_interactive.py

// Tests for the `pipedog init` non-interactive command: config-file + flag precedence.
//
// These drive the real command via `--dry-run`, which resolves the full config (file values
// merged with CLI flags) and prints it as JSON without generating any files: exercising the
// merge logic in `resolveScaffoldConfig` end to end.
//
// DIVERGENCE: Daily isn't ported ("smallwebrtc"); `--deploy-to-cloud` and `--enable-krisp`
// have no counterpart (tests under "NEW" show what they do instead).

import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, tmpDir } from "./helpers.ts";

function writeConfig(overrides: Record<string, unknown> = {}, remove: string[] = []): string {
  const data: Record<string, unknown> = {
    project_name: "file-bot",
    bot_type: "web",
    transports: ["smallwebrtc"],
    mode: "cascade",
    stt_service: "deepgram_stt",
    llm_service: "openai_llm",
    tts_service: "cartesia_tts",
    ...overrides,
  };
  for (const key of remove) delete data[key];
  const path = join(tmpDir(), "config.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

/** Invoke `init ... --dry-run` and return the parsed resolved config. */
async function dryRun(args: string[]): Promise<Record<string, any>> {
  const result = await cli(["init", ...args, "--dry-run"]);
  expect(result.code, result.output).toEqual(0);
  return JSON.parse(result.stdout);
}

describe("TestConfigFileResolution", () => {
  // A config file alone fully drives the resolved config.

  test("test_config_file_only", async () => {
    const resolved = await dryRun(["--config", writeConfig()]);
    expect(resolved.project_name).toEqual("file-bot");
    expect(resolved.bot_type).toEqual("web");
    expect(resolved.transports).toEqual(["smallwebrtc"]);
    expect(resolved.mode).toEqual("cascade");
    expect(resolved.stt_service).toEqual("deepgram_stt");
    expect(resolved.llm_service).toEqual("openai_llm");
    expect(resolved.tts_service).toEqual("cartesia_tts");
  });

  test("test_name_alias_in_config_file", async () => {
    // A config file may use 'name' instead of 'project_name'.
    const resolved = await dryRun([
      "--config",
      writeConfig({ name: "aliased-bot" }, ["project_name"]),
    ]);
    expect(resolved.project_name).toEqual("aliased-bot");
  });

  test("NEW: a config file may use camelCase keys, and a single transport string", async () => {
    const resolved = await dryRun([
      "--config",
      writeConfig(
        {
          botType: "web",
          transport: "websocket",
          sttService: "deepgram_stt",
          enableObservability: true,
        },
        ["bot_type", "transports", "stt_service"],
      ),
    ]);
    expect(resolved.transports).toEqual(["websocket"]);
    expect(resolved.enable_observability).toBe(true);
  });

  test("NEW: a missing config file is an error", async () => {
    const result = await cli(["init", "--config", join(tmpDir(), "nope.json"), "--dry-run"]);
    expect(result.code).toEqual(1);
    expect(result.output).toContain("Could not read the config file");
  });
});

describe("TestFlagPrecedence", () => {
  // CLI flags override values from the config file.

  test("test_flag_overrides_string_value", async () => {
    const resolved = await dryRun(["--config", writeConfig(), "--tts", "elevenlabs_tts"]);
    // Flag wins over the file value.
    expect(resolved.tts_service).toEqual("elevenlabs_tts");
    // Unspecified fields still come from the file.
    expect(resolved.stt_service).toEqual("deepgram_stt");
  });

  test("test_flag_overrides_name", async () => {
    const resolved = await dryRun(["--config", writeConfig(), "--name", "flag-bot"]);
    expect(resolved.project_name).toEqual("flag-bot");
  });

  test("test_observability_flag_enables_over_file_default", async () => {
    // no observability key -> defaults off
    const resolved = await dryRun(["--config", writeConfig(), "--observability"]);
    expect(resolved.enable_observability).toBe(true);
  });

  // Negatable booleans default to false, so an explicit --no-<flag> looks identical to an
  // omitted flag by value alone. These prove the explicit flag still beats a file value that
  // enabled the setting.
  const negated: [flag: string, fileKey: string, outputKey: string][] = [
    ["--no-eval", "enable_eval", "enable_eval"],
    ["--no-recording", "recording", "recording"],
    ["--no-transcription", "transcription", "transcription"],
    ["--no-observability", "enable_observability", "enable_observability"],
    ["--no-dockerfile", "dockerfile", "dockerfile"],
  ];
  for (const [flag, fileKey, outputKey] of negated) {
    test(`test_negated_flag_disables_over_file_value[${flag}]`, async () => {
      const resolved = await dryRun(["--config", writeConfig({ [fileKey]: true }), flag]);
      expect(resolved[outputKey]).toBe(false);
    });
  }

  test("test_the_last_of_a_flag_and_its_negation_wins", async () => {
    expect((await dryRun([...base(), "--recording", "--no-recording"])).recording).toBe(false);
    expect((await dryRun([...base(), "--no-recording", "--recording"])).recording).toBe(true);
  });

  // `--no-deploy-to-cloud` has no setting to turn off; the positive form is an error (below).
  test.skip("test_no_deploy_to_cloud_flag_disables_over_file_value", () => {});
  test.skip("test_enable_krisp_flag_enables_over_file_value", () => {});

  test("test_boolean_file_value_applies_when_flag_omitted", async () => {
    // With no flag, the file value still drives the setting: it's the flag that flips it.
    const resolved = await dryRun(["--config", writeConfig({ enable_eval: true })]);
    expect(resolved.enable_eval).toBe(true);
  });

  test("NEW: the runtime flag overrides the file, which overrides the default", async () => {
    expect((await dryRun(["--config", writeConfig()])).runtime).toEqual("bun");
    expect((await dryRun(["--config", writeConfig({ runtime: "node" })])).runtime).toEqual("node");
    expect(
      (await dryRun(["--config", writeConfig({ runtime: "node" }), "--runtime", "bun"])).runtime,
    ).toEqual("bun");
  });
});

function base(): string[] {
  return [
    "-t",
    "smallwebrtc",
    "-m",
    "cascade",
    "--stt",
    "deepgram_stt",
    "--llm",
    "openai_llm",
    "--tts",
    "cartesia_tts",
    "--name",
    "b",
  ];
}

describe("NEW: Pipecat's flags", () => {
  test("a Pipecat Cloud or Krisp flag is rejected with the reason", async () => {
    const cloud = await cli(["init", ...base(), "--deploy-to-cloud", "--dry-run"]);
    expect(cloud.code).toEqual(1);
    expect(cloud.output).toContain("--deploy-to-cloud isn't available");
    const krisp = await cli(["init", ...base(), "--enable-krisp", "--dry-run"]);
    expect(krisp.code).toEqual(1);
    expect(krisp.output).toContain("--enable-krisp isn't available");
    const pstn = await cli(["init", ...base(), "--daily-pstn-mode", "dial-in", "--dry-run"]);
    expect(pstn.code).toEqual(1);
    expect(pstn.output).toContain("--daily-pstn-mode");
  });

  test("their negations are accepted, so a Pipecat command line still parses", async () => {
    const result = await cli([
      "init",
      ...base(),
      "--no-deploy-to-cloud",
      "--no-enable-krisp",
      "--no-context-hub",
      "--dry-run",
    ]);
    expect(result.code, result.output).toEqual(0);
  });

  test("--context-hub points at --mcp", async () => {
    const result = await cli(["init", ...base(), "--context-hub"]);
    expect(result.code).toEqual(2);
    expect(result.output).toContain("--mcp");
  });

  test("Pipecat's config file keys are ignored with a note, not an error", async () => {
    const path = writeConfig({ deploy_to_cloud: true, enable_krisp: false });
    const result = await cli(["init", "--config", path, "--dry-run"]);
    expect(result.code, result.output).toEqual(0);
    expect(result.stderr).toContain("ignoring 'deploy_to_cloud'");
    expect(JSON.parse(result.stdout).project_name).toEqual("file-bot");
  });

  test("an unknown flag is a usage error", async () => {
    const result = await cli(["init", "--nonsense"]);
    expect(result.code).toEqual(2);
    expect(result.output).toContain("pipedog init --help");
  });

  test("a second target is a usage error", async () => {
    const result = await cli(["init", "a", "b"]);
    expect(result.code).toEqual(2);
  });

  test("--help shows the usage", async () => {
    const result = await cli(["init", "--help"]);
    expect(result.code).toEqual(0);
    expect(result.stdout).toContain("Usage: pipedog init");
    expect(result.stdout).toContain("--overwrite-guide");
  });

  test("--dry-run writes nothing", async () => {
    const target = tmpDir();
    const result = await cli(["init", target, ...base(), "--dry-run"]);
    expect(result.code).toEqual(0);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, "server"))).toBe(false);
  });
});
