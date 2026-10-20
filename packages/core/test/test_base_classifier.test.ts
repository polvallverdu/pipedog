// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_base_classifier.py

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import {
  BaseClassifier,
  ClassifierError,
  ClassifierImage,
  type ClassifierQuestion,
  type ClassifierResult,
  type ClassifierValue,
  YesNoQuestion,
  YesNoResult,
} from "../src/classifiers/base_classifier.ts";
import type { ImageRawFrame } from "../src/frames/frames.ts";
import type { LLMTokenUsage } from "../src/metrics/metrics.ts";

const QUESTION = { answer: new YesNoQuestion({ instructions: "is this red?" }) };

/** A classifier that cannot see images: its _ask takes no images. */
class _TextClassifier extends BaseClassifier {
  calls = 0;

  protected async _ask(
    _state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage | null]> {
    this.calls += 1;
    const results: Record<string, ClassifierResult> = {};
    for (const name of Object.keys(questions)) {
      results[name] = new YesNoResult({ probability: 0.5 });
    }
    return [results, null];
  }
}

/** A classifier that sees images and records what it was given. */
class _ImageClassifier extends BaseClassifier {
  images: (readonly ClassifierImage[])[] = [];

  override get supportsImages(): boolean {
    return true;
  }

  protected async _ask(
    _state: ClassifierValue,
    questions: Readonly<Record<string, ClassifierQuestion>>,
    images: readonly ClassifierImage[] = [],
  ): Promise<[Record<string, ClassifierResult>, LLMTokenUsage | null]> {
    this.images.push(images);
    const results: Record<string, ClassifierResult> = {};
    for (const name of Object.keys(questions)) {
      results[name] = new YesNoResult({ probability: 0.9 });
    }
    return [results, null];
  }
}

// PORTING NOTE: upstream builds its fixture images with Pillow. There is no
// image library here, so PNGs are encoded by hand below and the other formats
// are small pre-encoded images.

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An RGB PNG of one solid color. */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(rgb, y * stride + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// An 8x8 red JPEG.
const RED_JPEG = fromBase64(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z",
);
// A 1x1 lossless WebP.
const WEBP = fromBase64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");
// A 1x1 GIF.
const GIF = fromBase64("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");

function _jpeg(): ClassifierImage {
  return new ClassifierImage({ data: RED_JPEG, contentType: "image/jpeg" });
}

function imageFrame(image: Uint8Array, size: [number, number], format: string): ImageRawFrame {
  return { image, size, format };
}

describe("TestImages", () => {
  test("test_a_classifier_that_cannot_see_images_refuses_them", async () => {
    const classifier = new _TextClassifier();

    expect(classifier.supportsImages).toBe(false);
    const promise = classifier.yesNo("a frame", QUESTION, { images: [_jpeg()] });
    await expect(promise).rejects.toBeInstanceOf(ClassifierError);
    await expect(promise).rejects.toThrow(/cannot see images/);
    expect(classifier.calls).toBe(0);
  });

  test("test_a_classifier_that_cannot_see_images_still_answers_text", async () => {
    const classifier = new _TextClassifier();

    const results = await classifier.yesNo("hello", QUESTION);

    expect(results.answer?.probability).toBe(0.5);
  });

  test("test_images_reach_a_classifier_that_sees_them", async () => {
    const classifier = new _ImageClassifier();
    const image = _jpeg();

    await classifier.yesNo("a frame", QUESTION, { images: [image] });
    await classifier.ask("a frame", QUESTION, { images: [image, image] });
    await classifier.yesNo("no frame", QUESTION);

    expect(classifier.images).toEqual([[image], [image, image], []]);
  });

  test("test_the_image_bytes_stay_out_of_the_repr", () => {
    expect(String(_jpeg())).not.toContain("data");
  });
});

describe("TestImageType", () => {
  const cases: [string, Uint8Array, string][] = [
    ["PNG", png(4, 4, [255, 0, 0]), "image/png"],
    ["JPEG", RED_JPEG, "image/jpeg"],
    ["WEBP", WEBP, "image/webp"],
  ];
  for (const [pillowFormat, data, contentType] of cases) {
    test(`test_the_type_is_read_from_the_bytes[${pillowFormat}-${contentType}]`, () => {
      expect(new ClassifierImage({ data }).contentType).toBe(contentType);
    });
  }

  test("test_a_given_type_is_kept", () => {
    expect(
      new ClassifierImage({
        data: new TextEncoder().encode("png bytes"),
        contentType: "image/png",
      }).contentType,
    ).toBe("image/png");
  });

  test("test_another_image_type_is_an_error", () => {
    expect(() => new ClassifierImage({ data: GIF })).toThrow("PNG, JPEG or WebP, got image/gif");
  });

  test("test_bytes_that_are_not_an_image_are_an_error", () => {
    expect(() => new ClassifierImage({ data: new TextEncoder().encode("not an image") })).toThrow(
      "not an image",
    );
  });
});

describe("TestImageFromFrame", () => {
  test.todo(
    "test_raw_pixels_are_encoded_as_a_jpeg (needs the JPEG encoder in utils/image.ts, not ported yet)",
  );

  test.todo(
    "test_pixels_with_alpha_are_encoded_without_it (needs the JPEG encoder in utils/image.ts, not ported yet)",
  );

  test("test_an_encoded_frame_keeps_its_bytes", async () => {
    const encoded = png(4, 4, [0, 0, 255]);
    const frame = imageFrame(encoded, [4, 4], "image/png");

    const image = await ClassifierImage.fromFrame(frame);

    expect([image.contentType, image.data]).toEqual(["image/png", encoded]);
  });

  test("test_an_encoded_frame_of_another_type_is_an_error", async () => {
    const frame = imageFrame(new TextEncoder().encode("gif bytes"), [4, 4], "image/gif");

    await expect(ClassifierImage.fromFrame(frame)).rejects.toThrow();
  });
});
