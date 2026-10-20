// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_audio_utils.py

import { describe, expect, test } from "bun:test";

import { pcmToWav } from "../src/audio/utils.ts";

/** Minimal RIFF/WAVE reader standing in for Python's `wave` module. */
function readWav(data: Uint8Array): [number, number, number, Uint8Array] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...data.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new Error("file does not start with RIFF id");
  }
  let numChannels = 0;
  let sampleWidth = 0;
  let sampleRate = 0;
  let frames: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      sampleWidth = Math.floor((view.getUint16(body + 14, true) + 7) / 8);
    } else if (id === "data") {
      // Like `wave.readframes(getnframes())`: only complete frames are read.
      const blockAlign = numChannels * sampleWidth;
      const nframes = Math.floor(size / blockAlign);
      frames = data.slice(body, body + nframes * blockAlign);
    }
    offset = body + size + (size % 2);
  }
  if (frames === undefined) throw new Error("data chunk missing");
  return [numChannels, sampleWidth, sampleRate, frames];
}

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** `struct.pack("<...h", *samples)` */
function packInt16(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (const [i, s] of samples.entries()) view.setInt16(i * 2, s, true);
  return out;
}

/** `memoryview(pcm).cast("h")` */
function int16View(pcm: Uint8Array): Int16Array {
  const copy = pcm.slice();
  return new Int16Array(copy.buffer, 0, copy.length / 2);
}

describe("TestPcmToWav", () => {
  test("test_mono", () => {
    const pcm = repeat([0x01, 0x00], 1600); // 0.1s of a constant sample at 16kHz
    const wav = pcmToWav(pcm, 16000);
    const [numChannels, sampleWidth, sampleRate, frames] = readWav(wav);
    expect(numChannels).toEqual(1);
    expect(sampleWidth).toEqual(2);
    expect(sampleRate).toEqual(16000);
    expect(frames).toEqual(pcm);
  });

  test("test_stereo", () => {
    const pcm = repeat([0x01, 0x00, 0x02, 0x00], 2400); // 0.1s of interleaved stereo at 24kHz
    const wav = pcmToWav(pcm, 24000, 2);
    const [numChannels, sampleWidth, sampleRate, frames] = readWav(wav);
    expect(numChannels).toEqual(2);
    expect(sampleWidth).toEqual(2);
    expect(sampleRate).toEqual(24000);
    expect(frames).toEqual(pcm);
  });

  test("test_empty", () => {
    const wav = pcmToWav(new Uint8Array(0), 16000);
    const [, , sampleRate, frames] = readWav(wav);
    expect(sampleRate).toEqual(16000);
    expect(frames).toEqual(new Uint8Array(0));
  });

  test("test_bytearray", () => {
    // Python's bytearray maps to Uint8Array as well; use a fresh mutable copy.
    const pcm = repeat([0x01, 0x00], 1600).slice();
    const wav = pcmToWav(pcm, 16000);
    const [, , , frames] = readWav(wav);
    expect(frames).toEqual(pcm.slice());
  });

  test("test_typed_memoryview_preserves_complete_frames", () => {
    const cases: [number, number[]][] = [
      [1, [1, -2, 3]],
      [2, [1, -2]],
    ];
    for (const [channels, samples] of cases) {
      const pcm = packInt16(samples);
      const wav = pcmToWav(int16View(pcm), 16000, channels);
      const [numChannels, sampleWidth, sampleRate, frames] = readWav(wav);
      expect(numChannels).toEqual(channels);
      expect(sampleWidth).toEqual(2);
      expect(sampleRate).toEqual(16000);
      expect(frames).toEqual(pcm);
    }
  });

  test("test_typed_memoryview_drops_only_partial_trailing_frame", () => {
    const pcm = packInt16([1, -2, 3, -4, 5]);
    const wav = pcmToWav(int16View(pcm), 24000, 2);
    const [, , , frames] = readWav(wav);
    expect(frames).toEqual(pcm.subarray(0, pcm.length - 2));
  });

  test("test_byte_memoryview", () => {
    const pcm = new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x03]);
    // `memoryview(pcm)` over bytes: a byte view onto a larger buffer.
    const backing = new Uint8Array(pcm.length + 4);
    backing.set(pcm, 2);
    const wav = pcmToWav(backing.subarray(2, 2 + pcm.length), 16000);
    const [, , , frames] = readWav(wav);
    expect(frames).toEqual(pcm.subarray(0, pcm.length - 1));
  });

  test("test_drops_partial_trailing_frame", () => {
    const stereo = repeat([0x01, 0x00, 0x02, 0x00], 100);
    const pcm = new Uint8Array(stereo.length + 2); // stereo plus a lone sample
    pcm.set(stereo);
    pcm.set([0x03, 0x00], stereo.length);
    const wav = pcmToWav(pcm, 24000, 2);
    const [numChannels, , , frames] = readWav(wav);
    expect(numChannels).toEqual(2);
    expect(frames).toEqual(pcm.subarray(0, pcm.length - 2));
  });
});
