// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Seeded random numbers, standing in for `np.random` so the tests are repeatable. */
export function rng(seed = 1234): { uniform(): number; normal(mean: number, std: number): number } {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniform,
    normal(mean, std) {
      const u = 1 - uniform();
      const v = uniform();
      return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

/** `np.linspace(0, duration, n, endpoint)` for the tests' time axes. */
export function linspace(start: number, stop: number, n: number, endpoint: boolean): number[] {
  const step = (stop - start) / (endpoint ? n - 1 : n);
  return Array.from({ length: n }, (_, i) => start + i * step);
}

export function randomInt16(n: number, random: ReturnType<typeof rng>): Int16Array {
  return Int16Array.from({ length: n }, () => Math.floor(random.uniform() * 65535) - 32768);
}

export const bytesOf = (s: Int16Array): Uint8Array =>
  new Uint8Array(s.buffer, s.byteOffset, s.byteLength);

export function int16Of(b: Uint8Array): Int16Array {
  const out = new Int16Array(b.length >> 1);
  new Uint8Array(out.buffer).set(b.subarray(0, out.length * 2));
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
