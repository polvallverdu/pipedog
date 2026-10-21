// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_image_gen.py

/** Tests for OpenAIImageGenService response handling. */

import { expect, mock, test } from "bun:test";
import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { encode as encodePng } from "fast-png";
import { OpenAIImageGenService, type OpenAIImageGenSettingsOptions } from "../src/image.ts";

// Pillow's `Image.new(mode, size, "red")` saved as PNG.
function pngBytes(mode: "RGB" | "RGBA", size: [number, number] = [64, 32]): Uint8Array {
  const [width, height] = size;
  const channels = mode === "RGBA" ? 4 : 3;
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data[i * channels] = 255;
    if (channels === 4) data[i * channels + 3] = 255;
  }
  return encodePng({ width, height, data, channels, depth: 8 });
}

type Internals = any;

function makeService(
  data: Record<string, unknown>[],
  settings?: OpenAIImageGenSettingsOptions,
): {
  service: OpenAIImageGenService;
  generate: ReturnType<typeof mock>;
  fetchMock: ReturnType<typeof mock>;
} {
  // DIVERGENCE: upstream passes a MagicMock aiohttp session; the port downloads with `fetch`.
  const fetchMock = mock(
    async (_input: string | URL | Request, _init?: RequestInit) => new Response(),
  );
  const service = new OpenAIImageGenService({
    apiKey: "test-key",
    fetch: fetchMock as unknown as typeof fetch,
    settings: settings ? new OpenAIImageGenService.Settings(settings) : null,
  });
  const generate = mock(async (_params: Record<string, unknown>, _options?: unknown) => ({
    created: 0,
    data,
  }));
  (service as Internals)._client = { images: { generate } };
  return { service, generate, fetchMock };
}

async function frames(service: OpenAIImageGenService): Promise<Frame[]> {
  const result: Frame[] = [];
  for await (const frame of service.runImageGen("a red square")) result.push(frame);
  return result;
}

test("test_decodes_inline_base64_image", async () => {
  // GPT Image models return the image as base64 with no URL.
  const b64 = bytesToBase64(pngBytes("RGB"));
  const { service } = makeService([{ b64_json: b64 }]);

  const result = await frames(service);

  expect(result.length).toBe(1);
  const frame = result[0] as URLImageRawFrame;
  expect(frame).toBeInstanceOf(URLImageRawFrame);
  expect(frame.url).toBeNull();
  expect(frame.size).toEqual([64, 32]);
  expect(frame.format).toBe("RGB");
  expect(frame.image.length).toBe(64 * 32 * 3);
});

test("test_converts_alpha_images_to_rgb", async () => {
  // Images with an alpha channel are emitted as RGB.
  const b64 = bytesToBase64(pngBytes("RGBA"));
  const { service } = makeService([{ b64_json: b64 }]);

  const result = await frames(service);

  const frame = result[0] as URLImageRawFrame;
  expect(frame.format).toBe("RGB");
  expect(frame.image.length).toBe(64 * 32 * 3);
});

test("test_downloads_hosted_url_image", async () => {
  // A response that carries a URL is fetched from that URL.
  const url = "https://example.com/image.png";
  const { service, fetchMock } = makeService([{ url }]);
  fetchMock.mockImplementation(async () => new Response(pngBytes("RGB")));

  const result = await frames(service);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![0]).toBe(url);
  const frame = result[0] as URLImageRawFrame;
  expect(frame.url).toBe(url);
  expect(frame.size).toEqual([64, 32]);
});

test("test_reports_error_when_response_has_no_image", async () => {
  // A data entry with neither a URL nor base64 data yields an error.
  const { service } = makeService([{}]);

  const result = await frames(service);

  expect(result.length).toBe(1);
  expect(result[0]).toBeInstanceOf(ErrorFrame);
});

test("test_default_model_is_sent_without_response_format", async () => {
  // GPT Image models reject response_format, so it is never sent.
  const b64 = bytesToBase64(pngBytes("RGB"));
  const { service, generate } = makeService([{ b64_json: b64 }]);

  await frames(service);

  const kwargs = generate.mock.calls.at(-1)![0] as Record<string, unknown>;
  expect(kwargs.model).toBe("gpt-image-2.5-flare");
  expect(kwargs.quality).toBeNull();
  expect("response_format" in kwargs).toBe(false);
});

test("test_quality_setting_is_forwarded", async () => {
  // A configured quality tier reaches the Images API.
  const b64 = bytesToBase64(pngBytes("RGB"));
  const { service, generate } = makeService([{ b64_json: b64 }], { quality: "low" });

  await frames(service);

  expect((generate.mock.calls.at(-1)![0] as Record<string, unknown>).quality).toBe("low");
});
