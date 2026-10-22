// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/cli/test_eval_env.py

// `pipedog eval` (the `pipedog-eval` bin) loads the nearest `.env` for the harness's own services.
//
// DIVERGENCE: upstream stubs python-dotenv's `load_dotenv` and checks the call. Here the loader is
// a small function of `cli.ts`, so the test checks what it does: the file found walking up from
// the working directory is loaded, without overriding the shell.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loadDotenv } from "../src/cli.ts";

describe("TestEvalLoadsDotenv", () => {
  let base: string;
  const saved = { ...process.env };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pipedog-evals-env-")));
    writeFileSync(
      join(base, ".env"),
      "PIPEDOG_TEST_FROM_FILE=from-file\nPIPEDOG_TEST_SHELL=from-file\n",
    );
    mkdirSync(join(base, "bots"));
    delete process.env.PIPEDOG_TEST_FROM_FILE;
    process.env.PIPEDOG_TEST_SHELL = "from-shell";
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    for (const key of ["PIPEDOG_TEST_FROM_FILE", "PIPEDOG_TEST_SHELL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("test_the_nearest_env_file_is_loaded_without_overriding_the_shell", async () => {
    const path = await _loadDotenv(join(base, "bots"));
    expect(path).toEqual(join(base, ".env"));
    expect(process.env.PIPEDOG_TEST_FROM_FILE).toEqual("from-file");
    // The shell wins.
    expect(process.env.PIPEDOG_TEST_SHELL).toEqual("from-shell");
  });
});
