// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/azure/image.py

/**
 * Azure OpenAI image generation service implementation.
 *
 * This module provides integration with Azure's OpenAI image generation API
 * using REST endpoints for creating images from text prompts.
 *
 * Porting notes:
 * - DIVERGENCE: upstream takes a required `aiohttp_session`. Here requests
 *   use `fetch` (the global one by default, or the `fetch` option).
 * - DIVERGENCE: upstream decodes the result with Pillow and reports Pillow's
 *   mode (`RGB`, `RGBA`, ...) as the frame format. Here PNGs are decoded with
 *   `decodePngToRgb` from `@pipedog/openai/image` and the frame is always
 *   `RGB`; pass `decodeImage` to decode other formats.
 * - Deprecated APIs are not ported: the `imageSize` and `model` constructor
 *   options.
 */

import { abortable, currentSignal, sleep } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, URLImageRawFrame } from "@pipedog/core/frames/frames";
import { ImageGenService, type ImageGenServiceOptions } from "@pipedog/core/services/image_service";
import { ImageGenSettings, type ImageGenSettingsOptions } from "@pipedog/core/services/settings";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { decodePngToRgb, type ImageDecoder } from "@pipedog/openai/image";

export interface AzureImageGenSettingsOptions extends ImageGenSettingsOptions {
  /** Target size for generated images. */
  imageSize?: string | null | NotGiven;
}

/**
 * Settings for the Azure image generation service.
 *
 * - `model`: Azure image generation model identifier.
 * - `imageSize`: target size for generated images.
 */
export class AzureImageGenSettings extends ImageGenSettings {
  imageSize: string | null | NotGiven = NOT_GIVEN;

  constructor(options: AzureImageGenSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface AzureImageGenServiceRESTOptions extends ImageGenServiceOptions {
  /** Azure OpenAI API key for authentication. */
  apiKey: string;
  /** Azure OpenAI endpoint URL, ending in `/`. */
  endpoint: string;
  /** Azure API version string. Defaults to "2023-06-01-preview". */
  apiVersion?: string;
  /**
   * `fetch` used for the requests. Defaults to the global `fetch`.
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
  settings?: AzureImageGenSettings | null;
}

/**
 * Azure OpenAI REST-based image generation service.
 *
 * Provides image generation using Azure's OpenAI service via REST API.
 * Supports asynchronous image generation with polling for completion and
 * automatic image download and processing.
 */
export class AzureImageGenServiceREST extends ImageGenService {
  static Settings: typeof AzureImageGenSettings = AzureImageGenSettings;
  declare protected _settings: AzureImageGenSettings;

  protected _apiKey: string;
  protected _azureEndpoint: string;
  protected _apiVersion: string;
  protected _fetch: typeof fetch;
  protected _decodeImage: ImageDecoder;

  /**
   * Initialize the AzureImageGenServiceREST.
   *
   * @param options.apiKey Azure OpenAI API key for authentication.
   * @param options.endpoint Azure OpenAI endpoint URL.
   * @param options.apiVersion Azure API version string. Defaults to
   *   "2023-06-01-preview".
   * @param options.fetch `fetch` used for the requests.
   * @param options.decodeImage Decodes the generated image into RGB pixels.
   * @param options.settings Runtime-updatable settings.
   */
  constructor(options: AzureImageGenServiceRESTOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof AzureImageGenServiceREST).Settings({
      model: null,
      imageSize: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({ settings: defaultSettings });

    this._apiKey = options.apiKey;
    this._azureEndpoint = options.endpoint;
    this._apiVersion = options.apiVersion ?? "2023-06-01-preview";
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this._decodeImage = options.decodeImage ?? decodePngToRgb;
  }

  /**
   * Generate an image from a text prompt using Azure OpenAI.
   *
   * @param prompt The text prompt describing the desired image.
   * @returns URLImageRawFrame containing the generated image data, or
   *   ErrorFrame if generation fails.
   */
  override async *runImageGen(prompt: string): AsyncGenerator<Frame, void, unknown> {
    const url = `${this._azureEndpoint}openai/images/generations:submit?api-version=${this._apiVersion}`;

    const headers = { "api-key": this._apiKey, "Content-Type": "application/json" };

    const body: Record<string, unknown> = {
      prompt,
      n: 1,
    };

    if (this._settings.imageSize !== null && this._settings.imageSize !== NOT_GIVEN) {
      body.size = this._settings.imageSize;
    }

    const submission = await abortable(
      this._fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: currentSignal(),
      }),
    );
    // Upstream reads `submission.headers["operation-location"]`, which raises
    // when it is missing (e.g. on a 429).
    const operationLocation = submission.headers.get("operation-location");
    if (operationLocation === null) {
      throw new Error(
        `Azure image generation submission returned no operation-location (HTTP ${submission.status})`,
      );
    }
    let status = "";
    let attemptsLeft = 120;
    let jsonResponse: Record<string, any> | null = null;
    while (status !== "succeeded") {
      attemptsLeft -= 1;
      if (attemptsLeft === 0) {
        yield new ErrorFrame({ error: "Image generation timed out" });
        return;
      }

      await sleep(1);

      const response = await abortable(
        this._fetch(operationLocation, { headers, signal: currentSignal() }),
      );

      jsonResponse = (await abortable(response.json())) as Record<string, any>;
      status = jsonResponse.status;
    }

    const imageUrl: string | null = jsonResponse ? jsonResponse.result.data[0].url : null;
    if (!imageUrl) {
      yield new ErrorFrame({ error: "Image generation failed" });
      return;
    }

    // Load the image from the url
    const response = await abortable(this._fetch(imageUrl, { signal: currentSignal() }));
    const imageBytes = new Uint8Array(await abortable(response.arrayBuffer()));
    const image = await this._decodeImage(imageBytes);
    yield new URLImageRawFrame({
      url: imageUrl,
      image: image.image,
      size: image.size,
      format: "RGB",
    });
  }
}
