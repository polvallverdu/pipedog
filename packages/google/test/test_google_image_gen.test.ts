// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_image_gen.py

/** Tests for GoogleImageGenService response handling. */

import { describe, expect, mock, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import type { GenerateContentResponse, Part } from "@google/genai";
import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { GoogleImageGenService, type GoogleImageGenSettingsOptions } from "../src/image.ts";
import type { ImageDecoder } from "../src/image_decoder.ts";

/** A solid red PNG (Pillow `Image.new(mode, size, "red").save(buffer, "PNG")`). */
function _pngBytes(mode: "RGB" | "RGBA", size: [number, number] = [64, 32]): Uint8Array {
  const [width, height] = size;
  const channels = mode === "RGBA" ? 4 : 3;
  const pixel = mode === "RGBA" ? [255, 0, 0, 255] : [255, 0, 0];
  const raw = new Uint8Array(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * channels);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(pixel, row + 1 + x * channels);
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = mode === "RGBA" ? 6 : 2; // color type
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}

function _response(parts: Part[]): GenerateContentResponse {
  return { candidates: [{ content: { role: "model", parts } }] } as GenerateContentResponse;
}

function _imagePart(mode: "RGB" | "RGBA" = "RGB"): Part {
  return { inlineData: { data: bytesToBase64(_pngBytes(mode)), mimeType: "image/png" } };
}

/**
 * Stand-in for Pillow's `Image.open(...).convert("RGB")`, which is not ported
 * (see `image_decoder.ts`). Only used by tests whose assertions are about the
 * request, not the decoded pixels.
 */
const _rgbDecoder: ImageDecoder = async () => ({
  image: new Uint8Array(64 * 32 * 3),
  size: [64, 32],
  mode: "RGB",
});

function _service(
  responses: (GenerateContentResponse | Error)[],
  settings: GoogleImageGenSettingsOptions = {},
  imageDecoder: ImageDecoder | null = null,
) {
  const queue = [...responses];
  const generateContent = mock(async (_params: any) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next as GenerateContentResponse;
  });
  const service = new GoogleImageGenService({
    apiKey: "test-key",
    settings: new GoogleImageGenService.Settings(settings),
    client: { models: { generateContent } },
    imageDecoder,
  });
  return { service, generateContent };
}

async function _frames(service: GoogleImageGenService): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of service.runImageGen("a red square")) frames.push(frame);
  return frames;
}

describe("test_google_image_gen", () => {
  // Needs a real image decoder (upstream: Pillow), not ported yet.
  test.todo("test_emits_inline_image (needs image decoding: services/google/image_decoder.ts default decoder, Pillow, is unported)", async () => {
    // The image part of a Gemini response becomes an RGB image frame.
    const { service } = _service([_response([{ text: "Here you go." }, _imagePart()])]);

    const frames = await _frames(service);

    expect(frames.length).toBe(1);
    const frame = frames[0] as URLImageRawFrame;
    expect(frame).toBeInstanceOf(URLImageRawFrame);
    expect(frame.url).toBeNull();
    expect(frame.size).toEqual([64, 32]);
    expect(frame.format).toBe("RGB");
    expect(frame.image.length).toBe(64 * 32 * 3);
  });

  test.todo("test_converts_alpha_images_to_rgb (needs image decoding: services/google/image_decoder.ts default decoder, Pillow, is unported)", async () => {
    // Images with an alpha channel are emitted as RGB.
    const { service } = _service([_response([_imagePart("RGBA")])]);

    const frames = await _frames(service);

    const frame = frames[0] as URLImageRawFrame;
    expect(frame.format).toBe("RGB");
    expect(frame.image.length).toBe(64 * 32 * 3);
  });

  test("test_requests_one_image_per_call", async () => {
    // number_of_images makes that many requests, each asking for an image.
    const { service, generateContent } = _service(
      [0, 1, 2].map(() => _response([_imagePart()])),
      { numberOfImages: 3 },
      _rgbDecoder,
    );

    const frames = await _frames(service);

    expect(frames.length).toBe(3);
    expect(generateContent.mock.calls.length).toBe(3);
    const kwargs = generateContent.mock.calls.at(-1)![0];
    expect(kwargs.model).toBe("gemini-3.1-flash-image");
    expect(kwargs.contents).toBe("a red square");
    expect(kwargs.config.responseModalities).toEqual(["IMAGE"]);
    expect(kwargs.config.imageConfig.aspectRatio).toBe("1:1");
    // Upstream: `image_config.image_size is None`; unset fields are absent in JS.
    expect(kwargs.config.imageConfig.imageSize ?? null).toBeNull();
  });

  test("test_sends_image_size", async () => {
    // image_size reaches the request's image config.
    const { service, generateContent } = _service(
      [_response([_imagePart()])],
      { imageSize: "2K" },
      _rgbDecoder,
    );

    await _frames(service);

    const kwargs = generateContent.mock.calls.at(-1)![0];
    expect(kwargs.config.imageConfig.imageSize).toBe("2K");
  });

  test("test_reports_error_when_response_has_no_image", async () => {
    // A response without an image part, such as a safety block, yields an error.
    const { service } = _service([_response([{ text: "I can't draw that." }])]);

    const frames = await _frames(service);

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
  });

  test("test_reports_api_errors", async () => {
    // An exception from the API is reported as an error frame.
    const { service } = _service([new Error("boom")]);

    const frames = await _frames(service);

    expect(frames.length).toBe(1);
    expect(frames[0]).toBeInstanceOf(ErrorFrame);
    expect((frames[0] as ErrorFrame).error).toContain("boom");
  });

  // Deprecated: `negative_prompt` is deprecated upstream (warn_deprecated) and not ported.
  test.skip("test_negative_prompt_warns", () => {});
});
