// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_utils_startup.py

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _setupFilePaths } from "../src/utils/startup.ts";

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

test("test_setup_file_paths_uses_platform_path_separator", () => {
  const tmpPath = mkdtempSync(join(tmpdir(), "pipecat-startup-"));
  restores.push(() => rmSync(tmpPath, { recursive: true, force: true }));
  const first = join(tmpPath, "first.py");
  const second = join(tmpPath, "second.py");

  // monkeypatch.setattr(startup.os, "pathsep", ";"): the TS port derives the
  // separator from the platform, so pretend to be on Windows.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  restores.push(() => Object.defineProperty(process, "platform", platform));

  const previous = process.env.PIPECAT_SETUP_FILES;
  process.env.PIPECAT_SETUP_FILES = `${first};${second}`;
  restores.push(() => {
    if (previous === undefined) delete process.env.PIPECAT_SETUP_FILES;
    else process.env.PIPECAT_SETUP_FILES = previous;
  });

  expect(_setupFilePaths()).toEqual([resolve(first), resolve(second)]);
});
