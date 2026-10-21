// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/image/google.mdx. Type-checked on every docs build.

// #region usage
import { GoogleImageGenService } from "@pipedog/google/image";
import type { ImageDecoder } from "@pipedog/google/image_decoder";

// Your decoder from PNG/JPEG/WebP bytes to RGB pixels (sharp, @jsquash/*, ...).
declare const decodeImage: ImageDecoder;

const imageGen = new GoogleImageGenService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  imageDecoder: decodeImage,
  settings: new GoogleImageGenService.Settings({
    model: "gemini-3.1-flash-image",
    aspectRatio: "16:9",
    imageSize: "2K",
  }),
});
// #endregion usage
