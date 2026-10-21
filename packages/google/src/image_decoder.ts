// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Decoding of the encoded images (PNG, JPEG, WebP) Gemini returns inline.
 *
 * Upstream decodes them with Pillow (`Image.open(...)`). There is no
 * dependency-free, edge-compatible decoder in pipedog yet, so the services
 * take an injectable `imageDecoder`; the default is a stub that throws.
 */

/** A decoded image: interleaved pixels, size and Pillow mode (e.g. `"RGB"`). */
export interface DecodedImage {
  /** Raw pixel bytes. */
  image: Uint8Array;
  /** Image dimensions as [width, height]. */
  size: [number, number];
  /** Pixel format, as a Pillow mode (`"RGB"`, `"RGBA"`, ...). */
  mode: string;
}

/**
 * Decodes encoded image bytes to RGB pixels (Pillow
 * `Image.open(io.BytesIO(data)).convert("RGB")`).
 *
 * @param data The encoded image bytes.
 * @param mimeType The MIME type Gemini reported for them, if any.
 */
export type ImageDecoder = (data: Uint8Array, mimeType: string | null) => Promise<DecodedImage>;

/**
 * The default `ImageDecoder`: not ported yet.
 *
 * STUB: decoding images (Pillow) has no edge-compatible JS equivalent in
 * pipedog yet. Pass an `imageDecoder` (e.g. one built on `sharp` or
 * `@jsquash/*`) to the service to handle image output.
 */
export const notPortedImageDecoder: ImageDecoder = async () => {
  throw new Error(
    "not ported yet: decoding images (Pillow) is not available; pass an `imageDecoder` option",
  );
};
