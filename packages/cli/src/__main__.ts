#!/usr/bin/env node
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The `pipedog` bin: `bunx @pipedog/cli init`, `npx @pipedog/cli init`, or `pipedog` once installed.
 *
 * It runs the CLI of `main.ts` when the file is the process's entry point, and has no side effect
 * when imported.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./main.ts";

/** Whether this module is the process's entry point (`if __name__ == "__main__":`). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await run(process.argv.slice(2));
}
