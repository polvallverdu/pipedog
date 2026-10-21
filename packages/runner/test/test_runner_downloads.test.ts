// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_runner_downloads.py

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resolveDownloadPath, HTTPException } from "../src/run.ts";

function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "runner-downloads-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function expect403(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(HTTPException);
  expect((error as HTTPException).statusCode).toBe(403);
}

describe("TestRunnerDownloads", () => {
  test("test_resolve_download_path_allows_files_inside_folder", () =>
    withTmp(async (tmp) => {
      const downloads = join(tmp, "downloads");
      const nested = join(downloads, "nested");
      mkdirSync(nested, { recursive: true });
      const filePath = join(nested, "recording.txt");
      writeFileSync(filePath, "session transcript");

      const resolved = await _resolveDownloadPath(downloads, "nested/recording.txt");

      expect(resolved).toBe(realpathSync(filePath));
    }));

  test("test_resolve_download_path_blocks_parent_traversal", () =>
    withTmp(async (root) => {
      const downloads = join(root, "downloads");
      mkdirSync(downloads);
      writeFileSync(join(root, "secret.txt"), "secret");
      await expect403(_resolveDownloadPath(downloads, "../secret.txt"));
    }));

  test("test_resolve_download_path_blocks_decoded_encoded_slashes", () =>
    withTmp(async (root) => {
      const downloads = join(root, "media");
      mkdirSync(downloads);
      mkdirSync(join(root, "outside"));
      writeFileSync(join(root, "outside", "secret.txt"), "secret");
      await expect403(_resolveDownloadPath(downloads, "../outside/secret.txt"));
    }));

  test("test_resolve_download_path_blocks_absolute_paths", () =>
    withTmp(async (tmp) => {
      const downloads = join(tmp, "downloads");
      mkdirSync(downloads);
      await expect403(_resolveDownloadPath(downloads, "/etc/passwd"));
    }));

  test("test_resolve_download_path_blocks_symlink_escape", () =>
    withTmp(async (root) => {
      const downloads = join(root, "downloads");
      const outside = join(root, "outside");
      mkdirSync(downloads);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(downloads, "linked"));
      await expect403(_resolveDownloadPath(downloads, "linked/secret.txt"));
    }));
});
