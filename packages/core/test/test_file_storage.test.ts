// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_file_storage.py

import { describe, expect, test } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: test-only temp-dir fixtures; tests run on Bun.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileNotFoundError, LocalFileStorage } from "../src/utils/file_storage.ts";

/** `tempfile.TemporaryDirectory()` equivalent. */
async function withTemporaryDirectory(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pipecat-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// LocalFileStorage disk I/O (save/load/delete/_trim) is a documented stub in
// @pipecat-ts/core, which cannot import node:fs; it needs a runtime-specific
// LocalFileStorage implementation. Tests that touch the disk are todo until then.
const TODO_DISK_IO =
  "needs LocalFileStorage disk I/O (save/load/delete/_trim), unported in packages/core/src/utils/file_storage.ts";

describe("TestLocalFileStorage", () => {
  test.todo(`test_save_then_load_roundtrips_contents (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });
      const fileId = await storage.save("report.pdf", new TextEncoder().encode("contents"));

      expect(await storage.load(fileId)).toEqual(new TextEncoder().encode("contents"));
    });
  });

  test.todo(`test_save_does_not_leak_filename_into_id (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });
      const fileId = await storage.save("../../etc/passwd", new TextEncoder().encode("x"));

      expect(fileId).toMatch(/^pipecat:[0-9a-f]{32}$/);
    });
  });

  test.todo(`test_load_missing_id_raises_file_not_found (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });

      await expect(storage.load("a".repeat(32))).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_load_rejects_path_traversal_id", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const root = tmp;
      const uploads = join(root, "uploads");
      mkdirSync(uploads);
      writeFileSync(join(root, "secret.txt"), "secret");
      const storage = new LocalFileStorage({ folder: uploads });

      await expect(storage.load("../secret.txt")).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_load_rejects_absolute_path_id", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });

      await expect(storage.load("/etc/passwd")).rejects.toThrow(FileNotFoundError);
    });
  });

  test.todo(`test_delete_removes_saved_file (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });
      const fileId = await storage.save("report.pdf", new TextEncoder().encode("contents"));

      await storage.delete(fileId);

      await expect(storage.load(fileId)).rejects.toThrow(FileNotFoundError);
    });
  });

  test.todo(`test_delete_missing_id_is_a_noop (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp });

      await storage.delete("a".repeat(32));
    });
  });

  test.todo(`test_save_trims_oldest_file_once_over_max (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, maxFiles: 2 });
      const first = await storage.save("a.txt", new TextEncoder().encode("1"));
      await storage.save("b.txt", new TextEncoder().encode("2"));
      await storage.save("c.txt", new TextEncoder().encode("3"));

      await expect(storage.load(first)).rejects.toThrow(FileNotFoundError);
      expect(readdirSync(tmp).length).toEqual(2);
    });
  });

  test.todo(`test_max_files_zero_disables_trimming (${TODO_DISK_IO})`, async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, maxFiles: 0 });
      for (let i = 0; i < 5; i++) {
        await storage.save(`${i}.txt`, new TextEncoder().encode(String(i)));
      }

      expect(readdirSync(tmp).length).toEqual(5);
    });
  });
});
