// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_file_storage.py

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
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

// @pipedog/core has no filesystem access of its own; the storage is given one.

/**
 * The filesystem, with every written file stamped a second later than the one
 * before. Trimming keeps the newest files by mtime, and files written within
 * one tick of the filesystem's clock (ext4 on a CI runner: a few milliseconds)
 * share an mtime, so which of them is "oldest" would be down to readdir order.
 * DIVERGENCE: upstream's test relies on the real clock telling them apart.
 */
function steadyClockFs(): typeof fs {
  let seconds = 1_000_000;
  return {
    ...fs,
    writeFile: async (path: Parameters<typeof fs.writeFile>[0], data: never) => {
      await fs.writeFile(path, data);
      seconds += 1;
      await fs.utimes(path, seconds, seconds);
    },
  } as typeof fs;
}

describe("TestLocalFileStorage", () => {
  test("test_save_then_load_roundtrips_contents", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });
      const fileId = await storage.save("report.pdf", new TextEncoder().encode("contents"));

      expect(await storage.load(fileId)).toEqual(new TextEncoder().encode("contents"));
    });
  });

  test("test_save_does_not_leak_filename_into_id", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });
      const fileId = await storage.save("../../etc/passwd", new TextEncoder().encode("x"));

      expect(fileId).toMatch(/^pipecat:[0-9a-f]{32}$/);
    });
  });

  test("test_load_missing_id_raises_file_not_found", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });

      await expect(storage.load("a".repeat(32))).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_load_rejects_path_traversal_id", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const root = tmp;
      const uploads = join(root, "uploads");
      mkdirSync(uploads);
      writeFileSync(join(root, "secret.txt"), "secret");
      const storage = new LocalFileStorage({ folder: uploads, fs });

      await expect(storage.load("../secret.txt")).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_load_rejects_absolute_path_id", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });

      await expect(storage.load("/etc/passwd")).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_delete_removes_saved_file", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });
      const fileId = await storage.save("report.pdf", new TextEncoder().encode("contents"));

      await storage.delete(fileId);

      await expect(storage.load(fileId)).rejects.toThrow(FileNotFoundError);
    });
  });

  test("test_delete_missing_id_is_a_noop", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, fs });

      await storage.delete("a".repeat(32));
    });
  });

  test("test_save_trims_oldest_file_once_over_max", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, maxFiles: 2, fs: steadyClockFs() });
      const first = await storage.save("a.txt", new TextEncoder().encode("1"));
      await storage.save("b.txt", new TextEncoder().encode("2"));
      await storage.save("c.txt", new TextEncoder().encode("3"));

      await expect(storage.load(first)).rejects.toThrow(FileNotFoundError);
      expect(readdirSync(tmp).length).toEqual(2);
    });
  });

  test("test_max_files_zero_disables_trimming", async () => {
    await withTemporaryDirectory(async (tmp) => {
      const storage = new LocalFileStorage({ folder: tmp, maxFiles: 0, fs });
      for (let i = 0; i < 5; i++) {
        await storage.save(`${i}.txt`, new TextEncoder().encode(String(i)));
      }

      expect(readdirSync(tmp).length).toEqual(5);
    });
  });
});
