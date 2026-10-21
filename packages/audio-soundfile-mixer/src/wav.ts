// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A WAV reader in pure TypeScript, standing in for libsndfile's `sf.read(file, dtype="int16")`.
 *
 * Reads RIFF/WAVE (and RF64) files with PCM (8, 16, 24 and 32 bit), IEEE float (32 and 64 bit),
 * A-law and mu-law samples, including `WAVE_FORMAT_EXTENSIBLE`, and returns interleaved int16
 * samples converted as libsndfile converts them: integers by dropping low bits (8-bit is
 * unsigned and shifted up), floats scaled by 32767. Other containers (FLAC, Ogg, MP3, AIFF, ...)
 * are recognized by their signature and rejected with a clear error.
 */

export interface WavSound {
  /** Interleaved int16 samples (`numChannels` per frame). */
  samples: Int16Array;
  sampleRate: number;
  numChannels: number;
}

const FORMAT_PCM = 0x0001;
const FORMAT_FLOAT = 0x0003;
const FORMAT_ALAW = 0x0006;
const FORMAT_MULAW = 0x0007;
const FORMAT_EXTENSIBLE = 0xfffe;

const SIGNATURES: Array<[string, string]> = [
  ["fLaC", "FLAC"],
  ["OggS", "Ogg (Vorbis/Opus)"],
  ["ID3", "MP3"],
  ["FORM", "AIFF"],
  [".snd", "AU"],
  ["caff", "CAF"],
  ["riff", "Sony Wave64"],
];

function ascii(data: Uint8Array, offset: number, length = 4): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

/** Name of the container, when it is a known non-WAV audio format. */
function otherFormat(data: Uint8Array): string | null {
  const head = ascii(data, 0, 4);
  for (const [magic, name] of SIGNATURES) if (head.startsWith(magic)) return name;
  if (data.length > 1 && data[0] === 0xff && ((data[1] as number) & 0xe0) === 0xe0) return "MP3";
  return null;
}

function decodeMulaw(byte: number): number {
  const u = ~byte & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

function decodeAlaw(byte: number): number {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

/** Round half to even, as libsndfile's `lrint` does. */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Parse a WAV file.
 *
 * @throws If the data is not a WAV file, or uses an unsupported encoding.
 */
export function readWavSound(data: Uint8Array): WavSound {
  const other = otherFormat(data);
  if (other) {
    throw new Error(`unsupported audio format ${other}: only WAV files are supported`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const riff = ascii(data, 0);
  if ((riff !== "RIFF" && riff !== "RF64") || ascii(data, 8) !== "WAVE") {
    throw new Error("not a WAV file (missing RIFF/WAVE header); only WAV files are supported");
  }

  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bits = 0;
  let body: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = ascii(data, offset);
    let size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(start, true);
      numChannels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26) {
        format = view.getUint16(start + 24, true); // the sub-format's leading GUID bytes
      }
    } else if (id === "data") {
      // A streamed file may have 0 or 0xFFFFFFFF as the size: take the rest.
      if (size === 0xffffffff || start + size > data.length) size = data.length - start;
      body = data.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !numChannels) throw new Error("WAV file has no fmt chunk");
  if (!body) throw new Error("WAV file has no data chunk");

  const bytes = bits >> 3;
  const count = Math.floor(body.length / (bytes || 1));
  const out = new Int16Array(count);
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);

  if (format === FORMAT_PCM) {
    if (bits === 8) for (let i = 0; i < count; i++) out[i] = ((body[i] as number) - 128) << 8;
    else if (bits === 16) for (let i = 0; i < count; i++) out[i] = v.getInt16(i * 2, true);
    else if (bits === 24) {
      // The top two bytes of each 24-bit sample (libsndfile drops the low byte).
      for (let i = 0; i < count; i++) out[i] = v.getInt16(i * 3 + 1, true);
    } else if (bits === 32) for (let i = 0; i < count; i++) out[i] = v.getInt32(i * 4, true) >> 16;
    else throw new Error(`unsupported WAV PCM bit depth ${bits}`);
  } else if (format === FORMAT_FLOAT) {
    if (bits === 32) {
      for (let i = 0; i < count; i++) out[i] = clamp16(rint(v.getFloat32(i * 4, true) * 32767));
    } else if (bits === 64) {
      for (let i = 0; i < count; i++) out[i] = clamp16(rint(v.getFloat64(i * 8, true) * 32767));
    } else throw new Error(`unsupported WAV float bit depth ${bits}`);
  } else if (format === FORMAT_MULAW && bits === 8) {
    for (let i = 0; i < count; i++) out[i] = decodeMulaw(body[i] as number);
  } else if (format === FORMAT_ALAW && bits === 8) {
    for (let i = 0; i < count; i++) out[i] = decodeAlaw(body[i] as number);
  } else {
    throw new Error(
      `unsupported WAV encoding (format tag 0x${format.toString(16)}, ${bits} bits): ` +
        "only PCM, float, A-law and mu-law WAV files are supported",
    );
  }
  return { samples: out, sampleRate, numChannels };
}
