// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_init_in_place.py

// Tests for `pipedog init <target>` in-place scaffolding (e.g. `pipedog init .`).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, read, SERVICE_FLAGS, tmpDir } from "./helpers.ts";

describe("test_init_in_place", () => {
  test("test_init_in_place_writes_into_target_dir", async () => {
    // `pipedog init <dir> ...` scaffolds directly into <dir>, no subfolder.
    const target = tmpDir();
    const result = await cli(["init", target, "--name", "demo", ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);

    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    // Not nested under the project name.
    expect(existsSync(join(target, "demo"))).toBe(false);
  });

  test("test_init_in_place_also_writes_agent_guide", async () => {
    // Non-interactive `init` still initializes for agent-led dev: AGENTS.md + CLAUDE.md.
    const target = tmpDir();
    const result = await cli(["init", target, ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);

    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    expect(read(target, "CLAUDE.md").trim()).toEqual("@AGENTS.md");
    // The scaffold path skips GETTING_STARTED.md: the README is the start-here.
    expect(existsSync(join(target, "GETTING_STARTED.md"))).toBe(false);
  });

  test("test_init_in_place_derives_name_from_dir", async () => {
    // Without --name, the project name is derived from the target dir basename.
    const target = join(tmpDir(), "my-derived-bot");
    mkdirSync(target);
    const result = await cli(["init", target, ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);

    const pkg = JSON.parse(read(target, "server", "package.json"));
    expect(pkg.name).toEqual("my-derived-bot");
  });

  test("test_init_in_place_preserves_claude_md", async () => {
    // The agent-loop case: an existing CLAUDE.md is untouched.
    const target = tmpDir();
    writeFileSync(join(target, "CLAUDE.md"), "# guidance");
    const result = await cli(["init", target, "--name", "demo", ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);

    expect(read(target, "CLAUDE.md")).toEqual("# guidance");
    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
  });

  test("test_init_in_place_over_agent_guide", async () => {
    // The full agent loop: scaffold in place into a dir already holding the guide. Mirrors what
    // `pipedog init` leaves behind before the agent re-runs it to scaffold. Preserve-by-default:
    // the existing guide files are all kept as is, and the bot is scaffolded alongside them
    // (refresh the guide explicitly with --overwrite-guide).
    const target = tmpDir();
    writeFileSync(join(target, "AGENTS.md"), "# my guide");
    writeFileSync(join(target, "GETTING_STARTED.md"), "# dev");
    writeFileSync(join(target, "CLAUDE.md"), "@AGENTS.md");
    const result = await cli(["init", target, "--name", "demo", ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);

    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
    // Existing guide files survive untouched.
    expect(read(target, "AGENTS.md")).toEqual("# my guide");
    expect(read(target, "GETTING_STARTED.md")).toEqual("# dev");
    expect(read(target, "CLAUDE.md")).toEqual("@AGENTS.md");
  });

  test("test_init_in_place_aborts_on_existing_project", async () => {
    // Refuses to clobber a directory that already contains a project.
    const target = tmpDir();
    mkdirSync(join(target, "server"));
    const result = await cli(["init", target, "--name", "demo", ...SERVICE_FLAGS]);
    expect(result.code).toEqual(1);
    expect(result.output).toContain("already exists");
  });

  test("test_invalid_scaffold_flags_write_nothing", async () => {
    // An incomplete scaffold invocation fails before writing: no half-initialized dir. The
    // config is validated before the guide is written, so a bad invocation leaves the directory
    // untouched rather than dropping AGENTS.md/CLAUDE.md and then erroring.
    const target = tmpDir();
    // --bot-type with no transport/mode/services is invalid.
    const result = await cli(["init", target, "--bot-type", "web"]);
    expect(result.code).toEqual(1);
    expect(result.output.toLowerCase()).toContain("validation failed");
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(target, "server"))).toBe(false);
    expect(existsSync(join(target, ".mcp.json"))).toBe(false);
  });

  test("NEW: an existing README.md and .gitignore are kept", async () => {
    const target = tmpDir();
    writeFileSync(join(target, "README.md"), "# mine");
    writeFileSync(join(target, ".gitignore"), "mine");
    const result = await cli(["init", target, ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);
    expect(read(target, "README.md")).toEqual("# mine");
    expect(read(target, ".gitignore")).toEqual("mine");
  });

  test("NEW: the target is created when it doesn't exist", async () => {
    const target = join(tmpDir(), "deep", "new-bot");
    const result = await cli(["init", target, ...SERVICE_FLAGS]);
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(target, "server", "bot.ts"))).toBe(true);
  });

  test("NEW: no target scaffolds into the current directory instead of prompting", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", ...SERVICE_FLAGS, "--name", "here"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, "server", "bot.ts"))).toBe(true);
  });

  test("NEW: a target that is a file is an error", async () => {
    const cwd = tmpDir();
    writeFileSync(join(cwd, "file"), "x");
    const result = await cli(["init", "file", ...SERVICE_FLAGS], { cwd });
    expect(result.code).toEqual(1);
    expect(result.output).toContain("not a directory");
  });
});
