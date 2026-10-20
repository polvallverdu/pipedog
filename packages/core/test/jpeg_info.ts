// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * What Pillow's `Image.open(...)` reports for a JPEG without decoding it: the
 * format, the mode and the size, read from the SOI marker and the frame header.
 * Throws if the bytes are not a well-formed JPEG up to the first scan.
 */
export function jpegInfo(data: Uint8Array): {
  format: string;
  mode: string;
  size: [number, number];
} {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("not a JPEG (no SOI marker)");
  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) throw new Error(`bad JPEG marker at ${pos}`);
    const marker = data[pos + 1]!;
    const length = (data[pos + 2]! << 8) | data[pos + 3]!;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = (data[pos + 5]! << 8) | data[pos + 6]!;
      const width = (data[pos + 7]! << 8) | data[pos + 8]!;
      const components = data[pos + 9]!;
      const mode = { 1: "L", 3: "RGB", 4: "CMYK" }[components] ?? `${components} components`;
      return { format: "JPEG", mode, size: [width, height] };
    }
    if (marker === 0xda) break;
    pos += 2 + length;
  }
  throw new Error("JPEG has no frame header");
}
