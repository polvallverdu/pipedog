// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/cli/templates/gitignore.jinja2

/**
 * The generated project's `.gitignore`.
 *
 * DIVERGENCE: upstream's is GitHub's Python template (232 lines). This one covers what a
 * Bun or Node bot and its Vite client produce.
 */

export function renderGitignore(generateClient: boolean): string {
  const lines = [
    "# Dependencies",
    "node_modules/",
    "",
    "# Environment variables (API keys): copy .env.example to .env",
    ".env",
    ".env.local",
    ".env.*.local",
    "",
    "# Build output and caches",
    "dist/",
    "*.tsbuildinfo",
    ".cache/",
    "",
    "# Logs",
    "*.log",
    "logs/",
    "",
    "# Audio recordings and files the runner saves",
    "recordings/",
    "uploads/",
    "downloads/",
    "",
    "# Editors and operating systems",
    ".DS_Store",
    "Thumbs.db",
    ".idea/",
    ".vscode/*",
    "!.vscode/mcp.json",
    "",
  ];
  if (generateClient) {
    lines.push("# Client (Vite)", "client/dist/", "client/.env.local", "");
  }
  return lines.join("\n");
}
