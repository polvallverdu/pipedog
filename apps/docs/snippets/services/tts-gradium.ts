// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/gradium.mdx. Type-checked on every docs build.

// #region usage
import { GradiumTTSService } from "@pipedog/gradium/tts";

const tts = new GradiumTTSService({
  apiKey: process.env.GRADIUM_API_KEY ?? "",
  settings: new GradiumTTSService.Settings({ voice: "_6Aslh2DxfmnRLmP" }),
});
// #endregion usage
