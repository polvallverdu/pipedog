// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** A WAV writer, standing in for `soundfile.write` in the tests. */
export function wavBytes(
  samples: ArrayLike<number>,
  sampleRate = 16000,
  options: { format?: number; bits?: number; channels?: number } = {},
): Uint8Array {
  const format = options.format ?? 1;
  const bits = options.bits ?? 16;
  const channels = options.channels ?? 1;
  const width = bits / 8;
  const dataSize = samples.length * width;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const text = (o: number, s: string) => out.set(new TextEncoder().encode(s), o);
  text(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * width, true);
  v.setUint16(32, channels * width, true);
  v.setUint16(34, bits, true);
  text(36, "data");
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number;
    const o = 44 + i * width;
    if (format === 3 && bits === 32) v.setFloat32(o, s, true);
    else if (format === 3 && bits === 64) v.setFloat64(o, s, true);
    else if (bits === 8) v.setUint8(o, s);
    else if (bits === 16) v.setInt16(o, s, true);
    else if (bits === 24) {
      v.setUint8(o, s & 0xff);
      v.setUint8(o + 1, (s >> 8) & 0xff);
      v.setUint8(o + 2, (s >> 16) & 0xff);
    } else v.setInt32(o, s, true);
  }
  return out;
}

export const pcm = (samples: number[]): Uint8Array =>
  new Uint8Array(new Int16Array(samples).buffer);

export const samplesOf = (audio: Uint8Array): number[] =>
  Array.from(new Int16Array(audio.buffer, audio.byteOffset, audio.byteLength >> 1));
