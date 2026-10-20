// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/image.py

/** Image encoding helpers. */

import { encodeJpegRgb } from "./jpeg_encoder.ts";

/**
 * Encode an image for a model to look at.
 *
 * An image whose format is a MIME type is already encoded and keeps its
 * bytes. Raw pixels are encoded as a JPEG.
 *
 * @param image The image bytes, raw pixels or already encoded.
 * @param size The image's width and height.
 * @param format The pixel format, such as `"RGB"` or `"RGBA"`, or the MIME
 *   type of an encoded image. Raw pixels are taken as RGB when not given.
 * @returns The encoded bytes and their MIME type.
 */
export async function encodeImage(
  image: Uint8Array,
  size: [number, number],
  format: string | null,
): Promise<[Uint8Array, string]> {
  if (format?.startsWith("image/")) {
    return [image, format];
  }
  return [await encodeJpeg(image, size, format || "RGB"), "image/jpeg"];
}

/** Bytes per pixel of the raw pixel formats (Pillow modes) that can be encoded. */
const PIXEL_FORMATS: Record<string, number> = { L: 1, LA: 2, RGB: 3, RGBA: 4, RGBX: 4 };

/**
 * `Image.frombytes(format, size, image).convert("RGB")`: the pixels as
 * interleaved RGB, dropping alpha and widening grayscale.
 */
function toRgb(image: Uint8Array, [width, height]: [number, number], format: string): Uint8Array {
  const channels = PIXEL_FORMATS[format];
  if (channels === undefined) {
    throw new Error(`unrecognized image mode: ${format}`);
  }
  const pixels = width * height;
  if (image.length < pixels * channels) {
    throw new Error("not enough image data");
  }
  if (channels === 3) {
    return image;
  }
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const src = i * channels;
    if (channels <= 2) {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = image[src]!;
    } else {
      rgb[i * 3] = image[src]!;
      rgb[i * 3 + 1] = image[src + 1]!;
      rgb[i * 3 + 2] = image[src + 2]!;
    }
  }
  return rgb;
}

// Upstream encodes with Pillow in a thread; there are no threads here, so the
// (pure TypeScript) encoder runs inline.
async function encodeJpeg(
  image: Uint8Array,
  size: [number, number],
  format: string,
): Promise<Uint8Array> {
  return encodeJpegRgb(toRgb(image, size, format), size[0], size[1]);
}
