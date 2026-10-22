// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Registers the pipedog docs MCP server, `@pipedog/mcp`, with coding agents.
 *
 * Upstream's `pipecat init` runs the Pipecat Context Hub's `install` (a subprocess that registers
 * the hub with each agent CLI it finds, plus a local index of about 900 MB). pipedog's docs
 * server ships its docs in the package, so there is no index to build, and registering it is
 * writing the same stanza the docs page "Docs for AI tools" shows into the project's config
 * file for each client:
 *
 * | Client | File | Root key |
 * |---|---|---|
 * | Claude Code | `.mcp.json` | `mcpServers` |
 * | Cursor | `.cursor/mcp.json` | `mcpServers` |
 * | VS Code | `.vscode/mcp.json` | `servers` (with `type: "stdio"`) |
 *
 * Project files are shared with the team through git and need no agent CLI on the machine
 * (`claude mcp add pipedog --scope project -- npx -y @pipedog/mcp` writes the same `.mcp.json`).
 * Registering is idempotent and never destroys anything: other servers in the file are kept, an
 * existing `pipedog` entry that differs is kept unless asked to overwrite, and a file that isn't
 * plain JSON (VS Code allows comments in `mcp.json`) is left alone, with the stanza to paste.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The server's name in each client. */
export const MCP_SERVER_NAME = "pipedog";
export const MCP_PACKAGE = "@pipedog/mcp";
export const MCP_COMMAND = "npx";
export const MCP_ARGS: readonly string[] = ["-y", MCP_PACKAGE];

export type McpClient = "claude" | "cursor" | "vscode";

export interface McpTarget {
  client: McpClient;
  /** The name shown to the user. */
  label: string;
  /** The config file, relative to the project. */
  file: string;
  /** The object key the servers are under. */
  rootKey: "mcpServers" | "servers";
  /** The server's stanza. */
  entry: Record<string, unknown>;
}

/** The clients, and the config format each reads (as in the docs' "Docs for AI tools" page). */
export const MCP_TARGETS: readonly McpTarget[] = [
  {
    client: "claude",
    label: "Claude Code",
    file: ".mcp.json",
    rootKey: "mcpServers",
    entry: { command: MCP_COMMAND, args: [...MCP_ARGS] },
  },
  {
    client: "cursor",
    label: "Cursor",
    file: ".cursor/mcp.json",
    rootKey: "mcpServers",
    entry: { command: MCP_COMMAND, args: [...MCP_ARGS] },
  },
  {
    client: "vscode",
    label: "VS Code",
    file: ".vscode/mcp.json",
    rootKey: "servers",
    // VS Code uses `servers`, not `mcpServers`, and names the transport.
    entry: { type: "stdio", command: MCP_COMMAND, args: [...MCP_ARGS] },
  },
];

/** What happened to one client's config. */
export type McpStatus =
  /** The server was added (the file was created, or the stanza written into it). */
  | "added"
  /** Already registered exactly so. */
  | "exists"
  /** A different `pipedog` entry was replaced (`overwrite`). */
  | "updated"
  /** A different `pipedog` entry is there, and was kept. */
  | "kept"
  /** The file exists but isn't plain JSON, or isn't an object: left untouched. */
  | "invalid"
  /** The file couldn't be written. */
  | "error";

export interface McpResult {
  client: McpClient;
  label: string;
  /** The config file, relative to the project. */
  file: string;
  status: McpStatus;
  /** Why, for `invalid` and `error`. */
  detail?: string;
}

/** The stanza of a client as it appears in its file, to paste by hand. */
export function mcpSnippet(target: McpTarget): string {
  return JSON.stringify({ [target.rootKey]: { [MCP_SERVER_NAME]: target.entry } }, null, 2);
}

function sameEntry(a: unknown, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface RegisterMcpOptions {
  /** The clients to register with (default: all). */
  clients?: readonly McpClient[];
  /** Replace a `pipedog` entry that differs from the standard one. */
  overwrite?: boolean;
}

/**
 * Register `@pipedog/mcp` in the project's MCP config files.
 *
 * @param projectDir The project directory.
 * @returns One result per client, in order.
 */
export function registerMcp(projectDir: string, options: RegisterMcpOptions = {}): McpResult[] {
  const wanted = options.clients ?? MCP_TARGETS.map((t) => t.client);
  const results: McpResult[] = [];
  for (const target of MCP_TARGETS) {
    if (!wanted.includes(target.client)) continue;
    const base = { client: target.client, label: target.label, file: target.file };
    const path = join(projectDir, target.file);
    try {
      let data: Record<string, unknown> = {};
      if (existsSync(path)) {
        let parsed: unknown;
        const text = readFileSync(path, "utf8");
        try {
          parsed = text.trim() === "" ? {} : JSON.parse(text);
        } catch (e) {
          results.push({
            ...base,
            status: "invalid",
            detail: `not plain JSON (${e instanceof Error ? e.message : String(e)})`,
          });
          continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          results.push({ ...base, status: "invalid", detail: "not a JSON object" });
          continue;
        }
        data = parsed as Record<string, unknown>;
      }
      const servers = data[target.rootKey];
      if (
        servers !== undefined &&
        (typeof servers !== "object" || servers === null || Array.isArray(servers))
      ) {
        results.push({
          ...base,
          status: "invalid",
          detail: `"${target.rootKey}" is not an object`,
        });
        continue;
      }
      const map = (servers ?? {}) as Record<string, unknown>;
      let status: McpStatus = "added";
      if (MCP_SERVER_NAME in map) {
        if (sameEntry(map[MCP_SERVER_NAME], target.entry)) {
          results.push({ ...base, status: "exists" });
          continue;
        }
        if (!options.overwrite) {
          results.push({ ...base, status: "kept" });
          continue;
        }
        status = "updated";
      }
      data[target.rootKey] = { ...map, [MCP_SERVER_NAME]: target.entry };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      results.push({ ...base, status });
    } catch (e) {
      results.push({
        ...base,
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** The outcome as lines for the terminal. */
export function describeMcpResults(results: readonly McpResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const where = `${r.label} (${r.file})`;
    switch (r.status) {
      case "added":
        lines.push(`✓ Registered the pipedog docs MCP server for ${where}`);
        break;
      case "updated":
        lines.push(`✓ Updated the pipedog docs MCP server for ${where}`);
        break;
      case "exists":
        lines.push(`• The pipedog docs MCP server is already registered for ${where}`);
        break;
      case "kept":
        lines.push(
          `• Kept the pipedog entry in ${r.file} (it differs from the standard one; pass --overwrite-guide to replace it)`,
        );
        break;
      case "invalid":
        lines.push(
          `⚠ Could not register ${r.label}: ${r.file} is ${r.detail}. Add this to it by hand:`,
          ...mcpSnippet(MCP_TARGETS.find((t) => t.client === r.client) as McpTarget)
            .split("\n")
            .map((l) => `    ${l}`),
        );
        break;
      case "error":
        lines.push(`⚠ Could not register ${r.label} (${r.file}): ${r.detail}`);
        break;
    }
  }
  return lines;
}
