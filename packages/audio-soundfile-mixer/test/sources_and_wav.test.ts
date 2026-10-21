// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** What is new in the port: sources other than a path, and the pure-TS WAV reader. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readWavSound, SoundfileMixer } from "../src/index.ts";
import { pcm, samplesOf, wavBytes } from "./helpers.ts";

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/a.wav") return new Response(wavBytes([10, 20, 30]));
      return new Response("nope", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

async function mixOnce(
  source: ConstructorParameters<typeof SoundfileMixer>[0]["soundFiles"][string],
) {
  const mixer = new SoundfileMixer({ soundFiles: { a: source }, defaultSound: "a", volume: 1 });
  await mixer.start(16000);
  return samplesOf(await mixer.mix(pcm([0, 0, 0])));
}

describe("sound sources", () => {
  test("bytes, ArrayBuffer, URL, URL string and data: URL", async () => {
    const wav = wavBytes([10, 20, 30]);
    expect(await mixOnce(wav)).toEqual([10, 20, 30]);
    expect(await mixOnce(wav.buffer.slice(0) as ArrayBuffer)).toEqual([10, 20, 30]);
    expect(await mixOnce(new URL(`http://localhost:${server.port}/a.wav`))).toEqual([10, 20, 30]);
    expect(await mixOnce(`http://localhost:${server.port}/a.wav`)).toEqual([10, 20, 30]);
    expect(await mixOnce(`data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`)).toEqual([
      10, 20, 30,
    ]);
  });

  test("a failed URL is skipped and mixing passes through", async () => {
    expect(await mixOnce(`http://localhost:${server.port}/missing.wav`)).toEqual([0, 0, 0]);
  });

  test("a path is read through an injected filesystem", async () => {
    const reads: string[] = [];
    const mixer = new SoundfileMixer({
      soundFiles: { a: "/virtual/a.wav", b: "file:///virtual/b.wav" },
      defaultSound: "a",
      volume: 1,
      fileSystem: {
        async readFile(path) {
          reads.push(path);
          return wavBytes([7, 8, 9]);
        },
      },
    });
    await mixer.start(16000);
    expect(reads).toEqual(["/virtual/a.wav", "/virtual/b.wav"]);
    expect(samplesOf(await mixer.mix(pcm([0, 0, 0])))).toEqual([7, 8, 9]);
  });

  test("a path with no filesystem is a logged error, not a crash", async () => {
    const mixer = new SoundfileMixer({
      soundFiles: { a: "/x.wav" },
      defaultSound: "a",
      fileSystem: {
        async readFile() {
          throw new Error("no filesystem here");
        },
      },
    });
    await mixer.start(16000);
    const audio = pcm([1]);
    expect(await mixer.mix(audio)).toEqual(audio);
  });
});

describe("readWavSound", () => {
  test("converts sample formats as libsndfile does for int16", () => {
    expect(Array.from(readWavSound(wavBytes([0, 128, 255], 8000, { bits: 8 })).samples)).toEqual([
      -32768, 0, 32512,
    ]);
    expect(
      Array.from(readWavSound(wavBytes([0x123456, -0x123456], 8000, { bits: 24 })).samples),
    ).toEqual([0x1234, -0x1235]);
    expect(
      Array.from(readWavSound(wavBytes([0x12345678, -0x12345678], 8000, { bits: 32 })).samples),
    ).toEqual([0x1234, -0x1235]);
    expect(
      Array.from(readWavSound(wavBytes([0, 0.5, -1, 2], 8000, { format: 3, bits: 32 })).samples),
    ).toEqual([0, 16384, -32767, 32767]);
    expect(
      Array.from(readWavSound(wavBytes([0.25, -0.5], 8000, { format: 3, bits: 64 })).samples),
    ).toEqual([8192, -16384]);
  });

  test("decodes mu-law and A-law", () => {
    expect(
      Array.from(readWavSound(wavBytes([0xff, 0x00, 0x80], 8000, { format: 7, bits: 8 })).samples),
    ).toEqual([0, -32124, 32124]);
    expect(
      Array.from(readWavSound(wavBytes([0xd5, 0x55], 8000, { format: 6, bits: 8 })).samples),
    ).toEqual([8, -8]);
  });

  test("reports rate and channels, skips unknown chunks", () => {
    const base = wavBytes([1, 2, 3, 4], 22050, { channels: 2 });
    const list = new Uint8Array([...new TextEncoder().encode("LIST"), 3, 0, 0, 0, 1, 2, 3, 0]);
    const withList = new Uint8Array([...base.subarray(0, 36), ...list, ...base.subarray(36)]);
    const sound = readWavSound(withList);
    expect(sound.sampleRate).toBe(22050);
    expect(sound.numChannels).toBe(2);
    expect(Array.from(sound.samples)).toEqual([1, 2, 3, 4]);
  });

  test("rejects other audio formats with a clear message", () => {
    const sig = (s: string) =>
      new Uint8Array([...new TextEncoder().encode(s), 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => readWavSound(sig("fLaC"))).toThrow("FLAC");
    expect(() => readWavSound(sig("OggS"))).toThrow("Ogg");
    expect(() => readWavSound(sig("ID3\x04"))).toThrow("MP3");
    expect(() => readWavSound(sig("FORM"))).toThrow("AIFF");
    expect(() => readWavSound(new Uint8Array(20))).toThrow("not a WAV file");
    expect(() => readWavSound(wavBytes([1], 8000, { format: 2 }))).toThrow(
      "unsupported WAV encoding",
    );
  });
});
