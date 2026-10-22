// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/resembleai.mdx. Type-checked on every docs build.

// #region usage
import { ResembleAITTSService } from "@pipedog/resembleai/tts";

const tts = new ResembleAITTSService({
  apiKey: process.env.RESEMBLE_API_KEY ?? "",
  // Resemble's WebSocket reference lists the project as required.
  projectUuid: process.env.RESEMBLE_PROJECT_UUID ?? null,
  settings: new ResembleAITTSService.Settings({ voice: "your-voice-uuid" }),
});
// #endregion usage
