// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Read an ONNX model's `metadata_props` without loading the model.
 *
 * sherpa-onnx's SenseVoice export keeps the front end's parameters (LFR window,
 * CMVN statistics) and the language/text-norm ids in the model's metadata.
 * onnxruntime's JS API doesn't expose custom metadata, so this walks the
 * top-level fields of the `ModelProto` protobuf and skips the (large) graph by
 * its length, reading a few hundred kilobytes at most from a file.
 */

import type { OnnxModelSource } from "@pipedog/onnx";

// Held in a variable so bundlers leave the import alone; only used where there
// is a filesystem (Bun, Node, Deno).
const NODE_FS = "node:fs/promises";

interface FileHandleLike {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

type ReadAt = (position: number, length: number) => Promise<Uint8Array>;

/** `ModelProto.metadata_props` is field 14; `StringStringEntryProto` has key = 1, value = 2. */
const METADATA_PROPS_FIELD = 14;

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    const b = buf[pos + i];
    if (b === undefined) throw new RangeError("truncated varint");
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return [value, pos + i + 1];
    mul *= 128;
  }
  throw new RangeError("varint too long");
}

function parseEntry(buf: Uint8Array): [string, string] {
  const decoder = new TextDecoder();
  let key = "";
  let value = "";
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p] = readVarint(buf, pos);
    pos = p;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      const [len, q] = readVarint(buf, pos);
      const bytes = buf.subarray(q, q + len);
      if (field === 1) key = decoder.decode(bytes);
      else if (field === 2) value = decoder.decode(bytes);
      pos = q + len;
    } else if (wire === 0) {
      pos = readVarint(buf, pos)[1];
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return [key, value];
}

async function scan(readAt: ReadAt, size: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < size) {
    // A tag and a length are at most 10 bytes each.
    const head = await readAt(pos, Math.min(20, size - pos));
    const [tag, p1] = readVarint(head, 0);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      pos += readVarint(head, p1)[1];
    } else if (wire === 1) {
      pos += p1 + 8;
    } else if (wire === 5) {
      pos += p1 + 4;
    } else if (wire === 2) {
      const [len, p2] = readVarint(head, p1);
      if (field === METADATA_PROPS_FIELD) {
        const [key, value] = parseEntry(await readAt(pos + p2, len));
        out[key] = value;
      }
      pos += p2 + len;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} in ONNX model`);
    }
  }
  return out;
}

/** The `metadata_props` of an ONNX model held in memory. */
export function readOnnxMetadataFromBytes(bytes: Uint8Array): Promise<Record<string, string>> {
  return scan(
    async (position, length) => bytes.subarray(position, position + length),
    bytes.length,
  );
}

/**
 * The `metadata_props` of an ONNX model: bytes, or a filesystem path or `file:`
 * URL (read in place, without loading the whole file).
 */
export async function readOnnxMetadata(source: OnnxModelSource): Promise<Record<string, string>> {
  if (source instanceof Uint8Array) return readOnnxMetadataFromBytes(source);
  if (source instanceof ArrayBuffer) return readOnnxMetadataFromBytes(new Uint8Array(source));
  let path: string;
  if (source instanceof URL) {
    if (source.protocol !== "file:") {
      throw new Error(`readOnnxMetadata: fetch ${source.href} and pass its bytes instead`);
    }
    path = decodeURIComponent(source.pathname);
  } else {
    path = source.startsWith("file:") ? decodeURIComponent(new URL(source).pathname) : source;
  }
  const fs = (await import(NODE_FS)) as {
    open(path: string, flags: string): Promise<FileHandleLike>;
  };
  const handle = await fs.open(path, "r");
  try {
    const { size } = await handle.stat();
    return await scan(async (position, length) => {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buf, got, length - got, position + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    }, size);
  } finally {
    await handle.close();
  }
}
