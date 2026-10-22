// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/gladia.mdx. Type-checked on every docs build.

// #region usage
import { LanguageConfig } from "@pipedog/gladia/config";
import { GladiaSTTService } from "@pipedog/gladia/stt";

const stt = new GladiaSTTService({
  apiKey: process.env.GLADIA_API_KEY ?? "",
  region: "eu-west",
  settings: new GladiaSTTService.Settings({
    languageConfig: new LanguageConfig({ languages: ["en", "fr"], codeSwitching: true }),
  }),
});
// #endregion usage
