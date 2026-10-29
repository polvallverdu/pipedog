// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Small Python stand-ins the evals modules share: `hashlib.sha256`, `repr()`
 * of a scalar, and `format(x, ".2f")`.
 *
 * The SHA-256 is synchronous on purpose: upstream hashes cache keys inline,
 * between reading a cache and filling it, and `crypto.subtle.digest()` would
 * add a suspension there that asyncio never had.
 *
 * @internal
 */

import { pyNumberRepr } from "@pipedog/core/utils/py_json";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Hex SHA-256 of bytes or of a string's UTF-8 (`hashlib.sha256(...).hexdigest()`), synchronously. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6) >>> 0);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = Array.from(h) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** Python's `repr()` of a string. */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " " || ch === "\x7f") {
      out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    } else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** Python's `repr()` of a config scalar: a string quoted, `None`, `True`/`False`, a number. */
export function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyStrRepr(value);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumberRepr(value);
  return String(value);
}

/** Python's `str()` of a config scalar. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  return pyRepr(value);
}

/** Python's `float(value)` of a config scalar. */
export function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (!Number.isNaN(n)) return n;
  }
  throw new Error(`could not convert to float: ${pyRepr(value)}`);
}

/** Python's `str(float)`: `2.0`, `1.3`, `1e-05`. */
export function pyFloatStr(value: number): string {
  const repr = pyNumberRepr(value);
  return Number.isFinite(value) && /^-?\d+$/.test(repr) ? `${repr}.0` : repr;
}

/**
 * Python's `format(value, ".2f")`: like `toFixed(2)`, but an exact tie rounds
 * to even, as Python does (`0.125` → `0.12`).
 */
export function formatFixed2(value: number): string {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5 && scaled / 100 === value) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    return (even / 100).toFixed(2);
  }
  return value.toFixed(2);
}

/**
 * Python's `re.compile(pattern)` for a `re.search`, as a JS `RegExp`.
 *
 * DIVERGENCE: JS regexes are not Python's. The common Python-only syntax is
 * rewritten: named groups `(?P<name>...)` and backreferences `(?P=name)`, the
 * anchors `\A` and `\Z`, and global inline flags (`(?i)`, `(?s)`, `(?m)`,
 * `(?x)` is not supported) at the head of the pattern. Anything else is
 * compiled as JS reads it, and an invalid pattern throws a `SyntaxError`.
 */
export function pyRegExp(pattern: string): RegExp {
  let source = pattern;
  let flags = "";
  const head = /^\(\?([aiLmsux]+)\)/.exec(source);
  if (head) {
    for (const flag of head[1]!) {
      if (flag === "i" || flag === "m" || flag === "s") {
        if (!flags.includes(flag)) flags += flag;
      } else if (flag === "x") {
        throw new SyntaxError("verbose flag (?x) is not supported");
      }
    }
    source = source.slice(head[0].length);
  }
  source = source
    .replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>")
    .replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>")
    .replace(/(^|[^\\])((?:\\\\)*)\\A/g, "$1$2^")
    .replace(/(^|[^\\])((?:\\\\)*)\\Z/g, "$1$2$");
  return new RegExp(source, flags);
}
