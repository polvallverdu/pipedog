// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A small baseline JPEG encoder (JFIF, 8-bit, three components, no chroma
 * subsampling) in plain TypeScript.
 *
 * It stands in for Pillow's `Image.save(format="JPEG")`, which upstream uses
 * to encode raw video frames for a model to look at. Upstream needs no more
 * than a valid JPEG of the right size, so this encoder keeps to the simplest
 * profile every decoder supports: the standard quantization and Huffman
 * tables of ITU-T T.81 Annex K, scaled by quality like libjpeg.
 *
 * Runs everywhere core does: no dependencies, no `node:*`, no WebAssembly.
 */

// Zigzag order: ZIGZAG[i] is the row-major index of the i-th coefficient.
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// Annex K.1 quantization tables, row-major.
const LUMINANCE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMINANCE_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Annex K.3 Huffman tables: code counts per length (1..16), then the symbols.
interface HuffmanSpec {
  counts: number[];
  symbols: number[];
}
const DC_LUMINANCE: HuffmanSpec = {
  counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const DC_CHROMINANCE: HuffmanSpec = {
  counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const AC_LUMINANCE: HuffmanSpec = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};
const AC_CHROMINANCE: HuffmanSpec = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};

/** Canonical Huffman codes (Annex C) for a table: symbol → [code, length]. */
function buildCodes(spec: HuffmanSpec): { codes: Uint16Array; lengths: Uint8Array } {
  const codes = new Uint16Array(256);
  const lengths = new Uint8Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < spec.counts[length - 1]!; i++) {
      const symbol = spec.symbols[k++]!;
      codes[symbol] = code++;
      lengths[symbol] = length;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

/** A quantization table scaled for `quality` (1-100) the way libjpeg does. */
function scaleQuant(base: number[], quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.min(255, Math.max(1, Math.floor((base[i]! * scale + 50) / 100)));
  }
  return out;
}

// cos((2x + 1) u π / 16) for the forward DCT, indexed [u * 8 + x].
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) COS[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}

/** Forward 8x8 DCT-II (separable), in place on a row-major block of level-shifted samples. */
function fdct(block: Float64Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * COS[u * 8 + x]!;
      tmp[y * 8 + u] = sum * (u === 0 ? Math.SQRT1_2 : 1) * 0.5;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += tmp[y * 8 + u]! * COS[v * 8 + y]!;
      block[v * 8 + u] = sum * (v === 0 ? Math.SQRT1_2 : 1) * 0.5;
    }
  }
}

/** Growable byte buffer with an entropy-coded bit writer (with 0xFF byte stuffing). */
class ByteWriter {
  #buf = new Uint8Array(1024);
  #len = 0;
  #bitBuf = 0;
  #bitCount = 0;

  byte(b: number): void {
    if (this.#len === this.#buf.length) {
      const next = new Uint8Array(this.#buf.length * 2);
      next.set(this.#buf);
      this.#buf = next;
    }
    this.#buf[this.#len++] = b & 0xff;
  }

  word(w: number): void {
    this.byte(w >> 8);
    this.byte(w);
  }

  bytes(bs: ArrayLike<number>): void {
    for (let i = 0; i < bs.length; i++) this.byte(bs[i]!);
  }

  bits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.#bitBuf = (this.#bitBuf << 1) | ((value >> i) & 1);
      this.#bitCount++;
      if (this.#bitCount === 8) {
        this.byte(this.#bitBuf);
        if (this.#bitBuf === 0xff) this.byte(0);
        this.#bitBuf = 0;
        this.#bitCount = 0;
      }
    }
  }

  /** Pad the last entropy-coded byte with 1-bits (T.81 F.1.2.3). */
  flushBits(): void {
    if (this.#bitCount > 0) this.bits((1 << (8 - this.#bitCount)) - 1, 8 - this.#bitCount);
  }

  result(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

/** The magnitude category (bit length) of a coefficient, and its T.81 F.1.2.1 bits. */
function category(value: number): [number, number] {
  const abs = Math.abs(value);
  let size = 0;
  while (abs >> size) size++;
  const bits = value < 0 ? value + (1 << size) - 1 : value;
  return [size, bits];
}

interface Table {
  codes: Uint16Array;
  lengths: Uint8Array;
}

function writeHuffmanTable(w: ByteWriter, tableClass: number, id: number, spec: HuffmanSpec): void {
  w.byte((tableClass << 4) | id);
  w.bytes(spec.counts);
  w.bytes(spec.symbols);
}

export interface EncodeJpegOptions {
  /** Quality from 1 to 100. Defaults to 75, like Pillow. */
  quality?: number;
}

/**
 * Encode RGB pixels as a baseline JPEG.
 *
 * @param rgb Interleaved 8-bit RGB pixels, `width * height * 3` bytes, row-major.
 * @param width Image width in pixels.
 * @param height Image height in pixels.
 * @returns The JPEG file bytes.
 */
export function encodeJpegRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  options: EncodeJpegOptions = {},
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (width > 0xffff || height > 0xffff) {
    throw new RangeError(`image too large for JPEG: ${width}x${height}`);
  }
  if (rgb.length < width * height * 3) {
    throw new RangeError("not enough image data");
  }
  const quality = options.quality ?? 75;
  const quant = [scaleQuant(LUMINANCE_QUANT, quality), scaleQuant(CHROMINANCE_QUANT, quality)];
  const dc: Table[] = [buildCodes(DC_LUMINANCE), buildCodes(DC_CHROMINANCE)];
  const ac: Table[] = [buildCodes(AC_LUMINANCE), buildCodes(AC_CHROMINANCE)];

  const w = new ByteWriter();
  // SOI and a JFIF 1.01 APP0 segment (no thumbnail, 1:1 aspect).
  w.word(0xffd8);
  w.word(0xffe0);
  w.word(16);
  w.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0]);
  w.word(1);
  w.word(1);
  w.bytes([0, 0]);
  // DQT: both tables, 8-bit precision, in zigzag order.
  w.word(0xffdb);
  w.word(2 + 2 * 65);
  for (let t = 0; t < 2; t++) {
    w.byte(t);
    for (let i = 0; i < 64; i++) w.byte(quant[t]![ZIGZAG[i]!]!);
  }
  // SOF0: baseline, 8-bit, three components, no subsampling.
  w.word(0xffc0);
  w.word(8 + 3 * 3);
  w.byte(8);
  w.word(height);
  w.word(width);
  w.byte(3);
  for (let c = 0; c < 3; c++) {
    w.byte(c + 1);
    w.byte(0x11);
    w.byte(c === 0 ? 0 : 1);
  }
  // DHT: the four Annex K tables.
  w.word(0xffc4);
  const dhtLength =
    2 +
    [DC_LUMINANCE, AC_LUMINANCE, DC_CHROMINANCE, AC_CHROMINANCE].reduce(
      (n, s) => n + 17 + s.symbols.length,
      0,
    );
  w.word(dhtLength);
  writeHuffmanTable(w, 0, 0, DC_LUMINANCE);
  writeHuffmanTable(w, 1, 0, AC_LUMINANCE);
  writeHuffmanTable(w, 0, 1, DC_CHROMINANCE);
  writeHuffmanTable(w, 1, 1, AC_CHROMINANCE);
  // SOS: all three components in one interleaved scan.
  w.word(0xffda);
  w.word(6 + 2 * 3);
  w.byte(3);
  for (let c = 0; c < 3; c++) {
    w.byte(c + 1);
    w.byte(c === 0 ? 0x00 : 0x11);
  }
  w.bytes([0, 63, 0]);

  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const previousDc = [0, 0, 0];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let c = 0; c < 3; c++) {
        // Level-shifted YCbCr samples (JFIF), edge pixels repeated past the border.
        for (let y = 0; y < 8; y++) {
          const py = Math.min(by + y, height - 1);
          for (let x = 0; x < 8; x++) {
            const px = Math.min(bx + x, width - 1);
            const i = (py * width + px) * 3;
            const r = rgb[i]!;
            const g = rgb[i + 1]!;
            const b = rgb[i + 2]!;
            block[y * 8 + x] =
              c === 0
                ? 0.299 * r + 0.587 * g + 0.114 * b - 128
                : c === 1
                  ? -0.168736 * r - 0.331264 * g + 0.5 * b
                  : 0.5 * r - 0.418688 * g - 0.081312 * b;
          }
        }
        fdct(block, tmp);
        const t = c === 0 ? 0 : 1;
        const q = quant[t]!;
        const coefficients = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          const k = ZIGZAG[i]!;
          coefficients[i] = Math.round(block[k]! / q[k]!);
        }
        // DC: the difference from the previous block of this component.
        const diff = coefficients[0]! - previousDc[c]!;
        previousDc[c] = coefficients[0]!;
        const [dcSize, dcBits] = category(diff);
        w.bits(dc[t]!.codes[dcSize]!, dc[t]!.lengths[dcSize]!);
        if (dcSize > 0) w.bits(dcBits, dcSize);
        // AC: run-length of zeros and magnitude category, then the bits.
        let run = 0;
        for (let i = 1; i < 64; i++) {
          const value = coefficients[i]!;
          if (value === 0) {
            run++;
            continue;
          }
          while (run > 15) {
            w.bits(ac[t]!.codes[0xf0]!, ac[t]!.lengths[0xf0]!);
            run -= 16;
          }
          const [size, bits] = category(value);
          const symbol = (run << 4) | size;
          w.bits(ac[t]!.codes[symbol]!, ac[t]!.lengths[symbol]!);
          w.bits(bits, size);
          run = 0;
        }
        if (run > 0) w.bits(ac[t]!.codes[0x00]!, ac[t]!.lengths[0x00]!);
      }
    }
  }
  w.flushBits();
  w.word(0xffd9);
  return w.result();
}
