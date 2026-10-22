// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_init_context_hub.py

// Tests for the docs MCP server setup `pipedog init` performs.
//
// DIVERGENCE: upstream registers the Pipecat Context Hub (a subprocess) and offers to build its
// 900 MB index. pipedog registers `@pipedog/mcp` (`npx -y @pipedog/mcp`) by writing the
// project's MCP config files for Claude Code, Cursor and VS Code, in the formats of the docs'
// "Docs for AI tools" page. There is no index, so the tests of the index prompt, the index build,
// its status line and the freshness check (`TestIndexPrompt`, `TestIndexBuild`, `TestStatusLine`)
// are skipped. Two properties carry over: `init quickstart` doesn't skip the registration (it is a
// file write, not a multi-minute build), and a failure is never fatal.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeMcpResults, MCP_TARGETS, mcpSnippet, registerMcp } from "../src/mcp_register.ts";
import { cli, read, SERVICE_FLAGS, tmpDir } from "./helpers.ts";

/** The server's stanza, as the docs page shows it. */
const DOCS_STANZA = { command: "npx", args: ["-y", "@pipedog/mcp"] };

describe("TestQuickstart", () => {
  test("test_quickstart_registers_the_server_too", async () => {
    // Registering is a file write, so the fast path keeps it.
    const cwd = tmpDir();
    const result = await cli(["init", "quickstart"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, "pipedog-quickstart", ".mcp.json"))).toBe(true);
  });

  test("test_quickstart_still_writes_the_agent_guide", async () => {
    const cwd = tmpDir();
    await cli(["init", "quickstart"], { cwd });
    expect(existsSync(join(cwd, "pipedog-quickstart", "AGENTS.md"))).toBe(true);
  });

  test("test_no_mcp_skips_it_on_quickstart", async () => {
    const cwd = tmpDir();
    await cli(["init", "quickstart", "--no-mcp"], { cwd });
    expect(existsSync(join(cwd, "pipedog-quickstart", ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, "pipedog-quickstart", "AGENTS.md"))).toBe(true);
  });
});

describe("TestCodingAgentPath", () => {
  test("test_sets_up_the_server", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", "."], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".vscode", "mcp.json"))).toBe(true);
    expect(result.output).toContain("Registered the pipedog docs MCP server for Claude Code");
  });

  test("test_no_mcp_flag_skips_it", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", ".", "--no-mcp"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor"))).toBe(false);
    expect(existsSync(join(cwd, ".vscode"))).toBe(false);
  });

  test("test_scaffolding_sets_it_up_too", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", ".", ...SERVICE_FLAGS, "--name", "bot"], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(read(cwd, ".gitignore")).toContain("!.vscode/mcp.json");
  });

  test("NEW: a scaffold that fails validation registers nothing", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", ".", "--bot-type", "web"], { cwd });
    expect(result.code).toEqual(1);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });

  test("NEW: --mcp-client registers with the clients named", async () => {
    const cwd = tmpDir();
    const result = await cli(["init", ".", "--mcp-client", "cursor", "--mcp-client", "vscode"], {
      cwd,
    });
    expect(result.code, result.output).toEqual(0);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".vscode", "mcp.json"))).toBe(true);
    const bad = await cli(["init", ".", "--mcp-client", "emacs"], { cwd: tmpDir() });
    expect(bad.code).toEqual(2);
    expect(bad.output).toContain("--mcp-client must be one of");
  });
});

describe("TestConfigFormats", () => {
  // The files hold exactly what the docs' "Docs for AI tools" page shows for each client.

  test("test_claude_code_mcp_json", () => {
    const dir = tmpDir();
    registerMcp(dir);
    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { pipedog: DOCS_STANZA } });
  });

  test("test_cursor_mcp_json", () => {
    const dir = tmpDir();
    registerMcp(dir);
    expect(JSON.parse(read(dir, ".cursor", "mcp.json"))).toEqual({
      mcpServers: { pipedog: DOCS_STANZA },
    });
  });

  test("test_vscode_mcp_json_uses_servers_and_names_the_transport", () => {
    // VS Code uses `servers`, not `mcpServers`.
    const dir = tmpDir();
    registerMcp(dir);
    expect(JSON.parse(read(dir, ".vscode", "mcp.json"))).toEqual({
      servers: { pipedog: { type: "stdio", ...DOCS_STANZA } },
    });
  });

  test("test_the_formats_are_the_docs'", () => {
    // Read the docs page: each client's JSON block is the stanza written here.
    const docs = readFileSync(
      join(import.meta.dir, "../../../apps/docs/content/docs/guides/llms.mdx"),
      "utf8",
    );
    const blocks = [...docs.matchAll(/```json\n([\s\S]*?)```/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    for (const target of MCP_TARGETS) {
      const expected = JSON.parse(mcpSnippet(target));
      expect(blocks, `${target.client}`).toContainEqual(expected);
    }
    // The Claude Code command is the one the docs give.
    expect(docs).toContain("claude mcp add pipedog -- npx -y @pipedog/mcp");
  });
});

describe("TestRegistrationOutcomes", () => {
  test("test_a_new_registration_is_reported", () => {
    const dir = tmpDir();
    const results = registerMcp(dir);
    expect(results.map((r) => [r.client, r.status])).toEqual([
      ["claude", "added"],
      ["cursor", "added"],
      ["vscode", "added"],
    ]);
  });

  test("test_registering_twice_is_idempotent", () => {
    const dir = tmpDir();
    registerMcp(dir);
    const before = read(dir, ".mcp.json");
    const again = registerMcp(dir);
    expect(again.map((r) => r.status)).toEqual(["exists", "exists", "exists"]);
    expect(read(dir, ".mcp.json")).toEqual(before);
  });

  test("test_other_servers_are_kept", () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }),
    );
    registerMcp(dir);
    const data = JSON.parse(read(dir, ".mcp.json"));
    expect(data.mcpServers.other).toEqual({ command: "x" });
    expect(data.mcpServers.pipedog).toEqual(DOCS_STANZA);
    expect(data.extra).toEqual(1);
  });

  test("test_a_different_pipedog_entry_is_kept_unless_overwriting", () => {
    const dir = tmpDir();
    const mine = { command: "npx", args: ["-y", "@pipedog/mcp", "--live"] };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { pipedog: mine } }));
    const kept = registerMcp(dir, { clients: ["claude"] });
    expect(kept[0]?.status).toEqual("kept");
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.pipedog).toEqual(mine);
    const updated = registerMcp(dir, { clients: ["claude"], overwrite: true });
    expect(updated[0]?.status).toEqual("updated");
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.pipedog).toEqual(DOCS_STANZA);
  });

  test("test_a_file_that_isnt_plain_json_is_left_alone_with_the_stanza_to_paste", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".vscode"));
    // VS Code's mcp.json may hold comments.
    const text = '{\n  // my servers\n  "servers": {}\n}\n';
    writeFileSync(join(dir, ".vscode", "mcp.json"), text);
    const results = registerMcp(dir);
    const vscode = results.find((r) => r.client === "vscode");
    expect(vscode?.status).toEqual("invalid");
    expect(read(dir, ".vscode", "mcp.json")).toEqual(text);
    // The others are done regardless.
    expect(results.filter((r) => r.status === "added").length).toEqual(2);
    const lines = describeMcpResults(results).join("\n");
    expect(lines).toContain("Add this to it by hand");
    expect(lines).toContain('"servers"');
    expect(lines).toContain("@pipedog/mcp");
  });

  test("test_a_file_of_the_wrong_shape_is_left_alone", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".mcp.json"), "[]");
    expect(registerMcp(dir, { clients: ["claude"] })[0]?.status).toEqual("invalid");
    const dir2 = tmpDir();
    writeFileSync(join(dir2, ".mcp.json"), JSON.stringify({ mcpServers: [] }));
    expect(registerMcp(dir2, { clients: ["claude"] })[0]?.status).toEqual("invalid");
  });

  test("test_an_empty_file_is_filled", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".mcp.json"), "");
    expect(registerMcp(dir, { clients: ["claude"] })[0]?.status).toEqual("added");
  });

  test("test_a_rejected_registration_is_surfaced", () => {
    // The directory can't be written to: a file where the directory should be.
    const dir = tmpDir();
    writeFileSync(join(dir, ".cursor"), "not a directory");
    const results = registerMcp(dir, { clients: ["cursor"] });
    expect(results[0]?.status).toEqual("error");
    expect(describeMcpResults(results).join("\n")).toContain("Could not register Cursor");
  });
});

describe("TestFailureIsNeverFatal", () => {
  test("test_a_broken_config_does_not_fail_init", async () => {
    const cwd = tmpDir();
    writeFileSync(join(cwd, ".cursor"), "a file, not a directory");
    const result = await cli(["init", "."], { cwd });
    expect(result.code, result.output).toEqual(0);
    expect(result.output).toContain("Could not register Cursor");
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
  });

  test("test_a_rerun_says_it_is_registered_and_doesnt_ask_to_reload", async () => {
    const cwd = tmpDir();
    await cli(["init", "."], { cwd });
    const again = await cli(["init", "."], { cwd });
    expect(again.output).toContain("already registered for Claude Code");
    expect(again.output).not.toContain("MCP servers load when a coding session starts");
  });
});

// The Context Hub's index: its prompt, build, progress line and freshness check have no
// counterpart (`@pipedog/mcp` bundles its docs).
describe("TestIndexPrompt", () => {
  test.skip("test_no_question_once_an_index_exists", () => {});
  test.skip("test_an_index_from_a_newer_hub_still_counts", () => {});
  test.skip("test_non_interactive_prints_the_command_instead_of_asking", () => {});
  test.skip("test_an_index_without_a_completed_refresh_still_prompts", () => {});
});
describe("TestIndexBuild", () => {
  test.skip("test_asks_the_hub_for_the_stream_it_echoes", () => {});
  test.skip("test_failure_shows_the_error_and_how_to_retry", () => {});
  test.skip("test_failure_output_is_not_read_as_markup", () => {});
});
describe("TestStatusLine", () => {
  test.skip("test_shows_the_message_without_the_log_furniture", () => {});
  test.skip("test_an_unfamiliar_line_is_shown_whole", () => {});
  test.skip("test_a_half_written_line_is_carried_to_the_next_read", () => {});
  test.skip("test_long_lines_are_trimmed_to_the_terminal", () => {});
  test.skip("test_bracketed_values_are_not_read_as_markup", () => {});
});
