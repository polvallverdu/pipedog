// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GeminiFileAPI.uploadFile with each kind of source, against a fake `fetch`.
 *
 * pipedog-only: upstream has no File API tests, and takes only a path.
 */

import { expect, test } from "bun:test";
import { GeminiFileAPI } from "../src/gemini_live/file_api.ts";

type Call = { url: string; headers: Record<string, string>; body: Uint8Array | string };

/** A fetch that answers the two resumable-upload steps. */
function _fakeFetch(calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === "string"
        ? init.body
        : new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    calls.push({ url, headers, body });
    if (calls.length === 1) {
      return new Response("{}", { status: 200, headers: { "X-Goog-Upload-URL": "https://up/1" } });
    }
    return Response.json({ file: { name: "files/abc", uri: "https://files/abc" } });
  }) as typeof fetch;
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

async function _upload(
  file: Parameters<GeminiFileAPI["uploadFile"]>[0],
  displayName: string | null = null,
  options: Parameters<GeminiFileAPI["uploadFile"]>[2] = {},
  fs: ConstructorParameters<typeof GeminiFileAPI>[0]["fs"] = null,
): Promise<{ result: Record<string, unknown>; calls: Call[] }> {
  const calls: Call[] = [];
  const api = new GeminiFileAPI({ apiKey: "k", fetch: _fakeFetch(calls), fs });
  const result = await api.uploadFile(file, displayName, options);
  return { result, calls };
}

function _expectUploaded(calls: Call[], mimeType: string): void {
  expect(calls).toHaveLength(2);
  expect(calls[0]?.headers["x-goog-upload-header-content-length"]).toBe("5");
  expect(calls[0]?.headers["x-goog-upload-header-content-type"]).toBe(mimeType);
  expect(calls[1]?.url).toBe("https://up/1");
  expect(calls[1]?.headers["content-length"]).toBe("5");
  expect(calls[1]?.body).toEqual(BYTES);
}

test("test_upload_bytes", async () => {
  const { result, calls } = await _upload(BYTES, "clip.wav");
  _expectUploaded(calls, "audio/x-wav");
  expect(calls[0]?.body).toBe('{"file": {"display_name": "clip.wav"}}');
  expect((result.file as Record<string, unknown>).name).toBe("files/abc");
});

test("test_upload_array_buffer_defaults_to_octet_stream", async () => {
  const { calls } = await _upload(BYTES.slice().buffer);
  _expectUploaded(calls, "application/octet-stream");
});

test("test_upload_blob_uses_its_type", async () => {
  const { calls } = await _upload(new Blob([BYTES], { type: "image/png" }));
  _expectUploaded(calls, "image/png");
});

test("test_upload_readable_stream_with_mime_type", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(BYTES.subarray(0, 2));
      controller.enqueue(BYTES.subarray(2));
      controller.close();
    },
  });
  const { calls } = await _upload(stream, null, { mimeType: "application/pdf" });
  _expectUploaded(calls, "application/pdf");
});

test("test_upload_path_with_injected_fs", async () => {
  const paths: string[] = [];
  const fs = {
    readFile: async (path: string) => {
      paths.push(path);
      return BYTES;
    },
  };
  const { calls } = await _upload("/data/doc.pdf", null, {}, fs);
  expect(paths).toEqual(["/data/doc.pdf"]);
  _expectUploaded(calls, "application/pdf");
});

test("test_upload_path_reads_with_node_fs_by_default", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "gemini-file-api-"));
  try {
    const path = join(dir, "note.txt");
    await writeFile(path, BYTES);
    const { calls } = await _upload(path);
    _expectUploaded(calls, "text/plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test_upload_path_without_fs_throws_clear_error", async () => {
  const calls: Call[] = [];
  const api = new GeminiFileAPI({ apiKey: "k", fetch: _fakeFetch(calls) });
  // Stand in for a runtime without node:fs.
  (api as unknown as { _importFs: () => Promise<unknown> })._importFs = async () => {
    throw new Error("No such module: node:fs/promises");
  };
  await expect(api.uploadFile("/data/doc.pdf")).rejects.toThrow(
    /cannot read the path \/data\/doc\.pdf, because this runtime has no node:fs/,
  );
  expect(calls).toHaveLength(0);
});
