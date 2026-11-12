// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/image.py

/**
 * OpenAI image generation service implementation.
 *
 * This module provides integration with OpenAI's image generation API for
 * creating images from text prompts.
 *
 * Porting notes:
 * - DIVERGENCE: upstream downloads hosted results with a required
 *   `aiohttp_session`. Here the download uses `fetch` (the global one by
 *   default, or the `fetch` option).
 * - Upstream decodes the image with Pillow and converts it to RGB. Here PNGs
 *   are decoded with `fast-png` (pure JS); `decodeImage` can be passed to
 *   decode other formats.
 * - Deprecated APIs are not ported: the `imageSize` and `model` constructor
 *   options.
 */

import { abortable, currentSignal } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { ImageGenService, type ImageGenServiceOptions } from "@pipedog/core/services/image_service";
import { ImageGenSettings, type ImageGenSettingsOptions } from "@pipedog/core/services/settings";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";
import OpenAI from "openai";

/**
 * Hint set for the `size` argument to `images.generate`. The values mirror the
 * literal type the OpenAI SDK accepts on its `size` parameter, redeclared
 * here.
 *
 * Settings fields use this alias in unions like `OpenAIImageSize | string`, so
 * editors show these values as completion hints without rejecting other
 * strings. If OpenAI adds a size before this list is updated, callers can
 * still pass it and we forward it through. Invalid values surface as an
 * OpenAI API error at runtime. Keep in sync on a best-effort basis when
 * bumping the openai dep.
 */
export type OpenAIImageSize =
  | "auto"
  | "1024x1024"
  | "1536x1024"
  | "1024x1536"
  | "256x256"
  | "512x512"
  | "1792x1024"
  | "1024x1792";

/**
 * Hint set for the `quality` argument to `images.generate`, redeclared and
 * used the same way as `OpenAIImageSize` above.
 */
export type OpenAIImageQuality =
  | "auto"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "standard"
  | "hd";

/**
 * Hint set for the `moderation` argument to `images.generate`, redeclared and
 * used the same way as `OpenAIImageSize` above.
 */
export type OpenAIImageModeration = "low" | "auto";

export interface OpenAIImageGenSettingsOptions extends ImageGenSettingsOptions {
  /** Target size for generated images. */
  imageSize?: OpenAIImageSize | (string & {}) | null | NotGiven;
  /**
   * Rendering quality for generated images. Lower tiers generate faster at
   * the cost of detail. `null` lets OpenAI pick the best quality for the
   * model.
   */
  quality?: OpenAIImageQuality | (string & {}) | null | NotGiven;
  /**
   * Content-moderation level applied to generated images, either `"low"` for
   * less restrictive filtering or `"auto"`. `null` leaves OpenAI's default in
   * place.
   */
  moderation?: OpenAIImageModeration | (string & {}) | null | NotGiven;
}

/**
 * Settings for the OpenAI image generation service.
 *
 * - `model`: image generation model identifier.
 * - `imageSize`: target size for generated images.
 * - `quality`: rendering quality for generated images. Lower tiers generate
 *   faster at the cost of detail. `null` lets OpenAI pick the best quality
 *   for the model.
 * - `moderation`: content-moderation level applied to generated images,
 *   either `"low"` for less restrictive filtering or `"auto"`. `null` leaves
 *   OpenAI's default in place.
 */
export class OpenAIImageGenSettings extends ImageGenSettings {
  imageSize: OpenAIImageSize | (string & {}) | null | NotGiven = NOT_GIVEN;
  quality: OpenAIImageQuality | (string & {}) | null | NotGiven = NOT_GIVEN;
  moderation: OpenAIImageModeration | (string & {}) | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAIImageGenSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** A decoded image as interleaved RGB pixels. */
export interface DecodedRgbImage {
  /** The pixels, 3 bytes per pixel. */
  image: Uint8Array;
  /** Width and height. */
  size: [number, number];
}

/** Decodes encoded image bytes into RGB pixels. */
export type ImageDecoder = (bytes: Uint8Array) => Promise<DecodedRgbImage> | DecodedRgbImage;

/**
 * Decode a PNG and convert it to RGB (Pillow's `Image.open(...).convert("RGB")`):
 * alpha is dropped, grayscale widened and palettes expanded.
 *
 * @param bytes The PNG bytes.
 * @returns The RGB pixels and the image size.
 */
export function decodePngToRgb(bytes: Uint8Array): DecodedRgbImage {
  const png = decodePng(bytes);
  const { width, height } = png;
  const pixelCount = width * height;
  let data: ArrayLike<number> = png.data;
  let channels = png.channels;
  let shift = 0;

  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0]?.length ?? 3;
  } else if (png.depth === 16) {
    // Pillow keeps the most significant byte of each 16-bit sample.
    shift = 8;
  } else if (png.depth !== 8) {
    throw new Error(`Unsupported PNG bit depth for RGB conversion: ${png.depth}`);
  }

  const rgb = new Uint8Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const src = i * channels;
    const dst = i * 3;
    if (channels >= 3) {
      rgb[dst] = data[src]! >> shift;
      rgb[dst + 1] = data[src + 1]! >> shift;
      rgb[dst + 2] = data[src + 2]! >> shift;
    } else {
      // L or LA: widen the gray value.
      const v = data[src]! >> shift;
      rgb[dst] = v;
      rgb[dst + 1] = v;
      rgb[dst + 2] = v;
    }
  }
  return { image: rgb, size: [width, height] };
}

export interface OpenAIImageGenServiceOptions extends ImageGenServiceOptions {
  /** OpenAI API key for authentication. */
  apiKey: string;
  /** Custom base URL for OpenAI API. If null, uses default. */
  baseUrl?: string | null;
  /**
   * `fetch` used to download hosted results. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /**
   * Decodes the generated image into RGB pixels. Defaults to
   * `decodePngToRgb`.
   *
   * DIVERGENCE: pipedog-only. Upstream decodes with Pillow.
   */
  decodeImage?: ImageDecoder | null;
  /** Runtime-updatable settings. */
  settings?: OpenAIImageGenSettings | null;
}

/**
 * OpenAI image generation service.
 *
 * Provides image generation capabilities using OpenAI's GPT Image models.
 * Supports various image sizes and can generate images from text prompts.
 */
export class OpenAIImageGenService extends ImageGenService {
  static Settings: typeof OpenAIImageGenSettings = OpenAIImageGenSettings;
  declare protected _settings: OpenAIImageGenSettings;

  protected _client: OpenAI;
  protected _fetch: typeof fetch;
  protected _decodeImage: ImageDecoder;

  /**
   * Initialize the OpenAI image generation service.
   *
   * @param options.apiKey OpenAI API key for authentication.
   * @param options.baseUrl Custom base URL for OpenAI API. If null, uses default.
   * @param options.fetch `fetch` used to download hosted results.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-image-2.5-flare").
   */
  constructor(options: OpenAIImageGenServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof OpenAIImageGenService).Settings({
      model: "gpt-image-2.5-flare",
      imageSize: null,
      quality: null,
      moderation: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ settings: defaultSettings });
    this._client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? undefined,
    });
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._decodeImage = options.decodeImage ?? decodePngToRgb;
  }

  /**
   * Generate an image from a text prompt using OpenAI's Images API.
   *
   * @param prompt Text description of the image to generate.
   * @returns URLImageRawFrame containing the generated image data.
   */
  override async *runImageGen(prompt: string): AsyncGenerator<Frame, void, unknown> {
    logger.debug(`Generating image from prompt: ${prompt}`);

    const size = assertGiven(this._settings.imageSize);
    const quality = assertGiven(this._settings.quality);
    const moderation = assertGiven(this._settings.moderation);
    const image = await abortable(
      this._client.images.generate(
        {
          prompt,
          model: assertGiven(this._settings.model) as string,
          n: 1,
          size: size as OpenAI.Images.ImageGenerateParams["size"],
          quality: quality as OpenAI.Images.ImageGenerateParams["quality"],
          moderation: moderation as OpenAI.Images.ImageGenerateParams["moderation"],
        },
        { signal: currentSignal() },
      ),
    );

    if (!image.data || image.data.length === 0) {
      yield new ErrorFrame({ error: "Image generation failed: no data returned" });
      return;
    }

    // The GPT Image models always return the bytes inline; the response
    // carries a URL only when the model supports hosted results.
    const imageUrl = image.data[0]!.url ?? null;
    const b64Data = image.data[0]!.b64_json;

    let imageBytes: Uint8Array;
    if (imageUrl) {
      const response = await abortable(this._fetch(imageUrl, { signal: currentSignal() }));
      imageBytes = new Uint8Array(await abortable(response.arrayBuffer()));
    } else if (b64Data) {
      imageBytes = base64ToBytes(b64Data);
    } else {
      yield new ErrorFrame({ error: "Image generation failed" });
      return;
    }

    // GPT Image PNGs can carry an alpha channel, while output transports
    // render RGB video by default.
    const generated = await this._decodeImage(imageBytes);
    yield new URLImageRawFrame({
      image: generated.image,
      size: generated.size,
      format: "RGB",
      url: imageUrl,
    });
  }
}
