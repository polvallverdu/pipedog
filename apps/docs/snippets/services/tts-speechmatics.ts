// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/speechmatics.mdx. Type-checked on every docs build.

// #region usage
import { SpeechmaticsTTSService } from "@pipedog/speechmatics/tts";

const tts = new SpeechmaticsTTSService({
  apiKey: process.env.SPEECHMATICS_API_KEY ?? "",
  settings: new SpeechmaticsTTSService.Settings({ voice: "sarah" }),
});
// #endregion usage
