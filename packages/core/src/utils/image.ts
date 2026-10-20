// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/image.py

/** Image encoding helpers. */

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

// STUB: upstream encodes raw pixels with Pillow (`Image.frombytes(...).save(format="JPEG")`)
// in a thread. Core has no runtime-agnostic JPEG encoder yet.
async function encodeJpeg(
  _image: Uint8Array,
  _size: [number, number],
  _format: string,
): Promise<Uint8Array> {
  throw new Error(
    "not ported yet: encodeImage() cannot JPEG-encode raw pixels; pass an already encoded image (format 'image/...')",
  );
}
