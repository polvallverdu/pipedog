// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/gradium.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { GradiumSTTService } from "@pipedog/gradium/stt";

const stt = new GradiumSTTService({
  apiKey: process.env.GRADIUM_API_KEY ?? "",
  settings: new GradiumSTTService.Settings({ language: Language.EN }),
});
// #endregion usage

// #region turns
const withTurns = new GradiumSTTService({
  apiKey: process.env.GRADIUM_API_KEY ?? "",
  enableTurnDetection: true,
  settings: new GradiumSTTService.Settings({ eotHorizonS: 3.0, eotThreshold: 0.5 }),
});
// #endregion turns
