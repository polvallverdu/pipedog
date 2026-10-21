// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/image/openai.mdx. Type-checked on every docs build.

// #region usage
import { OpenAIImageGenService } from "@pipedog/openai/image";

const imageGen = new OpenAIImageGenService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIImageGenService.Settings({
    model: "gpt-image-2.5-flare",
    imageSize: "1024x1024",
    quality: "low",
  }),
});
// #endregion usage
