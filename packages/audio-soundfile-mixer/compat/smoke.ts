// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: mixes a WAV given as bytes, and one fetched from a data:
// URL. No filesystem is touched, so it runs on workerd too.

import { SoundfileMixer } from "@pipedog/audio-soundfile-mixer";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-soundfile-mixer smoke: ${message}`);
}

function wav(samples: number[], sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  v.setUint32(4, 36 + samples.length * 2, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i] as number, true);
  return out;
}

export default async function smoke(): Promise<void> {
  const bytes = wav([1000, 1000, 1000], 16000);
  const b64 = btoa(String.fromCharCode(...wav([200, 400, 600], 16000)));
  const mixer = new SoundfileMixer({
    soundFiles: { a: bytes, b: `data:audio/wav;base64,${b64}` },
    defaultSound: "a",
    volume: 0.5,
  });
  await mixer.start(16000);
  const out = new Int16Array(
    (await mixer.mix(new Uint8Array(new Int16Array([100, 200, 300]).buffer))).slice().buffer,
  );
  check(out.join() === "600,700,800", `mixed ${out.join()}`);

  // Reading a path needs a filesystem (not on workerd): Bun, Node and Deno write a temp file and load it.
  if (globalThis.navigator?.userAgent !== "Cloudflare-Workers") {
    const fs = (await import("node:fs/promises")) as typeof import("node:fs/promises");
    const os = (await import("node:os")) as typeof import("node:os");
    const dir = await fs.mkdtemp(`${os.tmpdir()}/soundfile-mixer-`);
    try {
      await fs.writeFile(`${dir}/a.wav`, wav([5, 6], 16000));
      const fromPath = new SoundfileMixer({
        soundFiles: { a: `${dir}/a.wav` },
        defaultSound: "a",
        volume: 1,
      });
      await fromPath.start(16000);
      const mixed = new Int16Array((await fromPath.mix(new Uint8Array(4))).slice().buffer);
      check(mixed.join() === "5,6", `path mixed ${mixed.join()}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
