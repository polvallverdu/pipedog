// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/__init__.py

/**
 * The `@pipedog/core` package entry point.
 *
 * Porting notes:
 * - The version is this package's version (upstream reads the installed
 *   `pipecat-ai` distribution's metadata); keep it in sync with package.json.
 * - The check for a separately installed `pipecat-ai-flows` package is Python
 *   packaging specific and is not ported.
 * - The `asyncio.wait_for` replacement for Python < 3.12 has no JS
 *   counterpart (`waitFor` from `@pipedog/asyncio` is used everywhere).
 */

import { logger } from "./utils/logger.ts";
import { VERSION } from "./version.ts";

const __version__ = VERSION;

interface ProcessLike {
  argv?: string[];
  versions?: Record<string, string | undefined>;
}

function currentProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

/** A short description of the JavaScript runtime, for the version banner. */
function runtimeDescription(): string {
  const g = globalThis as {
    Bun?: { version: string };
    Deno?: { version: { deno: string } };
    navigator?: { userAgent?: string };
  };
  if (g.Bun) return `Bun ${g.Bun.version}`;
  if (g.Deno) return `Deno ${g.Deno.version.deno}`;
  const node = currentProcess()?.versions?.node;
  if (node) return `Node ${node}`;
  return g.navigator?.userAgent ?? "unknown runtime";
}

/**
 * Whether to emit the import-time version banner.
 *
 * The banner is a handy startup marker for bots and interactive use, but it's
 * just noise for the `pipecat` / `pc` CLI — it even corrupts `--help` output —
 * so suppress it there.
 */
export function _shouldLogVersionBanner(): boolean {
  const script = currentProcess()?.argv?.[1] ?? "";
  const base = script.split(/[\\/]/).pop() ?? "";
  const program = base.replace(/\.[^.]*$/, "");
  return program !== "pipecat" && program !== "pc";
}

if (_shouldLogVersionBanner()) {
  // Upstream prints "ᓚᘏᗢ Pipecat <version> ᓚᘏᗢ"; this is pipedog, with its own version.
  logger.info(`pipedog ${__version__} (${runtimeDescription()})`);
}

/** Returns the pipedog version (shared by every @pipedog package). */
export function version(): string {
  return __version__;
}
