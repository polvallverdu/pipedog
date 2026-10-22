// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_init_interactive.py

// Tests for the interactive scaffold path of `pipedog init` (the wizard).
//
// When the developer chooses "Scaffold a runnable bot now", init runs the interactive wizard
// (`askProjectQuestions`) and the real `scaffoldInteractive` + `ProjectGenerator`, in place.
// These script the answers of the build-method prompt and the wizard (a `Prompter`, where
// upstream stubs questionary), exercising that path end to end without needing a TTY.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, ScriptedPrompter, tmpDir } from "./helpers.ts";

const WIZARD = [
  "default", // Project name: the directory's name
  "web",
  "none",
  "smallwebrtc",
  false,
  "cascade",
  "deepgram_stt",
  "openai_llm",
  "cartesia_tts",
  "bun",
  false, // customize features
  false, // Dockerfile
  false, // evals
];

describe("test_init_interactive", () => {
  test("test_interactive_scaffold_in_place_uses_derived_name", async () => {
    // The build-method prompt returns "scaffold", so init runs the wizard in place, deriving the
    // wizard's default name from the directory (no <name> subfolder).
    const prompter = new ScriptedPrompter(["scaffold", ...WIZARD]);
    const target = join(tmpDir(), "my-bot");
    const result = await cli(["init", target], { interactive: true, prompter });
    expect(result.code, result.output).toEqual(0);
    expect(prompter.asked[0]).toEqual("How do you want to build?");
    // The wizard offered the directory's name.
    expect(prompter.asked[1]).toEqual("Project name:");
    expect(JSON.parse(readFileSync(join(target, "server", "package.json"), "utf8")).name).toEqual(
      "my-bot",
    );
    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(target, "my-bot"))).toBe(false);
    // init initializes for agent-led dev before scaffolding.
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    // The scaffold's README is the start-here, so no GETTING_STARTED.md.
    expect(existsSync(join(target, "GETTING_STARTED.md"))).toBe(false);
  });

  test("NEW: the coding-agent path writes the developer guide and registers the MCP server", async () => {
    const prompter = new ScriptedPrompter(["agent"]);
    const target = tmpDir();
    const result = await cli(["init", target], { interactive: true, prompter });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(target, "GETTING_STARTED.md"))).toBe(true);
    expect(existsSync(join(target, "server"))).toBe(false);
    expect(existsSync(join(target, ".mcp.json"))).toBe(true);
    expect(result.output).toContain("Your project is ready.");
  });

  test("NEW: a cancelled build-method prompt falls through to the coding-agent path", async () => {
    const result = await cli(["init", tmpDir()], {
      interactive: true,
      prompter: new ScriptedPrompter([null]),
    });
    expect(result.code, result.output).toEqual(0);
    expect(result.output).toContain("GETTING_STARTED.md");
  });

  test("NEW: a cancelled wizard ends with exit code 1 and leaves the guide", async () => {
    const target = tmpDir();
    const result = await cli(["init", target], {
      interactive: true,
      prompter: new ScriptedPrompter(["scaffold", null]),
    });
    expect(result.code).toEqual(1);
    expect(result.output).toContain("cancelled");
    expect(existsSync(join(target, "server"))).toBe(false);
  });

  test("NEW: with no target, an interactive run asks for the directory", async () => {
    const cwd = tmpDir();
    const prompter = new ScriptedPrompter(["new-dir", "agent"]);
    const result = await cli(["init"], { cwd, interactive: true, prompter });
    expect(result.code, result.output).toEqual(0);
    expect(prompter.asked[0]).toEqual("Project directory");
    expect(existsSync(join(cwd, "new-dir", "AGENTS.md"))).toBe(true);
  });

  test("NEW: with no terminal, init never prompts: it writes the guide here", async () => {
    const cwd = tmpDir();
    const result = await cli(["init"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, "GETTING_STARTED.md"))).toBe(true);
    expect(result.output).toContain("open a coding session here");
  });

  test("NEW: an already scaffolded project skips the question", async () => {
    const target = tmpDir();
    await cli([
      "init",
      target,
      "-t",
      "smallwebrtc",
      "-m",
      "realtime",
      "--realtime",
      "openai_realtime",
    ]);
    const prompter = new ScriptedPrompter([]);
    const result = await cli(["init", target], { interactive: true, prompter });
    expect(result.code, result.output).toEqual(0);
    expect(prompter.asked).toEqual([]);
    expect(existsSync(join(target, "GETTING_STARTED.md"))).toBe(true);
  });
});
