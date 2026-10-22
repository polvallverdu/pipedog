// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/soniox.mdx. Type-checked on every docs build.

// #region usage
import { SonioxTTSService } from "@pipedog/soniox/tts";

const tts = new SonioxTTSService({
  apiKey: process.env.SONIOX_API_KEY ?? "",
  settings: new SonioxTTSService.Settings({ voice: "Adrian", speed: 1.1 }),
});
// #endregion usage
