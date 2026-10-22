// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Readers for the small binary files Pocket TTS uses besides its ONNX graphs:
 * `.safetensors` voice states, `.npy` arrays and `.wav` voice prompts.
 */

/** A tensor read from a file: float tensors as `Float32Array`, integer ones as `BigInt64Array`. */
export interface FileTensor {
  dtype: string;
  shape: number[];
  data: Float32Array | BigInt64Array;
}

const LITTLE_ENDIAN_HOST = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

function product(shape: readonly number[]): number {
  return shape.reduce((a, b) => a * b, 1);
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Decode raw little-endian tensor bytes of a safetensors/numpy dtype. */
function decodeTensor(
  bytes: Uint8Array,
  dtype: string,
  count: number,
): Float32Array | BigInt64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (dtype) {
    case "F32": {
      if (LITTLE_ENDIAN_HOST) return new Float32Array(bytes.slice(0, count * 4).buffer);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
      return out;
    }
    case "F64": {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getFloat64(i * 8, true);
      return out;
    }
    case "F16": {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = halfToFloat(view.getUint16(i * 2, true));
      return out;
    }
    case "BF16": {
      const out = new Float32Array(count);
      const u32 = new Uint32Array(out.buffer);
      for (let i = 0; i < count; i++) u32[i] = view.getUint16(i * 2, true) << 16;
      return out;
    }
    case "I64": {
      const out = new BigInt64Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getBigInt64(i * 8, true);
      return out;
    }
    case "I32": {
      const out = new BigInt64Array(count);
      for (let i = 0; i < count; i++) out[i] = BigInt(view.getInt32(i * 4, true));
      return out;
    }
    default:
      throw new Error(`Unsupported tensor dtype ${dtype}`);
  }
}

/** Read every tensor of a `.safetensors` file. */
export function readSafetensors(bytes: Uint8Array): Map<string, FileTensor> {
  if (bytes.length < 8) throw new Error("not a safetensors file: too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  if (8 + headerLength > bytes.length) throw new Error("not a safetensors file: bad header size");
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
  ) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const base = 8 + headerLength;
  const out = new Map<string, FileTensor>();
  for (const [name, info] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const [start, end] = info.data_offsets;
    const data = decodeTensor(
      bytes.subarray(base + start, base + end),
      info.dtype,
      product(info.shape),
    );
    out.set(name, { dtype: info.dtype, shape: info.shape, data });
  }
  return out;
}

/** Read a little-endian float/int `.npy` array (format versions 1-3, C order). */
export function readNpy(bytes: Uint8Array): FileTensor {
  const magic = String.fromCharCode(...bytes.subarray(1, 6));
  if (bytes[0] !== 0x93 || magic !== "NUMPY") throw new Error("not a .npy file");
  const major = bytes[6]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*True/.test(header);
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "";
  const shape = shapeText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (fortran) throw new Error(".npy arrays in Fortran order are not supported");
  const dtypes: Record<string, string> = {
    "<f4": "F32",
    "<f8": "F64",
    "<f2": "F16",
    "<i8": "I64",
    "<i4": "I32",
  };
  const dtype = descr ? dtypes[descr] : undefined;
  if (!dtype) throw new Error(`Unsupported .npy dtype ${descr}`);
  const data = decodeTensor(bytes.subarray(headerStart + headerLength), dtype, product(shape));
  return { dtype, shape, data };
}

/** Mono float audio and its sample rate. */
export interface DecodedAudio {
  audio: Float32Array;
  sampleRate: number;
}

/**
 * Decode a WAV file (PCM 8/16/24/32-bit or IEEE float 32/64-bit) and mix its
 * channels down to mono, as pocket-tts' `convert_audio(..., channels=1)` does.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("Not a WAV file (decode other formats yourself and pass the samples)");
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data || !sampleRate || !channels) throw new Error("WAV file without fmt/data chunks");
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const read = (i: number): number => {
    const at = i * width;
    if (format === 3) return width === 8 ? dv.getFloat64(at, true) : dv.getFloat32(at, true);
    if (format !== 1) throw new Error(`Unsupported WAV sample format ${format}`);
    switch (width) {
      case 1:
        return (dv.getUint8(at) - 128) / 128;
      case 2:
        return dv.getInt16(at, true) / 32768;
      case 3: {
        const v = dv.getUint8(at) | (dv.getUint8(at + 1) << 8) | (dv.getInt8(at + 2) << 16);
        return v / 8388608;
      }
      case 4:
        return dv.getInt32(at, true) / 2147483648;
      default:
        throw new Error(`Unsupported WAV sample width ${bits}`);
    }
  };
  const audio = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(f * channels + c);
    audio[f] = sum / channels;
  }
  return { audio, sampleRate };
}
