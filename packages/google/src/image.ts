// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/google/image.py

/**
 * Google AI image generation service implementation.
 *
 * This module provides integration with Google's Gemini image models for
 * generating images from text prompts using the Gemini API.
 *
 * Porting notes:
 * - The client is `GoogleGenAI` from `@google/genai` (fetch based). It can be
 *   replaced with the `client` option.
 * - Upstream decodes the returned image with Pillow and converts it to RGB.
 *   Here that is the injectable `imageDecoder` option; the default is a stub
 *   that throws "not ported yet", so without a decoder every generated image
 *   yields an `ErrorFrame`.
 * - Upstream sets `GRPC_ENABLE_FORK_SUPPORT=false` at import; there is no
 *   fork in JS, so it is not ported.
 * - Deprecated upstream APIs are not ported: `GoogleImageGenService.InputParams`,
 *   the `params` option and the `negativePrompt` setting.
 */

import { type GenerateContentResponse, GoogleGenAI, type HttpOptions } from "@google/genai";
import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { ImageGenService, type ImageGenServiceOptions } from "@pipedog/core/services/image_service";
import { ImageGenSettings, type ImageGenSettingsOptions } from "@pipedog/core/services/settings";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { type ImageDecoder, notPortedImageDecoder } from "./image_decoder.ts";
import { updateGoogleClientHttpOptions } from "./utils.ts";

export interface GoogleImageGenSettingsOptions extends ImageGenSettingsOptions {
  /** Number of images to generate per prompt. */
  numberOfImages?: number | NotGiven;
  /** Aspect ratio of generated images, such as `"1:1"` or `"16:9"`. */
  aspectRatio?: string | null | NotGiven;
  /** Resolution of generated images, one of `"1K"`, `"2K"` or `"4K"`. */
  imageSize?: "1K" | "2K" | "4K" | (string & {}) | null | NotGiven;
}

/**
 * Settings for the Google image generation service.
 *
 * - `model`: Gemini image model identifier.
 * - `numberOfImages`: number of images to generate per prompt.
 * - `aspectRatio`: aspect ratio of generated images, such as `"1:1"` or
 *   `"16:9"`. `null` leaves the model's own default in place.
 * - `imageSize`: resolution of generated images, one of `"1K"`, `"2K"` or
 *   `"4K"`. `null` leaves the model's own default in place. Supported sizes
 *   vary by model.
 */
export class GoogleImageGenSettings extends ImageGenSettings {
  numberOfImages: number | NotGiven = NOT_GIVEN;
  aspectRatio: string | null | NotGiven = NOT_GIVEN;
  imageSize: "1K" | "2K" | "4K" | (string & {}) | null | NotGiven = NOT_GIVEN;

  constructor(options: GoogleImageGenSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** The part of the GenAI client this service uses. */
export interface GoogleImageGenClient {
  models: Pick<GoogleGenAI["models"], "generateContent">;
}

export interface GoogleImageGenServiceOptions extends ImageGenServiceOptions {
  /** Google AI API key for authentication. */
  apiKey: string;
  /** HTTP options for the client. */
  httpOptions?: HttpOptions | null;
  /** Runtime-updatable settings. */
  settings?: GoogleImageGenSettings | null;
  /** A GenAI client to use instead of creating one. */
  client?: GoogleImageGenClient | null;
  /** Decodes the returned image to RGB pixels (upstream: Pillow). */
  imageDecoder?: ImageDecoder | null;
}

/**
 * Google AI image generation service using Gemini image models.
 *
 * Provides text-to-image generation using Google's Gemini image models
 * through the Gemini API. Each image is a separate request, so
 * `numberOfImages` images are generated one after another.
 */
export class GoogleImageGenService extends ImageGenService {
  static Settings = GoogleImageGenSettings;
  declare protected _settings: GoogleImageGenSettings;

  protected _client: GoogleImageGenClient | null;
  protected _imageDecoder: ImageDecoder;

  /**
   * Initialize the GoogleImageGenService with API key and parameters.
   *
   * @param options.apiKey Google AI API key for authentication.
   * @param options.httpOptions HTTP options for the client.
   * @param options.settings Runtime-updatable settings.
   * @param options.client A GenAI client to use instead of creating one.
   * @param options.imageDecoder Decodes the returned image to RGB pixels.
   *   Other options are passed to the parent ImageGenService.
   */
  constructor(options: GoogleImageGenServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new GoogleImageGenSettings({
      model: "gemini-3.1-flash-image",
      numberOfImages: 1,
      aspectRatio: "1:1",
      imageSize: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ ...options, settings: defaultSettings });

    // Add client header
    const httpOptions = updateGoogleClientHttpOptions(options.httpOptions ?? null) as HttpOptions;

    this._client =
      options.client ?? new GoogleGenAI({ apiKey: options.apiKey, httpOptions: httpOptions });
    this._imageDecoder = options.imageDecoder ?? notPortedImageDecoder;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Google image generation service supports metrics.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Generate images from a text prompt using a Gemini image model.
   *
   * @param prompt The text description to generate images from.
   * @returns Generated URLImageRawFrame objects containing the generated
   *   images, or ErrorFrame objects if generation fails.
   */
  override async *runImageGen(prompt: string): AsyncGenerator<Frame, void, unknown> {
    logger.debug(`Generating image from prompt: ${prompt}`);
    await this.startTtfbMetrics();

    try {
      const model = assertGiven(this._settings.model);
      if (model === null) {
        yield new ErrorFrame({ error: "Google image generation model must be specified" });
        return;
      }

      const aspectRatio = assertGiven(this._settings.aspectRatio);
      const imageSize = assertGiven(this._settings.imageSize);
      const config = {
        responseModalities: ["IMAGE"],
        imageConfig: {
          ...(aspectRatio !== null ? { aspectRatio } : {}),
          ...(imageSize !== null ? { imageSize } : {}),
        },
        automaticFunctionCalling: { disable: true },
        abortSignal: currentSignal(),
      };
      if (this._client === null) {
        throw new Error("assertion failed: client is null");
      }
      const numberOfImages = assertGiven(this._settings.numberOfImages);
      for (let i = 0; i < numberOfImages; i++) {
        const response = await abortable(
          this._client.models.generateContent({ model, contents: prompt, config }),
        );
        await this.stopTtfbMetrics();

        const imageData = getImageData(response);
        if (imageData === null) {
          yield new ErrorFrame({ error: "Image generation failed: no image returned" });
          return;
        }

        // Output transports render RGB video by default.
        const image = await this._imageDecoder(imageData.data, imageData.mimeType);
        yield new URLImageRawFrame({
          url: null, // Gemini returns the image inline, not as a URL
          image: image.image,
          size: image.size,
          format: image.mode,
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({
        error: `Image generation error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** Close the GenAI client at teardown. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._closeClient();
  }

  protected async _closeClient(): Promise<void> {
    if (!this._client) {
      return;
    }
    try {
      // The JS GenAI client keeps no session to close; a client that does
      // expose `aclose()` (e.g. a custom one) is closed.
      await (this._client as { aclose?: () => Promise<void> }).aclose?.();
    } catch (e) {
      rethrowIfCancelled(e);
      // Do nothing - we're shutting down anyway
    } finally {
      this._client = null;
    }
  }
}

/** Return the bytes of the first image part in a response, if any. */
function getImageData(
  response: GenerateContentResponse,
): { data: Uint8Array; mimeType: string | null } | null {
  for (const candidate of response.candidates ?? []) {
    if (!candidate.content) {
      continue;
    }
    for (const part of candidate.content.parts ?? []) {
      if (part.inlineData?.data) {
        return {
          data: base64ToBytes(part.inlineData.data),
          mimeType: part.inlineData.mimeType ?? null,
        };
      }
    }
  }
  return null;
}
