// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The PCM samples of a 16-bit mono WAV file, resampled to 16 kHz, with silence
 * appended. The silence lets the bot's turn detection end the user's turn.
 */
export function wavToPcm16k(wav: Uint8Array, tailSecs = 1.5): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("not a WAV file");

  // Walk the chunks to find the format and the samples.
  let rate = 0;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = text(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") rate = view.getUint32(offset + 12, true);
    if (id === "data") {
      const count = Math.floor(size / 2);
      const source = new Int16Array(count);
      for (let i = 0; i < count; i++) source[i] = view.getInt16(offset + 8 + i * 2, true);
      return resampleTo16k(source, rate, tailSecs);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Linear interpolation: plenty for speech recognition, and dependency-free. */
function resampleTo16k(source: Int16Array, rate: number, tailSecs: number): Uint8Array {
  const length = Math.floor((source.length * 16000) / rate);
  const tail = Math.floor(tailSecs * 16000);
  const out = new Int16Array(length + tail);
  for (let i = 0; i < length; i++) {
    const at = (i * rate) / 16000;
    const index = Math.floor(at);
    const frac = at - index;
    const a = source[index] ?? 0;
    const b = source[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return new Uint8Array(out.buffer);
}
