// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Reading NumPy `.npz` archives (what `numpy.load()` does for kokoro-onnx's
 * `voices-v1.0.bin`).
 *
 * An `.npz` is a zip of `.npy` files. Entries may be stored or deflated
 * (`numpy.savez` vs `numpy.savez_compressed`); deflated entries are inflated
 * with `DecompressionStream("deflate-raw")` (Bun, Node, Deno, browsers,
 * Workers). Only little-endian `float32` arrays in C order are supported,
 * which is what the Kokoro voice files hold.
 */

/** A float32 array with its shape. */
export interface NpyArray {
  data: Float32Array;
  shape: number[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse one `.npy` file. */
export function parseNpy(bytes: Uint8Array): NpyArray {
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== "NUMPY") {
    throw new Error("Not a .npy file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6] as number;
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (descr !== "<f4") throw new Error(`Unsupported .npy dtype ${descr} (only <f4)`);
  if (fortran !== "False") throw new Error("Unsupported .npy layout (Fortran order)");
  if (shapeText === undefined) throw new Error("Malformed .npy header");
  const shape = shapeText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const start = headerStart + headerLen;
  // Copy so the array is aligned and independent of the archive's buffer.
  const data = new Float32Array(count);
  new Uint8Array(data.buffer).set(bytes.subarray(start, start + count * 4));
  return { data, shape };
}

/**
 * Parse an `.npz` archive into its arrays, keyed by name without `.npy`
 * (as `numpy.load(path)[name]`).
 */
export async function parseNpz(bytes: Uint8Array): Promise<Map<string, NpyArray>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip (.npz) file");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const out = new Map<string, NpyArray>();
  const decoder = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Malformed zip central directory");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`Malformed zip entry ${name}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Uint8Array;
    if (method === 0) content = raw;
    else if (method === 8) content = await inflateRaw(raw);
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);

    out.set(name.endsWith(".npy") ? name.slice(0, -4) : name, parseNpy(content));
  }
  return out;
}
