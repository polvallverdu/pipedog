// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/evals/audio.py

/**
 * Audio files played as a user's turn.
 *
 * A turn's `audio:` names a recording to play instead of synthesizing its
 * text. WAV files are read natively; other formats need a decoder (see
 * `setUserAudioDecoder`).
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";

/**
 * Decoded audio as `soundfile.read(dtype="int16", always_2d=True)` gives it:
 * interleaved 16-bit samples, `channels` per frame.
 */
export interface DecodedUserAudio {
  /** Interleaved samples, `channels` per frame. */
  samples: Int16Array;
  /** Number of channels per frame (at least 1). */
  channels: number;
  /** The file's sample rate, in Hz. */
  sampleRate: number;
}

/**
 * Decodes an audio file the built-in WAV reader doesn't handle (MP3, FLAC,
 * OGG, ...). Throw to report the file unreadable.
 *
 * @param data The file's bytes.
 * @param path The file's path, for messages.
 */
export type UserAudioDecoder = (
  data: Uint8Array,
  path: string,
) => DecodedUserAudio | Promise<DecodedUserAudio>;

export interface LoadUserAudioOptions {
  /** Decoder for formats other than WAV; defaults to the one `setUserAudioDecoder` set. */
  decoder?: UserAudioDecoder | null;
}

let defaultDecoder: UserAudioDecoder | null = null;

/**
 * Set the decoder `loadUserAudio` uses for files that are not WAV, or null
 * to read WAV only.
 */
export function setUserAudioDecoder(decoder: UserAudioDecoder | null): void {
  defaultDecoder = decoder;
}

/** Python's `repr()` of a string. */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return quote + out + quote;
}

/**
 * Read an audio file as the PCM a user turn is sent as.
 *
 * The file keeps its own sample rate; the bot resamples on its way in.
 *
 * @param path Path to the audio file.
 * @returns Tuple of `[pcmBytes, sampleRate]` -- raw 16-bit little-endian mono PCM.
 * @throws Error (upstream: `ValueError`) if the file cannot be read as audio.
 */
export async function loadUserAudio(
  path: string,
  options: LoadUserAudioOptions = {},
): Promise<[Uint8Array, number]> {
  const decoder = options.decoder ?? defaultDecoder;
  let decoded: DecodedUserAudio;
  try {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (isWav(data)) {
      decoded = readWav(data);
    } else if (decoder) {
      decoded = await decoder(data, path);
    } else {
      // DIVERGENCE: upstream reads any format libsndfile does (WAV, MP3, FLAC,
      // OGG); without a decoder (`setUserAudioDecoder` or the `decoder` option)
      // only WAV is read here.
      throw new Error(
        "unsupported audio format (only WAV is read without a decoder; " +
          "pass one with setUserAudioDecoder or the decoder option)",
      );
    }
  } catch (e) {
    rethrowIfCancelled(e);
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read user audio ${pyStrRepr(path)}: ${reason}`, { cause: e });
  }

  const channels = decoded.channels;
  const frames = Math.floor(decoded.samples.length / channels);
  if (frames === 0) {
    throw new Error(`User audio ${pyStrRepr(path)} is empty`);
  }

  // A recording of one speaker carries the same voice on every channel, so the
  // mean is the mono take on it. Averaging in float avoids int16 overflow.
  const mono = new Int16Array(frames);
  const samples = decoded.samples;
  if (channels === 1) {
    mono.set(samples.subarray(0, frames));
  } else {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
      // numpy's astype(int16) truncates toward zero.
      mono[i] = Math.trunc(sum / channels);
    }
  }
  // PCM is little-endian; Int16Array uses the platform's order.
  const pcm = new Uint8Array(frames * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < frames; i++) view.setInt16(i * 2, mono[i]!, true);
  return [pcm, decoded.sampleRate];
}

function fourcc(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset]!,
    data[offset + 1]!,
    data[offset + 2]!,
    data[offset + 3]!,
  );
}

function isWav(data: Uint8Array): boolean {
  return data.length >= 12 && fourcc(data, 0) === "RIFF" && fourcc(data, 8) === "WAVE";
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** C's lrint under the default rounding mode: round half to even. */
function lrint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function clip16(x: number): number {
  return x > 32767 ? 32767 : x < -32768 ? -32768 : x;
}

/**
 * Read a RIFF/WAVE file's samples as int16, converting as libsndfile does:
 * unsigned 8-bit is re-centred and shifted up, 24- and 32-bit integers keep
 * their top 16 bits, and floats are scaled by 0x7FFF, rounded and clipped.
 */
function readWav(data: Uint8Array): DecodedUserAudio {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12;
  let format: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= data.length) {
    const id = fourcc(data, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > data.length) throw new Error("malformed WAV fmt chunk");
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40 || body + 40 > data.length) {
          throw new Error("malformed WAV extensible fmt chunk");
        }
        // The sub-format GUID starts with the format code.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataStart = body;
      // A streamed file may leave the size unset or too large.
      dataSize = Math.min(size, data.length - body);
      break;
    }
    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }

  if (format === null) throw new Error("WAV file has no fmt chunk");
  if (dataStart < 0) throw new Error("WAV file has no data chunk");
  if (channels < 1) throw new Error("WAV file has no channels");

  const bytesPerSample = bitsPerSample / 8;
  const isFloat = format === WAVE_FORMAT_IEEE_FLOAT;
  const supported =
    (format === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) ||
    (isFloat && (bitsPerSample === 32 || bitsPerSample === 64));
  if (!supported) {
    throw new Error(`unsupported WAV encoding (format ${format}, ${bitsPerSample}-bit)`);
  }
  const frameSize = Math.max(blockAlign, bytesPerSample * channels);
  const frames = Math.floor(dataSize / frameSize);
  const samples = new Int16Array(frames * channels);

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = dataStart + f * frameSize + c * bytesPerSample;
      let s: number;
      if (isFloat) {
        const x = bitsPerSample === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
        // NOTE: libsndfile scales float to int by 0x7FFF on read.
        s = clip16(lrint(x * 0x7fff));
      } else if (bitsPerSample === 8) {
        s = (data[p]! - 0x80) << 8;
      } else if (bitsPerSample === 16) {
        s = view.getInt16(p, true);
      } else if (bitsPerSample === 24) {
        // The top 16 bits of the 24: the high two bytes, signed.
        s = view.getInt16(p + 1, true);
      } else {
        s = view.getInt32(p, true) >> 16;
      }
      samples[f * channels + c] = s;
    }
  }
  return { samples, channels, sampleRate };
}
