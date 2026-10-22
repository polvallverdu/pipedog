// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boolTensor,
  createNativeBackend,
  createWebBackend,
  downloadModelFile,
  fileExists,
  int32Tensor,
  modelCacheDir,
} from "../src/index.ts";

// i2 = i + i (int32), b2 = Not(b) (bool)
const TINY_INT32_BOOL = Uint8Array.from(
  atob(
    "CAgSB3BpcGVkb2c6cQoPCgFpCgFpEgJpMiIDQWRkCgwKAWISAmIyIgNOb3QSBnRpbnkzMloQCgFpEgsKCQgGEgUKAxIBbloQCgFiEgsKCQgJEgUKAxIBbmIRCgJpMhILCgkIBhIFCgMSAW5iEQoCYjISCwoJCAkSBQoDEgFuQgQKABAN",
  ),
  (c) => c.charCodeAt(0),
);

describe("int32 and bool tensors", () => {
  for (const [name, create] of [
    ["onnxruntime-node", createNativeBackend],
    ["onnxruntime-web", createWebBackend],
  ] as const) {
    test(name, async () => {
      const backend = await create();
      const session = await backend.createSession(TINY_INT32_BOOL);
      const out = await session.run({
        i: int32Tensor(Int32Array.of(1, -2, 3), [3]),
        b: boolTensor(Uint8Array.of(1, 0, 1), [3]),
      });
      expect(out.i2!.type).toBe("int32");
      expect(Array.from(out.i2!.data as Int32Array)).toEqual([2, -4, 6]);
      expect(out.b2!.type).toBe("bool");
      expect(Array.from(out.b2!.data as Uint8Array, Number)).toEqual([0, 1, 0]);
      await session.dispose();
    });
  }
});

describe("model cache", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("modelCacheDir honours PIPEDOG_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache", async () => {
    process.env.PIPEDOG_CACHE_DIR = "/tmp/pd";
    expect(await modelCacheDir("kokoro")).toBe("/tmp/pd/kokoro");
    delete process.env.PIPEDOG_CACHE_DIR;
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    expect(await modelCacheDir("kokoro")).toBe("/tmp/xdg/pipedog/kokoro");
    delete process.env.XDG_CACHE_HOME;
    expect(await modelCacheDir("kokoro")).toMatch(/\.cache\/pipedog\/kokoro$/);
  });

  test("downloadModelFile downloads once, shares concurrent calls, and leaves no .part file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipedog-cache-"));
    const dest = join(dir, "sub", "model.bin");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: { "content-length": "4" },
      });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      downloadModelFile("https://models.invalid/m.bin", dest, { fetch: fakeFetch }),
      downloadModelFile("https://models.invalid/m.bin", dest, { fetch: fakeFetch }),
    ]);
    expect(a).toBe(dest);
    expect(b).toBe(dest);
    expect(calls).toBe(1);
    expect(Array.from(readFileSync(dest))).toEqual([1, 2, 3, 4]);
    expect(await fileExists(`${dest}.part`)).toBe(false);

    await downloadModelFile("https://models.invalid/m.bin", dest, { fetch: fakeFetch });
    expect(calls).toBe(1);
    await downloadModelFile("https://models.invalid/m.bin", dest, {
      fetch: fakeFetch,
      force: true,
    });
    expect(calls).toBe(2);
  });

  test("downloadModelFile fails on HTTP errors and keeps an existing file untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipedog-cache-"));
    const dest = join(dir, "model.bin");
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadModelFile("https://models.invalid/m.bin", dest, { fetch: notFound }),
    ).rejects.toThrow("HTTP 404");
    expect(await fileExists(dest)).toBe(false);
    writeFileSync(dest, "x");
    await downloadModelFile("https://models.invalid/m.bin", dest, { fetch: notFound });
    expect(readFileSync(dest, "utf8")).toBe("x");
  });
});
