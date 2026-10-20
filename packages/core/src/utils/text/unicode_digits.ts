// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Python's `\\d` (in str patterns) matches any Unicode decimal digit, and
// `int()` / `float()` accept them: `int("٥٠") == 50`. JavaScript's `\\p{Nd}`
// matches the same characters, but `Number` / `BigInt` only take ASCII digits.
// `toAsciiDigits` converts first, so ported code parses what Python parses.
//
// Generated from Python 3.14.5 unicodedata (Unicode 16.0.0):
// the code points whose decimal value is 0; each starts a run of ten digits 0-9.

const ZERO_CODE_POINTS: readonly number[] = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50,
  0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
  0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0,
  0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16130,
  0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140,
  0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

const DIGIT_VALUE = new Map<number, number>();
for (const zero of ZERO_CODE_POINTS) {
  for (let i = 0; i < 10; i++) DIGIT_VALUE.set(zero + i, i);
}

/** Replace every Unicode decimal digit with its ASCII digit (`"٥٠"` → `"50"`). */
export function toAsciiDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const value = DIGIT_VALUE.get(ch.codePointAt(0) as number);
    out += value === undefined ? ch : String(value);
  }
  return out;
}
