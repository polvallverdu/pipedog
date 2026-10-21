#!/usr/bin/env node
// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/__main__.py

/**
 * Entry point for the `pipedog-eval` bin (upstream: `python -m pipecat.evals`).
 *
 * Runs the same CLI as `cli.ts`'s `evalApp`, so `pipedog-eval run ...` and
 * `bun node_modules/@pipedog/evals/src/__main__.ts run ...` execute identical
 * code. Importing this module has no side effects: the CLI runs only when the
 * file is the process's entry point.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { evalApp } from "./cli.ts";

/** Whether this module is the process's entry point (`if __name__ == "__main__":`). */
async function _isMain(): Promise<boolean> {
  const entry = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
  if (!entry) return false;
  try {
    const { realpathSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    rethrowIfCancelled(e);
    return false;
  }
}

if (await _isMain()) {
  process.exitCode = await evalApp(process.argv.slice(2));
}
