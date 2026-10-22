// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_quickstart.py

// Tests for the `pipedog init quickstart` command.
//
// DIVERGENCE: the preset is SmallWebRTC (no Daily), and has no Pipecat Cloud Dockerfile.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cli, read, tmpDir } from "./helpers.ts";

describe("TestQuickstart", () => {
  // The quickstart preset scaffolds in place into ./pipedog-quickstart.

  test("test_quickstart_generates_project", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", "quickstart"], { cwd });
    expect(result.code, result.output).toEqual(0);

    const project = join(cwd, "pipedog-quickstart");
    expect(existsSync(join(project, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(project, "server", "package.json"))).toBe(true);
    expect(existsSync(join(project, ".gitignore"))).toBe(true);
    expect(existsSync(join(project, "README.md"))).toBe(true);
    // The coding-agent guide comes with it.
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(true);
    // No Pipecat Cloud Dockerfile: that's the optional --dockerfile.
    expect(existsSync(join(project, "server", "Dockerfile"))).toBe(false);
  });

  test("test_quickstart_fails_if_project_exists", async () => {
    const cwd = tmpDir();
    mkdirSync(join(cwd, "pipedog-quickstart", "server"), { recursive: true });
    const result = await cli(["init", "quickstart"], { cwd });
    expect(result.code).toEqual(1);
    expect(result.output).toContain("already exists");
  });

  test("test_quickstart_output_contains_defaults", async () => {
    const result = await cli(["init", "quickstart"], { cwd: tmpDir() });
    expect(result.code, result.output).toEqual(0);
    expect(result.output).toContain("SmallWebRTC");
    expect(result.output).toContain("Deepgram");
    expect(result.output).toContain("OpenAI");
    expect(result.output).toContain("Cartesia");
    // Daily is gone.
    expect(result.output).not.toContain("Daily");
  });

  test("test_quickstart_warns_when_scaffold_flags_passed", async () => {
    // quickstart is a fixed preset; combining it with scaffold flags should warn rather than
    // silently ignore them, but still scaffold the canned (web) bot.
    const cwd = tmpDir();
    const result = await cli(["init", "quickstart", "--bot-type", "telephony"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(result.output).toContain("fixed preset");
    expect(existsSync(join(cwd, "pipedog-quickstart", "server", "bot.ts"))).toBe(true);
  });

  test("NEW: the quickstart bot is the canned one", async () => {
    const cwd = tmpDir();
    await cli(["init", "quickstart"], { cwd });
    const bot = read(cwd, "pipedog-quickstart", "server", "bot.ts");
    expect(bot).toContain("DeepgramSTTService");
    expect(bot).toContain("OpenAIResponsesLLMService");
    expect(bot).toContain("CartesiaTTSService");
    expect(bot).toContain("webrtc:");
    expect(JSON.parse(read(cwd, "pipedog-quickstart", "server", "package.json")).name).toEqual(
      "pipedog-quickstart",
    );
  });
});
