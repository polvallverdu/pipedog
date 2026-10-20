// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_version_banner.py

/**
 * The import-time version banner is suppressed for the pipecat/pc CLI.
 *
 * Python's `sys.argv[0]` is the script; in JS `process.argv[0]` is the
 * runtime and `process.argv[1]` is the script, so the program goes in slot 1.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as pipecat from "../src/index.ts";

let savedArgv: string[];

beforeEach(() => {
  savedArgv = process.argv;
});

afterEach(() => {
  process.argv = savedArgv;
});

function setProgram(prog: string): void {
  process.argv = [savedArgv[0] ?? "bun", prog];
}

test("test_banner_suppressed_for_cli_programs", () => {
  for (const prog of ["pipecat", "pc", "/usr/local/bin/pipecat", "pipecat.exe"]) {
    setProgram(prog);
    expect(pipecat._shouldLogVersionBanner()).toBe(false);
  }
});

test("test_banner_shown_for_bots_and_library_use", () => {
  for (const prog of ["bot.py", "python", "-c", "pytest", "/path/to/myapp"]) {
    setProgram(prog);
    expect(pipecat._shouldLogVersionBanner()).toBe(true);
  }
});
